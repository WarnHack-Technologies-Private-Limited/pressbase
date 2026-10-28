# 0016: Migrating from a WordPress database with mysql2, behind a query interface

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

WXR (ADR 0013) carries content but not what makes a site feel moved: people's passwords, roles and profiles, the site's settings, and plugin data stored where WXR doesn't look (Yoast SEO's term fields live in an option). WordPress's own database has all of it, and Pressbase already checks WordPress password hashes at login (ADR 0005). So v0.6 reads a WordPress site straight from MySQL or MariaDB.

Constraints:

- Pressbase runs on Node and PostgreSQL; nothing in it talks to MySQL yet.
- Sites can be large: wp_posts and wp_postmeta run to millions of rows.
- The database is someone's live site. A migration must not be able to change it, and its password must not leak into logs or terminals.
- Contributors and the default CI don't have MySQL.
- The import writer (writer.ts) already does everything on the write side for any `ImportSource`.

## Decision

1. **A new source, the same writer.** `WordPressDatabaseSource` (import-export/wordpress-db-reader.ts) yields the same records a WXR file gives, in the writer's order: site, users, terms, posts with their meta, terms and comments. Nothing is written around the writer: `ImportAuthor` gained optional fields (password hash, nicename, URL, registration date, roles, user meta) and the writer's `#createUser()` uses them. Re-running, menus, featured images and content rewriting behave exactly as for WXR.
2. **The SQL sits behind a small interface.** `WordPressDatabase` (import-export/wordpress-db.ts) has one method per query (`users(after, limit)`, `postmeta(ids)`, `comments(postIds, after, limit)`…). The mysql2 implementation holds all the SQL; an in-memory implementation over hand-written fixture rows (wordpress-db-fixture.ts) answers the same calls. Tests run the reader and the whole migration on the fake and PGlite. A CI job (`wordpress-mysql`, `services: mysql:8`) loads the same rows into real MySQL and checks the SQL returns exactly what the fake does, then migrates as a SELECT-only user.
3. **Keyset pagination.** Every table is read by ID in pages (`WHERE ID > ? ORDER BY ID LIMIT ?`): 500 users or terms, 100 posts (with their meta, terms and comments; comments in pages of 1,000). Memory stays flat whatever the site's size, and pages stay fast where OFFSET would slow down.
4. **Read-only.** Every query is a SELECT, inside `START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT`: the server refuses writes, and a live site's tables are read as of one moment. A MySQL user with only `SELECT` on the database is enough. The table prefix goes into SQL, so it must match `[A-Za-z0-9_]+`; every value is a bound parameter.
5. **Secrets.** Connection URLs are printed with the password as `***`; driver errors pass through a filter that removes the password. TLS is used when the URL asks for it (`ssl-mode=VERIFY_IDENTITY`/`VERIFY_CA` verify the certificate, `REQUIRED` only encrypts, as MySQL's client does). The CLI also reads the URL from `PRESSBASE_WP_DB_URL`, to keep it out of shell history. Password hashes go into `users.pass` and nowhere else: not the report, not the logs.
6. **mysql2** is the driver. It's pure JavaScript (no native build, like the rest of Pressbase: scrypt, bcryptjs, PGlite), maintained, promise-based, speaks both MySQL 8's `caching_sha2_password` and MariaDB, does TLS, and can return `DATETIME` as strings (`dateStrings`), which keeps WordPress's zero dates (`0000-00-00 00:00:00`) intact. It's loaded with a dynamic `import()`, so it costs nothing until a migration runs. drizzle-orm lists mysql2 as an optional peer; a pnpm override (`drizzle-orm>mysql2: "-"`) keeps core on the same drizzle-orm copy as `@pressbase/db`, since a second copy breaks its types.
7. **No admin screen yet.** Typing database credentials into a web form, and letting the server connect to arbitrary hosts on behalf of a browser, is a security decision of its own. The migration is the CLI (`pressbase migrate wordpress`) and a core function (`migrateFromWordPressDatabase()`).
8. **SEO meta stays as it is.** Yoast SEO (`_yoast_wpseo_*`) and Rank Math (`rank_math_*`) post and term meta are copied untouched; Yoast's term fields, kept in the `wpseo_taxonomy_meta` option, become term meta under Yoast's own keys (`wpseo_title`, `wpseo_desc`…). The primary-term meta (`_yoast_wpseo_primary_{taxonomy}`, `rank_math_primary_{taxonomy}`) holds a term ID, so it's remapped. No neutral `_pressbase_seo_*` pair is written: both plugins store templates (`%%title%% %%sep%% %%sitename%%`, `%title% %sep%`) whose variables only they expand, so a copy would be either wrong or a template engine of its own. A future SEO plugin can read the original keys.

## Consequences

- One more runtime dependency in core (mysql2 and 7 small dependencies), and an override in pnpm-workspace.yaml.
- The fake must keep answering like the SQL does; the CI job compares them record by record, so a drift fails the build.
- Everything the writer learns (hashes, roles, folders, primary terms) also helps WXR imports when a source fills those fields.
- Multisite networks are refused (a `{prefix}blogs` table); migrating one site of a network needs per-site prefixes and the shared users table, which is later work.

## Alternatives considered

- **`mysql` (the original driver).** Unmaintained since 2020 and lacks `caching_sha2_password`, MySQL 8's default.
- **`mariadb` (MariaDB's connector).** Maintained and fast, but MySQL 8 support is secondary to MariaDB's.
- **Drizzle's MySQL dialect.** A schema for WordPress's tables to run ten SELECTs, and the same peer-dependency problem.
- **Asking for a `mysqldump` file.** No server needed, but parsing MySQL's SQL dialect is a project in itself, and dumps are as big as the site. A database URL works with a local copy as well as a live server.
- **Raw SQL against a fake that parses SQL** (an in-memory SQL engine). Heavier than the interface, and still not MySQL; the CI job covers the real thing.
