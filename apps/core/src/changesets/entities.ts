import { schema } from '@pressbase/db';
import type { GlobalStylesConfig } from '@pressbase/theme-json';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { type CurrentUser, userCan } from '../auth/users';
import type { Post, PostInput } from '../content/posts';
import { sanitizePostContent, sanitizePostTitle, sanitizeSlug } from '../content/sanitize';
import type { Kernel } from '../kernel';
import { type SettingDefinition, sanitizeSettingValue } from '../options/settings';
import { rawText } from '../routes/rest-util';
import {
  decodeGlobalStyles,
  GLOBAL_STYLES_POST_TYPE,
  prepareGlobalStyles,
  saveGlobalStyles,
  userGlobalStylesPost,
} from '../themes/global-styles';
import { getBlockTemplates } from '../themes/templates';
import type { ChangesetPreview } from './preview';

/**
 * What a changeset can hold (v0.8, ADR 0022): a small registry of entity
 * handlers, keyed by entity type — WordPress's WP_Customize_Setting
 * subclasses, reduced to four operations.
 *
 * An entry key is `{type}:{id}`: `page:12`, `wp_navigation:5`,
 * `wp_global_styles:pressbase`, `option:blogname`. The handler for `type`
 * validates the value, checks the user may change the entity, writes it
 * inside the publish transaction and lays it over a preview.
 */

/** A value or permission problem with one entry (WordPress's setting validity WP_Error). */
export class ChangesetEntryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ChangesetEntityHandler<V = unknown> {
  /** The entity type: the part of an entry key before the first colon. */
  readonly type: string;
  /** Publish order, lowest first: posts (10), global styles (20), options (30). */
  readonly order: number;
  /**
   * Checks and prepares a value for entity `id`, as `user` writes it
   * (WP_Customize_Setting::validate() and sanitize()): sanitised for that
   * user, so publishing later stores what was checked. Throws ChangesetEntryError.
   */
  validate(kernel: Kernel, id: string, value: unknown, user: CurrentUser): Promise<V>;
  /** Whether `user` may change the entity (WP_Customize_Setting::check_capabilities()). */
  canEdit(kernel: Kernel, id: string, value: V, user: CurrentUser): Promise<boolean>;
  /**
   * Writes the value (WP_Customize_Setting::save()). Runs inside the publish
   * transaction; `author` is who wrote the entry. Throwing rolls back the
   * whole publish.
   */
  apply(kernel: Kernel, id: string, value: V, author: CurrentUser | null): Promise<void>;
  /** Lays the value over a preview (WP_Customize_Setting::preview()). */
  preview(kernel: Kernel, id: string, value: V, preview: ChangesetPreview): Promise<void>;
  /**
   * Entry keys this entry needs written (or previewed) before it: a page
   * placed under a page the same changeset creates. Unknown keys are ignored.
   */
  after?(id: string, value: V): string[];
}

export class ChangesetEntities {
  #handlers = new Map<string, ChangesetEntityHandler>();

  register<V>(handler: ChangesetEntityHandler<V>): void {
    this.#handlers.set(handler.type, handler as ChangesetEntityHandler);
  }

  unregister(type: string): boolean {
    return this.#handlers.delete(type);
  }

  get(type: string): ChangesetEntityHandler | undefined {
    return this.#handlers.get(type);
  }

  types(): string[] {
    return [...this.#handlers.keys()];
  }
}

const KEY = /^([a-z0-9_-]{1,40}):(\S{1,200})$/;

/** Splits an entry key into its entity type and ID. */
export function parseEntryKey(key: string): { type: string; id: string } | undefined {
  const match = KEY.exec(key);
  return match?.[1] && match[2] ? { type: match[1], id: match[2] } : undefined;
}

/**
 * Entries in the order they're written: by handler order, then each after
 * the entries it names in `after()` (a stable topological sort; a loop keeps
 * the given order).
 */
export function orderEntries<
  T extends { key: string; id: string; value: unknown; handler: ChangesetEntityHandler },
>(entries: T[]): T[] {
  const sorted = [...entries].sort((a, b) => a.handler.order - b.handler.order);
  const byKey = new Map(sorted.map((e) => [e.key, e]));
  const out: T[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (entry: T) => {
    if (state.has(entry.key)) return;
    state.set(entry.key, 'visiting');
    for (const key of entry.handler.after?.(entry.id, entry.value) ?? []) {
      const before = byKey.get(key);
      if (before) visit(before);
    }
    state.set(entry.key, 'done');
    out.push(entry);
  };
  for (const entry of sorted) visit(entry);
  return out;
}

/* ------------------------------------------------------------------ posts */

/** A post entry's value: the WordPress REST fields Studio changes. */
const postValue = z
  .object({
    title: rawText.optional(),
    content: rawText.optional(),
    excerpt: rawText.optional(),
    status: z.enum(['publish', 'draft', 'pending', 'private']).optional(),
    slug: z.string().max(200).optional(),
    /** A post ID, or the slug of a post (one this changeset creates, say). */
    parent: z.union([z.number().int().min(0), z.string().min(1).max(200)]).optional(),
    menu_order: z.number().int().optional(),
    /** The custom template (`_wp_page_template`); '' for the default. */
    template: z.string().max(200).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Give at least one field to change.' });

export type PostEntryValue = z.infer<typeof postValue>;

export interface PostEntityOptions {
  /**
   * Finds the post an entry ID names. By default a numeric ID is the post's
   * ID, and anything else its slug (the newest post of the type with it).
   */
  find?: (kernel: Kernel, id: string, type: string) => Promise<Post | undefined>;
  /**
   * Lets an entry name, by slug, a post that doesn't exist yet: publishing
   * creates it (a template customised from a theme file). `terms` gives the
   * new post's terms, by taxonomy, as slugs (a template's `wp_theme`).
   */
  create?: { terms?: (kernel: Kernel) => Promise<Record<string, string[]>> };
}

async function findPost(kernel: Kernel, id: string, type: string): Promise<Post | undefined> {
  if (/^\d+$/.test(id)) {
    const post = await kernel.posts.get(Number(id));
    return post?.type === type ? post : undefined;
  }
  const [post] = await kernel.db
    .select()
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.type, type),
        eq(schema.posts.slug, id),
        notInArray(schema.posts.status, ['trash', 'inherit']),
      ),
    )
    .orderBy(desc(schema.posts.date), desc(schema.posts.id))
    .limit(1);
  return post;
}

function postInput(value: PostEntryValue, parentId?: number | null): PostInput {
  const input: PostInput = {};
  if (value.title !== undefined) input.title = value.title;
  if (value.content !== undefined) input.content = value.content;
  if (value.excerpt !== undefined) input.excerpt = value.excerpt;
  if (value.status !== undefined) input.status = value.status;
  if (value.slug !== undefined) input.slug = value.slug;
  if (parentId !== undefined) input.parentId = parentId || null;
  if (value.menu_order !== undefined) input.menuOrder = value.menu_order;
  return input;
}

/** The meta key holding a post's custom template (get_page_template_slug()). */
export const PAGE_TEMPLATE_META = '_wp_page_template';

/**
 * The templates a post of `type` may choose (WP_Theme::get_page_templates()
 * for a block theme: custom templates for the type), by slug.
 */
async function pageTemplates(kernel: Kernel, type: string): Promise<Set<string>> {
  const templates = await getBlockTemplates(kernel, { post_type: type });
  return new Set(templates.map((t) => t.slug));
}

/** Term IDs for slugs, creating missing terms (for posts a changeset creates). */
async function termIds(
  kernel: Kernel,
  terms: Record<string, string[]>,
): Promise<Record<string, number[]>> {
  const ids: Record<string, number[]> = {};
  for (const [taxonomy, slugs] of Object.entries(terms)) {
    if (!kernel.taxonomies.get(taxonomy)) continue;
    const found = await kernel.terms.list(taxonomy, { slug: slugs, perPage: 100 });
    ids[taxonomy] = [];
    for (const slug of slugs) {
      const term =
        found.terms.find((t) => t.slug === slug) ??
        (await kernel.terms.insert(taxonomy, { name: slug, slug }));
      ids[taxonomy].push(term.id);
    }
  }
  return ids;
}

/**
 * The handler for posts of one type, keyed by post ID (or slug). Core
 * registers it for `page` and `wp_navigation`; templates and template parts
 * register with one line:
 *
 *   kernel.changesets.entities.register(
 *     postEntityHandler('wp_template_part', { find, create: { terms } }),
 *   );
 *
 * Publishing saves through `kernel.posts`, so revisions, hooks and cache
 * purges work as for any save. Edit rights are `edit_post` on the post (and
 * `publish_post` to change its status to published); creating needs the
 * type's `create_posts` and `publish_posts`.
 */
export function postEntityHandler(
  type: string,
  options: PostEntityOptions = {},
): ChangesetEntityHandler<PostEntryValue> {
  const find = options.find ?? findPost;
  const typeOf = (kernel: Kernel) => {
    const postType = kernel.postTypes.get(type);
    if (!postType) throw new ChangesetEntryError('invalid_post_type', 'Invalid post type.');
    return postType;
  };
  return {
    type,
    order: 10,

    async validate(kernel, id, value, user) {
      const postType = typeOf(kernel);
      const parsed = postValue.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ChangesetEntryError(
          'rest_invalid_param',
          `${issue?.path.join('.') || 'value'}: ${issue?.message ?? 'Invalid value.'}`,
        );
      }
      const post = await find(kernel, id, type);
      if (!post) {
        const isSlug = !/^\d+$/.test(id) && sanitizeSlug(id) === id;
        if (!options.create || !isSlug) {
          throw new ChangesetEntryError('rest_post_invalid_id', 'Invalid post ID.');
        }
      }
      const v = { ...parsed.data };
      if (v.parent !== undefined && !postType.hierarchical) delete v.parent;
      if (typeof v.parent === 'string') {
        if (/^\d+$/.test(v.parent)) v.parent = Number(v.parent);
        else if (sanitizeSlug(v.parent) !== v.parent || v.parent === id) {
          throw new ChangesetEntryError('rest_post_invalid_parent', 'Invalid post parent ID.');
        }
      }
      if (v.parent === Number(id)) {
        throw new ChangesetEntryError('rest_post_invalid_parent', 'Invalid post parent ID.');
      }
      if (v.template !== undefined) {
        // check_template(): the default, the post's own, or one the type may choose.
        if (v.template === 'default') v.template = '';
        const current = post
          ? await kernel.meta.get('post', post.id, PAGE_TEMPLATE_META, true)
          : '';
        if (
          v.template &&
          v.template !== current &&
          !(await pageTemplates(kernel, type)).has(v.template)
        ) {
          throw new ChangesetEntryError(
            'rest_invalid_param',
            `template is not one of ${[...(await pageTemplates(kernel, type))].join(', ')}.`,
          );
        }
      }
      if (v.slug !== undefined) v.slug = sanitizeSlug(v.slug);
      if (!userCan(user, 'unfiltered_html')) {
        if (v.title !== undefined) v.title = sanitizePostTitle(v.title);
        if (v.excerpt !== undefined) v.excerpt = sanitizePostTitle(v.excerpt);
        if (v.content !== undefined) v.content = sanitizePostContent(v.content);
      }
      return v;
    },

    async canEdit(kernel, id, value, user) {
      const postType = typeOf(kernel);
      const post = await find(kernel, id, type);
      if (!post) {
        return (
          userCan(user, postType.cap.create_posts) && userCan(user, postType.cap.publish_posts)
        );
      }
      if (!(await currentUserCan(kernel, user, 'edit_post', post.id))) return false;
      const publishing = value.status === 'publish' || value.status === 'private';
      if (publishing && post.status !== value.status) {
        return currentUserCan(kernel, user, 'publish_post', post.id);
      }
      return true;
    },

    async apply(kernel, id, value, author) {
      let parentId: number | undefined;
      if (typeof value.parent === 'string') {
        // A page placed under one the changeset creates: written first (after()).
        const parent = await find(kernel, value.parent, type);
        if (!parent) {
          throw new ChangesetEntryError('rest_post_invalid_parent', 'Invalid post parent ID.');
        }
        parentId = parent.id;
      } else if (value.parent !== undefined) {
        parentId = value.parent;
      }
      const input = postInput(value, parentId);
      // The value was sanitised for its author when it was written; publishing
      // filters it again for an author without unfiltered_html, as wp_insert_post() would.
      input.filterHtml = !userCan(author, 'unfiltered_html');
      const setTemplate = async (postId: number) => {
        if (value.template === undefined) return;
        // update_post_meta( $post_id, '_wp_page_template', … ), as WP_REST_Posts_Controller::handle_template() does.
        if (value.template)
          await kernel.meta.update('post', postId, PAGE_TEMPLATE_META, value.template);
        else await kernel.meta.delete('post', postId, PAGE_TEMPLATE_META);
      };
      const post = await find(kernel, id, type);
      if (post) {
        const { filterHtml: _filter, ...fields } = input;
        if (Object.keys(fields).length) await kernel.posts.update(post.id, input);
        await setTemplate(post.id);
        return;
      }
      // Only an entry named by slug creates a post; a missing ID is a deleted post.
      if (!options.create || /^\d+$/.test(id))
        throw new ChangesetEntryError('rest_post_invalid_id', 'Invalid post ID.');
      const terms = options.create.terms
        ? await termIds(kernel, await options.create.terms(kernel))
        : {};
      const created = await kernel.posts.insert(type, {
        ...input,
        title: input.title ?? id,
        slug: id,
        status: input.status ?? 'publish',
        authorId: author?.id ?? null,
        terms,
      });
      await setTemplate(created.id);
    },

    after(_id, value) {
      return typeof value.parent === 'string' ? [`${type}:${value.parent}`] : [];
    },

    async preview(kernel, id, value, preview) {
      const post = await find(kernel, id, type);
      let parentId: number | undefined;
      if (typeof value.parent === 'string') {
        const slug = value.parent;
        const created = [...preview.created.values()].find(
          (c) => c.post.type === type && c.post.slug === slug,
        );
        parentId = created?.post.id ?? (await find(kernel, slug, type))?.id;
      } else if (value.parent !== undefined) {
        parentId = value.parent;
      }
      const input = postInput(value, parentId);
      if (post) {
        if (value.template !== undefined) preview.templates.set(post.id, value.template);
        preview.posts.set(post.id, {
          ...(preview.posts.get(post.id) ?? post),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.slug ? { slug: input.slug } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.menuOrder !== undefined ? { menuOrder: input.menuOrder } : {}),
          modified: new Date(),
        });
        return;
      }
      if (!options.create || /^\d+$/.test(id)) return;
      const now = new Date();
      const previewId = preview.nextId();
      if (value.template !== undefined) preview.templates.set(previewId, value.template);
      preview.created.set(previewId, {
        post: {
          id: previewId,
          authorId: preview.user.id,
          date: now,
          modified: now,
          content: input.content ?? '',
          title: input.title ?? id,
          excerpt: input.excerpt ?? '',
          status: input.status ?? 'publish',
          commentStatus: 'closed',
          pingStatus: 'closed',
          password: '',
          slug: id,
          contentFiltered: '',
          parentId: input.parentId ?? null,
          guid: '',
          menuOrder: input.menuOrder ?? 0,
          type,
          mimeType: '',
          commentCount: 0,
        },
        terms: options.create.terms ? await options.create.terms(kernel) : {},
      });
    },
  };
}

/* ---------------------------------------------------------- global styles */

/**
 * User global styles, keyed by theme: `wp_global_styles:{stylesheet}`. The
 * value is what POST /wp/v2/global-styles/{id} takes (`styles`, `settings`),
 * prepared as that endpoint prepares it; `edit_theme_options` (the post
 * type's capabilities) is needed.
 */
export function globalStylesEntityHandler(): ChangesetEntityHandler<GlobalStylesConfig> {
  return {
    type: GLOBAL_STYLES_POST_TYPE,
    order: 20,

    async validate(kernel, id, value, user) {
      if (!(await kernel.themes.get(id))) {
        throw new ChangesetEntryError('rest_theme_not_found', 'Theme not found.');
      }
      const request = z
        .object({ styles: z.unknown().optional(), settings: z.unknown().optional() })
        .strict()
        .safeParse(value);
      if (!request.success) {
        throw new ChangesetEntryError('rest_invalid_param', 'Give `styles` and/or `settings`.');
      }
      const post = await userGlobalStylesPost(kernel, id);
      const existing: GlobalStylesConfig = post
        ? decodeGlobalStyles(post.content)
        : { version: 3, isGlobalStylesUserThemeJSON: true };
      const prepared = prepareGlobalStyles(kernel, user, existing, request.data);
      if (!prepared.ok) throw new ChangesetEntryError(prepared.code, prepared.message);
      return prepared.config;
    },

    async canEdit(_kernel, _id, _value, user) {
      return userCan(user, 'edit_theme_options');
    },

    async apply(kernel, id, config, author) {
      const post = await userGlobalStylesPost(kernel, id, true);
      if (!post) throw new ChangesetEntryError('rest_global_styles_not_found', 'No global styles.');
      await saveGlobalStyles(kernel, post, config, undefined, author?.id);
    },

    async preview(kernel, id, config, preview) {
      if (id === (await kernel.themes.activeStylesheet())) preview.globalStyles = config;
    },
  };
}

/* ---------------------------------------------------------------- options */

/**
 * The options a changeset may change: the site's identity and front page,
 * and the header menu — what the Customizer's Site Identity, Homepage
 * Settings and Menus panels change. Each needs its setting's capability
 * (`manage_options`), or `edit_theme_options` for the menu.
 */
export const CHANGESET_OPTIONS = [
  'blogname',
  'blogdescription',
  'show_on_front',
  'page_on_front',
  'page_for_posts',
  'site_logo',
  'site_icon',
  'pressbase_navigation_fallback',
] as const;

/** Settings the registry doesn't expose over REST but a changeset may change. */
const EXTRA_SETTINGS: Record<string, SettingDefinition> = {
  pressbase_navigation_fallback: {
    option: 'pressbase_navigation_fallback',
    schema: z.number().int().min(0),
    default: 0,
    capability: 'edit_theme_options',
  },
};

function settingFor(kernel: Kernel, option: string): SettingDefinition | undefined {
  for (const [, setting] of kernel.settings.entries())
    if (setting.option === option) return setting;
  return EXTRA_SETTINGS[option];
}

/**
 * Options holding a post ID that an entry may give as the slug of a post
 * instead, such as a page the same changeset creates (the site builder's
 * home page and menu): the ID is looked up when the entry is published or
 * previewed, after the post's own entry (`after()`).
 */
export const POST_ID_OPTIONS: Record<string, string> = {
  page_on_front: 'page',
  page_for_posts: 'page',
  pressbase_navigation_fallback: 'wp_navigation',
};

const slugRef = (id: string, value: unknown): string | undefined =>
  POST_ID_OPTIONS[id] && typeof value === 'string' && !/^\d+$/.test(value) ? value : undefined;

/** Options on the allow-list, keyed by option name: `option:blogname`. */
export function optionEntityHandler(allowed: ReadonlySet<string>): ChangesetEntityHandler<unknown> {
  const setting = (kernel: Kernel, id: string) => {
    const found = allowed.has(id) ? settingFor(kernel, id) : undefined;
    if (!found) {
      throw new ChangesetEntryError(
        'changeset_option_not_allowed',
        'This option can’t be changed in a changeset.',
      );
    }
    return found;
  };
  return {
    type: 'option',
    order: 30,

    async validate(kernel, id, value) {
      const definition = setting(kernel, id);
      const slug = slugRef(id, value);
      if (slug !== undefined) {
        if (sanitizeSlug(slug) !== slug) {
          throw new ChangesetEntryError('rest_invalid_param', 'Give a post ID or a post’s slug.');
        }
        return slug;
      }
      const parsed = definition.schema.safeParse(value);
      if (!parsed.success) {
        throw new ChangesetEntryError(
          'rest_invalid_param',
          parsed.error.issues[0]?.message ?? 'Invalid value.',
        );
      }
      try {
        return definition.sanitize ? await definition.sanitize(parsed.data, id) : parsed.data;
      } catch (error) {
        throw new ChangesetEntryError(
          'rest_invalid_param',
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    async canEdit(kernel, id, _value, user) {
      return userCan(user, setting(kernel, id).capability);
    },

    async apply(kernel, id, value) {
      let stored = value;
      const slug = slugRef(id, value);
      if (slug !== undefined) {
        // Written after the post's entry, so a post the changeset creates exists by now.
        const post = await findPost(kernel, slug, POST_ID_OPTIONS[id] as string);
        if (!post) throw new ChangesetEntryError('rest_post_invalid_id', 'Invalid post ID.');
        stored = post.id;
      }
      // update_option(): sanitize_option() and the pre_update_option filters run now.
      const next = await sanitizeSettingValue(kernel, setting(kernel, id), stored);
      await kernel.options.set(id, next);
    },

    after(id, value) {
      const slug = slugRef(id, value);
      return slug === undefined ? [] : [`${POST_ID_OPTIONS[id]}:${slug}`];
    },

    async preview(kernel, id, value, preview) {
      const slug = slugRef(id, value);
      if (slug === undefined) {
        preview.options.set(id, value);
        return;
      }
      const type = POST_ID_OPTIONS[id] as string;
      const created = [...preview.created.values()].find(
        (c) => c.post.type === type && c.post.slug === slug,
      );
      const postId = created?.post.id ?? (await findPost(kernel, slug, type))?.id;
      if (postId !== undefined) preview.options.set(id, postId);
    },
  };
}
