# Import and export (WXR)

Tools → Import and Tools → Export move content between Pressbase and WordPress sites in WordPress eXtended RSS (WXR 1.2), the format `wp-admin/includes/export.php` writes. Why it's built this way: [ADR 0013](../adr/0013-wxr-import-export.md).

| Piece | Where | WordPress |
| ----- | ----- | --------- |
| Records (the source-agnostic shapes) | `apps/core/src/import-export/records.ts` | `WXR_Parser`'s arrays (WordPress Importer plugin) |
| WXR reader (streaming) | `import-export/wxr-reader.ts` | `WXR_Parser_XML` |
| Writer (the import pipeline) | `import-export/writer.ts` | `WP_Import` |
| Content rewriting | `import-export/rewrite.ts` | `WP_Import::backfill_attachment_urls()` |
| Classic menus → block menus | `import-export/menus.ts` | `WP_Classic_To_Block_Menu_Converter` |
| Attachment downloads | `import-export/remote-file.ts` | `wp_safe_remote_get()`, `WP_Import::fetch_remote_file()` |
| PHP-serialized meta | `import-export/php-serialize.ts` | `maybe_serialize()`, `maybe_unserialize()` |
| Exporter | `import-export/exporter.ts` | `export_wp()` |
| Upload sessions and the job | `import-export/service.ts` | `wp_import_handle_upload()`, `wp_import_cleanup()` |
| REST | `routes/import-export.ts` | `wp-admin/import.php`, `wp-admin/export.php` |
| Admin screens | `apps/admin/src/components/tools/`, `lib/import-export.ts` | the importer's screens, `export.php` |
| WordPress database source | `import-export/wordpress-db-reader.ts`, `wordpress-db.ts` | the tables of `wp-admin/includes/schema.php` |
| WordPress database migration | `import-export/wordpress-migrate.ts` | — (see [below](#migrating-from-a-wordpress-database)) |

## The pipeline: sources and the writer

An import is a **source** that yields WordPress-shaped records, and the **writer** that imports them. The WXR reader is one source; a direct WordPress (MySQL) migration is meant to be another, reusing the writer unchanged.

```ts
interface ImportSource {
  records(signal?: AbortSignal): AsyncIterable<ImportRecord>;
}

type ImportRecord =
  | { kind: 'site'; site: ImportSite }        // base_site_url, base_blog_url, title…
  | { kind: 'author'; author: ImportAuthor }  // author_login, author_email, author_display_name…
  | { kind: 'term'; term: ImportTerm }        // term_taxonomy, slug, term_parent (a slug), termmeta
  | { kind: 'post'; post: ImportPost };       // any type, with terms, postmeta and comments
```

Field names are the WordPress Importer's (`post_title`, `post_date_gmt`, `comment_author_IP`…), and values are what WordPress stores: MySQL `Y-m-d H:i:s` dates (local and GMT), the source's IDs, and meta values as strings, PHP-serialized where WordPress serialized them. A MySQL reader can therefore pass rows almost as they come out of `wp_posts`, `wp_postmeta`, `wp_terms`, `wp_comments`.

The contract a source keeps:

- **Order:** the site first, then authors, then terms, then posts. Within those, anything may refer forward: a term's parent, a page's parent, a featured image, a menu item's target and a comment's parent are resolved when the source ends.
- **Streaming:** yield each record as it's read. The writer keeps only ID maps (old → new) and the pending forward references in memory.
- **Nav menus:** classic menus come as `nav_menu` terms plus `nav_menu_item` posts (with their `_menu_item_*` meta), exactly as WordPress stores them.

Running it:

```ts
import { runImport } from './import-export';
const report = await runImport(kernel, mySource, { user, fetchAttachments: true });
// or, by hand: new ImportWriter(kernel, options) → begin(), write(record)…, finish()
```

A MySQL migration will need things WXR doesn't carry (password hashes, user meta, SEO meta): extend `ImportAuthor` with optional fields and teach `#createUser()` to use them, rather than writing users around the writer.

## What the writer does

Per record, as `WP_Import` does:

- **Authors.** Each login maps to a user: the admin's choice (an existing user, or a new one), else an existing user with the same login, else a new user (with `create_users`), else the person importing. New users get the default role and a random password; one without an email address can't be created, so their posts go to the person importing (reported). A user with the same email is reused.
- **Terms.** Categories, tags and terms of registered taxonomies, with parents (by slug) and term meta. A term whose slug already exists in its taxonomy is reused. Terms of unregistered taxonomies are skipped and reported. Post formats (`post_format`, `post-format-gallery`) are kept: Pressbase registers the taxonomy (not in the REST API, as in WordPress).
- **Posts.** Any registered post type; others are skipped and counted per type ("This site has no “product” post type"). Saved through `kernel.posts.insert()` (so `save_post` and friends fire) with the original slug, status, dates, author, password, comment status and menu order, and without a revision. The original `guid` and modified date are kept. Content goes through kses unless the importing user has `unfiltered_html`. Sticky posts are added to `sticky_posts`.
- **Post meta.** Every row, unserialized into JSON. `_edit_lock` is dropped, `_edit_last` is mapped to the new user, `_thumbnail_id` waits for the attachment and is then remapped, and attachments' `_wp_attached_file`/`_wp_attachment_metadata` are recreated by the upload instead.
- **Comments.** Threaded (parents mapped), with their meta, status and user (mapped when the user was an author). Content goes through the comment kses unless the user has `unfiltered_html`.
- **Attachments**, when "Download and import file attachments" is on and the user can `upload_files`: the file is downloaded from `attachment_url` (or the guid), then stored with `uploadAttachment()`, so type checks, image sizes and metadata are the media library's. The original date is kept, so the file lands in its original `YYYY/MM` folder. Off, attachments are skipped and reported.
- **Classic menus** become published `wp_navigation` posts named after the menu, made of `navigation-link` and `navigation-submenu` blocks, as `WP_Classic_To_Block_Menu_Converter` builds them, with URLs from this site's permalinks. Items whose target wasn't imported are left out (their children move up) and reported. Pressbase doesn't pick a menu for the header: the newest published menu shows by default (see [Navigation](navigation.md)).

When the source ends (`finish()`): term and post parents that came later are linked, featured images remapped, and the content of every imported post is rewritten:

- old file URLs → the new files, and image sub-sizes with them (`photo-300x200.jpg` follows `photo.jpg`; only `-WxH`, `-scaled` and `-rotated` suffixes count, so `photo2.jpg` isn't caught);
- attachment IDs in blocks (image, cover, file, audio, video `id`; media & text `mediaId`; gallery `ids`; `wp-image-{id}` classes), synced pattern and navigation `ref`s, navigation link `id`s;
- `?p=`, `?page_id=`, `?attachment_id=` and `?cat=` links to the old site get the new IDs; any other link to the old site's address gets this site's address.

Those writes go straight to the database, so one `pressbase_cache_purge` of `site` follows.

### Re-running an import

Safe, and the way to resume. A post is "already there" when a post of the same type has the same date (to the second) and the same title or guid (WordPress's `post_exists()` uses title, date and type; the guid helps when a title was edited since). Existing posts are skipped, but new comments on them still come in (a comment exists when the post, author and date match). Existing terms, users and menus (same name) are skipped too. Everything skipped is listed in the report.

## Background jobs and the REST API

The admin's import runs as a `pressbase/import` job ([Jobs](jobs.md)), so it outlives the request:

| Method | Route | Does |
| ------ | ----- | ---- |
| POST | `/pressbase/v1/import` | The raw body is the file (`Content-Type: application/xml`, name in `Content-Disposition`). Streamed to `<dataDir>/imports/{id}.xml`, never held in memory, up to `PRESSBASE_MAX_IMPORT_MB` (default 1024). Read once to list its authors and count its content. → 201 with the summary, the site's users and what this user may do. Not WXR → 400 `wxr_invalid`. |
| GET | `/pressbase/v1/import` | The ten most recent imports. |
| GET | `/pressbase/v1/import/{id}` | `status` (`uploaded`, `queued`, `running`, `completed`, `failed`), `progress` (`done` of `total` items, `phase`, `current`), the `report`, and `error`. |
| POST | `/pressbase/v1/import/{id}/start` | `{ authors: { login: { action: 'map', user_id } \| { action: 'create' } }, fetch_attachments }` → 202, queued. `create` needs `create_users`, downloads need `upload_files`. A second start → 409. |
| DELETE | `/pressbase/v1/import/{id}` | Cancels a queued import and deletes the upload. A running one → 409. |
| GET | `/pressbase/v1/export` | The export form's choices: types, authors and months per type, categories, statuses. |
| GET | `/pressbase/v1/export/download` | `content` (`all`, a post type, or WordPress's `posts`/`pages`), `author`, `category` (ID or slug), `start_date`, `end_date` (`YYYY-MM`), `status` → the WXR file, streamed, as `sitename.WordPress.YYYY-MM-DD.xml`. |

Capabilities: `import` and `export` (administrators). The job writes progress into its own row (`jobs.data`) at most once a second; the final report is also kept in `{id}.json` after the job row is pruned, and the uploaded XML is deleted once imported (`wp_import_cleanup()`). Uploads never started and old reports are deleted after a week. A job that dies (a restart) is retried up to three times; thanks to the matching above, a retry skips what's done. The job's timeout is four hours.

The uploaded file lives on the local disk of the process that received it, so the worker must share that data directory (true for a single core process, or several on one host).

## Downloading attachments safely

`fetchRemoteFile()` is `wp_safe_remote_get()`:

- `http` and `https` only, on ports 80, 443 and 8080; no credentials in the URL;
- private, loopback, link-local (cloud metadata), unique-local, CGNAT, multicast and unspecified addresses are refused. The check runs in the DNS lookup of the actual connection, so DNS rebinding can't get round it, and every redirect is checked again;
- at most 5 redirects, 60 seconds, and the upload limit (`PRESSBASE_MAX_UPLOAD_MB`, or less with `import_attachment_size_limit`), checked against `Content-Length` and while reading.

`PRESSBASE_IMPORT_ALLOW_PRIVATE_HOSTS=1` lifts the address and port checks for imports from a site on your own network; the `http_request_host_is_external` filter can allow single hosts.

## Exporting

`export_wp()`, streamed: post IDs are snapshotted, then posts are written 20 at a time. All content means every registered post type except revisions (wp_navigation menus and synced patterns included), every category, tag and custom taxonomy term (parents first), and the authors of the exported posts. A single type can be filtered by author, category (posts), date range and status (posts and pages), and brings the attachments and featured images of the chosen posts, as WordPress does. Meta values are written as WordPress stores them: arrays and objects PHP-serialized, `true` as `1`. Spam comments and `_edit_lock` are left out. WordPress's importer reads the file; Pressbase's reads it back (the round-trip test exports a site and compares a fresh import of it).

## For the CLI and scripts

```ts
import { exportWxr, importWxr } from './import-export';
const report = await importWxr(kernel, { path: 'site.xml' }, { userId: 1, fetchAttachments: true });
await exportWxr(kernel, { content: 'post', status: 'publish' }, createWriteStream('posts.xml'));
```

`importWxr()` runs in the calling process (no job), with every `ImportOptions` field (`authors`, `fetchAttachments`, `onProgress`, `signal`…). `scanWxr()` gives the summary without importing; `generateWxr()` yields the export's chunks.

## Hooks

The importer fires the WordPress Importer's per-item hooks. Its whole-array filters (`wp_import_posts`, `wp_import_categories`, `wp_import_tags`, `wp_import_terms`) don't exist, because the file is never held whole.

| Hook | Type | Arguments |
| ---- | ---- | --------- |
| `import_start`, `import_end` | action | — |
| `import_done` | action | `'wordpress'` |
| `wp_import_post_data_raw` | filter | `post` (the record) |
| `wp_import_existing_post` | filter | `postId` (0 for none), `post` |
| `wp_import_post_data_processed` | filter | `postdata`, `post` |
| `wp_import_insert_post` | action | `postId`, `originalId`, `postdata`, `post` |
| `wp_import_post_terms`, `wp_import_post_comments`, `wp_import_post_meta` | filter | list, `postId`, `post` |
| `wp_import_insert_term` | action | `{ term_id }`, `term`, `postId`, `post` |
| `wp_import_set_post_terms` | action | `ttIds`, `termIds`, `taxonomy`, `postId`, `post` |
| `wp_import_insert_comment` | action | `commentId`, `comment`, `postId`, `post` |
| `import_post_meta_key` | filter | `key`, `postId`, `post` (empty skips the row) |
| `import_post_meta` | action | `postId`, `key`, `value` |
| `wp_import_term_meta`, `import_term_meta_key`, `import_term_meta` | filter/filter/action | as the post meta ones, for terms |
| `import_allow_create_users`, `import_allow_fetch_attachments` | filter | `true` |
| `import_attachment_size_limit` | filter | `0` (the upload limit) |
| `http_request_host_is_external` | filter | `false`, `host`, `url` |
| `export_wp` | action | `args` |
| `export_args`, `export_wp_filename` | filter | `args`; `filename`, `sitename`, `date` |
| `the_title_export`, `the_content_export`, `the_excerpt_export` | filter | the value |
| `wxr_export_skip_postmeta`, `wxr_export_skip_commentmeta`, `wxr_export_skip_termmeta` | filter | `false`, `key`, `meta` |

## Migrating from a WordPress database

`pressbase migrate wordpress` ([CLI](../development/cli.md#migrate-wordpress)) and `migrateFromWordPressDatabase(kernel, options)` read a WordPress site straight from its MySQL or MariaDB database, so more comes over than WXR carries: passwords, roles and profiles, settings, and every post type. Why it's built this way: [ADR 0016](../adr/0016-wordpress-database-migration.md).

```ts
import { migrateFromWordPressDatabase } from './import-export';
const result = await migrateFromWordPressDatabase(kernel, {
  database: 'mysql://reader:secret@db.internal/wordpress?ssl-mode=VERIFY_IDENTITY',
  prefix: 'wp_',
  uploads: '/backups/wp-content/uploads', // leave out to download files from the old site
  userId: 1,
  // dryRun: true, skip: ['attachment', 'comments', 'options'], uploadsUrl: 'https://cdn.example/uploads'
});
// result.counts: what the source holds; result.report: the ImportReport;
// result.options: the settings carried and refused.
```

`WordPressDatabaseSource` is an `ImportSource` like the WXR reader, so the writer above does all the writing: re-runs skip what's there, classic menus become block menus, and content is rewritten to the new IDs and address.

**What's read.** Single sites only: a database with a `{prefix}blogs` table is a multisite network and is refused. Tables are read in pages by ID (keyset pagination: 500 users or terms at a time, 100 posts with their meta, terms and comments), never whole. Table and column names are WordPress 7.1's (`wp-admin/includes/schema.php`).

| WordPress | Becomes |
| --------- | ------- |
| `wp_users`, `wp_usermeta` | Users. The password hash (`user_pass`: `$wp$` bcrypt, bcrypt, phpass or old MD5) is kept, so people log in with their old password, which is then re-hashed with scrypt ([ADR 0005](../adr/0005-password-hashing.md)). Roles from `{prefix}capabilities` (roles this site has, when the person migrating has `promote_users`; otherwise the default role), `display_name`, `user_nicename`, `user_url`, `user_registered`, and the meta `first_name`, `last_name`, `nickname`, `description` and `locale` (a language not installed here falls back to the site's). Other user meta (sessions, screen options, plugin data) isn't carried. A user already here with the same username or email address is matched, not duplicated, and keeps their own password. |
| `wp_terms`, `wp_term_taxonomy`, `wp_termmeta` | Terms of every registered taxonomy, with parents and meta. `nav_menu` terms become block menus; `link_category` is ignored. |
| `wp_posts`, `wp_postmeta`, `wp_term_relationships` | Posts of every type (pages, attachments, `nav_menu_item`, `wp_navigation`, synced patterns…), with meta and terms. Revisions and auto-drafts are left out, as `export_wp()` does; types this site doesn't have are reported. Sticky posts come from the `sticky_posts` option. |
| `wp_comments`, `wp_commentmeta` | Comments, threaded, linked to their commenters' accounts. Spam is left out, as `export_wp()` does. |
| `wp_options` | The settings below. |

**Settings carried** (`CARRIED_OPTIONS`; `skip: ['options']` keeps this site's). Before the content, so dates, folders and image sizes follow them: `blogname`, `blogdescription`, `timezone_string` (or `gmt_offset`, as `Etc/GMT±N`, when it's a whole hour), `WPLANG` (as `locale`, if that language is installed), `date_format`, `time_format`, `start_of_week`, `posts_per_page`, `posts_per_rss`, `rss_use_excerpt`, `show_on_front`, `default_comment_status`, `default_ping_status`, `comment_moderation`, `comment_registration`, `thread_comments`, `thread_comments_depth`, `comments_per_page`, `blog_public`, `uploads_use_yearmonth_folders`, the thumbnail, medium, medium_large and large sizes, `thumbnail_crop`, and `permalink_structure`, `category_base` and `tag_base` (through Settings → Permalinks' checks). After the content, with the new IDs: `page_on_front`, `page_for_posts` and `default_category`. Values pass the same validation as the settings screens; refused ones are reported. Not carried: `siteurl` and `home` (the new site keeps its address), `admin_email`, plugins, themes, widgets, role definitions (`wp_user_roles`), cron and transients.

**Media.** Attachments keep their parents, featured images (`_thumbnail_id`), galleries (block `ids` and classic `[gallery ids="…"]`), alt text and captions. A file's old address is the old uploads URL (`upload_url_path`, else `siteurl` plus `upload_path` or `/wp-content/uploads`; `uploadsUrl` overrides it) plus its `_wp_attached_file`.

- With `uploads` (a local copy of `wp-content/uploads`; preferred, as it needs no network), files are read from that folder. Paths can't leave it (symlinks included), and a missing file is reported as an error rather than downloaded.
- Without it, and for URLs outside the old uploads address (files offloaded to a CDN), files are downloaded through the guarded downloader above.

Files keep their `YYYY/MM` folder from `_wp_attached_file` (WordPress files an upload in its parent post's month, so it can differ from the attachment's own date), and image sub-sizes are regenerated with this site's sizes.

**SEO meta.** Yoast SEO (`_yoast_wpseo_*`) and Rank Math (`rank_math_*`) post meta and term meta are kept exactly as they were. Yoast keeps term fields in the `wpseo_taxonomy_meta` option rather than in term meta; they're attached to their terms as term meta under Yoast's keys (`wpseo_title`, `wpseo_desc`, `wpseo_focuskw`…). The primary-category meta (`_yoast_wpseo_primary_{taxonomy}`, `rank_math_primary_{taxonomy}`) holds a term ID, so it's remapped. No Pressbase-neutral SEO fields (such as `_pressbase_seo_title`) are written: both plugins store templates with their own variables (`%%sitename%%`, `%sep%`), so a neutral copy would either be wrong or need their template engines. An SEO plugin for Pressbase can read these keys.

**Security.**

- Every query is a `SELECT`, run inside `START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT`. A MySQL user with only `SELECT` is enough, and recommended: `CREATE USER 'pressbase_reader'@'%' IDENTIFIED BY '…'; GRANT SELECT ON wordpress.* TO 'pressbase_reader'@'%';`
- The connection password is never printed: URLs are shown as `mysql://reader:***@host/db`, and driver errors are filtered.
- TLS is used when the URL asks for it. `ssl-mode=VERIFY_IDENTITY` or `VERIFY_CA` (also `ssl=true`, `sslmode=verify-full`) verify the server's certificate; `ssl-mode=REQUIRED` (`sslmode=require`) encrypts without verifying, as MySQL's client does; `ssl-ca=/path/ca.pem` trusts a CA. With `ssl-mode=DISABLED`, or no parameter, there's no TLS.
- The table prefix must match `[A-Za-z0-9_]+`; every value is a bound parameter.
- Password hashes are written to `users.pass` only: never to the report, the progress or the logs.

**No admin screen.** Taking database credentials in a web form (and letting the server connect wherever a browser says) is a security decision for later. For now the migration is the CLI and the core function.

**Tests without MySQL.** The reader talks to a small query interface (`WordPressDatabase`, one method per query). `memoryWordPressDatabase()` answers it from hand-written rows modelled on a WordPress 7.1 database (`wordpress-db-fixture.ts`, with an image in `fixtures/wp-uploads`), and `wordpress-migrate.test.ts` migrates them into PGlite. The `wordpress-mysql` CI job loads the same rows into MySQL 8 with WordPress's schema, checks that the SQL returns what the fake does, record for record, and migrates as a SELECT-only user (`wordpress-db.mysql.test.ts`, skipped unless `PRESSBASE_TEST_MYSQL_URL` is set).

## Not yet

- Slugs: Pressbase's `sanitize_title()` keeps ASCII only, so non-Latin slugs (`%d0%bf…`) are re-made from the title.
- The REST `format` field still says `standard`; imported formats are stored and exported, not shown.
- Comments' `wp_filter_comment()` hooks (`pre_comment_content`…) don't run during an import.
- A theme's menu locations aren't in WXR; choose the header menu in Appearance → Menus.
- Uploads through the admin pass the Next.js proxy; for very large files, `importWxr()` (the CLI) avoids it.
- WordPress database migration: multisite networks; links (`wp_links`); widgets, theme mods and menu locations; plugin tables other than meta.
