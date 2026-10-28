import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { schema } from '@pressbase/db';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { type CurrentUser, userCan } from '../auth/users';
import { siteInfo, termLink } from '../blocks/helpers';
import { ksesComment, relUgc } from '../comments/format';
import { parseRestDate } from '../content/dates';
import { permalink, permalinkContext } from '../content/permalinks';
import type { Post } from '../content/posts';
import type { Kernel } from '../kernel';
import { fileUrl, MediaError, maxUploadBytes, setMeta, uploadAttachment } from '../media/service';
import { insertUser, UserError } from '../people/users';
import { type ClassicMenuItem, convertClassicMenu, menuItemFromPost, type ResolvedTarget } from './menus';
import { maybeUnserialize } from './php-serialize';
import type {
  ImportAuthor,
  ImportComment,
  ImportMeta,
  ImportPost,
  ImportPostTerm,
  ImportRecord,
  ImportSite,
  ImportSource,
  ImportTerm,
} from './records';
import { ZERO_DATE } from './records';
import { type FetchOptions, fetchRemoteFile, type RemoteFile, RemoteFileError } from './remote-file';
import { createRewriter } from './rewrite';

/**
 * The import writer: takes WordPress-shaped records from any source and
 * writes them into the site. It is the WordPress Importer plugin's WP_Import
 * (process_authors, process_categories/tags/terms, process_posts,
 * process_menu_item, process_attachment, backfill_parents,
 * backfill_attachment_urls, remap_featured_images), reorganised to stream:
 * records are written as they arrive, and whatever refers forward (a post's
 * parent, a featured image, a menu item's target, a term's parent) is
 * resolved in finish().
 *
 *   const writer = new ImportWriter(kernel, { user });
 *   await writer.begin();
 *   for await (const record of source.records()) await writer.write(record);
 *   const report = await writer.finish();
 *
 * or simply `runImport(kernel, source, options)`.
 *
 * Re-running an import is safe: a post that already exists (same type and
 * date, and the same title or guid; WordPress's post_exists() matches title,
 * date and type) is skipped and reported, and so are existing terms, users,
 * comments (same post, author and date) and menus (same name).
 */

declare module '@pressbase/hooks' {
  interface ActionRegistry {
    /** An import begins (WP_Import::import_start()). */
    import_start: [];
    /** An import has finished writing (WP_Import::import_end()). */
    import_end: [];
    /** After import_end, with the importer's name, as WordPress's importers fire it. */
    import_done: [importer: string];
    /** A post was created (after wp_insert_post), with its ID in the source. */
    wp_import_insert_post: [
      postId: number,
      originalPostId: number,
      postdata: ImportPostData,
      post: ImportPost,
    ];
    /** A post's terms were set. */
    wp_import_set_post_terms: [
      ttIds: number[],
      termIds: number[],
      taxonomy: string,
      postId: number,
      post: ImportPost,
    ];
    /** A term was created while setting a post's terms. */
    wp_import_insert_term: [
      term: { term_id: number },
      postTerm: ImportPostTerm,
      postId: number,
      post: ImportPost,
    ];
    /** A comment was created. */
    wp_import_insert_comment: [
      commentId: number,
      comment: ImportComment,
      postId: number,
      post: ImportPost,
    ];
    /** A post meta row was added. */
    import_post_meta: [postId: number, key: string, value: unknown];
    /** A term meta row was added. */
    import_term_meta: [termId: number, key: string, value: unknown];
  }
  interface FilterRegistry {
    /** The post as read from the source, before anything else (WP_Import::process_posts()). */
    wp_import_post_data_raw: [post: ImportPost];
    /** The ID of an existing post that matches, or 0 to import it anyway. */
    wp_import_existing_post: [postId: number, post: ImportPost];
    /** The fields about to be saved. */
    wp_import_post_data_processed: [postdata: ImportPostData, post: ImportPost];
    wp_import_post_terms: [terms: ImportPostTerm[], postId: number, post: ImportPost];
    wp_import_post_comments: [comments: ImportComment[], postId: number, post: ImportPost];
    wp_import_post_meta: [meta: ImportMeta[], postId: number, post: ImportPost];
    /** Return an empty string to skip the meta row. */
    import_post_meta_key: [key: string, postId: number, post: ImportPost];
    wp_import_term_meta: [meta: ImportMeta[], termId: number, term: ImportTerm];
    import_term_meta_key: [key: string, termId: number, term: ImportTerm];
    /** May the importer create users for authors? (Also needs `create_users`.) */
    import_allow_create_users: [allow: boolean];
    /** May the importer download attachments? (Also needs `upload_files`.) */
    import_allow_fetch_attachments: [allow: boolean];
    /** Largest attachment to download, in bytes; 0 means the upload limit. */
    import_attachment_size_limit: [bytes: number];
    /** True lets a host on a private network be downloaded from (wp_http_validate_url()). */
    http_request_host_is_external: [external: boolean, host: string, url: string];
  }
}

/** The fields the writer saves for a post: WordPress's $postdata, in Pressbase's names. */
export interface ImportPostData {
  import_id: number;
  post_author: number;
  post_date: Date;
  post_modified: Date | undefined;
  post_content: string;
  post_excerpt: string;
  post_title: string;
  post_status: string;
  post_name: string;
  comment_status: 'open' | 'closed';
  ping_status: 'open' | 'closed';
  guid: string;
  post_parent: number | null;
  menu_order: number;
  post_type: string;
  post_password: string;
}

/** How to handle one author: map them to a user, or create a user. */
export type AuthorChoice =
  | { action: 'map'; userId: number }
  | { action: 'create'; login?: string };

export interface ImportOptions {
  /** Who runs the import: their capabilities decide what's allowed, and unmapped posts are theirs. */
  user: CurrentUser;
  /** Per author login. Without a choice: an existing user with the same login, else a new user. */
  authors?: Record<string, AuthorChoice>;
  /** "Download and import file attachments". Default false. */
  fetchAttachments?: boolean;
  /** Download from private network addresses (PRESSBASE_IMPORT_ALLOW_PRIVATE_HOSTS). */
  allowPrivateHosts?: boolean;
  /** Rewrite old URLs and IDs in imported content. Default true. */
  rewriteContent?: boolean;
  /** How many posts the source holds, for progress. */
  total?: number;
  /** Called with progress at most every `progressIntervalMs` (default 1000), and at the end. */
  onProgress?: (progress: ImportProgress) => void | Promise<void>;
  progressIntervalMs?: number;
  signal?: AbortSignal;
  /** Replaces the downloader (tests). */
  fetchFile?: (url: string, options: FetchOptions) => Promise<RemoteFile>;
}

export interface ImportProgress {
  phase: 'importing' | 'finishing' | 'done';
  /** Posts read so far (every type). */
  done: number;
  total: number;
  /** The post being imported. */
  current: string;
}

export type ReportKind = 'author' | 'term' | 'post' | 'attachment' | 'comment' | 'menu' | 'meta';

export interface ReportItem {
  kind: ReportKind;
  /** What it was called: a title, a name or a login. */
  title: string;
  /** Post type or taxonomy. */
  type?: string;
  /** Its ID in the source. */
  id?: number;
  /** A machine-readable code (exists, invalid_post_type, …). */
  code: string;
  /** What happened, in plain words. */
  reason: string;
}

export interface ImportReport {
  imported: {
    /** Users created for authors. */
    users: number;
    terms: number;
    /** Posts created, per post type (attachments included). */
    posts: Record<string, number>;
    comments: number;
    menus: number;
  };
  /** Items left out on purpose: already there, a type this site doesn't have, attachments not downloaded. */
  skipped: { total: number; items: ReportItem[] };
  /** Items that failed. */
  errors: { total: number; items: ReportItem[] };
  /** Posts whose type isn't registered here, per type (WordPress: "Invalid post type"). */
  skippedPostTypes: Record<string, number>;
  /** Post terms whose taxonomy isn't registered here, per taxonomy. */
  skippedTaxonomies: Record<string, number>;
  /** How each author was handled: login → user ID. */
  authors: Record<string, number>;
  site: ImportSite | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Each list keeps this many entries; the totals count everything. */
const REPORT_LIMIT = 200;
/** Meta keys that are never copied (wxr_filter_postmeta(), and what the upload recreates). */
const SKIPPED_META = new Set(['_edit_lock']);
const ATTACHMENT_FILE_META = new Set(['_wp_attached_file', '_wp_attachment_metadata']);
const STATUSES = new Set(['publish', 'future', 'draft', 'pending', 'private', 'trash']);

export class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function emptyReport(): ImportReport {
  return {
    imported: { users: 0, terms: 0, posts: {}, comments: 0, menus: 0 },
    skipped: { total: 0, items: [] },
    errors: { total: 0, items: [] },
    skippedPostTypes: {},
    skippedTaxonomies: {},
    authors: {},
    site: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

/**
 * Dates match to the second: WXR (MySQL's DATETIME) has no fractions, so a
 * Pressbase post saved at 10:00:00.123 comes back from its own export as 10:00:00.
 */
function sameSecond(column: AnyPgColumn, date: Date) {
  const second = new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString();
  return sql`date_trunc('second', ${column}) = ${second}::timestamptz`;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class ImportWriter {
  readonly report: ImportReport = emptyReport();
  #site: ImportSite | null = null;
  #timeZone = 'UTC';
  #home = '';
  #filterHtml = false;
  #canCreateUsers = false;
  #canFetch = false;
  #maxAttachmentBytes = 0;
  /** author login → user ID; author_id (source) → user ID. */
  #authorsByLogin = new Map<string, number>();
  #authorsById = new Map<number, number>();
  #authorRecords = new Map<string, ImportAuthor>();
  /** Source term ID → term ID here (term IDs are unique across taxonomies since WordPress 4.2). */
  #terms = new Map<number, number>();
  #termsBySlug = new Map<string, number>();
  #pendingTermParents: { taxonomy: string; termId: number; parentSlug: string }[] = [];
  /** Source post ID → post ID here, attachments included. */
  #posts = new Map<number, number>();
  /** Posts created by this run (for the content rewrite). */
  #created: number[] = [];
  #orphans: [postId: number, oldParent: number][] = [];
  #featured: [postId: number, oldAttachment: number][] = [];
  #sticky: number[] = [];
  #urls = new Map<string, string>();
  #sizePrefixes = new Map<string, string>();
  #menus = new Map<string, string>();
  #menuItems: ClassicMenuItem[] = [];
  #done = 0;
  #current = '';
  #lastProgress = 0;
  #begun = false;

  constructor(
    private readonly kernel: Kernel,
    private readonly options: ImportOptions,
  ) {}

  /** WP_Import::import_start(): checks what this user may do and fires `import_start`. */
  async begin(): Promise<void> {
    if (this.#begun) return;
    this.#begun = true;
    const { kernel, options } = this;
    const user = options.user;
    if (!userCan(user, 'import')) {
      throw new ImportError('import_forbidden', 'Sorry, you are not allowed to import content into this site.');
    }
    this.#timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
    this.#home = (await kernel.options.get<string>('home', '')).replace(/\/+$/, '');
    this.#filterHtml = !userCan(user, 'unfiltered_html');
    this.#canCreateUsers =
      userCan(user, 'create_users') &&
      Boolean(await kernel.hooks.applyFilters('import_allow_create_users', true));
    this.#canFetch =
      Boolean(options.fetchAttachments) &&
      userCan(user, 'upload_files') &&
      Boolean(await kernel.hooks.applyFilters('import_allow_fetch_attachments', true));
    const limit = Number(await kernel.hooks.applyFilters('import_attachment_size_limit', 0));
    const max = maxUploadBytes(kernel);
    this.#maxAttachmentBytes = limit > 0 ? Math.min(limit, max) : max;
    await kernel.hooks.doAction('import_start');
  }

  /** Writes one record. Records must come in source order: site, authors, terms, posts. */
  async write(record: ImportRecord): Promise<void> {
    if (!this.#begun) await this.begin();
    this.options.signal?.throwIfAborted();
    switch (record.kind) {
      case 'site':
        this.#site = record.site;
        this.report.site = record.site;
        return;
      case 'author':
        this.#authorRecords.set(record.author.author_login, record.author);
        await this.#author(record.author.author_login);
        return;
      case 'term':
        await this.#term(record.term);
        return;
      case 'post':
        this.#done += 1;
        this.#current = record.post.post_title || `#${record.post.post_id}`;
        try {
          await this.#post(record.post);
        } catch (error) {
          if (this.options.signal?.aborted) throw error;
          this.#error({
            kind: record.post.post_type === 'attachment' ? 'attachment' : 'post',
            title: this.#current,
            type: record.post.post_type,
            id: record.post.post_id,
            code: (error as { code?: string }).code ?? 'import_post_failed',
            reason: describe(error),
          });
        }
        await this.#progress('importing');
        return;
    }
  }

  /** Resolves everything that referred forward, rewrites content and fires `import_end`. */
  async finish(): Promise<ImportReport> {
    if (!this.#begun) await this.begin();
    await this.#progress('finishing', true);
    await this.#backfillTermParents();
    await this.#backfillParents();
    await this.#remapFeaturedImages();
    await this.#stickPosts();
    if (this.options.rewriteContent !== false) await this.#rewriteContent();
    await this.#importMenus();
    // Direct writes (parents, rewritten content) skip the per-post hooks; one
    // site-wide purge covers them, as WordPress's wp_cache_flush() does.
    await this.kernel.hooks.doAction('pressbase_cache_purge', ['site'], 'import');
    await this.kernel.hooks.doAction('import_end');
    await this.kernel.hooks.doAction('import_done', 'wordpress');
    this.report.finishedAt = new Date().toISOString();
    await this.#progress('done', true);
    return this.report;
  }

  /* --------------------------------------------------------------- report */

  #skip(item: ReportItem): void {
    this.report.skipped.total += 1;
    if (this.report.skipped.items.length < REPORT_LIMIT) this.report.skipped.items.push(item);
  }

  #error(item: ReportItem): void {
    this.report.errors.total += 1;
    if (this.report.errors.items.length < REPORT_LIMIT) this.report.errors.items.push(item);
  }

  #countPost(type: string): void {
    this.report.imported.posts[type] = (this.report.imported.posts[type] ?? 0) + 1;
  }

  async #progress(phase: ImportProgress['phase'], force = false): Promise<void> {
    const { onProgress, progressIntervalMs = 1000, total } = this.options;
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - this.#lastProgress < progressIntervalMs) return;
    this.#lastProgress = now;
    await onProgress({
      phase,
      done: this.#done,
      total: Math.max(total ?? 0, this.#done),
      current: phase === 'importing' ? this.#current : '',
    });
  }

  /* -------------------------------------------------------------- authors */

  /**
   * WP_Import::get_author_mapping(): the user an author's posts go to. Their
   * choice first; then an existing user with the same login; then a new user
   * (when allowed); then the person running the import.
   */
  async #author(login: string): Promise<number> {
    const known = this.#authorsByLogin.get(login);
    if (known !== undefined) return known;
    const record = this.#authorRecords.get(login);
    const choice = this.options.authors?.[login];
    let userId: number | undefined;

    if (choice?.action === 'map') {
      userId = await this.#userId(eq(schema.users.id, choice.userId));
      if (!userId) {
        this.#error({
          kind: 'author',
          title: login,
          code: 'invalid_user',
          reason: `The user chosen for ${login} doesn’t exist; their posts are yours.`,
        });
      }
    } else {
      const wantedLogin = (choice?.action === 'create' && choice.login?.trim()) || login;
      userId = await this.#userId(sql`lower(${schema.users.login}) = ${wantedLogin.toLowerCase()}`);
      if (userId) {
        this.#skip({ kind: 'author', title: wantedLogin, code: 'exists', reason: 'A user with this username already exists.' });
      } else if (!this.#canCreateUsers) {
        if (choice?.action === 'create') {
          this.#error({
            kind: 'author',
            title: login,
            code: 'import_cannot_create_users',
            reason: 'You can’t create users here, so their posts are yours.',
          });
        }
      } else {
        userId = await this.#createUser(wantedLogin, record);
      }
    }

    const id = userId ?? this.options.user.id;
    this.#authorsByLogin.set(login, id);
    this.report.authors[login] = id;
    if (record?.author_id) this.#authorsById.set(record.author_id, id);
    return id;
  }

  async #userId(condition: ReturnType<typeof eq>): Promise<number | undefined> {
    const [row] = await this.kernel.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(condition)
      .limit(1);
    return row?.id;
  }

  async #createUser(login: string, record: ImportAuthor | undefined): Promise<number | undefined> {
    const email = record?.author_email?.trim() ?? '';
    if (email) {
      const existing = await this.#userId(sql`lower(${schema.users.email}) = ${email.toLowerCase()}`);
      if (existing) {
        this.#skip({
          kind: 'author',
          title: login,
          code: 'exists',
          reason: `A user with the email address ${email} already exists; their posts are theirs.`,
        });
        return existing;
      }
    }
    if (!email) {
      this.#error({
        kind: 'author',
        title: login,
        code: 'import_user_no_email',
        reason: 'The export has no email address for this author, so no user was created; their posts are yours.',
      });
      return undefined;
    }
    try {
      const user = await insertUser(this.kernel, {
        username: login,
        email,
        password: randomBytes(24).toString('base64url'),
        name: record?.author_display_name || login,
        first_name: record?.author_first_name ?? '',
        last_name: record?.author_last_name ?? '',
      });
      this.report.imported.users += 1;
      return user.id;
    } catch (error) {
      this.#error({
        kind: 'author',
        title: login,
        code: error instanceof UserError ? error.code : 'import_user_failed',
        reason: `Couldn’t create a user for ${login} (${describe(error)}); their posts are yours.`,
      });
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- terms */

  async #findTerm(taxonomy: string, slug: string): Promise<number | undefined> {
    const key = `${taxonomy}:${slug}`;
    const cached = this.#termsBySlug.get(key);
    if (cached) return cached;
    const [row] = await this.kernel.db
      .select({ id: schema.terms.id })
      .from(schema.terms)
      .innerJoin(schema.termTaxonomy, eq(schema.termTaxonomy.termId, schema.terms.id))
      .where(and(eq(schema.terms.slug, slug), eq(schema.termTaxonomy.taxonomy, taxonomy)))
      .limit(1);
    if (row) this.#termsBySlug.set(key, row.id);
    return row?.id;
  }

  /** process_categories(), process_tags(), process_terms() for one term. */
  async #term(term: ImportTerm): Promise<void> {
    const taxonomy = term.term_taxonomy;
    if (taxonomy === 'nav_menu') {
      // Classic menus: converted into wp_navigation posts in finish().
      this.#menus.set(term.slug, term.term_name || term.slug);
      return;
    }
    const label = term.term_name || term.slug;
    if (!this.kernel.taxonomies.get(taxonomy)) {
      this.#skip({
        kind: 'term',
        title: label,
        type: taxonomy,
        id: term.term_id,
        code: 'invalid_taxonomy',
        reason: `This site has no “${taxonomy}” taxonomy.`,
      });
      return;
    }
    const existing = term.slug ? await this.#findTerm(taxonomy, term.slug) : undefined;
    if (existing) {
      if (term.term_id) this.#terms.set(term.term_id, existing);
      this.#skip({ kind: 'term', title: label, type: taxonomy, id: term.term_id, code: 'exists', reason: 'Already exists.' });
      return;
    }
    const hierarchical = this.kernel.taxonomies.get(taxonomy)?.hierarchical ?? false;
    const parent =
      hierarchical && term.term_parent ? await this.#findTerm(taxonomy, term.term_parent) : undefined;
    try {
      const created = await this.kernel.terms.insert(taxonomy, {
        name: label,
        slug: term.slug,
        description: term.term_description,
        parent,
      });
      this.#termsBySlug.set(`${taxonomy}:${created.slug}`, created.id);
      if (term.term_id) this.#terms.set(term.term_id, created.id);
      if (hierarchical && term.term_parent && !parent) {
        this.#pendingTermParents.push({ taxonomy, termId: created.id, parentSlug: term.term_parent });
      }
      this.report.imported.terms += 1;
      await this.#termMeta(created.id, term);
    } catch (error) {
      this.#error({
        kind: 'term',
        title: label,
        type: taxonomy,
        id: term.term_id,
        code: (error as { code?: string }).code ?? 'import_term_failed',
        reason: describe(error),
      });
    }
  }

  /** WP_Import::process_termmeta() */
  async #termMeta(termId: number, term: ImportTerm): Promise<void> {
    const list = await this.kernel.hooks.applyFilters('wp_import_term_meta', term.termmeta, termId, term);
    const rows: { termId: number; key: string; value: unknown }[] = [];
    for (const meta of list ?? []) {
      const key = await this.kernel.hooks.applyFilters('import_term_meta_key', meta.key, termId, term);
      if (!key) continue;
      rows.push({ termId, key, value: maybeUnserialize(meta.value) });
    }
    if (!rows.length) return;
    await this.kernel.db.insert(schema.termmeta).values(rows);
    for (const row of rows) await this.kernel.hooks.doAction('import_term_meta', termId, row.key, row.value);
  }

  async #backfillTermParents(): Promise<void> {
    for (const { taxonomy, termId, parentSlug } of this.#pendingTermParents) {
      const parent = await this.#findTerm(taxonomy, parentSlug);
      if (!parent || parent === termId) continue;
      try {
        await this.kernel.terms.update(taxonomy, termId, { parent });
      } catch {
        // A loop or a vanished term: leave it at the top level.
      }
    }
  }

  /* ---------------------------------------------------------------- posts */

  #date(local: string, gmt: string): Date | undefined {
    if (gmt && gmt !== ZERO_DATE) {
      const date = parseRestDate(gmt, 'UTC', true);
      if (date) return date;
    }
    if (local && local !== ZERO_DATE) return parseRestDate(local, this.#timeZone, false);
    return undefined;
  }

  /** post_exists(): same type and date, and the same title or guid. */
  async #existing(post: ImportPost, date: Date): Promise<number> {
    const p = schema.posts;
    const [row] = await this.kernel.db
      .select({ id: p.id })
      .from(p)
      .where(
        and(
          eq(p.type, post.post_type),
          sameSecond(p.date, date),
          post.guid
            ? or(eq(p.title, post.post_title), eq(p.guid, post.guid))
            : eq(p.title, post.post_title),
        ),
      )
      .limit(1);
    return row?.id ?? 0;
  }

  async #post(raw: ImportPost): Promise<void> {
    const { kernel } = this;
    const post = (await kernel.hooks.applyFilters('wp_import_post_data_raw', raw)) as ImportPost;
    const type = post.post_type;
    const title = post.post_title || `#${post.post_id}`;

    if (type === 'nav_menu_item') {
      const item = menuItemFromPost(post);
      if (item) this.#menuItems.push(item);
      return;
    }
    if (!kernel.postTypes.get(type) || type === 'revision') {
      this.report.skippedPostTypes[type] = (this.report.skippedPostTypes[type] ?? 0) + 1;
      this.#skip({
        kind: 'post',
        title,
        type,
        id: post.post_id,
        code: 'invalid_post_type',
        reason: `This site has no “${type}” post type. A plugin that adds it may help.`,
      });
      return;
    }
    if (post.status === 'auto-draft') return;

    const date = this.#date(post.post_date, post.post_date_gmt) ?? new Date();
    const existing = Number(
      await kernel.hooks.applyFilters('wp_import_existing_post', await this.#existing(post, date), post),
    );
    if (existing) {
      const found = await kernel.posts.get(existing);
      if (found && found.type === type) {
        this.#posts.set(post.post_id, existing);
        this.#skip({
          kind: type === 'attachment' ? 'attachment' : 'post',
          title,
          type,
          id: post.post_id,
          code: 'exists',
          reason: 'Already exists.',
        });
        // New comments on an existing post still come in (comment_exists() skips the rest).
        await this.#comments(found, post);
        return;
      }
    }

    const authorId = post.post_author ? await this.#author(post.post_author) : this.options.user.id;
    let parentId: number | null = null;
    if (post.post_parent) {
      const mapped = this.#posts.get(post.post_parent);
      if (mapped) parentId = mapped;
    }

    const postdata = (await kernel.hooks.applyFilters(
      'wp_import_post_data_processed',
      {
        import_id: post.post_id,
        post_author: authorId,
        post_date: date,
        post_modified: this.#date(post.post_modified, post.post_modified_gmt),
        post_content: post.post_content,
        post_excerpt: post.post_excerpt,
        post_title: post.post_title,
        post_status: STATUSES.has(post.status) ? post.status : 'draft',
        post_name: post.post_name,
        comment_status: post.comment_status === 'open' ? 'open' : 'closed',
        ping_status: post.ping_status === 'open' ? 'open' : 'closed',
        guid: post.guid,
        post_parent: parentId,
        menu_order: post.menu_order,
        post_type: type,
        post_password: post.post_password,
      } satisfies ImportPostData,
      post,
    )) as ImportPostData;

    let created: Post | undefined;
    if (type === 'attachment') {
      created = await this.#attachment(post, postdata);
      if (!created) return;
    } else {
      created = await kernel.posts.insert(type, {
        title: postdata.post_title,
        content: postdata.post_content,
        excerpt: postdata.post_excerpt,
        status: postdata.post_status,
        slug: postdata.post_name,
        date: postdata.post_date,
        authorId: postdata.post_author,
        parentId: postdata.post_parent,
        menuOrder: postdata.menu_order,
        commentStatus: postdata.comment_status,
        pingStatus: postdata.ping_status,
        password: postdata.post_password,
        filterHtml: this.#filterHtml,
        saveRevision: false,
      });
      // The original guid, as WP_Import passes it to wp_insert_post(), and the modified date.
      const set: Partial<typeof schema.posts.$inferInsert> = {};
      if (postdata.guid) set.guid = postdata.guid.slice(0, 255);
      if (postdata.post_modified) set.modified = postdata.post_modified;
      if (Object.keys(set).length) {
        await kernel.db.update(schema.posts).set(set).where(eq(schema.posts.id, created.id));
      }
    }

    const id = created.id;
    this.#posts.set(post.post_id, id);
    this.#created.push(id);
    this.#countPost(type);
    if (post.post_parent && !parentId) this.#orphans.push([id, post.post_parent]);
    if (post.is_sticky && type === 'post') this.#sticky.push(id);
    await kernel.hooks.doAction('wp_import_insert_post', id, post.post_id, postdata, post);

    await this.#postTerms(id, post);
    await this.#comments(created, post);
    await this.#postMeta(id, post);
  }

  /** The terms block of process_posts(): finds or creates each term, then sets them per taxonomy. */
  async #postTerms(postId: number, post: ImportPost): Promise<void> {
    const terms = await this.kernel.hooks.applyFilters('wp_import_post_terms', post.terms, postId, post);
    const byTaxonomy = new Map<string, number[]>();
    for (const term of terms ?? []) {
      const taxonomy = term.domain === 'tag' ? 'post_tag' : term.domain;
      const tax = this.kernel.taxonomies.get(taxonomy);
      if (!tax) {
        this.report.skippedTaxonomies[taxonomy] = (this.report.skippedTaxonomies[taxonomy] ?? 0) + 1;
        continue;
      }
      const slug = term.slug || term.name;
      let termId = slug ? await this.#findTerm(taxonomy, slug) : undefined;
      if (!termId) {
        try {
          const created = await this.kernel.terms.insert(taxonomy, { name: term.name || slug, slug });
          termId = created.id;
          this.#termsBySlug.set(`${taxonomy}:${created.slug}`, created.id);
          this.report.imported.terms += 1;
          await this.kernel.hooks.doAction('wp_import_insert_term', { term_id: termId }, term, postId, post);
        } catch (error) {
          this.#error({
            kind: 'term',
            title: term.name || slug,
            type: taxonomy,
            code: (error as { code?: string }).code ?? 'import_term_failed',
            reason: describe(error),
          });
          continue;
        }
      }
      const list = byTaxonomy.get(taxonomy) ?? [];
      if (!list.includes(termId)) list.push(termId);
      byTaxonomy.set(taxonomy, list);
    }
    for (const [taxonomy, ids] of byTaxonomy) {
      await this.kernel.terms.setObjectTerms(postId, taxonomy, ids);
      const ttIds = await this.kernel.db
        .select({ id: schema.termTaxonomy.id })
        .from(schema.termTaxonomy)
        .where(and(eq(schema.termTaxonomy.taxonomy, taxonomy), inArray(schema.termTaxonomy.termId, ids)));
      await this.kernel.hooks.doAction(
        'wp_import_set_post_terms',
        ttIds.map((r) => r.id),
        ids,
        taxonomy,
        postId,
        post,
      );
    }
  }

  /** The comments block of process_posts(): threaded, deduplicated by author and date. */
  async #comments(target: Post, post: ImportPost): Promise<void> {
    const list = await this.kernel.hooks.applyFilters('wp_import_post_comments', post.comments, target.id, post);
    if (!list?.length) return;
    const inserted = new Map<number, number>();
    for (const comment of [...list].sort((a, b) => a.comment_id - b.comment_id)) {
      const date = this.#date(comment.comment_date, comment.comment_date_gmt) ?? new Date();
      const c = schema.comments;
      const [found] = await this.kernel.db
        .select({ id: c.id })
        .from(c)
        .where(and(eq(c.postId, target.id), eq(c.author, comment.comment_author), sameSecond(c.date, date)))
        .limit(1);
      if (found) {
        inserted.set(comment.comment_id, found.id);
        this.#skip({
          kind: 'comment',
          title: `${comment.comment_author || 'Anonymous'} on “${target.title}”`,
          id: comment.comment_id,
          code: 'exists',
          reason: 'Already exists.',
        });
        continue;
      }
      const approved = ['1', '0', 'spam', 'trash'].includes(comment.comment_approved)
        ? comment.comment_approved
        : '0';
      const content = comment.comment_content;
      try {
        const row = await this.kernel.comments.insert(
          {
            postId: target.id,
            parentId: comment.comment_parent ? (inserted.get(comment.comment_parent) ?? null) : null,
            content: this.#filterHtml ? relUgc(ksesComment(content)) : content,
            author: comment.comment_author,
            authorEmail: comment.comment_author_email.slice(0, 100),
            authorUrl: comment.comment_author_url.slice(0, 200),
            authorIp: comment.comment_author_IP.slice(0, 100),
            type: comment.comment_type || 'comment',
            userId: comment.comment_user_id ? (this.#authorsById.get(comment.comment_user_id) ?? null) : null,
            date,
          },
          approved,
        );
        inserted.set(comment.comment_id, row.id);
        this.report.imported.comments += 1;
        if (comment.commentmeta.length) {
          await this.kernel.db.insert(schema.commentmeta).values(
            comment.commentmeta.map((m) => ({ commentId: row.id, key: m.key, value: maybeUnserialize(m.value) })),
          );
        }
        await this.kernel.hooks.doAction('wp_import_insert_comment', row.id, comment, target.id, post);
      } catch (error) {
        this.#error({
          kind: 'comment',
          title: `${comment.comment_author || 'Anonymous'} on “${target.title}”`,
          id: comment.comment_id,
          code: 'import_comment_failed',
          reason: describe(error),
        });
      }
    }
  }

  /** The postmeta block of process_posts(). `_thumbnail_id` waits for remap_featured_images(). */
  async #postMeta(postId: number, post: ImportPost): Promise<void> {
    const list = await this.kernel.hooks.applyFilters('wp_import_post_meta', post.postmeta, postId, post);
    const rows: { postId: number; key: string; value: unknown }[] = [];
    for (const meta of list ?? []) {
      const key = await this.kernel.hooks.applyFilters('import_post_meta_key', meta.key, postId, post);
      if (!key || SKIPPED_META.has(key)) continue;
      if (post.post_type === 'attachment' && ATTACHMENT_FILE_META.has(key)) continue;
      if (key === '_thumbnail_id') {
        const old = Number(meta.value);
        if (old) this.#featured.push([postId, old]);
        continue;
      }
      let value: unknown = maybeUnserialize(meta.value);
      if (key === '_edit_last') {
        const mapped = this.#authorsById.get(Number(meta.value));
        if (!mapped) continue;
        value = mapped;
      }
      rows.push({ postId, key, value });
    }
    if (!rows.length) return;
    await this.kernel.db.insert(schema.postmeta).values(rows);
    for (const row of rows) await this.kernel.hooks.doAction('import_post_meta', postId, row.key, row.value);
  }

  /* ---------------------------------------------------------- attachments */

  /** WP_Import::process_attachment() and fetch_remote_file(). */
  async #attachment(post: ImportPost, postdata: ImportPostData): Promise<Post | undefined> {
    const title = post.post_title || `#${post.post_id}`;
    if (!this.#canFetch) {
      this.#skip({
        kind: 'attachment',
        title,
        type: 'attachment',
        id: post.post_id,
        code: 'attachment_fetch_disabled',
        reason: this.options.fetchAttachments
          ? 'You can’t upload files, so it wasn’t downloaded.'
          : 'Attachments weren’t downloaded (“Download and import file attachments” was off).',
      });
      return undefined;
    }
    let url = post.attachment_url || post.guid;
    // A relative URL is relative to the old site (WP_Import's base_url).
    if (url && !/^https?:\/\//i.test(url) && this.#site?.base_site_url) {
      url = `${this.#site.base_site_url.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
    }
    const fetchFile = this.options.fetchFile ?? fetchRemoteFile;
    let file: RemoteFile;
    try {
      file = await fetchFile(url, {
        maxBytes: this.#maxAttachmentBytes,
        allowPrivate: this.options.allowPrivateHosts,
        signal: this.options.signal,
        hostIsExternal: async (host, href) =>
          Boolean(await this.kernel.hooks.applyFilters('http_request_host_is_external', false, host, href)),
      });
    } catch (error) {
      if (this.options.signal?.aborted) throw error;
      this.#error({
        kind: 'attachment',
        title,
        type: 'attachment',
        id: post.post_id,
        code: error instanceof RemoteFileError ? error.code : 'import_file_error',
        reason: `Couldn’t download ${url}: ${describe(error)}`,
      });
      return undefined;
    }

    // Name the file as the old site did (the URL's file name), not by the final redirect.
    let filename = file.filename;
    try {
      filename = path.basename(decodeURIComponent(new URL(url).pathname)) || filename;
    } catch {
      // Keep the downloaded name.
    }
    let created: Post;
    try {
      created = await uploadAttachment(this.kernel, {
        data: file.data,
        filename,
        user: this.options.user,
        title: postdata.post_title || undefined,
        caption: postdata.post_excerpt,
        description: postdata.post_content,
        parentId: postdata.post_parent,
        date: postdata.post_date,
      });
    } catch (error) {
      this.#error({
        kind: 'attachment',
        title,
        type: 'attachment',
        id: post.post_id,
        code: error instanceof MediaError ? error.code : 'import_file_error',
        reason: describe(error),
      });
      return undefined;
    }
    await this.kernel.db
      .update(schema.posts)
      .set({
        authorId: postdata.post_author,
        menuOrder: postdata.menu_order,
        ...(postdata.post_modified ? { modified: postdata.post_modified } : {}),
      })
      .where(eq(schema.posts.id, created.id));

    // backfill_attachment_urls(): the old URL (and guid) now mean the new file.
    const newUrl = created.guid || (await fileUrl(this.kernel, String(await this.kernel.posts.getMeta(created.id, '_wp_attached_file'))));
    this.#urls.set(url, newUrl);
    if (post.guid && post.guid !== url) this.#urls.set(post.guid, newUrl);
    // Image sub-sizes: photo-300x200.jpg follows photo.jpg.
    const oldStem = url.replace(/(?:-scaled|-rotated)?\.[a-z0-9]{2,5}$/i, '');
    const newStem = newUrl.replace(/(?:-scaled|-rotated)?\.[a-z0-9]{2,5}$/i, '');
    if (oldStem !== url && newStem !== newUrl) this.#sizePrefixes.set(oldStem, newStem);
    return (await this.kernel.posts.get(created.id)) as Post;
  }

  /* ------------------------------------------------------------- finishing */

  /** backfill_parents(): posts whose parent came later. */
  async #backfillParents(): Promise<void> {
    for (const [postId, oldParent] of this.#orphans) {
      const parent = this.#posts.get(oldParent);
      if (!parent || parent === postId) continue;
      const [row] = await this.kernel.db
        .select({ type: schema.posts.type })
        .from(schema.posts)
        .where(eq(schema.posts.id, parent));
      const [self] = await this.kernel.db
        .select({ type: schema.posts.type })
        .from(schema.posts)
        .where(eq(schema.posts.id, postId));
      if (!row || !self) continue;
      // Hierarchical types need a parent of their own type; attachments may hang off any post.
      const hierarchical = this.kernel.postTypes.get(self.type)?.hierarchical;
      if (self.type !== 'attachment' && !(hierarchical && row.type === self.type)) continue;
      await this.kernel.db.update(schema.posts).set({ parentId: parent }).where(eq(schema.posts.id, postId));
    }
  }

  /** remap_featured_images() */
  async #remapFeaturedImages(): Promise<void> {
    for (const [postId, oldAttachment] of this.#featured) {
      const attachment = this.#posts.get(oldAttachment);
      if (attachment) await setMeta(this.kernel, postId, '_thumbnail_id', attachment);
    }
  }

  /** stick_post() for each sticky post, in one write. */
  async #stickPosts(): Promise<void> {
    if (!this.#sticky.length) return;
    const current = await this.kernel.options.get<number[]>('sticky_posts', []);
    const next = [...new Set([...current, ...this.#sticky])];
    if (next.length !== current.length) await this.kernel.options.set('sticky_posts', next);
  }

  async #rewriteContent(): Promise<void> {
    const oldBases = [this.#site?.base_blog_url ?? '', this.#site?.base_site_url ?? ''].filter(Boolean);
    const rewrite = createRewriter({
      posts: this.#posts,
      terms: this.#terms,
      urls: this.#urls,
      sizePrefixes: this.#sizePrefixes,
      oldBases,
      newBase: this.#home,
    });
    const p = schema.posts;
    for (let i = 0; i < this.#created.length; i += 100) {
      const ids = this.#created.slice(i, i + 100);
      const rows = await this.kernel.db
        .select({ id: p.id, content: p.content, excerpt: p.excerpt })
        .from(p)
        .where(inArray(p.id, ids));
      for (const row of rows) {
        const content = rewrite(row.content);
        const excerpt = rewrite(row.excerpt);
        if (content !== row.content || excerpt !== row.excerpt) {
          await this.kernel.db.update(p).set({ content, excerpt }).where(eq(p.id, row.id));
        }
      }
    }
  }

  /** Classic menus → wp_navigation posts (WP_Classic_To_Block_Menu_Converter). */
  async #importMenus(): Promise<void> {
    if (!this.#menuItems.length && !this.#menus.size) return;
    const kernel = this.kernel;
    const ctx = await permalinkContext(kernel);
    const site = await siteInfo(kernel);
    const rewrite = createRewriter({
      posts: this.#posts,
      terms: this.#terms,
      urls: this.#urls,
      sizePrefixes: this.#sizePrefixes,
      oldBases: [this.#site?.base_blog_url ?? '', this.#site?.base_site_url ?? ''].filter(Boolean),
      newBase: this.#home,
    });
    const byMenu = new Map<string, ClassicMenuItem[]>();
    for (const item of this.#menuItems) {
      const list = byMenu.get(item.menu) ?? [];
      list.push(item);
      byMenu.set(item.menu, list);
    }
    for (const [slug, items] of byMenu) {
      const name = this.#menus.get(slug) ?? slug;
      const [existing] = await kernel.db
        .select({ id: schema.posts.id })
        .from(schema.posts)
        .where(and(eq(schema.posts.type, 'wp_navigation'), eq(schema.posts.title, name)))
        .limit(1);
      if (existing) {
        this.#skip({ kind: 'menu', title: name, code: 'exists', reason: 'A menu with this name already exists.' });
        continue;
      }
      const resolved = new Map<number, ResolvedTarget | undefined>();
      for (const item of items) {
        resolved.set(item.id, await this.#menuTarget(item, ctx, site, rewrite));
      }
      const menu = convertClassicMenu(items, resolved);
      for (const item of menu.missing) {
        this.#skip({
          kind: 'menu',
          title: `${item.title || item.object} in “${name}”`,
          id: item.id,
          code: 'menu_item_missing',
          reason: 'What it links to wasn’t imported, so it was left out of the menu.',
        });
      }
      try {
        await kernel.posts.insert('wp_navigation', {
          title: name,
          slug,
          status: 'publish',
          content: menu.content,
          authorId: this.options.user.id,
          saveRevision: false,
        });
        this.report.imported.menus += 1;
      } catch (error) {
        this.#error({ kind: 'menu', title: name, code: 'import_menu_failed', reason: describe(error) });
      }
    }
  }

  async #menuTarget(
    item: ClassicMenuItem,
    ctx: Awaited<ReturnType<typeof permalinkContext>>,
    site: Awaited<ReturnType<typeof siteInfo>>,
    rewrite: (content: string) => string,
  ): Promise<ResolvedTarget | undefined> {
    if (item.type === 'post_type') {
      const id = this.#posts.get(item.objectId);
      const post = id ? await this.kernel.posts.get(id) : undefined;
      if (!post) return undefined;
      return { id: post.id, url: await permalink(this.kernel, post, ctx), title: post.title };
    }
    if (item.type === 'taxonomy') {
      const id = this.#terms.get(item.objectId);
      const term = id ? await this.kernel.terms.get(item.object, id) : undefined;
      if (!term) return undefined;
      return { id: term.id, url: termLink(site, term), title: term.name };
    }
    if (item.type === 'post_type_archive') {
      return { url: `${this.#home}/?post_type=${encodeURIComponent(item.object)}`, title: item.title || item.object };
    }
    if (!item.url) return undefined;
    return { url: rewrite(item.url), title: item.title || item.url };
  }
}

/** Runs a whole import: begin, every record from the source, finish. */
export async function runImport(
  kernel: Kernel,
  source: ImportSource,
  options: ImportOptions,
): Promise<ImportReport> {
  const writer = new ImportWriter(kernel, options);
  await writer.begin();
  for await (const record of source.records(options.signal)) await writer.write(record);
  return writer.finish();
}
