import { maybeUnserialize } from './php-serialize';
import type {
  ImportAuthor,
  ImportComment,
  ImportMeta,
  ImportPost,
  ImportRecord,
  ImportSite,
  ImportSource,
  ImportTerm,
} from './records';
import {
  type PostFilter,
  type WordPressCounts,
  type WordPressDatabase,
  WordPressDatabaseError,
  type WpMetaRow,
  type WpPostRow,
} from './wordpress-db';

/**
 * An import source that reads a WordPress site straight from its database:
 * the same records a WXR file gives (records.ts), read with SELECTs from the
 * tables in wp-admin/includes/schema.php, so the same writer (writer.ts)
 * imports them. Single sites only.
 *
 * Records come in the writer's order: the site (wp_options), every user
 * (wp_users, wp_usermeta), every term (wp_terms, wp_term_taxonomy,
 * wp_termmeta), then every post of every type with its meta, terms and
 * comments (wp_posts, wp_postmeta, wp_term_relationships, wp_comments,
 * wp_commentmeta). Each table is read in pages by ID (keyset pagination), so
 * memory stays flat whatever the site's size; a page of posts holds its
 * comments. Like WordPress's exporter (wp-admin/includes/export.php) it
 * leaves out revisions, auto-drafts and spam comments.
 */

export interface WordPressSourceOptions {
  /** Post types to leave out (`attachment`, say). */
  skipTypes?: string[];
  /** Read comments (default true). */
  comments?: boolean;
  /** Where the old site's uploads were served from; default from its options (wp_upload_dir()). */
  uploadsUrl?: string;
  /** Rows per page. */
  batchSize?: number;
}

/**
 * The wp_options rows the source reads: the site's identity, what decides
 * uploads' URLs, and the settings a migration carries (wordpress-migrate.ts).
 */
export const SITE_OPTIONS = [
  'siteurl',
  'home',
  'blogname',
  'blogdescription',
  'WPLANG',
  'upload_path',
  'upload_url_path',
  'sticky_posts',
  'wpseo_taxonomy_meta',
] as const;

/** The user meta carried, besides `{prefix}capabilities` (roles). */
const USER_META = ['first_name', 'last_name', 'nickname', 'description', 'locale'];

const POST_BATCH = 100;
const BATCH = 500;
const COMMENT_BATCH = 1000;

function groupMeta(rows: WpMetaRow[]): Map<number, ImportMeta[]> {
  const out = new Map<number, ImportMeta[]>();
  for (const row of rows) {
    const list = out.get(row.owner) ?? [];
    list.push({ key: row.key, value: row.value });
    out.set(row.owner, list);
  }
  return out;
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export class WordPressDatabaseSource implements ImportSource {
  #options: Map<string, string> | undefined;

  constructor(
    readonly db: WordPressDatabase,
    private readonly settings: WordPressSourceOptions = {},
  ) {}

  get filter(): PostFilter {
    return {
      excludeTypes: this.settings.skipTypes ?? [],
      comments: this.settings.comments !== false,
    };
  }

  /**
   * Checks this is a single WordPress site: its tables are there, and it isn't
   * a multisite network (whose `{prefix}blogs` table lists the sites).
   */
  async check(): Promise<void> {
    const prefix = this.db.prefix;
    if (!(await this.db.hasTable('options')) || !(await this.db.hasTable('posts'))) {
      throw new WordPressDatabaseError(
        'wp_tables_missing',
        `There are no WordPress tables with the prefix ${prefix} in this database. Check --prefix (it’s $table_prefix in wp-config.php).`,
      );
    }
    if (await this.db.hasTable('blogs')) {
      throw new WordPressDatabaseError(
        'wp_multisite_unsupported',
        `This is a WordPress multisite network (it has a ${prefix}blogs table). Pressbase can only migrate single sites for now.`,
      );
    }
  }

  /** The site's options among `names` (values as WordPress stores them), plus SITE_OPTIONS. */
  async options(names: readonly string[] = []): Promise<Map<string, string>> {
    const wanted = [...new Set([...SITE_OPTIONS, ...names])];
    const missing = this.#options ? wanted.filter((n) => !this.#options?.has(n)) : wanted;
    this.#options ??= new Map();
    if (missing.length) {
      for (const row of await this.db.options(missing)) {
        this.#options.set(row.option_name, str(row.option_value));
      }
      for (const name of missing) if (!this.#options.has(name)) this.#options.set(name, '');
    }
    return this.#options;
  }

  counts(): Promise<WordPressCounts> {
    return this.db.counts(this.filter);
  }

  /** wp_upload_dir()'s baseurl (wp-includes/functions.php), without a trailing slash. */
  async uploadsUrl(): Promise<string> {
    if (this.settings.uploadsUrl) return this.settings.uploadsUrl.replace(/\/+$/, '');
    const options = await this.options();
    const siteurl = (options.get('siteurl') ?? '').replace(/\/+$/, '');
    const urlPath = (options.get('upload_url_path') ?? '').trim();
    if (urlPath) return urlPath.replace(/\/+$/, '');
    const uploadPath = (options.get('upload_path') ?? '').trim().replace(/^\/+|\/+$/g, '');
    // A relative upload_path sits under ABSPATH, so under siteurl; an absolute one has no known URL.
    if (uploadPath && uploadPath !== 'wp-content/uploads' && !/^[a-z]:|^\//i.test(uploadPath)) {
      return `${siteurl}/${uploadPath}`;
    }
    return `${siteurl}/wp-content/uploads`;
  }

  async *records(signal?: AbortSignal): AsyncIterable<ImportRecord> {
    const options = await this.options();
    yield { kind: 'site', site: this.#site(options) };
    for await (const author of this.#authors(signal)) yield { kind: 'author', author };
    const seoTermMeta = this.#yoastTermMeta(options.get('wpseo_taxonomy_meta') ?? '');
    for await (const term of this.#terms(seoTermMeta, signal)) yield { kind: 'term', term };
    const sticky = maybeUnserialize(options.get('sticky_posts') ?? '');
    const stickyIds = new Set(
      sticky && typeof sticky === 'object' ? Object.values(sticky).map(Number) : [],
    );
    const uploadsUrl = await this.uploadsUrl();
    for await (const post of this.#posts(stickyIds, uploadsUrl, signal)) {
      yield { kind: 'post', post };
    }
  }

  #site(options: Map<string, string>): ImportSite {
    const locale = options.get('WPLANG') || 'en_US';
    return {
      title: options.get('blogname') ?? '',
      link: options.get('home') ?? '',
      description: options.get('blogdescription') ?? '',
      // get_bloginfo( 'language' ): the locale with a hyphen.
      language: locale.replace('_', '-'),
      wxr_version: '',
      base_site_url: (options.get('siteurl') ?? '').replace(/\/+$/, ''),
      base_blog_url: (options.get('home') ?? '').replace(/\/+$/, ''),
    };
  }

  async *#authors(signal?: AbortSignal): AsyncIterable<ImportAuthor> {
    const capabilities = `${this.db.prefix}capabilities`;
    let after = 0;
    for (;;) {
      signal?.throwIfAborted();
      const users = await this.db.users(after, BATCH);
      if (!users.length) return;
      const meta = groupMeta(
        await this.db.usermeta(
          users.map((u) => u.ID),
          [...USER_META, capabilities],
        ),
      );
      for (const user of users) {
        const own = new Map((meta.get(user.ID) ?? []).map((m) => [m.key, m.value]));
        const caps = maybeUnserialize(own.get(capabilities) ?? '');
        const roles =
          caps && typeof caps === 'object' && !Array.isArray(caps)
            ? Object.entries(caps as Record<string, unknown>)
                .filter(([, granted]) => granted === true || granted === 1 || granted === '1')
                .map(([role]) => role)
            : [];
        yield {
          author_id: Number(user.ID),
          author_login: str(user.user_login),
          author_email: str(user.user_email),
          author_display_name: str(user.display_name),
          author_first_name: own.get('first_name') ?? '',
          author_last_name: own.get('last_name') ?? '',
          author_pass: str(user.user_pass),
          author_nicename: str(user.user_nicename),
          author_url: str(user.user_url),
          author_registered: str(user.user_registered),
          author_roles: roles,
          author_meta: ['nickname', 'description', 'locale']
            .filter((key) => own.has(key))
            .map((key) => ({ key, value: own.get(key) ?? '' })),
        };
      }
      after = Number(users[users.length - 1]?.ID);
    }
  }

  /**
   * Yoast SEO keeps term SEO fields in one option, `wpseo_taxonomy_meta`
   * (taxonomy → term ID → wpseo_title, wpseo_desc, …), not in wp_termmeta.
   * They become term meta under Yoast's own keys, so they follow the term.
   */
  #yoastTermMeta(raw: string): Map<string, ImportMeta[]> {
    const out = new Map<string, ImportMeta[]>();
    const value = maybeUnserialize(raw);
    if (!value || typeof value !== 'object') return out;
    for (const [taxonomy, terms] of Object.entries(value as Record<string, unknown>)) {
      if (!terms || typeof terms !== 'object') continue;
      for (const [termId, fields] of Object.entries(terms as Record<string, unknown>)) {
        if (!fields || typeof fields !== 'object') continue;
        const list = Object.entries(fields as Record<string, unknown>)
          .filter(([key, v]) => key.startsWith('wpseo_') && (typeof v === 'string' || typeof v === 'number'))
          .map(([key, v]) => ({ key, value: String(v) }));
        if (list.length) out.set(`${taxonomy}:${termId}`, list);
      }
    }
    return out;
  }

  async *#terms(seo: Map<string, ImportMeta[]>, signal?: AbortSignal): AsyncIterable<ImportTerm> {
    let after = 0;
    for (;;) {
      signal?.throwIfAborted();
      const rows = await this.db.terms(after, BATCH);
      if (!rows.length) return;
      const meta = groupMeta(await this.db.termmeta([...new Set(rows.map((r) => r.term_id))]));
      for (const row of rows) {
        yield {
          term_id: Number(row.term_id),
          term_taxonomy: str(row.taxonomy),
          slug: str(row.slug),
          term_parent: Number(row.parent) ? str(row.parent_slug) : '',
          term_name: str(row.name),
          term_description: str(row.description),
          termmeta: [
            ...(meta.get(row.term_id) ?? []),
            ...(seo.get(`${row.taxonomy}:${row.term_id}`) ?? []),
          ],
        };
      }
      after = Number(rows[rows.length - 1]?.term_taxonomy_id);
    }
  }

  async *#posts(
    sticky: Set<number>,
    uploadsUrl: string,
    signal?: AbortSignal,
  ): AsyncIterable<ImportPost> {
    const filter = this.filter;
    let after = 0;
    for (;;) {
      signal?.throwIfAborted();
      const rows = await this.db.posts(after, POST_BATCH, filter);
      if (!rows.length) return;
      const ids = rows.map((r) => Number(r.ID));
      const meta = groupMeta(await this.db.postmeta(ids));
      const terms = new Map<number, ImportPost['terms']>();
      for (const row of await this.db.postTerms(ids)) {
        const list = terms.get(Number(row.object_id)) ?? [];
        list.push({ domain: str(row.taxonomy), slug: str(row.slug), name: str(row.name) });
        terms.set(Number(row.object_id), list);
      }
      const comments = filter.comments ? await this.#comments(ids) : new Map();
      for (const row of rows) {
        const id = Number(row.ID);
        yield this.#post(row, {
          meta: meta.get(id) ?? [],
          terms: terms.get(id) ?? [],
          comments: comments.get(id) ?? [],
          sticky: sticky.has(id),
          uploadsUrl,
        });
      }
      after = ids[ids.length - 1] ?? after;
    }
  }

  async #comments(postIds: number[]): Promise<Map<number, ImportComment[]>> {
    const out = new Map<number, ImportComment[]>();
    let after = 0;
    for (;;) {
      const rows = await this.db.comments(postIds, after, COMMENT_BATCH);
      if (!rows.length) return out;
      const meta = groupMeta(await this.db.commentmeta(rows.map((r) => Number(r.comment_ID))));
      for (const row of rows) {
        const list = out.get(Number(row.comment_post_ID)) ?? [];
        list.push({
          comment_id: Number(row.comment_ID),
          comment_author: str(row.comment_author),
          comment_author_email: str(row.comment_author_email),
          comment_author_IP: str(row.comment_author_IP),
          comment_author_url: str(row.comment_author_url),
          comment_date: str(row.comment_date),
          comment_date_gmt: str(row.comment_date_gmt),
          comment_content: str(row.comment_content),
          comment_approved: str(row.comment_approved),
          comment_type: str(row.comment_type) || 'comment',
          comment_parent: Number(row.comment_parent) || 0,
          comment_user_id: Number(row.user_id) || 0,
          commentmeta: meta.get(Number(row.comment_ID)) ?? [],
        });
        out.set(Number(row.comment_post_ID), list);
      }
      if (rows.length < COMMENT_BATCH) return out;
      after = Number(rows[rows.length - 1]?.comment_ID);
    }
  }

  #post(
    row: WpPostRow,
    extra: {
      meta: ImportMeta[];
      terms: ImportPost['terms'];
      comments: ImportComment[];
      sticky: boolean;
      uploadsUrl: string;
    },
  ): ImportPost {
    let attachmentUrl = '';
    if (row.post_type === 'attachment') {
      // wp_get_attachment_url(): the uploads URL and _wp_attached_file, else the guid.
      const file = extra.meta.find((m) => m.key === '_wp_attached_file')?.value ?? '';
      if (/^https?:\/\//i.test(file)) attachmentUrl = file;
      else if (file) attachmentUrl = `${extra.uploadsUrl}/${file.replace(/^\/+/, '')}`;
      else attachmentUrl = str(row.guid);
    }
    return {
      post_id: Number(row.ID),
      post_title: str(row.post_title),
      link: '',
      guid: str(row.guid),
      post_author: str(row.author_login),
      post_content: str(row.post_content),
      post_excerpt: str(row.post_excerpt),
      post_date: str(row.post_date),
      post_date_gmt: str(row.post_date_gmt),
      post_modified: str(row.post_modified),
      post_modified_gmt: str(row.post_modified_gmt),
      comment_status: str(row.comment_status),
      ping_status: str(row.ping_status),
      post_name: str(row.post_name),
      status: str(row.post_status),
      post_parent: Number(row.post_parent) || 0,
      menu_order: Number(row.menu_order) || 0,
      post_type: str(row.post_type),
      post_password: str(row.post_password),
      is_sticky: extra.sticky && row.post_type === 'post',
      attachment_url: attachmentUrl,
      terms: extra.terms,
      postmeta: extra.meta,
      comments: extra.comments,
    };
  }
}
