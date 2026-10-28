import { readFileSync } from 'node:fs';

/**
 * Reading a WordPress site's MySQL/MariaDB database: the queries the
 * WordPress database source (wordpress-db-reader.ts) needs, behind a small
 * interface so the reader can be tested against an in-memory fake
 * (wordpress-db-fixture.ts) and run against real MySQL through mysql2.
 * See docs/architecture/import-export.md and ADR 0016.
 *
 * Tables and columns are WordPress's own (wp-admin/includes/schema.php in
 * WordPress 7.1.3, wp_get_db_schema()). Every query is a SELECT, run inside a
 * read-only transaction: a MySQL user with only the SELECT privilege is enough.
 */

/** One meta row: wp_postmeta, wp_termmeta, wp_commentmeta or wp_usermeta. `owner` is the post, term, comment or user ID. */
export interface WpMetaRow {
  owner: number;
  key: string;
  value: string;
}

/** wp_users (schema.php, `$users_single_table`). */
export interface WpUserRow {
  ID: number;
  user_login: string;
  user_pass: string;
  user_nicename: string;
  user_email: string;
  user_url: string;
  user_registered: string;
  display_name: string;
}

/** wp_terms joined to wp_term_taxonomy, with the parent's slug. */
export interface WpTermRow {
  term_taxonomy_id: number;
  term_id: number;
  name: string;
  slug: string;
  taxonomy: string;
  description: string;
  parent: number;
  /** The parent term's slug (wp_terms of `parent`), or null. */
  parent_slug: string | null;
}

/** wp_posts, with the author's login (wp_users.user_login of `post_author`). */
export interface WpPostRow {
  ID: number;
  post_author: number;
  author_login: string | null;
  post_date: string;
  post_date_gmt: string;
  post_content: string;
  post_title: string;
  post_excerpt: string;
  post_status: string;
  comment_status: string;
  ping_status: string;
  post_password: string;
  post_name: string;
  post_modified: string;
  post_modified_gmt: string;
  post_parent: number;
  guid: string;
  menu_order: number;
  post_type: string;
  post_mime_type: string;
}

/** A post's term: wp_term_relationships → wp_term_taxonomy → wp_terms. */
export interface WpPostTermRow {
  object_id: number;
  taxonomy: string;
  slug: string;
  name: string;
}

/** wp_comments. */
export interface WpCommentRow {
  comment_ID: number;
  comment_post_ID: number;
  comment_author: string;
  comment_author_email: string;
  comment_author_url: string;
  comment_author_IP: string;
  comment_date: string;
  comment_date_gmt: string;
  comment_content: string;
  comment_approved: string;
  comment_type: string;
  comment_parent: number;
  user_id: number;
}

/** What a dry run reports: what the source holds, per kind. */
export interface WordPressCounts {
  users: number;
  /** Per taxonomy. */
  terms: Record<string, number>;
  /** Per post type (attachments, menu items and wp_navigation included). */
  posts: Record<string, number>;
  comments: number;
}

/** Which posts the reader wants: every type except these, and never revisions or auto-drafts. */
export interface PostFilter {
  excludeTypes: string[];
  /** Read comments? */
  comments: boolean;
}

/**
 * The queries the reader runs. Keyset pagination everywhere: `after` is the
 * last ID of the previous page, results are ordered by ID, at most `limit`.
 * Lists of IDs (`ids`) are at most a page long.
 */
export interface WordPressDatabase {
  /** The table prefix ($table_prefix in wp-config.php), checked to be [A-Za-z0-9_]+. */
  readonly prefix: string;
  /** Does `{prefix}{name}` exist? */
  hasTable(name: string): Promise<boolean>;
  /** wp_options rows by name. */
  options(names: string[]): Promise<{ option_name: string; option_value: string }[]>;
  users(after: number, limit: number): Promise<WpUserRow[]>;
  usermeta(ids: number[], keys: string[]): Promise<WpMetaRow[]>;
  /** Paged by term_taxonomy_id. */
  terms(after: number, limit: number): Promise<WpTermRow[]>;
  termmeta(ids: number[]): Promise<WpMetaRow[]>;
  posts(after: number, limit: number, filter: PostFilter): Promise<WpPostRow[]>;
  postmeta(ids: number[]): Promise<WpMetaRow[]>;
  postTerms(ids: number[]): Promise<WpPostTermRow[]>;
  /** Comments on these posts, spam excluded (as export.php does), paged by comment_ID. */
  comments(postIds: number[], after: number, limit: number): Promise<WpCommentRow[]>;
  commentmeta(ids: number[]): Promise<WpMetaRow[]>;
  counts(filter: PostFilter): Promise<WordPressCounts>;
  close(): Promise<void>;
}

export class WordPressDatabaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** WordPress refuses other characters in $table_prefix (wp_set_wpdb_vars()); so does Pressbase, since it goes into SQL. */
export function checkPrefix(prefix: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(prefix)) {
    throw new WordPressDatabaseError(
      'invalid_prefix',
      'The table prefix may only contain letters, numbers and underscores, like wp_.',
    );
  }
  return prefix;
}

/* ------------------------------------------------------- connection URLs */

export interface ParsedDatabaseUrl {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** undefined: no TLS. `verify`: check the server's certificate. */
  tls?: { verify: boolean; ca?: string };
}

const VERIFY = new Set(['true', '1', 'verify_identity', 'verify-full', 'verify_ca', 'verify-ca']);
const ENCRYPT_ONLY = new Set(['required', 'require', 'preferred', 'prefer']);
const NO_TLS = new Set(['false', '0', 'disabled', 'disable']);

/**
 * Parses `mysql://user:password@host:3306/database?ssl-mode=VERIFY_IDENTITY`.
 * TLS is used when the URL asks for it:
 *
 * - `ssl=true`, `ssl-mode=VERIFY_IDENTITY` or `VERIFY_CA`, `sslmode=verify-full`
 *   or `verify-ca`: encrypted, and the server's certificate must be valid.
 * - `ssl-mode=REQUIRED`, `sslmode=require`: encrypted without checking the
 *   certificate, as MySQL's own client does for REQUIRED.
 * - `ssl-ca=<file>` (or `sslca`, `sslrootcert`): a CA certificate to trust;
 *   implies verification.
 *
 * Errors never contain the password.
 */
export function parseDatabaseUrl(raw: string): ParsedDatabaseUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WordPressDatabaseError(
      'invalid_db_url',
      'That isn’t a database URL. Use mysql://user:password@host/database.',
    );
  }
  if (url.protocol !== 'mysql:' && url.protocol !== 'mariadb:') {
    throw new WordPressDatabaseError(
      'invalid_db_url',
      'The database URL must start with mysql:// (or mariadb://).',
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!database || database.includes('/')) {
    throw new WordPressDatabaseError(
      'invalid_db_url',
      'The database URL must name the database: mysql://user:password@host/database.',
    );
  }
  const param = (...names: string[]) => {
    for (const name of names) {
      const value = url.searchParams.get(name);
      if (value !== null) return value.toLowerCase();
    }
    return undefined;
  };
  const caFile =
    url.searchParams.get('ssl-ca') ??
    url.searchParams.get('sslca') ??
    url.searchParams.get('sslrootcert');
  const mode = param('ssl-mode', 'sslmode', 'ssl_mode', 'ssl');
  let tls: ParsedDatabaseUrl['tls'];
  if (mode && !NO_TLS.has(mode)) {
    if (VERIFY.has(mode)) tls = { verify: true };
    else if (ENCRYPT_ONLY.has(mode)) tls = { verify: false };
    else {
      throw new WordPressDatabaseError(
        'invalid_db_url',
        `Unknown TLS mode “${mode}”. Use ssl-mode=VERIFY_IDENTITY, VERIFY_CA, REQUIRED or DISABLED.`,
      );
    }
  }
  if (caFile) {
    let ca: string;
    try {
      ca = readFileSync(caFile, 'utf8');
    } catch {
      throw new WordPressDatabaseError('invalid_db_url', `Can’t read the CA file ${caFile}.`);
    }
    tls = { verify: true, ca };
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, '') || 'localhost',
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    tls,
  };
}

/** The URL with its password replaced by `***`, safe to print. */
export function redactDatabaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    // Not a URL: hide anything between the scheme's "//user:" and "@".
    return raw.replace(/(\/\/[^:/@]*:)[^@]*@/, '$1***@');
  }
}

/** Removes a password from a message, in case a driver or a URL put it there. */
export function redactSecret(message: string, secret: string): string {
  if (!secret) return message;
  let out = message;
  for (const form of new Set([secret, encodeURIComponent(secret)])) {
    out = out.split(form).join('***');
  }
  return out;
}

/* ------------------------------------------------------------- MySQL */

/** The subset of mysql2's promise connection used here. */
interface MysqlConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

/** Rows per IN (…) list; pages are at most this long anyway. */
const IN_CHUNK = 1000;

function placeholders(list: unknown[]): string {
  return list.map(() => '?').join(', ');
}

/**
 * Connects to a WordPress database with mysql2 (ADR 0016). Dates come back as
 * the strings MySQL stores (`dateStrings`), so zero dates survive, and
 * the session runs in a read-only transaction with a consistent snapshot.
 */
export async function connectWordPressDatabase(
  url: string,
  prefix = 'wp_',
): Promise<WordPressDatabase> {
  const config = parseDatabaseUrl(url);
  const p = checkPrefix(prefix);
  const mysql = await import('mysql2/promise');
  let connection: MysqlConnection;
  try {
    connection = (await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      connectTimeout: 15_000,
      ...(config.tls
        ? {
            ssl: {
              rejectUnauthorized: config.tls.verify,
              ...(config.tls.ca ? { ca: config.tls.ca } : {}),
            },
          }
        : {}),
    })) as unknown as MysqlConnection;
  } catch (error) {
    throw new WordPressDatabaseError(
      'db_connect_error',
      redactSecret(
        `Couldn’t connect to ${redactDatabaseUrl(url)}: ${error instanceof Error ? error.message : String(error)}`,
        config.password,
      ),
    );
  }

  const run = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    try {
      const [rows] = await connection.query(sql, values);
      return rows as T[];
    } catch (error) {
      throw new WordPressDatabaseError(
        'db_query_error',
        redactSecret(
          `The WordPress database refused a query: ${error instanceof Error ? error.message : String(error)}`,
          config.password,
        ),
      );
    }
  };
  // Every statement after this is a SELECT; the server refuses writes in a read-only transaction.
  await run('START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT');

  const meta = async (table: string, column: string, ids: number[]): Promise<WpMetaRow[]> => {
    if (!ids.length) return [];
    const out: WpMetaRow[] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      out.push(
        ...(await run<WpMetaRow>(
          `SELECT ${column} AS owner, meta_key AS \`key\`, meta_value AS value FROM ${p}${table} WHERE ${column} IN (${placeholders(chunk)}) ORDER BY meta_id`,
          chunk,
        )),
      );
    }
    return out.map((r) => ({ owner: Number(r.owner), key: r.key ?? '', value: r.value ?? '' }));
  };

  const postWhere = (filter: PostFilter) => {
    const types = ['revision', ...filter.excludeTypes];
    return {
      sql: `p.post_type NOT IN (${placeholders(types)}) AND p.post_status <> 'auto-draft'`,
      values: types,
    };
  };

  return {
    prefix: p,
    async hasTable(name) {
      const rows = await run<{ n: number }>(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
        [`${p}${name}`],
      );
      return Number(rows[0]?.n ?? 0) > 0;
    },
    options: (names) =>
      names.length
        ? run(
            `SELECT option_name, option_value FROM ${p}options WHERE option_name IN (${placeholders(names)})`,
            names,
          )
        : Promise.resolve([]),
    users: (after, limit) =>
      run(
        `SELECT ID, user_login, user_pass, user_nicename, user_email, user_url, user_registered, display_name FROM ${p}users WHERE ID > ? ORDER BY ID LIMIT ?`,
        [after, limit],
      ),
    async usermeta(ids, keys) {
      if (!ids.length || !keys.length) return [];
      const rows = await run<WpMetaRow>(
        `SELECT user_id AS owner, meta_key AS \`key\`, meta_value AS value FROM ${p}usermeta WHERE user_id IN (${placeholders(ids)}) AND meta_key IN (${placeholders(keys)}) ORDER BY umeta_id`,
        [...ids, ...keys],
      );
      return rows.map((r) => ({ owner: Number(r.owner), key: r.key ?? '', value: r.value ?? '' }));
    },
    terms: (after, limit) =>
      run(
        `SELECT tt.term_taxonomy_id, t.term_id, t.name, t.slug, tt.taxonomy, tt.description, tt.parent, pt.slug AS parent_slug
         FROM ${p}term_taxonomy tt
         JOIN ${p}terms t ON t.term_id = tt.term_id
         LEFT JOIN ${p}terms pt ON pt.term_id = tt.parent AND tt.parent <> 0
         WHERE tt.term_taxonomy_id > ? ORDER BY tt.term_taxonomy_id LIMIT ?`,
        [after, limit],
      ),
    termmeta: (ids) => meta('termmeta', 'term_id', ids),
    posts(after, limit, filter) {
      const where = postWhere(filter);
      return run(
        `SELECT p.ID, p.post_author, u.user_login AS author_login, p.post_date, p.post_date_gmt, p.post_content, p.post_title, p.post_excerpt, p.post_status, p.comment_status, p.ping_status, p.post_password, p.post_name, p.post_modified, p.post_modified_gmt, p.post_parent, p.guid, p.menu_order, p.post_type, p.post_mime_type
         FROM ${p}posts p LEFT JOIN ${p}users u ON u.ID = p.post_author
         WHERE p.ID > ? AND ${where.sql} ORDER BY p.ID LIMIT ?`,
        [after, ...where.values, limit],
      );
    },
    postmeta: (ids) => meta('postmeta', 'post_id', ids),
    async postTerms(ids) {
      if (!ids.length) return [];
      // link_category relationships point at wp_links, not posts.
      return run(
        `SELECT tr.object_id, tt.taxonomy, t.slug, t.name
         FROM ${p}term_relationships tr
         JOIN ${p}term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
         JOIN ${p}terms t ON t.term_id = tt.term_id
         WHERE tr.object_id IN (${placeholders(ids)}) AND tt.taxonomy <> 'link_category'
         ORDER BY tr.object_id, tr.term_order, tt.term_taxonomy_id`,
        ids,
      );
    },
    async comments(postIds, after, limit) {
      if (!postIds.length) return [];
      return run(
        `SELECT comment_ID, comment_post_ID, comment_author, comment_author_email, comment_author_url, comment_author_IP, comment_date, comment_date_gmt, comment_content, comment_approved, comment_type, comment_parent, user_id
         FROM ${p}comments WHERE comment_post_ID IN (${placeholders(postIds)}) AND comment_approved <> 'spam' AND comment_ID > ?
         ORDER BY comment_ID LIMIT ?`,
        [...postIds, after, limit],
      );
    },
    commentmeta: (ids) => meta('commentmeta', 'comment_id', ids),
    async counts(filter) {
      const where = postWhere(filter);
      const [users] = await run<{ n: number }>(`SELECT COUNT(*) AS n FROM ${p}users`);
      const terms = await run<{ taxonomy: string; n: number }>(
        `SELECT taxonomy, COUNT(*) AS n FROM ${p}term_taxonomy GROUP BY taxonomy ORDER BY taxonomy`,
      );
      const posts = await run<{ post_type: string; n: number }>(
        `SELECT p.post_type, COUNT(*) AS n FROM ${p}posts p WHERE ${where.sql} GROUP BY p.post_type ORDER BY p.post_type`,
        where.values,
      );
      let comments = 0;
      if (filter.comments) {
        const [row] = await run<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${p}comments c JOIN ${p}posts p ON p.ID = c.comment_post_ID WHERE c.comment_approved <> 'spam' AND ${where.sql}`,
          where.values,
        );
        comments = Number(row?.n ?? 0);
      }
      return {
        users: Number(users?.n ?? 0),
        terms: Object.fromEntries(terms.map((r) => [r.taxonomy, Number(r.n)])),
        posts: Object.fromEntries(posts.map((r) => [r.post_type, Number(r.n)])),
        comments,
      };
    },
    async close() {
      try {
        await run('COMMIT');
      } finally {
        await connection.end().catch(() => {});
      }
    },
  };
}
