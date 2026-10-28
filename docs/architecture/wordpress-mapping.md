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
| `wp_hash_password`, `wp_check_password`, `PasswordHash` (phpass)    | `auth/password.ts`                                                                   | scrypt. Imported WordPress hashes (`$wp$2y$`, bcrypt, phpass `$P$`, MD5) are verified, then re-hashed on login. |
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
| `options-permalink.php`, `WP_Rewrite::set_permalink_structure()`, `set_category_base()`, `set_tag_base()` | `apps/core/src/routes/permalinks.ts` (`/pressbase/v1/permalinks`), Settings → Permalinks | See [The public site](public-site.md#permalinks). |
| `wp_head()`, `wp_footer()`, `wp_body_open()`, `WP_Scripts`, `WP_Styles`, `wp_enqueue_script()`, `wp_enqueue_style()` | `apps/core/src/frontend/head.ts`, `dependencies.ts` (`kernel.scripts`, `kernel.styles`) | See [Scripts and styles](scripts-and-styles.md). |
| `wp_kses_post`, `sanitize_title` | `apps/core/src/content/sanitize.ts` | Keeps block delimiters intact. |
| `WP_REST_Posts_Controller`, `WP_REST_Terms_Controller`, `WP_REST_Users_Controller`, types / taxonomies / statuses controllers | `apps/core/src/routes/posts.ts`, `terms.ts`, `users.ts`, `types.ts` | See [REST API](rest-api.md). |
| `parse_blocks`, `serialize_blocks`, `WP_Block_Parser` | `packages/blocks` (`parseBlocks`, `serializeBlocks`) | Same output shape. See [Blocks](blocks.md). |
| `WP_Block_Type_Registry`, `register_block_type` | `BlockTypeRegistry`; `kernel.blocks.registerBlockType()` | Keys follow `block.json`. |
| `WP_Block`, `render_block`, `do_blocks` | `packages/blocks/src/block.ts`; `kernel.blocks.render()` | Async render callbacks; same filters. |
| `esc_html`, `esc_attr`, `esc_url` | `escHtml`, `escAttr`, `escUrl` in `@pressbase/blocks` | |
| `wp-includes/blocks/*.php` (dynamic blocks) | `apps/core/src/blocks/library/` | Latest posts, categories, archives, tag cloud, page list, search, site title and tagline, login/out, synced pattern, post title/date/excerpt/author/terms, and the comment blocks. |
| `register_block_pattern`, `register_block_pattern_category` | `kernel.blocks.registerBlockPattern()`, `registerBlockPatternCategory()` | |
| `WP_REST_Block_Types_Controller`, `WP_REST_Block_Renderer_Controller`, `WP_REST_Block_Patterns_Controller`, `WP_REST_Block_Pattern_Categories_Controller`, `WP_REST_Blocks_Controller` | `apps/core/src/routes/blocks.ts` | See [REST API](rest-api.md). |
| `wp_handle_upload()`, `wp_unique_filename()`, `sanitize_file_name()`, `wp_check_filetype_and_ext()`, `wp_create_image_subsizes()`, `wp_delete_attachment()` | `apps/core/src/media/` | Storage adapters instead of direct disk writes; sharp instead of GD/Imagick. See [Media](media.md). |
| `WP_REST_Attachments_Controller` | `apps/core/src/routes/media.ts` | |
| `WP_Theme_JSON`, `WP_Theme_JSON_Resolver`, `wp_get_global_stylesheet()`, `wp_get_typography_font_size_value()`, `wp_get_layout_style()`, `WP_Font_Face` | `packages/theme-json` | See [Themes](themes.md). |
| `WP_Theme`, `wp_get_themes()`, `switch_theme()`, `_register_theme_block_patterns()` | `apps/core/src/themes/` (`kernel.themes`) | Pattern PHP is interpreted, never run. |
| `block-supports/layout.php`, `elements.php`, `position.php`, `block-style-variations.php` | `apps/core/src/themes/supports.ts` | Render filters. |
| `WP::parse_request()`, `WP_Rewrite` rules, the main `WP_Query`, `redirect_canonical()` | `apps/core/src/frontend/query.ts` | |
| `template-loader.php`, `get_*_template()` | `apps/core/src/frontend/hierarchy.ts` | |
| `template-canvas.php`, `get_the_block_template_html()`, `wp_get_document_title()`, `get_body_class()` | `apps/core/src/frontend/render.ts` | |
| `WP_REST_Themes_Controller` | `apps/core/src/routes/themes.ts` | Plus theme activation. |
| `feed-rss2.php`, `feed-rss2-comments.php`, `feed-atom.php`, `feed-atom-comments.php`, `do_feed()`, `feed_links()`, `feed_links_extra()` | `apps/core/src/frontend/feeds.ts` | RSS 2.0 and Atom; `rss` and `rdf` answer RSS 2.0. See [The public site](public-site.md). |
| `WP_Sitemaps` and its providers, `WP_Sitemaps_Stylesheet` | `apps/core/src/frontend/sitemaps.ts` | Same URLs and 2,000-URL pages; password-protected posts are left out. |
| `do_robots()` | `apps/core/src/frontend/robots.ts` | Disallows `/admin/`. |
| `esc_xml()`, `ent2ncr()` | `apps/core/src/frontend/xml.ts` | |
| Caching plugins (`clean_post_cache`, page caches) | `apps/core/src/cache/`, `apps/web/src/lib/page-cache.ts` | Tag-based purges. See [ADR 0008](../adr/0008-public-page-caching.md). |
| `publish_future_post` (wp-cron) | a one-minute timer in `apps/core/src/server.ts` | Until the job queue arrives. |
| `themes.php` | `/admin/appearance` | |
| `register_post_type( 'wp_navigation' )`, `WP_Navigation_Fallback`, `WP_REST_Navigation_Fallback_Controller` | `apps/core/src/content/post-types.ts`, `content/navigation.ts`, `routes/navigation.ts` | The header's menu is chosen with the `pressbase_navigation_fallback` option. See [Navigation](navigation.md). |
| `blocks/navigation.php`, `navigation-link.php`, `navigation-submenu.php`, `home-link.php`, `view.js` | `apps/core/src/blocks/library/navigation.ts` | A small inline script instead of the Interactivity API. |
| Site editor → Navigation, `nav-menus.php` | `/admin/appearance/menus` | |
| `WP_Theme_JSON_Resolver::get_style_variations()`, the site editor's style variation logic | `packages/theme-json/src/style-variations.ts`, `kernel.themes` (`active().variations`) | Full, colour and typography variations; choosing one writes the user's global styles, as in WordPress. |
| `wp_global_styles` post type, `get_user_data_from_wp_global_styles()`, `get_user_global_styles_post_id()` | `apps/core/src/themes/global-styles.ts` | One post per theme, slug `wp-global-styles-{stylesheet}` (no `wp_theme` term). |
| `WP_REST_Global_Styles_Controller`, `WP_REST_Global_Styles_Revisions_Controller` | `apps/core/src/routes/global-styles.ts` | Plus `/pressbase/v1/global-styles/preview`. |
| `WP_Theme_JSON::remove_insecure_properties()`, `wp_filter_global_styles_post()`, `safecss_filter_attr()`, `validate_custom_css()` | `packages/theme-json/src/sanitize.ts` | |
| Site editor → Styles | `/admin/appearance/styles` | The essentials: variations, colours, type, layout, revisions, live preview. |
| `site_logo`, `site_icon`, `get_custom_logo()`, `WP_Site_Icon`, `get_site_icon_url()`, `wp_site_icon()` | `apps/core/src/themes/site-identity.ts`, `blocks/library/post-media.ts` (`core/site-logo`) | Icon crops are sub-sizes of the chosen image (`site_icon-512` … `site_icon-32`), not a separate cropped attachment. |
| Customizer → Site Identity, `options-general.php` site icon | Settings → General, *Site identity* card | |
| `wp-content/themes/twentytwentyfive` | `themes/twentytwentyfive` | Bundled, unchanged. |
| `upload.php`, `options-media.php`, the media modal | `/admin/media`, `/admin/settings/media`, `MediaPicker` | |
| `wp_insert_user`, `wp_update_user`, `wp_delete_user` (with reassign), `validate_username`, `is_email`, `count_users`, `count_many_users_posts` | `apps/core/src/people/users.ts`, `validation.ts` | See [People](people.md). |
| `WP_Application_Passwords`, `wp_authenticate_application_password`, `WP_REST_Application_Passwords_Controller` | `apps/core/src/people/application-passwords.ts`, `routes/application-passwords.ts` | `Authorization: Basic` middleware; SHA-256 digests like WordPress 6.8's `wp_fast_hash`. |
| `wp_mail` (PHPMailer) | `kernel.mail` (`apps/core/src/mail/`, nodemailer) | SMTP from env, else a development outbox. Same filters and actions. |
| `retrieve_password`, `get_password_reset_key`, `check_password_reset_key`, `reset_password`, `wp-login.php?action=lostpassword` / `rp` | `apps/core/src/people/password-reset.ts`, `routes/password-reset.ts`; `/lost-password`, `/reset-password` | Same `user_activation_key` format (`time:hash`), 24-hour expiry. |
| `wp_new_user_notification`, `send_password_change_email`, `send_email_change_email` | `people/password-reset.ts` | |
| `users.php`, `user-new.php`, `user-edit.php`, `profile.php` | `/admin/users`, `/admin/users/new`, `/admin/users/{id}`, `/admin/profile` | |
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
| Site editor (`wp_template`, `wp_global_styles`) | Admin site editor | later |
| Classic menus (`nav_menu`, `/wp/v2/menus`, `WP_Classic_To_Block_Menu_Converter`) | Converted to `wp_navigation` by the importer | v0.6 |
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
