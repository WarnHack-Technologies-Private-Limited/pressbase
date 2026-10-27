/**
 * Pressbase's database schema.
 *
 * It keeps WordPress's data model (see wordpress/wp-admin/includes/schema.php)
 * so content, plugins and migrations map across cleanly, with these changes:
 *
 * - No table prefix and no `post_` / `comment_` / `user_` column prefixes.
 * - One `timestamptz` column replaces each local + GMT datetime pair.
 * - Missing relations are NULL with real foreign keys, never 0.
 * - Option and meta values are JSONB instead of PHP-serialized strings.
 * - New `sessions` table (WordPress keeps session tokens in usermeta).
 * - Dropped: the Links manager table and pingback columns (to_ping, pinged).
 *
 * The full column mapping lives in docs/architecture/database.md. After any
 * change here, run `pnpm db:generate` and commit the generated migration.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

const id = () => bigserial('id', { mode: 'number' }).primaryKey();
const ref = (name: string) => bigint(name, { mode: 'number' });
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/* ------------------------------------------------------------------ options */

export const options = pgTable('options', {
  id: id(),
  name: varchar('name', { length: 191 }).notNull().unique(),
  value: jsonb('value').notNull(),
  /** Autoloaded options are read in one query when the kernel boots. */
  autoload: boolean('autoload').notNull().default(true),
});

/* -------------------------------------------------------------------- users */

export const users = pgTable(
  'users',
  {
    id: id(),
    login: varchar('login', { length: 60 }).notNull(),
    /** Password hash. Format documented in apps/core/src/auth/password.ts. */
    pass: varchar('pass', { length: 255 }).notNull(),
    nicename: varchar('nicename', { length: 50 }).notNull(),
    email: varchar('email', { length: 100 }).notNull(),
    url: varchar('url', { length: 100 }).notNull().default(''),
    registeredAt: timestamptz('registered_at').notNull().defaultNow(),
    activationKey: varchar('activation_key', { length: 255 }).notNull().default(''),
    status: integer('status').notNull().default(0),
    displayName: varchar('display_name', { length: 250 }).notNull().default(''),
  },
  (t) => [
    // Logins and emails are unique case-insensitively, as WordPress enforces in PHP.
    uniqueIndex('users_login_key').on(sql`lower(${t.login})`),
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`),
    index('users_nicename_idx').on(t.nicename),
  ],
);

export const usermeta = pgTable(
  'usermeta',
  {
    id: id(),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 255 }).notNull(),
    value: jsonb('value'),
  },
  (t) => [index('usermeta_user_key_idx').on(t.userId, t.key), index('usermeta_key_idx').on(t.key)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the session token. The token itself only lives in the cookie. */
    id: varchar('id', { length: 64 }).primaryKey(),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    ip: varchar('ip', { length: 100 }).notNull().default(''),
    userAgent: varchar('user_agent', { length: 255 }).notNull().default(''),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/* -------------------------------------------------------------------- posts */

export const posts = pgTable(
  'posts',
  {
    id: id(),
    authorId: ref('author_id').references(() => users.id, { onDelete: 'set null' }),
    /** Publish date (WordPress post_date_gmt). Shown in the site's timezone. */
    date: timestamptz('date').notNull().defaultNow(),
    modified: timestamptz('modified').notNull().defaultNow(),
    content: text('content').notNull().default(''),
    title: text('title').notNull().default(''),
    excerpt: text('excerpt').notNull().default(''),
    status: varchar('status', { length: 20 }).notNull().default('publish'),
    commentStatus: varchar('comment_status', { length: 20 }).notNull().default('open'),
    pingStatus: varchar('ping_status', { length: 20 }).notNull().default('closed'),
    password: varchar('password', { length: 255 }).notNull().default(''),
    /** URL slug (WordPress post_name). */
    slug: varchar('slug', { length: 200 }).notNull().default(''),
    contentFiltered: text('content_filtered').notNull().default(''),
    parentId: ref('parent_id').references((): AnyPgColumn => posts.id, {
      onDelete: 'set null',
    }),
    guid: varchar('guid', { length: 255 }).notNull().default(''),
    menuOrder: integer('menu_order').notNull().default(0),
    type: varchar('type', { length: 20 }).notNull().default('post'),
    mimeType: varchar('mime_type', { length: 100 }).notNull().default(''),
    commentCount: integer('comment_count').notNull().default(0),
  },
  (t) => [
    index('posts_slug_idx').on(t.slug),
    index('posts_type_status_date_idx').on(t.type, t.status, t.date, t.id),
    index('posts_parent_idx').on(t.parentId),
    index('posts_author_idx').on(t.authorId),
    index('posts_type_status_author_idx').on(t.type, t.status, t.authorId),
  ],
);

export const postmeta = pgTable(
  'postmeta',
  {
    id: id(),
    postId: ref('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 255 }).notNull(),
    value: jsonb('value'),
  },
  (t) => [index('postmeta_post_key_idx').on(t.postId, t.key), index('postmeta_key_idx').on(t.key)],
);

/* --------------------------------------------------------------- taxonomies */

export const terms = pgTable(
  'terms',
  {
    id: id(),
    name: varchar('name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 200 }).notNull(),
    termGroup: bigint('term_group', { mode: 'number' }).notNull().default(0),
  },
  (t) => [index('terms_slug_idx').on(t.slug), index('terms_name_idx').on(t.name)],
);

export const termTaxonomy = pgTable(
  'term_taxonomy',
  {
    id: id(),
    termId: ref('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
    taxonomy: varchar('taxonomy', { length: 32 }).notNull(),
    description: text('description').notNull().default(''),
    parentId: ref('parent_id').references((): AnyPgColumn => termTaxonomy.id, {
      onDelete: 'set null',
    }),
    count: bigint('count', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    uniqueIndex('term_taxonomy_term_taxonomy_key').on(t.termId, t.taxonomy),
    index('term_taxonomy_taxonomy_idx').on(t.taxonomy),
  ],
);

export const termRelationships = pgTable(
  'term_relationships',
  {
    /** A post ID for built-in taxonomies; plugins may relate other objects. */
    objectId: ref('object_id').notNull(),
    termTaxonomyId: ref('term_taxonomy_id')
      .notNull()
      .references(() => termTaxonomy.id, { onDelete: 'cascade' }),
    termOrder: integer('term_order').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.objectId, t.termTaxonomyId] }),
    index('term_relationships_tt_idx').on(t.termTaxonomyId),
  ],
);

export const termmeta = pgTable(
  'termmeta',
  {
    id: id(),
    termId: ref('term_id')
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 255 }).notNull(),
    value: jsonb('value'),
  },
  (t) => [index('termmeta_term_key_idx').on(t.termId, t.key), index('termmeta_key_idx').on(t.key)],
);

/* ----------------------------------------------------------------- comments */

export const comments = pgTable(
  'comments',
  {
    id: id(),
    postId: ref('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    author: text('author').notNull().default(''),
    authorEmail: varchar('author_email', { length: 100 }).notNull().default(''),
    authorUrl: varchar('author_url', { length: 200 }).notNull().default(''),
    authorIp: varchar('author_ip', { length: 100 }).notNull().default(''),
    date: timestamptz('date').notNull().defaultNow(),
    content: text('content').notNull(),
    karma: integer('karma').notNull().default(0),
    /** '1' approved, '0' pending, 'spam', 'trash' — same values as WordPress. */
    approved: varchar('approved', { length: 20 }).notNull().default('1'),
    agent: varchar('agent', { length: 255 }).notNull().default(''),
    type: varchar('type', { length: 20 }).notNull().default('comment'),
    parentId: ref('parent_id').references((): AnyPgColumn => comments.id, {
      onDelete: 'set null',
    }),
    userId: ref('user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('comments_post_idx').on(t.postId),
    index('comments_approved_date_idx').on(t.approved, t.date),
    index('comments_date_idx').on(t.date),
    index('comments_parent_idx').on(t.parentId),
    index('comments_author_email_idx').on(t.authorEmail),
  ],
);

export const commentmeta = pgTable(
  'commentmeta',
  {
    id: id(),
    commentId: ref('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 255 }).notNull(),
    value: jsonb('value'),
  },
  (t) => [
    index('commentmeta_comment_key_idx').on(t.commentId, t.key),
    index('commentmeta_key_idx').on(t.key),
  ],
);
