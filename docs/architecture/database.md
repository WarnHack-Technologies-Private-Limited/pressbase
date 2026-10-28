# Database

The schema lives in `packages/db/src/schema.ts`. Pressbase keeps WordPress's data model, so content, plugins and migrations map cleanly, and modernises the details.

## Conventions

| Rule                                                                     | Why                                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Table names without a prefix (`posts`, not `wp_posts`).                  | Isolation belongs to PostgreSQL schemas, not name prefixes.                  |
| Column names without the table prefix (`posts.title`, not `post_title`). | Readable; the REST layer maps names back to WordPress's.                     |
| `bigserial` IDs, read as JS numbers.                                     | Same IDs as WordPress, so REST responses and imports line up.                |
| Missing relations are `NULL` with a real foreign key, never `0`.         | The database enforces integrity; the REST layer turns `NULL` into `0`.       |
| One `timestamptz` instead of each local + GMT pair.                      | One source of truth; convert with the `timezone_string` option when showing. |
| Option and meta values are `jsonb`.                                      | Structured, queryable, and safe (unlike PHP `unserialize`).                  |
| Unique logins and emails, case-insensitively (`lower()` indexes).        | WordPress enforces this in PHP; Pressbase enforces it in the database.           |

## Tables

| Pressbase                | WordPress                     | Purpose                                                                           |
| -------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `options`            | `wp_options`                  | Site settings. `autoload` is a boolean.                                           |
| `users`              | `wp_users`                    | Accounts.                                                                         |
| `usermeta`           | `wp_usermeta`                 | Per-user data, including `capabilities` (roles and grants).                       |
| `sessions`           | _(usermeta `session_tokens`)_ | Login sessions; SHA-256 of the token only.                                        |
| `posts`              | `wp_posts`                    | Posts, pages, attachments, revisions, any custom type.                            |
| `postmeta`           | `wp_postmeta`                 | Per-post data.                                                                    |
| `terms`              | `wp_terms`                    | Term names and slugs.                                                             |
| `term_taxonomy`      | `wp_term_taxonomy`            | Which taxonomy a term belongs to, and its parent and count.                       |
| `term_relationships` | `wp_term_relationships`       | Object ↔ term links.                                                              |
| `termmeta`           | `wp_termmeta`                 | Per-term data.                                                                    |
| `jobs`               | _(the `cron` option)_         | Background jobs and cron events. See [Jobs and cron](jobs.md).                    |
| `comments`           | `wp_comments`                 | Comments. `approved` keeps WordPress's values: `'1'`, `'0'`, `'spam'`, `'trash'`. |
| `commentmeta`        | `wp_commentmeta`              | Per-comment data.                                                                 |

### Column mapping for `posts`

| Pressbase                           | WordPress                                    |
| ------------------------------- | -------------------------------------------- |
| `id`                            | `ID`                                         |
| `author_id`                     | `post_author`                                |
| `date`                          | `post_date_gmt` (`post_date` is derived)     |
| `modified`                      | `post_modified_gmt`                          |
| `content`, `title`, `excerpt`   | `post_content`, `post_title`, `post_excerpt` |
| `status`                        | `post_status`                                |
| `comment_status`, `ping_status` | same                                         |
| `password`                      | `post_password`                              |
| `slug`                          | `post_name`                                  |
| `content_filtered`              | `post_content_filtered`                      |
| `parent_id`                     | `post_parent`                                |
| `guid`, `menu_order`            | same                                         |
| `type`                          | `post_type`                                  |
| `mime_type`                     | `post_mime_type`                             |
| `comment_count`                 | same                                         |
| _(dropped)_                     | `to_ping`, `pinged`                          |

Other tables follow the same pattern: remove the table prefix, use snake_case, and add `_id` to foreign keys.

## Important options

| Option                                          | Meaning                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `pressbase_db_version`                              | **Its presence marks the site as installed.** It also drives data upgrades. |
| `user_roles`                                    | Role definitions (`RoleMap`). Plugins may add roles here.                   |
| `siteurl`, `home`                               | Site address, without a trailing slash.                                     |
| `blogname`, `blogdescription`                   | Title and tagline.                                                          |
| `timezone_string`, `date_format`, `time_format` | Display preferences, in PHP `date()` format.                                |
| `blog_public`                                   | `false` asks search engines not to index the site.                          |

## Migrations

```bash
# 1. Edit packages/db/src/schema.ts
pnpm db:generate          # 2. drizzle-kit writes packages/db/migrations/NNNN_*.sql
# 3. Read the SQL, commit it with the schema change
```

- Migrations run automatically on every boot (`Kernel.useDatabase`). They are idempotent and tracked in `drizzle.__drizzle_migrations`.
- **Never edit a migration after it ships.** Add a new one.
- If a change also needs data transformed, bump `DB_VERSION` in `apps/core/src/version.ts` and add the upgrade routine to `Kernel.refreshState`. This is WordPress's `wp_upgrade()` pattern.

## Drivers

`connect(url)` in `packages/db/src/index.ts` picks the driver from the URL:

| URL                               | Driver                   | Use                                               |
| --------------------------------- | ------------------------ | ------------------------------------------------- |
| `postgres://…` / `postgresql://…` | postgres-js              | Production and development. PostgreSQL 14+.       |
| `pglite:<directory>`              | PGlite (WASM PostgreSQL) | Trying Pressbase with no server. Single process only. |
| `pglite:memory`                   | PGlite, in memory        | Tests.                                            |
