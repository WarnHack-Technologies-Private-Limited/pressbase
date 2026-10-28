# Plugins

A plugin is a folder with a `plugin.json` and compiled JavaScript. Pressbase finds it, and an administrator activates it from **Plugins** (or `/wp/v2/plugins`). Activation, deactivation and installing from a `.zip` all take effect at once: no rebuild, no restart. The design is in [ADR 0009](../adr/0009-plugin-runtime.md).

Code: `apps/core/src/plugins/` (manifest, discovery, manager, runtime, dynamic routing, zip reader), `apps/core/src/routes/plugins.ts`, the admin screen in `apps/admin/src/app/admin/plugins/`. The example, [`plugins/daily-tips`](../../plugins/daily-tips), uses a filter, REST routes, a custom post type, settings and an admin module.

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
| `settings.register(name, args) / addSection(id, args) / get / set` | a setting with its admin field; sections of a settings page. See [Settings](#settings) | `register_setting`, `add_settings_field`, `add_settings_section` |
| `admin.addPage({ slug, title, parent, capability, entry })` | an admin page, top level or under Settings or Tools. See [Admin pages](#admin-pages) | `add_menu_page`, `add_options_page`, `add_management_page` |
| `cli.addCommand(name, handler, { shortdesc, synopsis, longdesc })` | a `pressbase` command; `name` is the plugin's slug, then subcommand words. See [the CLI](../development/cli.md#plugin-commands) | `WP_CLI::add_command` |
| `i18n.__ / _x / _n / _nx`, `i18n.locale()`, `i18n.isRtl()` | translations in the plugin's text domain (its slug), from its `languages/` folder. See [Internationalisation](i18n.md#plugins) | `__()`, `load_plugin_textdomain` |
| `meta.register / registerPostMeta / registerTermMeta`, `meta.get / add / update / delete` | registered meta, shown under `meta` in REST with `showInRest`. See [Registered meta](#registered-meta) | `register_meta()`, `register_post_meta()`, `get_metadata()` & co. |
| `hooks.removeAction('wp_head', 'rel_canonical')` | removes one of core's named callbacks; restored on deactivation. See [Head output](#head-output-and-canonical-urls) | `remove_action()` with a function name |
| `content.permalink(post)`, `content.canonicalUrl(post)` | a post's URL, and its canonical URL after `get_canonical_url` | `get_permalink()`, `wp_get_canonical_url()` |
| `cache.purge(tags) / purgePaths(paths) / addTags(...) / pathTag(path)` | purge cached public pages. See [api.cache](#the-page-cache-apicache) | caching plugins' purge functions |
| `public.addFile(path, handler, options)` | a file at a fixed root path (`/llms.txt`). See [Plugin files](#plugin-files-at-the-site-root) | a rewrite rule and a `template_redirect` callback |
| `db.query(sql)` | one query's rows, on PostgreSQL and PGlite. See [Plugin tables](#plugin-tables-at-scale) | `$wpdb->get_results()` |

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
| `admin` | no | `pages`, `sections`, `settings` and `module`, registered when the plugin loads. See [Admin pages and settings](#admin-pages-and-settings) | `add_menu_page`, `register_setting` |

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

The same URLs also serve the plugin's declared [UI modules](#ui-modules) and their folders, from the plugin's root. Those are checked first, so a `public/admin/index.js` is hidden by an `admin/index.js` UI module.

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

## Meta, requests, head output, the cache and files (v0.7)

The server half of the plugin API gaps found while planning Pressbase SEO ([plan](../plans/first-party-plugins.md#platform-work-first-plugin-api-gaps), gaps 1 and 5 to 9). Tests: `apps/core/src/plugin-platform.test.ts`.

### Registered meta

`register_post_meta()`, `register_term_meta()` and `register_meta()` (`wordpress/wp-includes/meta.php`), with the REST `meta` field of `WP_REST_Meta_Fields` (`rest-api/fields/class-wp-rest-meta-fields.php`). Code: `content/meta.ts` (`kernel.meta`), `routes/meta-fields.ts`, `auth/meta-caps.ts`.

```ts
api.meta.registerPostMeta('', '_yoast_wpseo_title', {   // '' = every post type
  type: 'string',
  single: true,
  showInRest: true,
  sanitizeCallback: (value) => String(value).trim(),
  // Protected keys (leading _) need this to be editable through REST.
  authCallback: (allowed, key, postId, userId, cap, caps) => true,
});
api.meta.registerPostMeta('post', 'reading_level', {
  type: 'integer', single: true, default: 3,
  showInRest: { schema: { minimum: 1, maximum: 5 } },
});
api.meta.registerTermMeta('category', '_yoast_wpseo_bctitle', { single: true, showInRest: true, authCallback: () => true });

await api.meta.get('post', 12, 'reading_level', true);   // 3 until something is stored
await api.meta.update('post', 12, 'reading_level', 4);   // update_metadata()
```

| Argument | Notes | WordPress |
| --- | --- | --- |
| `type` | `string` (default), `boolean`, `integer`, `number`, `array`, `object`: the type of each value | `type` |
| `single` | one value (true) or a list, one row per value (default false) | `single` |
| `default` | returned while nothing is stored; must match the type | `default` |
| `label`, `description` | in the REST schema | same |
| `showInRest` | `true`, or `{ name, schema, prepareCallback }`. `array` values need `schema.items` | `show_in_rest` |
| `sanitizeCallback(value, key, objectType, subtype)` | runs on every write, as the filter `sanitize_{type}_meta_{key}[_for_{subtype}]` | `sanitize_callback` |
| `authCallback(allowed, key, objectId, userId, cap, caps)` | may the user add, edit or delete the key? As the filter `auth_{type}_meta_{key}[_for_{subtype}]` | `auth_callback` |

| `api.meta.` | WordPress |
| --- | --- |
| `register(objectType, key, args)` (`post`, `term`, `user`, `comment`), `registerPostMeta(postType, key, args)`, `registerTermMeta(taxonomy, key, args)` | `register_meta()`, `register_post_meta()`, `register_term_meta()` |
| `get(objectType, id, key, single?)` | `get_metadata()` (with `filter_default_metadata()`); `undefined` where WordPress gives `''` |
| `add(objectType, id, key, value, unique?)` → row ID or `false` | `add_metadata()` |
| `update(objectType, id, key, value, previous?)` → changed? | `update_metadata()` |
| `delete(objectType, id, key, value?)` | `delete_metadata()` |

**REST.** Keys registered with `showInRest` appear under `meta` in `/wp/v2/posts`, `/wp/v2/pages`, plugin post types that support `custom-fields`, and every taxonomy's terms, in the `view` and `edit` contexts (as in WordPress, they're readable by anyone who can read the object: don't register private data with `showInRest`). A single key shows its value or the default; a multi key a list; a stored value that doesn't fit the schema reads as `null`. Writes take `{ "meta": { "key": value } }`:

- unregistered names are ignored; `null` (or `[]` for a multi key) deletes;
- values are coerced (`"4"` → 4) and validated against the schema: `400 rest_invalid_param`, `data.params.meta` says why;
- the user needs `edit_post_meta` / `delete_post_meta` (`…_term_meta`) for the key: `map_meta_cap()` maps them to `edit_post` (or `edit_term`), then asks the key's auth callback. Without one, an unprotected key is allowed and a protected one (`_yoast_wpseo_title`, anything starting with `_`, filter `is_protected_meta`) is refused: `rest_cannot_update` / `rest_cannot_delete`, 401 or 403, "Sorry, you are not allowed to edit the {key} custom field."

Unlike WordPress, values and permissions are checked before the post or term is saved, so a refused meta write leaves nothing half-saved (a new object is created first, since the auth callback needs its ID). Writes fire `added_{type}_meta`, `updated_{type}_meta` and `deleted_{type}_meta`; a published post's meta change purges `post:{id}`, a term's `term:{id}`. Deactivating the plugin unregisters its keys and callbacks; stored values stay. Revisions of meta (`revisions_enabled`) and user and comment meta in REST are not built yet.

### Early request hooks: template_redirect and 404s

Code: `frontend/template-redirect.ts`, `frontend/render.ts`; the cache decision is [ADR 0017](../adr/0017-early-request-hooks-and-the-page-cache.md).

```ts
api.hooks.addAction('template_redirect', async (request) => {
  const rule = await findRedirect(request.path);           // the plugin's own lookup
  if (rule?.status === 410) request.notFound(410);
  else if (rule) request.redirect(rule.target, rule.status); // 301, 302, 303, 307, 308
});
api.hooks.addAction('pressbase_404', ({ path, query, referrer }) => log404(path, referrer));
api.hooks.addFilter('pre_handle_404', (preempt, main, url) => url.pathname === '/virtual/' || preempt);
```

| Hook | Type | Arguments | WordPress |
| --- | --- | --- | --- |
| `template_redirect` | action | `request`: `path`, `query`, `referrer`, `user`, `main()` (the main query, resolved on first use and shared with the render), `redirect(location, status = 302)`, `notFound(404 \| 410)`, `answer` | `template_redirect` in `template-loader.php`, with `wp_redirect()` + `exit` |
| `pre_handle_404` | filter | `false, main, url`: anything but `false` keeps the URL from being a 404 (status 200) | `pre_handle_404` in `WP::handle_404()` (`class-wp.php`) |
| `pressbase_404` | action | `{ path, query, referrer, user, main }`: a 404 is being served (pages, missing sitemaps and feeds, `notFound(404)`) | none: WordPress plugins check `is_404()` in `template_redirect` |

`template_redirect` runs once per public render, before robots.txt, sitemaps, feeds, plugin files and pages; the first `redirect()` or `notFound()` wins (later calls return `false`). Locations must be `http(s)` URLs or paths starting with `/`; line breaks and unsafe characters are removed or encoded (`wp_sanitize_redirect()`). A plugin redirect wins over core's own canonical and old-permalink redirects.

**With the page cache** ([ADR 0017](../adr/0017-early-request-hooks-and-the-page-cache.md)): these hooks run inside the render `apps/web` caches and shares with every anonymous visitor.

- Decide from the URL and the site's data, never from the visitor (cookies, user agent, referrer).
- When a rule changes, purge its source path: `await api.cache.purgePaths(['/old-post/'])`. Every answer carries a `path:{path}` tag, so this drops the cached page (and its `?query` variants) and the next request gets the redirect. Regex rules purge `site`.
- While anything listens to `pressbase_404`, 404 answers are `no-store`, so every hit reaches the action (WordPress's `nocache_headers()`). Keep the callback quick, or queue the write with `api.jobs`.

### Head output and canonical URLs

Core's head callbacks carry WordPress's function names, so a plugin that prints its own tags removes core's by name, as `remove_action( 'wp_head', 'rel_canonical' )` does. Removed callbacks come back, in their place, when the plugin is deactivated (`core-callbacks.ts`).

```ts
api.hooks.removeAction('wp_head', 'rel_canonical');
api.hooks.addAction('wp_head', async (out, page) => {
  const object = page.main.queriedObject;
  const url = object?.kind === 'post' && (await api.content.canonicalUrl(object.post));
  if (url) out.print(`<link rel="canonical" href="${escapeAttribute(url)}" />`); // escape what you print
}, 1);
api.hooks.addFilter('get_canonical_url', (url, post) => url);   // or just filter core's
```

| Named callback on `wp_head` | Priority | Prints |
| --- | --- | --- |
| `_block_template_viewport_meta_tag` | 0 | viewport meta |
| `wp_robots` | 1 | robots meta (filter `wp_robots` to change it rather than removing it) |
| `_wp_render_title_tag` | 1 | `<title>` (filters `document_title_parts`, `pre_get_document_title`, `document_title_separator`) |
| `wp_generator` | 1 | generator meta |
| `rel_canonical` | 1 | `<link rel="canonical">` on published singular pages, from `wp_get_canonical_url()` |
| `feed_links` | 2 | feed links (`feed_links()` and `feed_links_extra()`) |
| `wp_site_icon` | 99 | site icon links |

Core prints no meta description and no Open Graph or X tags, so a plugin adds its own without removing anything. `api.content.canonicalUrl(post)` is `wp_get_canonical_url()`: the permalink of a published post (with `comment-page-N/` when it's the page being rendered), through the `get_canonical_url` filter; `false` for anything unpublished. `api.content.permalink(post)` is `get_permalink()`.

### The page cache: api.cache

Output a plugin prints is cached ([ADR 0008](../adr/0008-public-page-caching.md)). Content changes and option changes (including the plugin's own `api.options` and settings) already purge what they affect. For anything else:

| `api.cache.` | |
| --- | --- |
| `purge(tags)` | announces `pressbase_cache_purge (tags, 'plugin:{slug}')`, which reaches every `apps/web` instance: `site`, `post:{id}`, `term:{id}`, `posts:{type}`, `path:{path}`, or the plugin's own tags |
| `purgePaths(paths)` | `purge()` with each path's tag |
| `addTags(...tags)` | records tags on the render in progress (in `wp_head`, a block, a file handler) so a later `purge()` reaches it, e.g. `my-plugin:settings` |
| `pathTag(path)` | `path:/old-post` (no trailing slash, no query) |

Tags are 1 to 200 printable ASCII characters. Prefix your own with the plugin's slug.

### Plugin files at the site root

```ts
api.public.addFile('/llms.txt', async () => {
  const { posts } = await api.content.query({ post_type: 'post', posts_per_page: 20 });
  return `# Posts\n${posts.map((p) => `- ${p.title}`).join('\n')}`;
});
api.public.addFile(`/${key}.txt`, () => key, { cache: false });  // IndexNow's key file
```

`addFile(path, handler, { contentType, cache })` returns a function that removes the file. The handler receives `{ path, query, user }` and returns the body as a string, `{ body, status, contentType, headers }`, or `null` for a 404. The content type defaults from the extension (`.txt` → `text/plain; charset=utf-8`, `.xml`, `.json`, `.md`, `.csv`, `.html`). A handler that throws answers 500 and is recorded against the plugin.

- **Core wins:** `robots.txt`, `favicon.ico`, sitemap and feed addresses (as core parses them, pretty or plain), anything under `/wp-`, and the admin's paths (`/admin`, `/login`, `/install`, `/lost-password`, `/reset-password`, `/editor-assets`, `/_next`, `/_pressbase`) are refused when the file is added, so the plugin fails to activate rather than shadowing them. Paths are letters, numbers, `.`, `_`, `~` and `-` in `/`-separated segments (`/.well-known/thing.json` is fine); two plugins can't serve the same path.
- **Only active plugins answer:** files are removed on deactivation, which also purges `site`.
- **Caching:** answers are cached like pages, tagged with what the handler read (`api.content.query` records `posts:post`, so a new post refreshes `/llms.txt`), `site` and the file's path tag. Use `cache: false` (`private, no-store`) when the content can change without a purge; or call `api.cache.purgePaths([path])` when it does.

Answers come from core's render endpoint, so they work on the public site and, through the admin's fallback rewrite, on the admin origin too.

### Plugin tables at scale

Plugin migrations are plain SQL ([Migrations](#migrations)), so indexes, unique constraints, partial indexes and foreign keys to the plugin's own tables all work. For tables that grow (redirects, form entries, logs):

```sql
-- migrations/0001-redirects.sql
create table my_seo_redirects (
  id bigserial primary key,
  source text not null,
  target text not null,
  status smallint not null default 301,
  hits bigint not null default 0,
  last_hit timestamptz
);
create unique index my_seo_redirects_source_idx on my_seo_redirects (source);
create index my_seo_redirects_last_hit_idx on my_seo_redirects (last_hit);
```

```ts
const { db } = api; // needs the "database" permission
const { sql } = db;
// Upsert on the unique index: one statement, no race.
await db.query(sql`insert into my_seo_redirects (source, target) values (${from}, ${to})
                   on conflict (source) do update set target = excluded.target`);
// Keyset pagination: "after the last id", never OFFSET (which reads every skipped row).
const page = await db.query<{ id: string; source: string }>(
  sql`select id, source from my_seo_redirects where id > ${after} order by id limit 50`);
// Pruning in batches, from a daily cron event.
api.cron.addAction('prune', () => db.query(sql`delete from my_seo_404s where id in (
  select id from my_seo_404s where last_hit < now() - interval '90 days' limit 5000)`));
```

- `api.db.query(sql)` runs one query and returns its rows on PostgreSQL and PGlite alike (`api.db.db.execute()` returns `{ rows }` on one and an array on the other). `bigint` columns can come back as strings: convert with `Number()`.
- Index every column you filter or sort on; keep a unique index on natural keys (a redirect's source) and use `on conflict` instead of check-then-insert.
- Paginate with keyset conditions (`where id > $last order by id limit n`, or `(created, id) < ($c, $i)` for newest first) and return a cursor; `offset` gets slower with every page.
- Cap logs: a daily `api.cron` event deleting old rows in batches (a few thousand per statement keeps locks short), and count with a capped `select count(*) from (… limit 10001)` rather than counting millions of rows.
- `create index concurrently` can't run inside a transaction: on PostgreSQL put it alone in its own migration file (one statement runs outside an implicit transaction block). On PGlite it isn't needed.
- Drop your tables in `uninstall`. Name them with the plugin's prefix.

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
## Admin pages and settings

The admin is a prebuilt Next.js app and plugins arrive at runtime, so nothing a plugin adds to the admin may need a rebuild. Two mechanisms cover it ([ADR 0011](../adr/0011-plugin-admin-extensions.md)):

1. **Declarative settings** (most plugins): the plugin describes its settings on the server and the admin draws the page. No admin JavaScript.
2. **UI modules** (the rest): a browser ES module the admin imports at runtime, which renders React into named **slots**: a page body, dashboard widgets, editor panels.

Code: `apps/core/src/plugins/admin.ts` (registrations, validation), `apps/core/src/routes/plugin-admin.ts` (REST and module serving); in the admin, `src/lib/extensions/` (registry, pages, settings helpers) and `src/components/extensions/` (host API, slots, the generic settings form). The example plugin uses all of it: [`plugins/daily-tips`](../../plugins/daily-tips) has a settings page, a dashboard widget, an editor panel, a Writing sidebar that follows the post as it's typed, and a Words column in the posts list.

### Settings

A setting is WordPress's `register_setting()` and its `add_settings_field()` in one: the stored value's rules and the field that edits it. Declare it in `plugin.json` or register it in code (needed for a `sanitize` callback):

```jsonc
// plugin.json
"admin": {
  "sections": [{ "id": "look", "title": "Look", "description": "How tips appear." }],
  "settings": [
    { "name": "accent", "control": "color", "label": "Widget colour", "default": "#3858e9", "section": "look" },
    { "name": "show_in_posts", "control": "toggle", "label": "Add a tip to posts", "default": true, "showInRest": true }
  ]
}
```

```js
// index.js
api.settings.register('own_tips', {
  control: 'textarea',
  label: 'Your tips',
  section: 'look',
  sanitize: (value) => {
    const tips = value.split('\n').map((t) => t.trim()).filter(Boolean);
    if (tips.length > 20) throw new Error('Keep it to 20 tips.'); // shown on the field
    return tips.join('\n');
  },
});
const tips = await api.settings.get('own_tips'); // stored value or the default
```

| Argument | Notes | WordPress |
| --- | --- | --- |
| `control` | `text`, `textarea`, `number`, `toggle`, `select`, `radio`, `url`, `email`, `color` | the field callback |
| `type` | `string`, `boolean`, `integer`, `number`, `array`, `object`; derived from `control` when left out (and the other way round). `array` and `object` have no field: REST only | `type` |
| `label`, `description`, `placeholder` | shown on the field | `label`, `description` |
| `default` | returned while nothing is stored; validated on registration | `default` |
| `options` | `[{ value, label }]` for `select` and `radio` (strings, or numbers for an integer) | |
| `min`, `max`, `step`, `maxLength`, `required` | validation, also used by the field | |
| `section`, `page` | the section (default: an untitled first one) and the page (default: the plugin's settings page) | `add_settings_field( …, $page, $section )` |
| `capability` | to see and change it; default `manage_options` | |
| `showInRest` | also at `/wp/v2/settings`, under its option name | `show_in_rest` |
| `option` | where it's stored: default `{prefix}{name}` (`daily_tips_accent`), as `api.options`. Another option needs the `options` permission | `$option_name` |
| `sanitize(value, option)` | runs after validation; return what to store, or throw to refuse the value | `sanitize_callback` |

Saving a setting (from its page, `/wp/v2/settings` or `api.settings.set`) runs what `update_option()` runs: the field's validation, the `sanitize` callback, the `sanitize_option_{option}` filter, then `pre_update_option_{option}` and `pre_update_option`. A page saves all or nothing: if any field is refused, nothing is stored and each message is shown on its field. `api.options.set` writes without any of this, like writing the option directly.

Settings of a plugin that doesn't name a page show on its **settings page**: titled after the plugin, under **Settings** (`add_options_page()`), at `/admin/settings/{plugin}`. The page uses the same cards, save bar, "Settings saved." toast and field errors as core's settings screens. Sections become cards, in registration order.

### Admin pages

```jsonc
"admin": {
  "pages": [
    { "slug": "reports", "title": "Reports", "parent": "tools", "entry": "admin/reports.js" },
    { "slug": "advanced", "title": "Advanced", "parent": "settings" }
  ]
}
```

or `api.admin.addPage({ slug, title, parent, capability, description, entry })`.

| `parent` | Where it shows | URL | WordPress |
| --- | --- | --- | --- |
| `settings` | Settings' sub-navigation, after core's screens | `/admin/settings/{plugin}[/{page}]` | `add_options_page()` |
| `tools` | listed on **Tools**, under Pressbase's own tools (`apps/admin/src/lib/tools.ts`) | `/admin/tools/{plugin}[/{page}]` | `add_management_page()` |
| none | the sidebar's **Extend** group, after Plugins | `/admin/plugin/{plugin}[/{page}]` | `add_menu_page()` |

The `/{page}` segment is left out when the page's slug is the plugin's. A page shows its `entry` module's UI, then the settings registered with `page: slug`, or both. `capability` (default `manage_options`) is checked by core: pages a user can't open are left out of their navigation and answer 403. At most 20 pages per plugin.

### REST

| Request | What | Errors |
| --- | --- | --- |
| `GET /pressbase/v1/admin-extensions` | `{ pages, modules }`: the plugin pages the current user may open, and active plugins' UI modules. Any logged-in user | `rest_not_logged_in` |
| `GET /pressbase/v1/plugin-pages/{plugin}/{page}` | the page, its `sections` with their `fields` (keyed by option name) and the current `values` | `rest_plugin_page_not_found`, `rest_forbidden` |
| `POST/PUT/PATCH /pressbase/v1/plugin-pages/{plugin}/{page}` | saves `{ option: value }`; settings not on the page, or that the user can't change, are ignored | `rest_invalid_param` (`data.params` by option) |

### UI modules

A UI module is a compiled ES module in the plugin folder, declared as `admin.module` (imported on every admin screen, to add dashboard widgets and editor panels) or as a page's `entry` (imported when the page opens; its default export is the page's component). Core serves both at `/wp-content/plugins/{plugin}/{file}?ver={version}` and the admin imports them with `import()`.

```js
// admin/index.js — no build step needed
const { element: { createElement: h, useState }, api, registerPlugin, DashboardWidget } = window.pressbase;

function Tip() {
  const [tip, setTip] = useState('');
  return h('div', null, tip, h('button', { onClick: async () => setTip((await api('/my-plugin/v1/tip')).tip) }, 'Another tip'));
}

registerPlugin('my-plugin', { render: () => h(DashboardWidget, { title: 'Writing tip' }, h(Tip)) });
```

Modules must use the admin's React through `window.pressbase`, not bundle their own (two Reacts can't share hooks). With a bundler, write JSX, mark `react`, `react-dom` and `react/jsx-runtime` as externals and map them to `window.pressbase.React`, `.ReactDOM` and `.jsxRuntime`.

**The host API, `window.pressbase`** (`apiVersion: 1`; additions keep the version, removals bump it):

| Member | What |
| --- | --- |
| `React`, `ReactDOM`, `jsxRuntime` | the admin's own copies |
| `element` | `@wordpress/element`'s shape: `createElement`, `Fragment`, `createContext`, `createPortal`, `memo`, `forwardRef`, `lazy`, `Suspense`, and the hooks (`useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `useReducer`, `useContext`, `useId`, `useSyncExternalStore`…) |
| `api(path, { method, body })`, `ApiError` | `fetch` for `/wp-json`, with the session cookie and the `X-Pressbase-Request` header writes need; throws `ApiError` (`status`, `code`, `message`, `data`) |
| `registerPlugin(name, { render })`, `unregisterPlugin`, `getPlugins`, `usePluginContext` | `@wordpress/plugins`: `render` is a component that renders Fills |
| `Fill`, `Slot`, `slots` | SlotFill: `<Fill name="dashboard">…</Fill>`; `slots` lists the names |
| `DashboardWidget`, `PluginDocumentSettingPanel` | Fills for the two built-in places |
| `PluginSidebar`, `PluginSidebarMoreMenuItem`, `PluginPrePublishPanel` | Fills for the post editor: a sidebar tab, a top-bar button that opens it, a panel before publishing ([Slots](#slots)) |
| `PostsListColumn`, `PostsListRowAction`, `PostsListFilter` | Fills for the posts and pages lists ([Slots](#slots)) |
| `TermEditFields`, `UserProfileFields` | Fills for the category and tag edit form, and the profile and user edit screens ([Slots](#slots)) |
| `editor` | the post being edited, live: `usePost(selector?)`, `getPost()`, `getEditedPostAttribute(name)`, `editPost(edits)`, `subscribe(listener)` ([Live editor data](#live-editor-data)) |
| `components` | the admin's UI kit: `Button`, `Spinner`, `Card`, `Notice`, `Badge`, `EmptyState`, `TextField`, `TextAreaField`, `SelectField`, `Checkbox` |
| `useToast()`, `useCurrentUser()` | the admin's toast (`toast('Saved.')`) and the user, with `capabilities` |

Each `registerPlugin()` is attributed to the plugin whose module was loading (modules load one at a time). When the plugin is deactivated its plugins and fills disappear at the next navigation; a module can't be unloaded, so it reappears without a re-import if the plugin is reactivated. A new `version` gives a new URL and a fresh import.

### Slots

| Slot | Where | Fill props | Fill function receives |
| --- | --- | --- | --- |
| `dashboard` (`DashboardWidget`) | a card on the Dashboard, after core's | `title`, `size` (`small`: a third of the width, `large`: two thirds), `order` | — |
| `editor.document-settings` (`PluginDocumentSettingPanel`) | a panel in the post and page editor's Post tab, before Revisions | `title`, `order` | `{ postId, postType }` (`postId` is null for a new post) |
| `plugin-page/{plugin}/{page}` (`slots.page(plugin, page)`) | a plugin page's body, after its `entry`'s component | `order` | `{ plugin, page }` |
| `editor.sidebar` (`PluginSidebar`) | a tab in the post and page editor's sidebar, after Post and Block, shown as its icon (named by `title`); its panel has the title as a heading and renders only while open | `name` (unique in the plugin), `title`, `icon`, `order` | `{ postId, postType }` |
| `editor.sidebar-more-menu` (`PluginSidebarMoreMenuItem`) | a button in the editor's top bar that opens (or closes) the sidebar `target`; the children are its label | `target`, `icon`, `order` | — |
| `editor.pre-publish` (`PluginPrePublishPanel`) | a panel in "Ready to publish?", which opens before a first publish (or schedule) only when there are such panels; the Publish button there always works | `title`, `initialOpen` (default true), `order` | `{ postId, postType }` |
| `posts-list.columns` (`PostsListColumn`) | a column after Date in the posts and pages lists (hidden on narrow screens), as `manage_posts_columns` | `title`, `postTypes`, `order` | the child is a function of `{ post, postType }`, called per row |
| `posts-list.row-actions` (`PostsListRowAction`) | a link or button among a row's actions (not in the Trash), as `post_row_actions` | `label` (or a function of the post), `href(post)` or `onClick(post, { reload })`, `isVisible(post)`, `postTypes`, `order` | — |
| `posts-list.filters` (`PostsListFilter`) | a select beside the category filter, as `restrict_manage_posts` | `id`, `label` (the "all" option), `options` (`[{ value, label }]`), `query(value)`, `postTypes`, `order` | — |
| `term.edit-fields` (`TermEditFields`) | fields in a category's or tag's edit form, after Description, as `{taxonomy}_edit_form_fields` | `taxonomies` (`category`, `post_tag`), `order` | `{ taxonomy, term, meta, editMeta }` |
| `user.profile-fields` (`UserProfileFields`) | a card on Profile and on a user's edit screen, after Account, as `show_user_profile` / `edit_user_profile` | `title`, `description`, `order` | `{ user, isSelf, meta, editMeta }` |

Fills are ordered by `order` (default 10), then by registration. A fill's children can be elements or a function of the slot's props. `postTypes` and `taxonomies` take a name or a list; without them a fill shows everywhere its slot is.

**Posts lists.** The lists load posts with `context=edit`, so a column's `post` is the whole REST post: `content.raw`, `meta` (registered with `show_in_rest`), the terms. No extra request is needed. A filter's chosen value goes in the URL as `?{id}=value` (so it survives reloads and links), and `query(value)` returns REST parameters for `/wp/v2/{type}`. The list's own parameters (`status`, `search`, `page`, `categories`…) can't be used, and ids that clash with them are ignored. On the server, read the parameters with the `rest_{post_type}_query` filter (as in WordPress) and return query arguments, e.g. a `meta_query`:

```js
// index.js (server)
api.hooks.addFilter('rest_post_query', (args, params) =>
  params['my-seo-description'] === 'missing'
    ? { ...args, meta_query: [{ key: '_yoast_wpseo_metadesc', compare: 'NOT EXISTS' }] }
    : args,
);
```

```js
// admin/index.js
h(PostsListFilter, {
  id: 'my-seo-description',
  label: 'All descriptions',
  options: [{ value: 'missing', label: 'Missing a description' }],
  query: (value) => ({ 'my-seo-description': value }),
});
```

**Term and profile fields** get the object's `meta` with unsaved edits and `editMeta(edits)`, which merges edits key by key. The edits save with the form (only the keys that changed are sent, as `meta` in the REST request); Discard and Cancel drop them. Register the meta on the server with `show_in_rest` so REST accepts it.

**Errors are contained.** Every fill, page component and plugin `render` runs inside an error boundary. A fill that throws is replaced by "The {plugin} plugin ran into a problem, so this part can’t be shown." with the error under *Details*; the rest of the screen works. A module that fails to import, or a `render` that throws, shows a warning naming the plugin above the screen's content.

### Live editor data

`window.pressbase.editor` is the post being edited, live, for editor fills: Gutenberg's `select('core/editor')` and `editPost()` with Pressbase names ([ADR 0018](../adr/0018-editor-data-for-plugins.md)).

| Member | What | Gutenberg |
| --- | --- | --- |
| `usePost()` | the post (below), re-rendering on every change; `null` outside the editor | `useSelect(select => select('core/editor').getCurrentPost())` |
| `usePost(selector)` | one part, e.g. `usePost((post) => post.meta.my_key)`; re-renders only when it changes. Return primitives or stable references | `useSelect(select => …getEditedPostAttribute('meta'))` |
| `getPost()`, `getEditedPostAttribute(name)` | the same, outside React | `select('core/editor').getEditedPostAttribute(name)` |
| `editPost({ meta, slug, excerpt })` | changes the post; `meta` merges key by key. Returns false outside the editor; other keys throw | `dispatch('core/editor').editPost()` |
| `subscribe(listener)` | called on every change; returns the unsubscribe | `subscribe()` |

The post has REST field names, with the edits not yet saved:

| Field | What |
| --- | --- |
| `id`, `type`, `status` | `id` is null and `status` is `auto-draft` until a new post is saved |
| `title`, `excerpt`, `slug` | as typed |
| `content` | serialised block markup; follows typing within about 300 ms |
| `blocks` | the parsed blocks (`name`, `attributes`, `innerBlocks`), parsed from `content` when first read |
| `featured_media` | attachment ID, 0 for none |
| `categories`, `tags`, `terms` | term IDs, and `terms.categories` / `terms.tags` as `{ id, name }` (a tag typed but not yet created has `id` 0) |
| `meta` | registered post meta (`show_in_rest`), with edits. A new post has only the keys plugins have edited until its first save, so read a missing key as its default |
| `link`, `permalink` | the saved permalink, and the one the edited slug gives (where pretty permalinks make that knowable) |
| `isDirty`, `isSaving` | unsaved changes; a save in progress |

Edits through `editPost()` are unsaved changes like any other: the editor shows "Unsaved changes", warns before leaving, keeps them in the browser copy, and saves them with the post (only the meta keys that changed). The minute autosave stores the title, content and excerpt, as WordPress's does, so meta edits stay unsaved after it until the next save; the browser copy protects them meanwhile, and restoring it brings them back.

```js
const { element: { createElement: h }, editor, PluginSidebar, components: { TextAreaField } } = window.pressbase;

function SearchPreview() {
  const title = editor.usePost((post) => post.title);
  const description = editor.usePost((post) => post.meta.my_seo_description ?? '');
  return h('div', null,
    h('p', null, title),
    h(TextAreaField, {
      label: 'Meta description',
      value: description,
      onChange: (e) => editor.editPost({ meta: { my_seo_description: e.target.value } }),
    }),
  );
}

registerPlugin('my-seo', {
  render: () => h(PluginSidebar, { name: 'seo', title: 'SEO', icon: SeoIcon }, h(SearchPreview)),
});
```

The editor panel is Pressbase's own sidebar, not Gutenberg's `@wordpress/edit-post` (the admin embeds the block editor, not the edit-post screen), so `PluginDocumentSettingPanel` here is a look-alike with the same purpose and props; `window.wp` is not provided.

### Security of UI modules

- **Admin JavaScript runs with the privileges of whoever is looking at the admin.** A UI module can call any REST route the current administrator can, read the page and change it. It's as trusted as the plugin's server code, which already runs with full access to the server (see [Security model](#security-model-and-limits)). Only administrators install plugins (`install_plugins`), and activating one is a decision to trust it in both places.
- Modules are served **only while the plugin is active**, only from the folders that hold declared modules (a module at the plugin's root is served alone), never the server `main` file, and only with allowed extensions (`.js`, `.mjs`, `.css`, images, fonts). Paths are decoded and checked segment by segment (`..`, encoded slashes, dot-files and symlinks out of the folder answer 404). Responses carry `X-Content-Type-Options: nosniff` and no CORS header. **Don't put secrets in a module's folder**: anything there is downloadable while the plugin is active.
- **CSP.** Module URLs are same-origin (the admin proxies `/wp-content/plugins/*` to core, like `/wp-json`), loaded with `import()`: no inline scripts, `eval` or third-party origins. The admin doesn't send a Content-Security-Policy yet; when it does, `script-src 'self'` covers plugin modules.
- **Caching.** With `?ver=` matching the plugin's version, modules are `Cache-Control: public, max-age=31536000, immutable`; otherwise `no-cache`. Bump the version when a module changes.

## Not yet

`PluginApi` in `runtime.ts` is the SDK's surface; keep it narrow and add to it rather than handing plugins the kernel. It is frozen with semantic versioning at 1.0.

Later work; the seams are in place:

- In-place plugin updates, a plugin directory, multisite (`network-active`).
