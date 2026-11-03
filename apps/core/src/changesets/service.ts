import { randomUUID } from 'node:crypto';
import { escAttr, escHtml, escUrl } from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { type CurrentUser, loadUser, userCan } from '../auth/users';
import { holdCachePurges, PURGE_ACTION } from '../cache/invalidation';
import { CacheTag } from '../cache/tags';
import { type Post, PostError } from '../content/posts';
import type { HtmlOutput } from '../frontend/head';
import type { PageRender } from '../frontend/page';
import type { RenderedPage, RenderRequest } from '../frontend/render';
import type { Kernel } from '../kernel';
import { activeTransaction } from '../transaction';
import {
  CHANGESET_OPTIONS,
  ChangesetEntities,
  ChangesetEntryError,
  globalStylesEntityHandler,
  optionEntityHandler,
  parseEntryKey,
  postEntityHandler,
} from './entities';
import {
  ChangesetPreview,
  currentChangesetPreview,
  outsideChangesetPreview,
  withChangesetPreview,
} from './preview';

/**
 * Changesets (v0.8, ADR 0022): one draft across global styles, templates,
 * pages, menus and a few options, previewed together and published or
 * discarded together. A port of the Customizer's changesets
 * (wordpress/wp-includes/class-wp-customize-manager.php): the
 * `customize_changeset` post type, its UUID slug and status flow, its JSON
 * content and its publish hook.
 *
 * Content, as save_changeset_post() stores it:
 *
 *   { "page:12": { "value": { "content": "…" }, "type": "page",
 *                  "user_id": 1, "date_modified_gmt": "2026-11-03T10:00:00.000Z" },
 *     "option:blogname": { "value": "Bakery", "type": "option", … } }
 *
 * Hooks: `customize_save` (changeset, data) before the entries are written;
 * `customize_save_after` (changeset, data) once they are committed; filter
 * `customize_changeset_branching` (false) — true allows a user more than one
 * open changeset.
 */

export const CHANGESET_POST_TYPE = 'customize_changeset';

/** Statuses of a changeset that can still change (WordPress's are the same, plus pending). */
export const OPEN_STATUSES = ['auto-draft', 'draft', 'future'] as const;
export type OpenStatus = (typeof OPEN_STATUSES)[number];

/** One entry, as stored. */
export interface ChangesetEntry {
  value: unknown;
  type: string;
  user_id: number;
  date_modified_gmt: string;
}

export type ChangesetData = Record<string, ChangesetEntry>;

/** Entries that failed validation or a permission check, by key (WordPress's setting validities). */
export class ChangesetValidationError extends Error {
  constructor(readonly entries: Record<string, { code: string; message: string }>) {
    const count = Object.keys(entries).length;
    super(
      count === 1
        ? 'Unable to save due to an invalid entry.'
        : `Unable to save due to ${count} invalid entries.`,
    );
  }
}

/** A request about a changeset that can't go ahead (WordPress's WP_Error codes). */
export class ChangesetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 500 = 400,
  ) {
    super(message);
  }
}

declare module '@pressbase/hooks' {
  interface ActionRegistry {
    customize_save: [changeset: Post, data: ChangesetData];
    customize_save_after: [changeset: Post, data: ChangesetData];
  }
  interface FilterRegistry {
    customize_changeset_branching: [branching: boolean];
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The query variables that ask for a preview (`customize_changeset_uuid` is WordPress's). */
export const PREVIEW_QUERY_VARS = ['changeset_uuid', 'customize_changeset_uuid'] as const;

/** Render requests already handled by renderPreview() (it renders through itself). */
const handled = new WeakSet<RenderRequest>();

export class ChangesetsService {
  /** What a changeset can hold: entity handlers by type (see entities.ts). */
  readonly entities = new ChangesetEntities();
  /** Options a changeset may change. */
  readonly options = new Set<string>(CHANGESET_OPTIONS);

  constructor(private readonly kernel: Kernel) {}

  /** Registers the post type, core's entity handlers and the hooks. Called by the kernel. */
  register(): void {
    const { kernel } = this;
    // create_initial_post_types(): every capability is `customize`, which
    // map_meta_cap() maps to edit_theme_options; a published changeset can't be edited.
    kernel.postTypes.register(
      CHANGESET_POST_TYPE,
      {
        label: 'Changesets',
        singularLabel: 'Changeset',
        public: false,
        supports: ['title', 'author'],
        capabilityType: CHANGESET_POST_TYPE,
        capabilities: {
          create_posts: 'edit_theme_options',
          delete_others_posts: 'edit_theme_options',
          delete_post: 'edit_theme_options',
          delete_posts: 'edit_theme_options',
          delete_private_posts: 'edit_theme_options',
          delete_published_posts: 'edit_theme_options',
          edit_others_posts: 'edit_theme_options',
          edit_post: 'edit_theme_options',
          edit_posts: 'edit_theme_options',
          edit_private_posts: 'edit_theme_options',
          edit_published_posts: 'do_not_allow',
          publish_posts: 'edit_theme_options',
          read: 'read',
          read_post: 'edit_theme_options',
          read_private_posts: 'edit_theme_options',
        },
      },
      true,
    );

    this.entities.register(postEntityHandler('page'));
    this.entities.register(postEntityHandler('wp_navigation'));
    this.entities.register(globalStylesEntityHandler());
    this.entities.register(optionEntityHandler(this.options));

    // _wp_customize_publish_changeset() (wp-includes/theme.php), on
    // transition_post_status: a changeset going to `publish` — through
    // publish() or, when scheduled, the publish_future_post event — writes its entries.
    kernel.hooks.addAction('transition_post_status', async (newStatus, oldStatus, post) => {
      const changeset = post as Post;
      if (changeset.type !== CHANGESET_POST_TYPE || newStatus !== 'publish') return;
      if (oldStatus === 'publish') return;
      if (activeTransaction()) {
        await this.#applyEntries(changeset);
        return;
      }
      // A scheduled changeset: the status changed outside a transaction.
      try {
        // publishDue() can run during a render, even a preview's: publish outside it.
        await outsideChangesetPreview(() =>
          this.#transactionally(changeset, () => this.#applyEntries(changeset)),
        );
      } catch (error) {
        await kernel.db
          .update(schema.posts)
          .set({ status: 'draft' })
          .where(eq(schema.posts.id, changeset.id));
        console.error(
          `[changesets] Scheduled changeset ${changeset.slug} failed to publish:`,
          error,
        );
      }
    });

    // Previews: the allow-listed options answer from the changeset (pre_option_{name}).
    for (const name of this.options) this.#previewOption(name);

    // WP_Customize_Manager::customize_preview_init(): wp_robots_no_robots().
    kernel.hooks.addFilter('wp_robots', async (robots) => {
      if (!currentChangesetPreview()) return robots;
      const isPublic = await kernel.options.get<boolean>('blog_public', true);
      return { ...robots, noindex: true, ...(isPublic ? { follow: true } : { nofollow: true }) };
    });

    // The Preview banner, first thing in the body.
    kernel.hooks.addAction('wp_body_open', async (out: HtmlOutput, page: PageRender) => {
      const preview = currentChangesetPreview();
      if (preview) out.print(await this.#banner(preview, page));
    });
  }

  /** Lets a changeset change one more option (it must have a registered setting). */
  allowOption(name: string): void {
    if (this.options.has(name)) return;
    this.options.add(name);
    this.#previewOption(name);
  }

  #previewOption(name: string): void {
    this.kernel.hooks.addFilter(`pre_option_${name}`, async (pre: unknown) => {
      const preview = currentChangesetPreview();
      return preview?.options.has(name) ? preview.options.get(name) : pre;
    });
  }

  /* ------------------------------------------------------------- reading */

  /** WP_Customize_Manager::find_changeset_post_id(): the changeset with this UUID. */
  async find(uuid: string): Promise<Post | undefined> {
    if (!UUID.test(uuid)) return undefined;
    const [post] = await this.kernel.db
      .select()
      .from(schema.posts)
      .where(and(eq(schema.posts.type, CHANGESET_POST_TYPE), eq(schema.posts.slug, uuid)))
      .orderBy(desc(schema.posts.id))
      .limit(1);
    return post;
  }

  /** A user's open changesets, newest first. */
  async openFor(userId: number): Promise<Post[]> {
    return this.kernel.db
      .select()
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.type, CHANGESET_POST_TYPE),
          eq(schema.posts.authorId, userId),
          inArray(schema.posts.status, [...OPEN_STATUSES]),
        ),
      )
      .orderBy(desc(schema.posts.modified), desc(schema.posts.id));
  }

  /** get_changeset_post_data(): the entries, or none when the content isn't a changeset. */
  data(changeset: Post): ChangesetData {
    try {
      const data = JSON.parse(changeset.content || '{}') as unknown;
      return data && typeof data === 'object' && !Array.isArray(data)
        ? (data as ChangesetData)
        : {};
    } catch {
      return {};
    }
  }

  isOpen(changeset: Post): boolean {
    return (OPEN_STATUSES as readonly string[]).includes(changeset.status);
  }

  /**
   * Whether `user` may see, change, publish or discard the changeset: its
   * author, or anyone with `customize` (edit_theme_options), as the
   * post type's capabilities say.
   */
  canManage(changeset: Post, user: CurrentUser | null): boolean {
    if (!user) return false;
    return changeset.authorId === user.id || userCan(user, 'edit_theme_options');
  }

  /** Who may start a changeset: anyone who can edit content or the theme. */
  canCreate(user: CurrentUser | null): boolean {
    return userCan(user, 'edit_posts') || userCan(user, 'edit_theme_options');
  }

  /* ------------------------------------------------------------- writing */

  /**
   * A new changeset (an auto-draft with a fresh UUID), or — unless
   * `customize_changeset_branching` allows several — the user's open one.
   */
  async create(user: CurrentUser, title = ''): Promise<{ changeset: Post; created: boolean }> {
    const branching = await this.kernel.hooks.applyFilters('customize_changeset_branching', false);
    if (!branching) {
      const [open] = await this.openFor(user.id);
      if (open) return { changeset: open, created: false };
    }
    const changeset = await this.kernel.posts.insert(CHANGESET_POST_TYPE, {
      title,
      content: '{}',
      status: 'auto-draft',
      slug: randomUUID(),
      authorId: user.id,
    });
    return { changeset, created: true };
  }

  /**
   * save_changeset_post() without publishing: sets entries (`null` removes
   * one), and optionally the title, status (`auto-draft`, `draft`, or
   * `future` with a date) and date. Every entry given is validated and
   * permission-checked for `user`; if any fails, nothing is saved.
   */
  async update(
    changeset: Post,
    user: CurrentUser,
    changes: {
      entries?: Record<string, unknown>;
      title?: string;
      status?: OpenStatus;
      date?: Date;
    },
  ): Promise<Post> {
    if (!this.isOpen(changeset)) {
      throw new ChangesetError(
        'changeset_already_published',
        'The previous set of changes has already been published.',
        409,
      );
    }
    const data = this.data(changeset);
    const errors: Record<string, { code: string; message: string }> = {};
    const now = new Date().toISOString();
    for (const [key, raw] of Object.entries(changes.entries ?? {})) {
      if (raw === null) {
        delete data[key];
        continue;
      }
      const parsed = parseEntryKey(key);
      const handler = parsed && this.entities.get(parsed.type);
      if (!parsed || !handler) {
        errors[key] = { code: 'unrecognized', message: 'This kind of entry isn’t recognised.' };
        continue;
      }
      try {
        const value = await handler.validate(this.kernel, parsed.id, raw, user);
        if (!(await handler.canEdit(this.kernel, parsed.id, value, user))) {
          errors[key] = {
            code: 'changeset_entry_forbidden',
            message: 'Sorry, you are not allowed to change this.',
          };
          continue;
        }
        data[key] = { value, type: parsed.type, user_id: user.id, date_modified_gmt: now };
      } catch (error) {
        if (!(error instanceof ChangesetEntryError)) throw error;
        errors[key] = { code: error.code, message: error.message };
      }
    }
    if (Object.keys(errors).length) throw new ChangesetValidationError(errors);

    let status = changes.status ?? changeset.status;
    // WordPress: only a future date may be given, and only with a status other than auto-draft.
    if (changes.date && changes.date.getTime() <= Date.now()) {
      throw new ChangesetError('not_future_date', 'You must supply a future date to schedule.');
    }
    if (status === 'future') {
      const date = changes.date ?? changeset.date;
      if (date.getTime() <= Date.now()) {
        throw new ChangesetError('not_future_date', 'You must supply a future date to schedule.');
      }
    } else if (changes.date) {
      if (status === 'auto-draft') {
        throw new ChangesetError(
          'cannot_supply_date_for_auto_draft_changeset',
          'An auto-draft changeset can’t be scheduled; save it as a draft first.',
        );
      }
      status = 'future';
    }
    if (status === 'future') await this.#assertCanPublish(data, user);

    return this.kernel.posts.update(changeset.id, {
      content: JSON.stringify(data),
      status,
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.date ? { date: changes.date } : {}),
      saveRevision: false,
    });
  }

  /** Every entry, checked against `user`'s rights (whoever publishes may not have written it). */
  async #assertCanPublish(data: ChangesetData, user: CurrentUser): Promise<void> {
    const errors: Record<string, { code: string; message: string }> = {};
    for (const [key, entry] of Object.entries(data)) {
      const parsed = parseEntryKey(key);
      const handler = parsed && this.entities.get(parsed.type);
      if (!parsed || !handler) {
        errors[key] = { code: 'unrecognized', message: 'This kind of entry isn’t recognised.' };
        continue;
      }
      let allowed = false;
      try {
        allowed = await handler.canEdit(this.kernel, parsed.id, entry.value, user);
      } catch (error) {
        if (!(error instanceof ChangesetEntryError)) throw error;
        errors[key] = { code: error.code, message: error.message };
        continue;
      }
      if (!allowed) {
        errors[key] = {
          code: 'changeset_entry_forbidden',
          message: 'Sorry, you are not allowed to change this.',
        };
      }
    }
    if (Object.keys(errors).length) throw new ChangesetValidationError(errors);
  }

  /**
   * Publishes the changeset: checks every entry against the publisher's
   * rights, then — in one database transaction — marks it published, which
   * writes every entry (the transition_post_status hook above). Any failure
   * rolls the whole publish back. Cache tags are purged once, after commit.
   */
  async publish(changeset: Post, user: CurrentUser): Promise<Post> {
    if (!this.isOpen(changeset)) {
      throw new ChangesetError(
        'changeset_already_published',
        'The previous set of changes has already been published.',
        409,
      );
    }
    await this.#assertCanPublish(this.data(changeset), user);
    await this.#transactionally(changeset, async () => {
      // Claims the changeset: a second publish running at the same time finds it published.
      const [claimed] = await this.kernel.db
        .select({ status: schema.posts.status })
        .from(schema.posts)
        .where(eq(schema.posts.id, changeset.id))
        .for('update');
      if (!claimed || !(OPEN_STATUSES as readonly string[]).includes(claimed.status)) {
        throw new ChangesetError(
          'changeset_already_published',
          'The previous set of changes has already been published.',
          409,
        );
      }
      await this.kernel.posts.update(changeset.id, { status: 'publish', date: new Date() });
    });
    return (await this.kernel.posts.get(changeset.id)) as Post;
  }

  /**
   * Runs `fn` in a transaction with cache purges held back: committed, the
   * held tags are purged once and `customize_save_after` fires; rolled back,
   * the in-memory state a write may have touched (options, the active
   * theme's styles) is reloaded from the database.
   */
  async #transactionally(changeset: Post, fn: () => Promise<void>): Promise<void> {
    const { kernel } = this;
    let tags: string[];
    try {
      ({ tags } = await holdCachePurges(() => kernel.transaction(fn)));
    } catch (error) {
      await kernel.options.load();
      await kernel.themes.refreshStyles();
      // A render running meanwhile could have seen (and cached) a value
      // that is now rolled back: options and styles are on every page.
      const types = new Set(Object.values(this.data(changeset)).map((e) => e.type));
      if (types.has('option') || types.has('wp_global_styles')) {
        await kernel.hooks.doAction(PURGE_ACTION, [CacheTag.site], 'changeset_rollback');
      }
      throw error;
    }
    if (tags.length) await kernel.hooks.doAction(PURGE_ACTION, tags, 'changeset_publish');
    const published = (await kernel.posts.get(changeset.id)) ?? changeset;
    await kernel.hooks.doAction('customize_save_after', published, this.data(published));
  }

  /** _publish_changeset_values(): writes each entry, in the handlers' order. */
  async #applyEntries(changeset: Post): Promise<void> {
    const data = this.data(changeset);
    await this.kernel.hooks.doAction('customize_save', changeset, data);
    const entries = Object.entries(data).map(([key, entry]) => {
      const parsed = parseEntryKey(key);
      const handler = parsed && this.entities.get(parsed.type);
      if (!parsed || !handler) {
        throw new ChangesetError('unrecognized', `The entry ${key} isn’t recognised.`);
      }
      return { key, entry, id: parsed.id, handler };
    });
    entries.sort((a, b) => a.handler.order - b.handler.order);
    const authors = new Map<number, CurrentUser | null>();
    for (const { key, entry, id, handler } of entries) {
      if (!authors.has(entry.user_id)) {
        authors.set(entry.user_id, await loadUser(this.kernel, entry.user_id));
      }
      try {
        await handler.apply(this.kernel, id, entry.value, authors.get(entry.user_id) ?? null);
      } catch (error) {
        if (error instanceof ChangesetEntryError) {
          throw new ChangesetValidationError({
            [key]: { code: error.code, message: error.message },
          });
        }
        if (error instanceof PostError) {
          throw new ChangesetValidationError({
            [key]: { code: error.code, message: error.message },
          });
        }
        throw error;
      }
    }
  }

  /**
   * Discards the changeset: trash_changeset_post(), which trashes it
   * without wp_trash_post()'s `__trashed` slug, so the UUID stays its own.
   */
  async discard(changeset: Post): Promise<Post> {
    if (!this.isOpen(changeset)) {
      throw new ChangesetError(
        'changeset_already_published',
        'The previous set of changes has already been published.',
        409,
      );
    }
    const { kernel } = this;
    await kernel.hooks.doAction('wp_trash_post', changeset.id);
    await kernel.meta.update('post', changeset.id, '_wp_trash_meta_status', changeset.status);
    await kernel.meta.update(
      'post',
      changeset.id,
      '_wp_trash_meta_time',
      Math.floor(Date.now() / 1000),
    );
    await kernel.db
      .update(schema.posts)
      .set({ status: 'trash' })
      .where(eq(schema.posts.id, changeset.id));
    const trashed = (await kernel.posts.get(changeset.id)) as Post;
    await kernel.hooks.doAction('transition_post_status', 'trash', changeset.status, trashed);
    await kernel.hooks.doAction('trashed_post', changeset.id);
    return trashed;
  }

  /* ------------------------------------------------------------ previews */

  /** The overlay a changeset previews (WP_Customize_Setting::preview() for each entry). */
  async previewOf(changeset: Post, user: CurrentUser): Promise<ChangesetPreview> {
    const preview = new ChangesetPreview(changeset, user);
    for (const [key, entry] of Object.entries(this.data(changeset))) {
      const parsed = parseEntryKey(key);
      const handler = parsed && this.entities.get(parsed.type);
      if (parsed && handler) await handler.preview(this.kernel, parsed.id, entry.value, preview);
    }
    return preview;
  }

  /**
   * A public page under `?changeset_uuid=` (WordPress's
   * `customize_changeset_uuid` works too): rendered with the changeset's
   * entries for a logged-in user who may manage the open changeset, as is
   * otherwise. Either way the answer is `no-store` and `noindex`, so the page
   * cache never keeps it. Undefined when the URL asks for no preview.
   */
  async renderPreview(
    request: RenderRequest,
    render: (request: RenderRequest) => Promise<RenderedPage>,
  ): Promise<RenderedPage | undefined> {
    if (handled.has(request) || currentChangesetPreview()) return undefined;
    const url = new URL(request.url, 'http://pressbase.invalid');
    const uuid = PREVIEW_QUERY_VARS.map((name) => url.searchParams.get(name)).find(
      (value) => value !== null,
    );
    if (uuid === undefined) return undefined;

    const changeset = request.user ? await this.find(uuid) : undefined;
    const allowed =
      changeset &&
      request.user &&
      this.isOpen(changeset) &&
      this.canManage(changeset, request.user);
    let page: RenderedPage;
    if (!allowed || !changeset || !request.user) {
      const inner = { ...request };
      handled.add(inner);
      page = await render(inner);
    } else {
      const preview = await this.previewOf(changeset, request.user);
      const theme =
        request.theme ??
        (preview.globalStyles
          ? await this.kernel.themes.withUserStyles(preview.globalStyles)
          : undefined);
      const inner: RenderRequest = { ...request, ...(theme ? { theme } : {}) };
      handled.add(inner);
      page = await withChangesetPreview(preview, () => render(inner));
      const home = (await this.kernel.options.get<string>('home', '')).replace(/\/+$/, '');
      page = {
        ...page,
        html: keepInPreview(page.html, home, changeset.slug),
        headers: page.headers.location
          ? {
              ...page.headers,
              location: withPreviewParam(page.headers.location, home, changeset.slug),
            }
          : page.headers,
      };
    }
    return {
      ...page,
      headers: { ...page.headers, 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' },
    };
  }

  /** The Preview banner: what's shown, and the ways out. */
  async #banner(preview: ChangesetPreview, page: PageRender): Promise<string> {
    const { i18n } = this.kernel;
    const siteUrl = (await this.kernel.options.get<string>('siteurl', '')).replace(/\/+$/, '');
    const exit = new URL(page.path, 'http://pressbase.invalid');
    for (const name of PREVIEW_QUERY_VARS) exit.searchParams.delete(name);
    const studio = `${siteUrl}/admin/studio?changeset_uuid=${encodeURIComponent(preview.uuid)}`;
    const count = Object.keys(this.data(preview.changeset)).length;
    const summary = i18n
      ._n(
        'You’re seeing %d unpublished change. Visitors don’t see it yet.',
        'You’re seeing %d unpublished changes. Visitors don’t see them yet.',
        count,
        'pressbase',
      )
      .replace('%d', String(count));
    return `<div id="pressbase-preview-banner" role="region" aria-label="${escAttr(i18n.__('Preview', 'pressbase'))}">
<style>#pressbase-preview-banner{position:sticky;top:0;z-index:100000;display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 16px;background:#1e1e1e;color:#fff;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}#pressbase-preview-banner p{margin:0;flex:1 1 16rem}#pressbase-preview-banner a{color:#fff;text-decoration:underline;text-underline-offset:2px}#pressbase-preview-banner a:focus-visible{outline:2px solid #fff;outline-offset:2px}#pressbase-preview-banner strong{margin-inline-end:6px}</style>
<p><strong>${escHtml(i18n.__('Preview', 'pressbase'))}</strong>${escHtml(summary)}</p>
<a data-changeset-preview-exit href="${escUrl(studio)}">${escHtml(i18n.__('Back to Studio', 'pressbase'))}</a>
<a data-changeset-preview-exit href="${escUrl(`${exit.pathname}${exit.search}${exit.hash}`)}">${escHtml(i18n.__('Exit preview', 'pressbase'))}</a>
</div>`;
  }
}

/** Paths under the site that are never public pages. */
const NOT_PAGES = /^\/(admin|wp-json|wp-content|wp-includes|wp-admin|wp-login\.php|login)(\/|$)/;

/** A same-site link that stays in the preview (with the changeset's UUID); others unchanged. */
function withPreviewParam(href: string, home: string, uuid: string): string {
  const decoded = href.replace(/&amp;/g, '&');
  let url: URL;
  try {
    url = new URL(decoded, `${home || 'http://pressbase.invalid'}/`);
  } catch {
    return href;
  }
  const origin = new URL(`${home || 'http://pressbase.invalid'}/`).origin;
  const relative = href.startsWith('/') && !href.startsWith('//');
  if (!relative && !(home && decoded.startsWith(`${home}/`)) && decoded !== home) return href;
  if (url.origin !== origin || NOT_PAGES.test(url.pathname)) return href;
  if (PREVIEW_QUERY_VARS.some((name) => url.searchParams.has(name))) return href;
  const hash = href.indexOf('#');
  const base = hash === -1 ? href : href.slice(0, hash);
  const fragment = hash === -1 ? '' : href.slice(hash);
  const separator = base.includes('?') ? (href.includes('&amp;') ? '&amp;' : '&') : '?';
  return `${base}${separator}changeset_uuid=${uuid}${fragment}`;
}

/**
 * Keeps navigation inside the preview, as the Customizer's preview script
 * does: same-site links in the page carry the changeset's UUID.
 */
function keepInPreview(html: string, home: string, uuid: string): string {
  return html.replace(/<a\b[^>]*>/gi, (tag) => {
    if (tag.includes('data-changeset-preview-exit')) return tag;
    return tag.replace(
      /(\shref=)(["'])([^"']*)\2/i,
      (_m, attr: string, quote: string, href: string) =>
        `${attr}${quote}${withPreviewParam(href, home, uuid)}${quote}`,
    );
  });
}
