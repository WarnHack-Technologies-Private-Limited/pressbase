# 0009: In-process ESM plugins with tracked registrations and per-request routing

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

WordPress's promise is that an administrator uploads a plugin and it works at once. [ADR 0003](0003-core-separate-from-next.md) kept core a plain Node process so it can `import()` code at runtime. v0.5 has to deliver the runtime itself: a manifest, discovery, loading, the lifecycle (activate, deactivate, uninstall, migrations), installs from a `.zip`, and `/wp/v2/plugins`.

Constraints:

- **No restart.** Activation and deactivation must take effect on the next request. But `createApp()` mounted a controller per post type when the app was built, and Hono compiles its router on the first request, so routes can't be added afterwards.
- **Deactivation must undo everything.** WordPress gets this for free because every request starts a fresh PHP process; a long-lived Node process keeps whatever a plugin registered.
- **One broken plugin must not take the site down,** on boot or at request time.
- **Honesty about isolation.** In-process JavaScript can't be sandboxed: `import('node:fs')` is always available.

## Decision

**Plugins are ES modules imported into the core process. Everything they register goes through a narrow, per-plugin `PluginApi` that records each registration so it can be taken back, and plugin routes are resolved per request by one catch-all handler.**

- **Manifest.** `plugin.json`, validated with zod (`plugins/manifest.ts`): `name` (slug, equals the folder name), `title`, `version`, `requires` (semver range of Pressbase), `main` (compiled ESM), `permissions`, `migrations`, and `admin` (declared pages and settings, validated and exposed only, for the SlotFill step).
- **Discovery.** `<dataDir>/plugins/*` and the repository's `plugins/` (bundled examples); the data directory wins. Active slugs are stored in WordPress's `active_plugins` option.
- **Loading.** On boot, after options load and before `init` (as `wp-settings.php` does), each active plugin is imported with a cache-busting query string and its default export (or `register`) is called with a fresh `PluginRuntime`'s `api`. A failure disposes what was registered, drops the plugin from `active_plugins` and records the error in `pressbase_plugin_errors`.
- **Tracked registrations.** `PluginRuntime` wraps every hook callback (so a throw is logged and skipped, a filter keeping its value), and records a disposer for every hook, post type, taxonomy and route. Deactivation calls them in reverse. `PostTypeRegistry.unregister()` and `TaxonomyRegistry.unregister()` were added for this; built-ins can't be removed.
- **Dynamic routing.** Core's own controllers stay mounted statically. `createApp()` ends with `pluginRoutes`, a catch-all reached only when no core route matched. It looks up the registries on each request: a plugin-owned post type or taxonomy at `/wp/v2/{rest_base}` is served by a posts or terms controller built for it and cached in a `WeakMap` keyed by the registration; a plugin namespace is served by that plugin's own small Hono app. Both are run with `app.fetch()`, inheriting the request's kernel and user through a middleware.
- **Lifecycle.** WordPress's hooks: `activate_plugin`, `activated_plugin`, `deactivate_plugin`, `deactivated_plugin`, `pre_uninstall_plugin`, `deleted_plugin`; the module's optional `activate`, `deactivate` and `uninstall` exports. Lifecycle changes run through a queue.
- **Migrations.** `.sql` files in the plugin's `migrations/`, run in natural order on activation through a new `DatabaseConnection.exec()` (simple query protocol), each recorded in `pressbase_plugin_migrations` after it succeeds. They need the `database` permission. Core's schema and migrations are untouched.
- **Permissions.** Declared scopes (`network`, `filesystem`, `database`, `options`) are shown before activation, must be confirmed in the activation request, and are recorded in `pressbase_plugin_permissions`. Enforced where cheap: `api.db` and migrations need `database`, `api.siteOptions` needs `options`. `network` and `filesystem` are declarations only.
- **Installs.** A strict ZIP reader of our own (`plugins/zip.ts`, using `node:zlib`) refuses zip-slip paths, symlinks and special files, encryption, ZIP64, duplicates and oversize archives, inflating every entry with a hard output limit; the plugin is unpacked into a staging folder and renamed into place.

## Consequences

- Activating, deactivating and installing work without a restart, and a deactivated plugin's routes answer 404 on the next request. Existing routes and tests are unchanged: plugin routing only runs after every core route missed.
- A throwing hook or route can't break a request for everyone, and a plugin that fails on boot is switched off with its error shown in the admin. Infinite loops, hung promises and deliberate misuse are not contained.
- **Plugins are fully trusted code**, exactly as in WordPress. Permissions are a contract and a review aid, not a sandbox, and the docs say so. `install_plugins` is equivalent to server access.
- Re-imported modules stay in memory until restart (Node has no module unloading). Plugin state is per process; several core processes need a restart after a change until options invalidation across processes exists.
- `PluginApi` is the surface the SDK will type and freeze at 1.0. Because plugins never receive the kernel, the same API could later be served across a worker or process boundary for real isolation.
- `plugin` in `/wp/v2/plugins` is the folder name, not WordPress's `folder/file`; URLs accept both shapes.

## Alternatives considered

- **Rebuild the Hono app on every change** and swap it behind a stable `fetch`. Simple, but rebuilding every controller on each activation is wasteful, and in-flight requests would see two apps. Per-request lookup touches only plugin routes.
- **Mount every possible type route at build time** (`/wp/v2/:base`) and look the type up inside the controller. That would change every core controller and its tests; the catch-all leaves them alone.
- **Worker threads or child processes per plugin** with Node's permission model. Real isolation, but hooks are synchronous-looking, chatty calls on hot paths (every block render, every option read); a message boundary there costs latency and needs a serialisable hook protocol. Left as a later step, made possible by the narrow API.
- **`vm` contexts.** Not a security boundary (Node's own docs say so) and break `import`.
- **An npm dependency for unzipping** (yauzl, adm-zip). A ~200-line reader with exactly the checks we need was smaller than auditing one; it only supports what plugin archives use.
