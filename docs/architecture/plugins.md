# Plugins

A plugin is a folder with a `plugin.json` and compiled JavaScript. Pressbase finds it, and an administrator activates it from **Plugins** (or `/wp/v2/plugins`). Activation, deactivation and installing from a `.zip` all take effect at once: no rebuild, no restart. The design is in [ADR 0009](../adr/0009-plugin-runtime.md).

Code: `apps/core/src/plugins/` (manifest, discovery, manager, runtime, dynamic routing, zip reader), `apps/core/src/routes/plugins.ts`, the admin screen in `apps/admin/src/app/admin/plugins/`. The example, [`plugins/daily-tips`](../../plugins/daily-tips), uses a filter, a REST route and a custom post type.

## Writing a plugin

The quickest start is the scaffolder, which writes a TypeScript plugin typed with `@pressbase/plugin-sdk`, a build and a pack script ([Writing plugins](../development/writing-plugins.md)):

```sh
npx create-pressbase-plugin reading-time   # or: pnpm create pressbase-plugin reading-time
cd reading-time && npm install && npm run pack   # → reading-time-0.1.0.zip
```

What Pressbase loads is simpler than that:

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

Plugins ship compiled JavaScript (`.js` or `.mjs`, ESM). Write TypeScript with [`@pressbase/plugin-sdk`](#the-sdk) and compile it with esbuild or `tsc`; `PluginApi` itself is defined in `apps/core/src/plugins/runtime.ts`.

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
| `cron.*`, `jobs.*` | scheduled events and background jobs, scoped to the plugin ([below](#background-work-cron-and-jobs)) | `wp_schedule_event` & co. |
| `scripts.*`, `styles.*`, `assets.url(file)` | scripts and stylesheets on public pages, and the plugin's `public/` files ([below](#scripts-styles-and-static-files)) | `wp_enqueue_script`, `wp_enqueue_style`, `plugins_url` |

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

## Background work: cron and jobs

`api.cron` is [WP-Cron](jobs.md#cron-kernelcron) for the plugin. Hook names get the plugin's option prefix, so a plugin can't schedule or clear core's events (`cleanup` → `reading_time_cleanup`; an already-prefixed name is left alone). Results are WordPress's, without the `WP_Error` variant.

```ts
api.cron.addAction('cleanup', async (days: number) => { /* … */ }); // add_action for the prefixed hook
export const activate = defineLifecycle(async (api) => {
  if (!(await api.cron.nextScheduled('cleanup', [30]))) {
    await api.cron.scheduleEvent(Date.now() / 1000, 'daily', 'cleanup', [30]);
  }
});
```

| `api.cron.` | WordPress |
| --- | --- |
| `scheduleEvent(timestamp, recurrence, hook, args?)` → `boolean` | `wp_schedule_event()` |
| `scheduleSingleEvent(timestamp, hook, args?)` → `boolean` | `wp_schedule_single_event()` |
| `nextScheduled(hook, args?)` → timestamp or `false` | `wp_next_scheduled()` |
| `unscheduleEvent(timestamp, hook, args?)` | `wp_unschedule_event()` |
| `clearScheduledHook(hook, args?)` / `unscheduleHook(hook)` → how many | `wp_clear_scheduled_hook()`, `wp_unschedule_hook()` |
| `addAction(hook, callback, priority?)`, `hookName(hook)`, `prefix` | `add_action()` for the prefixed name |

Timestamps are Unix seconds or a `Date`. A plugin's queries only see its own events; core's `kernel.cron` and Settings → Scheduled tasks see them all.

`api.jobs` is the [job queue](jobs.md#the-queue-kerneljobs) with names namespaced by the plugin's slug (`sync` → `reading-time/sync`):

```ts
api.jobs.register<{ url: string }>('fetch', async (data, { signal, attempt }) => {
  await fetch(data.url, { signal });
}, { maxAttempts: 5, backoffSeconds: 60 });
await api.jobs.enqueue('fetch', { url: 'https://example.com' }, { singletonKey: 'fetch:example' });
```

| `api.jobs.` | |
| --- | --- |
| `register(name, handler, { maxAttempts, backoffSeconds, timeoutSeconds }?)` | the handler for the plugin's `name` jobs; a throw is recorded against the plugin (`runtime_errors`) and retried |
| `enqueue(name, data?, { runAt, priority, singletonKey, replace, … }?)` → the job or `null` | `null` when a job with the `singletonKey` is pending or running |
| `cancel(id)` | deletes one of the plugin's pending jobs |
| `list({ name, status, limit }?)` | the plugin's jobs |
| `name(name)` | the full queue name |

**Deactivating** unregisters the plugin's job handlers and its cron runner (its events are `cron:{slug}` jobs). Its pending jobs and events stay in the queue untouched: nothing runs, nothing fails, no attempts are spent. On **reactivation** they run: overdue single events and jobs at once, a recurring event once (then on its schedule, keeping its phase, as WordPress does with missed events). **Deleting** the plugin removes all its jobs and events, whatever their state, after its `uninstall`. Details: [Jobs and cron](jobs.md#plugins).

## Scripts, styles and static files

A plugin's `public/` folder is served at `/wp-content/plugins/{name}/{file}` (WordPress's `plugins_url()`), **only while the plugin is active**, with the rules theme files follow: each path segment is decoded and checked (`..`, encoded slashes and backslashes, dot files are refused), symbolic links can't leave the folder, only static types are served (CSS, JS, images, fonts, video) with their content type and `nosniff`, and SVGs get a sandboxing CSP. A request whose `?ver=` is the plugin's version is cached for a year; others for an hour.

`api.scripts` and `api.styles` are [`kernel.scripts` and `kernel.styles`](scripts-and-styles.md#kernelscripts-and-kernelstyles) with two differences:

- a relative `src` is a file in `public/` (`'app.js'`, `'css/site.css'`; `./` and a leading `public/` are accepted), resolved to its URL; absolute and root-relative URLs are used as given;
- `ver` defaults to the plugin's version, so a new release is a new URL.

```ts
api.styles.enqueue('reading-time', 'style.css');                       // every public page
api.scripts.enqueue('reading-time', 'app.js', [], undefined, { inFooter: true, strategy: 'defer' });
api.hooks.addAction('wp_enqueue_scripts', (page) => {
  if (page.main.isSingular) api.scripts.enqueue('reading-time-single', 'single.js'); // this page only
});
api.assets.url('logo.svg'); // → /wp-content/plugins/reading-time/logo.svg
```

Registered outside a page render (in `register`), a handle is site-wide; it is dequeued and deregistered when the plugin is deactivated. Registered during a render, it belongs to that page only. Activating or deactivating a plugin purges the page cache (`site` tag), so cached pages don't keep a removed stylesheet.

## The SDK

`@pressbase/plugin-sdk` (`packages/plugin-sdk`) gives TypeScript plugins `PluginApi` and every type it hands out, the hook registries (so `api.hooks.addFilter('wp_robots', …)` autocompletes and types its callback), and a few helpers that cost nothing at runtime:

| Export | What it does |
| --- | --- |
| `definePlugin(register)` | types the default export |
| `defineLifecycle(fn)` | types `activate`, `deactivate`, `uninstall` |
| `defineManifest(json)` | types a `plugin.json` object |
| `defineRoute(args)`, `allowAnyone`, `requireCapability(api, cap)` | REST route arguments and permission callbacks |
| `restError(status, code, message, data?)` | a WordPress-shaped error `Response` |
| types: `PluginApi`, `PluginModule`, `FilterRegistry`, `ActionRegistry`, `FilterName`, `ActionName`, `FilterValue<K>`, `Post`, `QueryArgs`, `Job`, `PageRender`, `HtmlOutput`… | |

```ts
import { allowAnyone, definePlugin } from '@pressbase/plugin-sdk';

declare module '@pressbase/plugin-sdk' {
  interface FilterRegistry {
    reading_time_minutes: [minutes: number, postId: number]; // your own hook, typed
  }
}

export default definePlugin((api) => {
  api.rest.registerRoute('reading-time/v1', '/ping', { permission: allowAnyone, handler: () => 'pong' });
});
```

The types are generated from core when the SDK is built, so they never drift from `runtime.ts` ([ADR 0012](../adr/0012-plugin-sdk-types.md)). Core's runtime never reaches a plugin's bundle: the SDK's `.d.ts` refers to Hono, Drizzle and zod by type only.

## Not yet

These are later v0.5 steps; the seams are in place:

- **Admin extension points (SlotFill), plugin admin pages and the Settings API UI.** `admin.pages` and `admin.settings` are validated and returned by `/wp/v2/plugins` but not rendered. The admin will load `entry` modules into named slots and render settings from their schema.
- `PluginApi` in `runtime.ts` is the SDK's surface; keep it narrow and add to it rather than handing plugins the kernel. It is frozen with semantic versioning at 1.0.
- In-place plugin updates, a plugin directory, multisite (`network-active`).
