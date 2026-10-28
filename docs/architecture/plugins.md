# Plugins

A plugin is a folder with a `plugin.json` and compiled JavaScript. Pressbase finds it, and an administrator activates it from **Plugins** (or `/wp/v2/plugins`). Activation, deactivation and installing from a `.zip` all take effect at once: no rebuild, no restart. The design is in [ADR 0009](../adr/0009-plugin-runtime.md).

Code: `apps/core/src/plugins/` (manifest, discovery, manager, runtime, dynamic routing, zip reader), `apps/core/src/routes/plugins.ts`, the admin screen in `apps/admin/src/app/admin/plugins/`. The example, [`plugins/daily-tips`](../../plugins/daily-tips), uses a filter, a REST route and a custom post type.

## Writing a plugin

```
my-plugin/
  plugin.json
  index.js          the entry ("main"), an ES module
  migrations/       optional: 0001-create-table.sql, 0002-…
```

```js
// index.js
export default function register(api) {
  api.postTypes.register('book', {
    label: 'Books',
    singularLabel: 'Book',
    showInRest: true,
    restBase: 'books',
  });

  api.hooks.addFilter('rest_prepare_post', (item) => ({ ...item, reading_time: 3 }));

  api.rest.registerRoute('my-plugin/v1', '/hello', {
    permission: () => true, // required: return true for a public route
    handler: (c) => ({ hello: c.req.query('name') ?? 'world' }),
  });
}

export async function activate(api) {}   // once, when an administrator activates it
export async function deactivate(api) {} // when it's deactivated
export async function uninstall(api) {}  // before it's deleted: remove what it stored
```

Plugins ship compiled JavaScript (`.js` or `.mjs`, ESM). TypeScript is fine at build time; the scaffolder and a typed SDK (`packages/sdk`) come later in v0.5. Until then the types live in `apps/core/src/plugins/runtime.ts` (`PluginApi`).

`register(api)` runs every time the plugin loads: on boot, before the `init` action, and right after activation. Everything registered through `api` is tracked and taken back when the plugin is deactivated, so a plugin never needs to clean up its hooks, routes or types itself. When a plugin is activated while the site runs, `init` has already fired: do set-up work in `register`, not in an `init` callback.

### The plugin API

| `api.` | What it does | WordPress |
| --- | --- | --- |
| `plugin` | `name`, `title`, `version`, `dir`, granted `permissions` | — |
| `pressbase.version` | the running Pressbase version | `$wp_version` |
| `hooks.addFilter / addAction` | add a callback; returns a function that removes it | `add_filter`, `add_action` |
| `hooks.removeFilter / removeAction` | remove one of the plugin's callbacks | `remove_filter`, `remove_action` |
| `hooks.applyFilters / doAction / hasFilter / hasAction / didAction` | fire and inspect hooks (the plugin's own, too) | same names |
| `postTypes.register(name, args) / get` | a post type; with `showInRest` it's served at `/wp/v2/{restBase}` by the posts controller | `register_post_type` |
| `taxonomies.register(name, objectTypes, args) / get` | a taxonomy, at `/wp/v2/{restBase}` | `register_taxonomy` |
| `options.get / set / delete` | the plugin's own options, stored as `{slug_with_underscores}_{name}` | `get_option` & co. |
| `siteOptions.get / set / delete` | any option. Only with the `options` permission | |
| `db.db`, `db.sql`, `db.exec(script)` | Drizzle on Pressbase's connection. Only with the `database` permission | `$wpdb` |
| `content.posts`, `content.terms`, `content.query(args)` | the content services and `WP_Query`-style queries | `wp_insert_post`, `WP_Query` |
| `rest.registerRoute(namespace, route, { methods, handler, permission })` | a route at `/wp-json/{namespace}{route}`; the namespace is the plugin's name or starts with it (`my-plugin/v1`); `route` uses Hono's syntax (`/items/:id{[0-9]+}`) | `register_rest_route` |
| `rest.currentUser(c)`, `rest.userCan(c, cap)` | the request's user and `current_user_can()` | |
| `logger.debug / info / warn / error` | console output prefixed with `[plugin:slug]` | |

A route's `handler` receives Hono's context (`c.req.query()`, `await c.req.json()`, `c.json()`…) and returns a `Response` or any JSON value. `permission` is required, as WordPress requires `permission_callback`; returning anything but `true` answers 401 (logged out) or 403.

## plugin.json

```json
{
  "name": "daily-tips",
  "title": "Daily Tips",
  "version": "1.0.0",
  "description": "A writing tip with every post.",
  "author": { "name": "Ada", "url": "https://example.com" },
  "homepage": "https://example.com/daily-tips",
  "requires": ">=0.5.0 <1",
  "main": "index.js",
  "permissions": ["database"],
  "migrations": "migrations",
  "admin": {
    "pages": [{ "slug": "tips", "title": "Tips", "parent": "settings", "entry": "admin/tips.js" }],
    "settings": [{ "name": "show_in_posts", "type": "boolean", "label": "Add a tip to posts", "default": true }]
  }
}
```

| Field | Required | Notes | WordPress header |
| --- | --- | --- | --- |
| `name` | yes | the slug: lowercase letters, numbers, dashes, at most 64. Must match the folder name. `wp`, `pressbase`, `oembed`, `wp-site-health`, `wp-block-editor` are reserved | folder name |
| `title` | yes | shown in the admin | `Plugin Name` |
| `version` | yes | semantic version | `Version` |
| `description` | no | plain text | `Description` |
| `author` | no | a name, or `{ name, url }` | `Author`, `Author URI` |
| `homepage` | no | http(s) URL | `Plugin URI` |
| `requires` | no | semver range of Pressbase versions (default `*`). Checked on install, activation and load | `Requires at least` |
| `main` | no | the ES module to import, inside the folder (default `index.js`) | the main PHP file |
| `permissions` | no | `network`, `filesystem`, `database`, `options` (see below) | — |
| `migrations` | no | folder of `.sql` files. Needs the `database` permission | — |
| `admin` | no | declared admin `pages` and `settings`. Validated and returned by `/wp/v2/plugins`; the admin doesn't render them yet (see [Not yet](#not-yet)) | `add_menu_page`, `register_setting` |

## Where plugins live

`get_plugins()` looks in two places:

- `<dataDir>/plugins/<name>/` (default `.pressbase/plugins`): uploads land here, and these can be deleted;
- the repository's `plugins/` folder: plugins bundled with Pressbase (the example). They can be activated but not deleted.

A folder in the data directory wins over a bundled one with the same name. Folders that are symlinks are skipped. A folder with an invalid `plugin.json` is listed (with its error) so it can be deleted.

## Lifecycle

| Step | What happens | Hooks |
| --- | --- | --- |
| **Install** | `POST /wp/v2/plugins` with a `.zip` (see [Installing](#installing-from-a-zip)) | — |
| **Activate** | the declared permissions must be confirmed; migrations run; the module is imported and `register(api)` runs; then `activate(api)`; the slug joins `active_plugins` | `activate_plugin (slug)` before, `activated_plugin (slug)` after |
| **Boot** | every plugin in `active_plugins` is imported and registered, in order, after options load and before `init` | — |
| **Deactivate** | `deactivate(api)`, then every registration is removed; the slug leaves `active_plugins` | `deactivate_plugin`, `deactivated_plugin` |
| **Delete** | inactive plugins only: the module is imported (not registered) and `uninstall(api)` runs; the folder and Pressbase's records about the plugin are removed. Content the plugin created (posts of its type, its tables) stays unless `uninstall` removes it | `pre_uninstall_plugin (slug, manifest)`, `deleted_plugin (slug, deleted)` |

Activation and deactivation run one at a time (a queue in the manager), so two requests can't activate a plugin twice.

### When a plugin breaks

A broken plugin must not take the site down:

- **On activation**, if migrations, the import, `register` or `activate` throw, everything registered so far is removed, the plugin stays inactive and the error is recorded. The REST call answers `500 plugin_activation_failed` (or `plugin_migration_failed`).
- **On boot**, a plugin that fails to load is dropped from `active_plugins` (as WordPress does with `deactivate_plugins( $plugin, true )`) and the error recorded. The rest of the site boots normally.
- **While running**, a hook callback that throws is logged and skipped (a filter keeps its incoming value), and a route that throws answers `500 pressbase_plugin_error`. The plugin stays active; the last five errors are shown in the admin (`runtime_errors`).

Load and activation errors live in the `pressbase_plugin_errors` option and are shown on the Plugins screen until the plugin is activated successfully or deleted. Every recorded error also fires `pressbase_plugin_error (slug, error)`.

What isolation can't catch: an infinite loop, a callback that never resolves, or code that corrupts shared state. Those need a process boundary (see [Security model](#security-model-and-limits)).

### Migrations

`.sql` files in the plugin's `migrations` folder run on activation, sorted by name with numbers compared as numbers (`2-…` before `10-…`). Each file runs once, as one script over the simple query protocol (on PostgreSQL several statements run in one implicit transaction). After a file succeeds its name is added to `pressbase_plugin_migrations` (`{ slug: [files] }`); a file that fails stops activation, and the next activation tries it again. New files added in an update run on the next activation. Name tables with the plugin's prefix (`daily_tips_…`). Core's own migrations are separate (Drizzle, `packages/db/migrations`); plugins never change core tables.

## Installing from a .zip

`POST /wp/v2/plugins` (multipart, field `file`; optional `status=active` and `permissions=a,b`) or **Plugins → Upload plugin**. Needs `install_plugins` (and `activate_plugins` to activate). The archive is read by Pressbase's own strict ZIP reader (`plugins/zip.ts`) and refused when it has:

- a path that could escape the folder: `..`, an absolute path, a drive letter, a backslash or a control character (zip-slip): `incompatible_archive_path`;
- a symbolic link or other special file: `incompatible_archive_symlink`;
- encryption, ZIP64 or compression other than store/deflate, a damaged entry, a duplicate name, more than 5,000 files: `incompatible_archive`;
- more than the size limit: the upload limit (`PRESSBASE_MAX_UPLOAD_MB`) capped at 32 MB for the archive (`rest_upload_file_too_big`, 413), and four times that once unpacked (each entry is inflated with a hard output limit, so zip bombs stop early);
- no `plugin.json` at the root or in a single top-level folder (`incompatible_archive_no_plugins`), an invalid manifest or a missing `main` file (`pressbase_invalid_manifest`), or a `requires` this Pressbase doesn't meet.

The plugin is unpacked into a hidden staging folder and renamed into place, so a half-written plugin is never discovered. A plugin with the same name already installed is refused (`409 folder_exists`); delete it first to replace it. In-place updates are not built yet.

## REST: /wp/v2/plugins

WordPress's `WP_REST_Plugins_Controller`, with these differences:

- `plugin` is the folder name (`daily-tips`), not `folder/file`. URLs accept both `/wp/v2/plugins/daily-tips` and `/wp/v2/plugins/daily-tips/anything`.
- `POST /wp/v2/plugins` takes an uploaded `.zip`; there is no plugin directory, so `{ "slug": … }` answers `pressbase_plugin_directory_unavailable`.
- Activating a plugin that declares permissions needs `"permissions": [...]` in the body, covering them all; otherwise `400 pressbase_plugin_permissions_required` with `data.permissions`.
- Extra fields: `requires_pressbase`, `permissions`, `granted_permissions`, `admin`, `source` (`site` or `bundled`), `compatible`, `error`, `runtime_errors`.
- `network-active` doesn't exist (no multisite yet).

| Request | Capability | Errors |
| --- | --- | --- |
| `GET /wp/v2/plugins` (`status`, `search`) | `activate_plugins` | `rest_cannot_view_plugins` |
| `GET /wp/v2/plugins/{plugin}` | `activate_plugins` | `rest_cannot_view_plugin`, `rest_plugin_not_found` |
| `POST /wp/v2/plugins` | `install_plugins` (+ `activate_plugins` with `status=active`) | `rest_cannot_install_plugin`, archive errors above, `folder_exists` |
| `POST/PUT/PATCH /wp/v2/plugins/{plugin}` `{ status, permissions }` | `activate_plugins` | `rest_cannot_manage_plugins`, `pressbase_plugin_permissions_required`, `plugin_activation_failed` |
| `DELETE /wp/v2/plugins/{plugin}` | `activate_plugins` and `delete_plugins` | `rest_cannot_delete_active_plugin`, `pressbase_cannot_delete_bundled_plugin` |

Active plugins' namespaces are listed in the `/wp-json` index.

## Dynamic routing

Hono compiles its router on the first request, so routes can't be added once the server runs. `createApp()` mounts core's own controllers as before, and ends with one catch-all, `pluginRoutes` (`plugins/dispatch.ts`), that runs after every core route missed:

1. `/wp/v2/{base}` where `base` is the `restBase` of a post type or taxonomy a plugin registered: the request goes to a posts or terms controller built for that type (cached until the type is unregistered);
2. a path under a loaded plugin's namespace: the request goes to that plugin's own small Hono app (rebuilt when it registers a route);
3. anything else: `404 rest_no_route`.

The sub-apps receive the request's kernel and user, so core's middleware (CSRF header, session and application-password authentication, `requireInstalled`) has already run. The manager records which plugin owns which post type and taxonomy, so plugin types are never mounted statically and deactivation is a registry change, not a router change. Autosaves are not routed for plugin post types yet.

## Security model and limits

**Plugins run in the core process with full access.** A plugin is JavaScript that Pressbase imports; JavaScript in one process can't be sandboxed. A plugin can `import('node:fs')`, open sockets, read `process.env` (including `DATABASE_URL`) or reach the kernel through objects it's given. That is the same trust WordPress places in PHP plugins. **Install only plugins you trust**, and treat `install_plugins` as equivalent to server access (it's an administrator-only capability).

Permissions are therefore a declaration and a review aid, enforced where enforcing is cheap:

| Permission | What it means | Enforced |
| --- | --- | --- |
| `database` | raw SQL and plugin migrations | yes: `api.db` is undefined and migrations refuse to run without it |
| `options` | read and write any site option | yes: `api.siteOptions` is undefined without it; `api.options` is always scoped to the plugin's prefix |
| `network` | outgoing network connections | no: declared and shown only |
| `filesystem` | files outside the plugin folder | no: declared and shown only |

They are shown to the administrator before activation, which must confirm them (the REST `permissions` field), and recorded in `pressbase_plugin_permissions` (`{ slug: { permissions, granted_at, granted_by } }`). On boot a plugin gets the permissions recorded at activation, not what a newer `plugin.json` asks for.

Also enforced:

- a plugin's REST namespace starts with its name, so it can't add routes to `wp/v2` or `pressbase/v1`, and reserved names can't be taken;
- it can't replace a post type, taxonomy or REST base that's already registered, or take a `/wp/v2` base core serves itself (`users`, `media`, `plugins`…);
- every route needs a permission callback;
- upload validation as above; `main` and `migrations` must resolve (after following links) inside the plugin folder.

Real isolation (worker threads or separate processes with Node's permission model, capability-scoped RPC) is a possible later step; the narrow `PluginApi` is designed so that it could be served over such a boundary.

Re-importing a plugin after an update loads a new copy of the module (a query string busts Node's module cache); earlier copies stay in memory until the process restarts. Plugins are per process: with several core processes, restart the others after activating a plugin (multi-process option invalidation is on the roadmap).

## Not yet

These are later v0.5 steps; the seams are in place:

- **Admin extension points (SlotFill), plugin admin pages and the Settings API UI.** `admin.pages` and `admin.settings` are validated and returned by `/wp/v2/plugins` but not rendered. The admin will load `entry` modules into named slots and render settings from their schema.
- **`create-pressbase-plugin` and `packages/sdk`.** `PluginApi` in `runtime.ts` is the SDK's surface; keep it narrow and add to it rather than handing plugins the kernel.
- In-place plugin updates, a plugin directory, multisite (`network-active`).
