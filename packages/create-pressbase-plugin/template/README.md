# __PLUGIN_TITLE__

__PLUGIN_DESCRIPTION__

A [Pressbase](https://github.com/WarnHack-Technologies-Private-Limited/pressbase) plugin, made with `create-pressbase-plugin`.

## Develop

```sh
npm install
npm run build       # src/index.ts → dist/index.js
npm run typecheck   # type errors (the build only strips types)
npm run pack        # build, then __PLUGIN_SLUG__-<version>.zip
```

Upload the `.zip` in **Plugins → Upload plugin**, or with the REST API:

```sh
curl -u admin:APPLICATION_PASSWORD -F file=@__PLUGIN_SLUG__-0.1.0.zip \
  https://your-site.example/wp-json/wp/v2/plugins
```

While developing, you can also copy (not symlink) the folder into the site's
`.pressbase/plugins/__PLUGIN_SLUG__/`, then activate it from **Plugins**. After a rebuild,
deactivate and activate it again to load the new code.

## What's inside

| File | What it is |
| --- | --- |
| `plugin.json` | The manifest: name, version, the Pressbase versions it supports (`requires`), the entry (`main`), permissions. |
| `src/index.ts` | `register(api)` and the lifecycle callbacks, typed with `@pressbase/plugin-sdk`. |
| `migrations/` | `.sql` files run once each, in order, on activation. They need the `database` permission. |
| `public/` | Static files, served at `/wp-content/plugins/__PLUGIN_SLUG__/…` while the plugin is active. |
| `build.mjs` | esbuild: bundles `src/index.ts` into `dist/index.js`. |
| `scripts/pack.mjs` | Writes the installable `.zip`. |

The example adds a `<meta>` tag to public pages (`wp_head`), a stylesheet, and
`GET /wp-json/__PLUGIN_SLUG__/v1/hello?name=Ada`.

The full plugin API (hooks, post types, REST routes, options, cron, jobs,
scripts and styles…) is documented in
[docs/architecture/plugins.md](https://github.com/WarnHack-Technologies-Private-Limited/pressbase/blob/main/docs/architecture/plugins.md).
