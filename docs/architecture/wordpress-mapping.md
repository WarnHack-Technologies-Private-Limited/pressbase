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

## Planned

| WordPress                                      | Pressbase (planned)                             | Release |
| ---------------------------------------------- | ------------------------------------------- | ------- |
| `register_post_type`, `register_taxonomy`      | Content registries in core                  | v0.2    |
| `WP_Query`                                     | `ContentQuery` with the same arguments      | v0.2    |
| `map_meta_cap`                                 | Port into `auth/capabilities.ts`            | v0.2    |
| `wp_insert_post`, revisions, autosave          | Content service                             | v0.2    |
| `wp_handle_upload`, image sizes                | Media service (sharp, storage adapters)     | v0.2    |
| Application passwords                          | `Authorization: Basic` in core              | v0.2    |
| `parse_blocks`, `render_block`                 | `packages/blocks`                           | v0.3    |
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
