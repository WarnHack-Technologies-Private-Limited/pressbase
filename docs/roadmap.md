# Roadmap

Each release has a theme and a clear finish line. The `release` values in `apps/admin/src/lib/sections.ts` and the settings sub-navigation come from this page, so update them together.

## v0.1: Foundation ✅

- [x] Monorepo: pnpm workspaces, Turborepo, TypeScript, Biome, Vitest.
- [x] `@pressbase/hooks`: actions and filters with priorities, async callbacks, typed names.
- [x] `@pressbase/db`: WordPress data model on PostgreSQL (Drizzle), migrations, embedded PGlite.
- [x] Kernel and boot sequence, Options API with hooks.
- [x] Web installer: system checks, PostgreSQL or built-in database, setup token, auto-login.
- [x] Authentication: sessions, login throttling, CSRF protection.
- [x] WordPress default roles and capabilities.
- [x] REST: `/wp-json` index, `wp/v2/users/me`, `wp/v2/settings`, `pressbase/v1/dashboard`.
- [x] Admin: design tokens and component kit, dashboard, General settings, light and dark mode, mobile layout.

## v0.2: Content core ✅

Shipped in three milestones: content model, media, and people and conversation.

- [x] Post type, status and taxonomy registries (`register_post_type`, `register_taxonomy`).
- [x] `ContentQuery`, the counterpart of `WP_Query`: `post_type`, `tax_query`, `meta_query`, search, pagination.
- [x] `wp/v2` routes: posts, pages, categories, tags, types, taxonomies, statuses, users (read).
- [x] `wp/v2/media`: uploads (multipart or raw), image sizes, `-scaled` big images, featured images.
- [x] `wp/v2` routes: comments, users (write), application passwords, search.
- [x] `map_meta_cap`: per-object capabilities (`edit_post` on a specific post).
- [x] Revisions. Autosave shipped with the block editor (v0.3).
- [x] Content sanitising for users without `unfiltered_html`.
- [x] Media library: uploads, image sizes (sharp), local storage with an adapter interface.
- [ ] S3-compatible storage adapter.
- [x] Admin: Posts and Pages lists and editor (writing view + code view), Categories, Tags.
- [x] Admin: Media library and media picker.
- [x] Admin: Comments (moderation, inline reply, Undo) and Users (roles, reassign on delete), Profile.
- [x] Settings screens: Writing, Reading.
- [x] Settings screens: Media.
- [x] Settings screens: Discussion, including comment emails.
- [x] Application passwords for API clients (HTTPS or local hosts only).
- [x] Password reset by email (Nodemailer SMTP, or a local outbox in development).

## v0.3: Block editor ✅

- [x] Gutenberg in the admin (`@wordpress/block-editor`, `@wordpress/block-library`): iframed canvas, inserter, list view, Block tab, Code view.
- [x] Server-side block parsing and serialising (`@pressbase/blocks`, a port of `WP_Block_Parser`).
- [x] Dynamic block rendering on the server (`do_blocks`, `render_block` filters) with 15 core dynamic blocks.
- [x] Patterns and synced patterns (`/wp/v2/block-patterns`, `/wp/v2/blocks`).
- [x] Autosave (`/wp/v2/{type}/{id}/autosaves`) with a restore prompt and a browser safety copy.
- [x] Media library inside the editor (image, cover, gallery… "Media Library" buttons) and featured images.
- [x] Inserter Media tab, `/wp/v2/search` for link suggestions, multi-select in galleries.

## v0.4: Themes and the public site ✅

Twenty Twenty-Five renders the home page, posts, pages, archives, search, comments and 404 ([ADR 0007](adr/0007-public-rendering.md)), with page caching ([ADR 0008](adr/0008-public-page-caching.md)), feeds, sitemaps, global styles and menus. The site editor (templates and parts) moves to a later release.

- [x] `apps/web`: the public site, served by core's renderer (one origin with the admin).
- [x] `theme.json` engine (`@pressbase/theme-json`): presets, global styles, layout, fonts.
- [x] Block themes: discovery, activation, templates, parts, PHP patterns (converted without running PHP).
- [x] Template hierarchy, request routing, permalinks, Reading settings, post passwords.
- [x] Theme template blocks (query loop, navigation, template parts, featured image…) and theme-aware block supports.
- [x] Comments on the public site: threaded list, pagination (`/comment-page-N/`), the comment form.
- [x] Admin: Appearance (themes list, activate), "Visit site".
- [x] **Milestone:** Twenty Twenty-Five renders unchanged (its core templates).
- [x] Page caching in `apps/web`: tagged pages, purged by core on content changes (`pressbase_cache_purge`).
- [x] Global styles (Appearance → Styles), theme style variations, site logo and icon.
- [x] Navigation menus (`wp_navigation`, Appearance → Menus).
- [x] RSS and Atom feeds, `wp-sitemap.xml`, `robots.txt`.
- [x] Admin colour scheme: system, light or dark per user (#2).
- [x] Logins with WordPress password hashes (phpass and bcrypt) (#6).
- [x] Playwright end-to-end tests in CI (#7) and a Docker image (#8).
- [ ] Duotone, responsive style states. → later
- [ ] Site editor: templates and template parts (`wp_template`, `wp_template_part`). → later
- [x] Settings → Permalinks screen (the routing already follows `permalink_structure`). → done in v0.5

## v0.5: Plugins ✅

- [x] `plugin.json` manifest and runtime loader (no rebuild). See [Plugins](architecture/plugins.md).
- [x] Lifecycle: activate, deactivate, uninstall, plugin migrations; installing from a .zip; `/wp/v2/plugins` and the Plugins screen.
- [x] Admin extension points (SlotFill), admin pages, Settings API for plugins. See [Plugins](architecture/plugins.md#admin-pages-and-settings), [ADR 0011](adr/0011-plugin-admin-extensions.md).
- [x] Job queue and cron: a table-backed queue instead of pg-boss ([ADR 0010](adr/0010-job-queue.md)).
- [x] `create-pressbase-plugin` scaffolding and the plugin SDK. See [Writing plugins](development/writing-plugins.md).
- [x] Plugin permissions (network, filesystem, database scopes): declared, confirmed on activation, recorded; `database` and `options` enforced.
- [x] `wp_head` / `wp_footer`-style hooks so plugins can add to public pages.
- [x] Settings → Permalinks.

## v0.6: Migration and tooling

- [ ] WXR importer.
- [ ] Direct WordPress (MySQL) migration: users and password hashes, media, SEO meta.
- [ ] `pressbase` CLI (similar to wp-cli).
- [ ] Internationalisation: `.po`/`.mo` files, `@wordpress/i18n`.
- [ ] Site Health.

## v1.0: Stable

- [ ] Security audit, accessibility audit, performance budget.
- [ ] A frozen plugin API with semantic versioning from here on.
- [ ] Official Docker image and one-click deploy templates.

## Later

- Multisite: schema per site or row-level security.
- Real-time collaborative editing (Yjs).
- An Abilities API and MCP server, so AI agents can work on a site within capability checks (as WordPress 7 introduced).
