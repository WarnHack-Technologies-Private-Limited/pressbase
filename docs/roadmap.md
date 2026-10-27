# Roadmap

Each release has a theme and a clear finish line. The `release` values in `apps/admin/src/lib/sections.ts` and the settings sub-navigation come from this page, so update them together.

## v0.1: Foundation ✅ (current)

- [x] Monorepo: pnpm workspaces, Turborepo, TypeScript, Biome, Vitest.
- [x] `@pressbase/hooks`: actions and filters with priorities, async callbacks, typed names.
- [x] `@pressbase/db`: WordPress data model on PostgreSQL (Drizzle), migrations, embedded PGlite.
- [x] Kernel and boot sequence, Options API with hooks.
- [x] Web installer: system checks, PostgreSQL or built-in database, setup token, auto-login.
- [x] Authentication: sessions, login throttling, CSRF protection.
- [x] WordPress default roles and capabilities.
- [x] REST: `/wp-json` index, `wp/v2/users/me`, `wp/v2/settings`, `pressbase/v1/dashboard`.
- [x] Admin: design tokens and component kit, dashboard, General settings, light and dark mode, mobile layout.

## v0.2: Content core (in progress)

Shipping in three milestones. Milestone 1, the content model, is done.

- [x] Post type, status and taxonomy registries (`register_post_type`, `register_taxonomy`).
- [x] `ContentQuery`, the counterpart of `WP_Query`: `post_type`, `tax_query`, `meta_query`, search, pagination.
- [x] `wp/v2` routes: posts, pages, categories, tags, types, taxonomies, statuses, users (read).
- [ ] `wp/v2` routes: comments, media, users (write).
- [x] `map_meta_cap`: per-object capabilities (`edit_post` on a specific post).
- [x] Revisions. Autosave moves to v0.3 with the block editor.
- [x] Content sanitising for users without `unfiltered_html`.
- [ ] Media library: uploads, image sizes (sharp), local and S3-compatible storage.
- [x] Admin: Posts and Pages lists and editor (writing view + code view), Categories, Tags.
- [ ] Admin: Media, Comments and Users screens.
- [x] Settings screens: Writing, Reading.
- [ ] Settings screens: Discussion, Media.
- [ ] Application passwords for API clients.
- [ ] Password reset by email (Nodemailer, SMTP settings).

## v0.3: Block editor

- [ ] Gutenberg in the admin (`@wordpress/block-editor`, `@wordpress/block-library`).
- [ ] Server-side block parsing (`@wordpress/block-serialization-default-parser`).
- [ ] Dynamic block rendering on the server (React SSR).
- [ ] Patterns and synced patterns.

## v0.4: Themes and the public site

- [ ] `apps/web`: the public site (Next.js, ISR and cache tags).
- [ ] `theme.json` engine: settings and styles turned into CSS custom properties.
- [ ] Template hierarchy, template parts, navigation.
- [ ] Site editor and global styles.
- [ ] Permalinks and rewrite rules.
- [ ] **Milestone:** Twenty Twenty-Five renders unchanged.

## v0.5: Plugins

- [ ] `plugin.json` manifest and runtime loader (no rebuild).
- [ ] Lifecycle: activate, deactivate, uninstall, plugin migrations.
- [ ] Admin extension points (SlotFill), admin pages, Settings API for plugins.
- [ ] Job queue and cron (pg-boss).
- [ ] `create-pressbase-plugin` scaffolding and the plugin SDK.
- [ ] Plugin permissions (network, filesystem, database scopes).

## v0.6: Migration and tooling

- [ ] WXR importer.
- [ ] Direct WordPress (MySQL) migration: users and password hashes, media, SEO meta.
- [ ] `pressbase` CLI (similar to wp-cli).
- [ ] Internationalisation: `.po`/`.mo` files, `@wordpress/i18n`.
- [ ] RSS, sitemaps, Site Health.

## v1.0: Stable

- [ ] Security audit, accessibility audit, performance budget.
- [ ] A frozen plugin API with semantic versioning from here on.
- [ ] Official Docker image and one-click deploy templates.

## Later

- Multisite: schema per site or row-level security.
- Real-time collaborative editing (Yjs).
- An Abilities API and MCP server, so AI agents can work on a site within capability checks (as WordPress 7 introduced).
