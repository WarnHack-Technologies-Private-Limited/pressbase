# WordPress → Pressbase map

If you know WordPress, use this page to find the equivalent here. The reference copy of WordPress used while porting is 7.1.3. Paths in the left column are relative to a WordPress install.

## Implemented

| WordPress                                                           | Pressbase                                                                                | Notes                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `wp-settings.php` (bootstrap)                                       | `apps/core/src/kernel.ts`                                                            | Explicit boot phases; no globals.                                  |
| `wp-config.php`                                                     | `<dataDir>/config.json` + environment variables                                      | Written by the installer with mode 0600. Env vars win.             |
| `wp-admin/setup-config.php`, `install.php`                          | `apps/core/src/routes/install.ts`, `apps/admin/src/components/install/installer.tsx` | One flow; the database step is skipped when `DATABASE_URL` is set. |
| `wp_install()`, `populate_options()`                                | `apps/core/src/install/installer.ts`                                                 | Same defaults and sample content, in one transaction.              |
| `wp-admin/includes/schema.php`                                      | `packages/db/src/schema.ts`                                                          | See [Database](database.md).                                       |
| `wpdb`                                                              | Drizzle ORM (`kernel.db`)                                                            | Typed queries; raw SQL through `sql\`\``.                          |
| `WP_Hook`, `add_filter`, `apply_filters`, `do_action`, `did_action` | `packages/hooks` (`HookBus`)                                                         | Async-aware. See [Hooks](hooks.md).                                |
| `get_option`, `update_option`, `delete_option`                      | `kernel.options.get / set / delete`                                                  | Values are JSON, not serialized PHP.                               |
| `register_setting`, `/wp/v2/settings`                               | `apps/core/src/options/settings.ts`, `routes/settings.ts`                            | Same REST field names.                                             |
| `populate_roles()`, `WP_Roles`                                      | `apps/core/src/auth/capabilities.ts`                                                 | Same roles and capabilities, without the legacy `level_*` ones.    |
| `current_user_can()`                                                | `userCan(user, cap)`                                                                 | Primitive capabilities only, until `map_meta_cap` arrives in v0.2. |
| `wp_signon`, auth cookies                                           | `routes/auth.ts`, `auth/sessions.ts`                                                 | Sessions in their own table. Same 2- and 14-day lifetimes.         |
| `wp_hash_password`                                                  | `auth/password.ts`                                                                   | scrypt. Verifying WordPress hashes on migration comes in v0.6.     |
| REST error shape (`WP_Error` → JSON)                                | `restError()` in `apps/core/src/http.ts`                                             | `{ code, message, data: { status } }`.                             |
| `X-WP-Nonce` (REST CSRF)                                            | `X-Pressbase-Request` header                                                             | See [Security](security.md).                                       |
| `wp-admin/` menu                                                    | `apps/admin/src/lib/sections.ts`                                                     | Same order, grouped.                                               |
| `date_i18n()` formats                                               | `apps/admin/src/lib/php-date.ts`                                                     | PHP date format characters.                                        |
| `register_post_type`, `create_initial_post_types` | `apps/core/src/content/post-types.ts` | `kernel.postTypes.register(name, args)`. |
| `register_post_status` | `apps/core/src/content/post-statuses.ts` | Same core statuses and flags. |
| `register_taxonomy`, `create_initial_taxonomies` | `apps/core/src/content/taxonomies.ts` | `category` and `post_tag`. |
| `map_meta_cap`, `current_user_can( $cap, $id )` | `apps/core/src/auth/meta-caps.ts` | `currentUserCan(kernel, user, 'edit_post', id)`. |
| `wp_insert_post`, `wp_update_post`, `wp_trash_post`, `wp_untrash_post`, `wp_delete_post`, `wp_unique_post_slug`, `wp_save_post_revision` | `apps/core/src/content/posts.ts` (`kernel.posts`) | Same hooks and slug rules. Untrash restores to draft (WordPress 5.6+). |
| `wp_insert_term`, `wp_update_term`, `wp_delete_term`, `wp_set_object_terms`, `_update_post_term_count` | `apps/core/src/content/terms.ts` (`kernel.terms`) | |
| `WP_Query` | `apps/core/src/content/query.ts` (`queryPosts`) | Same argument names. |
| `get_permalink` | `apps/core/src/content/permalinks.ts` | Uses `permalink_structure`. |
| `wp_kses_post`, `sanitize_title` | `apps/core/src/content/sanitize.ts` | Keeps block delimiters intact. |
| `WP_REST_Posts_Controller`, `WP_REST_Terms_Controller`, `WP_REST_Users_Controller` (read), types / taxonomies / statuses controllers | `apps/core/src/routes/posts.ts`, `terms.ts`, `users.ts`, `types.ts` | See [REST API](rest-api.md). |
| `parse_blocks`, `serialize_blocks`, `WP_Block_Parser` | `packages/blocks` (`parseBlocks`, `serializeBlocks`) | Same output shape. See [Blocks](blocks.md). |
| `WP_Block_Type_Registry`, `register_block_type` | `BlockTypeRegistry`; `kernel.blocks.registerBlockType()` | Keys follow `block.json`. |
| `WP_Block`, `render_block`, `do_blocks` | `packages/blocks/src/block.ts`; `kernel.blocks.render()` | Async render callbacks; same filters. |
| `esc_html`, `esc_attr`, `esc_url` | `escHtml`, `escAttr`, `escUrl` in `@pressbase/blocks` | |
| `wp-includes/blocks/*.php` (dynamic blocks) | `apps/core/src/blocks/library/` | Latest posts, categories, archives, tag cloud, page list, search, site title and tagline, login/out, synced pattern, post title/date/excerpt/author/terms, and the comment blocks. |
| `register_block_pattern`, `register_block_pattern_category` | `kernel.blocks.registerBlockPattern()`, `registerBlockPatternCategory()` | |
| `WP_REST_Block_Types_Controller`, `WP_REST_Block_Renderer_Controller`, `WP_REST_Block_Patterns_Controller`, `WP_REST_Block_Pattern_Categories_Controller`, `WP_REST_Blocks_Controller` | `apps/core/src/routes/blocks.ts` | See [REST API](rest-api.md). |
| `wp_handle_upload()`, `wp_unique_filename()`, `sanitize_file_name()`, `wp_check_filetype_and_ext()`, `wp_create_image_subsizes()`, `wp_delete_attachment()` | `apps/core/src/media/` | Storage adapters instead of direct disk writes; sharp instead of GD/Imagick. See [Media](media.md). |
| `WP_REST_Attachments_Controller` | `apps/core/src/routes/media.ts` | |
| `upload.php`, `options-media.php`, the media modal | `/admin/media`, `/admin/settings/media`, `MediaPicker` | |
| `wp_new_comment()`, `wp_allow_comment()`, `check_comment()`, `wp_check_comment_disallowed_list()`, `wp_insert_comment()`, `wp_update_comment()`, `wp_set_comment_status()`, `wp_trash_comment()`, `wp_spam_comment()`, `wp_delete_comment()`, `wp_update_comment_count()`, `wp_count_comments()`, `WP_Comment_Query` | `apps/core/src/comments/service.ts` (`kernel.comments`) | See [Comments](comments.md). Disallowed keys mark spam rather than trash. |
| `get_comment_link()`, `get_page_of_comment()`, `get_avatar_url()`, `wp_rel_ugc()`, `$allowedtags` | `apps/core/src/comments/links.ts`, `format.ts` | |
| `WP_REST_Comments_Controller` | `apps/core/src/routes/comments.ts` | Anonymous comments allowed by default. |
| `wp-comments-post.php` | `POST /wp-comments-post`, `apps/core/src/routes/comments-post.ts` | |
| `edit-comments.php`, `options-discussion.php` | `/admin/comments`, `/admin/settings/discussion` | |
| `edit.php`, `post.php`, `edit-tags.php`, `options-reading.php`, `options-writing.php` | `/admin/posts`, `/admin/posts/{id}`, `/admin/posts/categories`, `/admin/settings/reading`, `/admin/settings/writing` | |

## Planned

| WordPress                                      | Pressbase (planned)                             | Release |
| ---------------------------------------------- | ------------------------------------------- | ------- |
| Autosave | Autosaves endpoint, with the block editor | v0.3 |
| Application passwords                          | `Authorization: Basic` in core              | v0.2    |
| `WP_Theme_JSON`, template loader, `WP_Rewrite` | `packages/theme-json`, router in `apps/web` | v0.4    |
| Plugins API, `activate_plugin`                 | Plugin loader + `plugin.json`               | v0.5    |
| `wp-cron.php`                                  | pg-boss job queue                           | v0.5    |
| Importer, wp-cli                               | Migration tool, `pressbase` CLI                 | v0.6    |
| `__()`, text domains                           | `@wordpress/i18n`, `.po`/`.mo`              | v0.6    |
| Abilities API (WordPress 7)                    | Abilities registry + MCP server             | later   |

## Dropped on purpose

| WordPress                           | Why                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------- |
| XML-RPC (`xmlrpc.php`)              | Superseded by the REST API, and a common attack surface.                  |
| Trackbacks and pingbacks            | Mostly spam today. The `ping_status` column stays for data compatibility. |
| Links manager (`wp_links`)          | Hidden in WordPress since 3.5.                                            |
| PHP serialization in the database   | JSONB is queryable and safe to read.                                      |
| `level_0` … `level_10` capabilities | Deprecated since WordPress 3.0.                                           |
