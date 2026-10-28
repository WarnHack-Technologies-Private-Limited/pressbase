# Writing plugins

How to start, build, test and ship a Pressbase plugin. What a plugin can do (the full `api` reference), its manifest, lifecycle and security model are in [Plugins](../architecture/plugins.md).

## Start with the scaffolder

```sh
npx create-pressbase-plugin reading-time
# or: pnpm create pressbase-plugin reading-time
# from this repository: node packages/create-pressbase-plugin/bin.mjs reading-time
```

In a terminal it asks for a title, a description and whether to include a database table; flags answer for it:

| Flag | |
| --- | --- |
| `--title`, `--description`, `--author` | written to `plugin.json` |
| `--dir <path>` | where to create it (default `./<name>`) |
| `--no-database` | leave out the migration, the `database` permission and the table example |
| `--requires <range>` | the Pressbase versions it supports (default `>=0.1.0 <1`) |
| `--sdk <spec>` | the `@pressbase/plugin-sdk` version to depend on |
| `-y`, `--yes` | ask nothing, use the defaults |

The name follows `plugin.json`'s rules: lowercase letters, numbers and single dashes, at most 64 characters, not one of the reserved names (`wp`, `pressbase`, `oembed`, `wp-site-health`, `wp-abilities`, `wp-block-editor`). Nothing is downloaded while scaffolding.

You get:

```
reading-time/
  plugin.json          name, version, requires, main: dist/index.js, permissions, migrations
  package.json         build, typecheck and pack scripts
  src/index.ts         register(api): a wp_head hook, a stylesheet, two REST routes; activate, uninstall
  migrations/0001-create-greetings.sql
  public/style.css     served at /wp-content/plugins/reading-time/style.css
  build.mjs            esbuild → dist/index.js
  scripts/pack.mjs     → reading-time-0.1.0.zip
  tsconfig.json, README.md, .gitignore
```

## Build, check, pack

```sh
npm install
npm run build       # src/index.ts → dist/index.js (one ES module; the SDK's helpers are bundled in)
npm run typecheck   # tsc --noEmit: esbuild strips types without checking them
npm run pack        # build, then <name>-<version>.zip
```

The `.zip` holds one folder named after the plugin, with `plugin.json`, `dist/`, `migrations/`, `public/` and `README.md`: what [the installer](../architecture/plugins.md#installing-from-a-zip) accepts (deflate, no ZIP64, no symbolic links). Upload it in **Plugins → Upload plugin** or `POST /wp-json/wp/v2/plugins`.

Anything you `import` is bundled into `dist/index.js`, except Node's built-ins. Keep dependencies small: the plugin runs in core's process ([security model](../architecture/plugins.md#security-model-and-limits)).

## Develop against a local site

Run Pressbase (`pnpm dev`), then copy the plugin folder (without `node_modules`) into `.pressbase/plugins/<name>/`, or upload the `.zip`. Activate it in **Plugins**. After a rebuild, deactivate and activate it again: activation imports the module afresh (earlier copies stay in memory until core restarts). Symlinked plugin folders are skipped on purpose.

Errors your hooks, routes and jobs throw are logged with a `[plugin:<name>]` prefix and listed on the Plugins screen (`runtime_errors`).

## Types

`@pressbase/plugin-sdk` gives you `PluginApi` and every type it hands out, generated from core ([ADR 0012](../adr/0012-plugin-sdk-types.md)). Hook names core declares autocomplete in `api.hooks.addFilter` / `addAction`, with typed callbacks; other names work with `unknown` arguments. Declare your own:

```ts
declare module '@pressbase/plugin-sdk' {
  interface FilterRegistry {
    reading_time_minutes: [minutes: number, postId: number];
  }
}
```

Your `tsconfig.json` needs `"moduleResolution": "Bundler"` (or `NodeNext`) and Node's types (`@types/node`), as the scaffolded one has.

## Inside this repository

- `packages/plugin-sdk`: `pnpm --filter @pressbase/plugin-sdk build` regenerates `src/core.generated.d.ts` from `apps/core/src/plugins/sdk-types.ts` and compiles `dist/`. Turbo runs it before the SDK's typecheck and the scaffolder's tests. When you add a type plugins need, export it from `sdk-types.ts`; when a core module starts declaring hooks, add an `export type {} from …` line there (the build tells you).
- `packages/create-pressbase-plugin`: the template is in `template/` with `__PLUGIN_SLUG__`, `__PLUGIN_TITLE__`, `__PLUGIN_DESCRIPTION__` and `__PLUGIN_PREFIX__` placeholders; lines between `// @database-start` and `// @database-end` (or `--` in SQL) are dropped with `--no-database`. Its test scaffolds a plugin, links the workspace's SDK, esbuild and TypeScript in place of `npm install`, builds, typechecks and packs it, then installs the `.zip` through core's installer and calls its routes.
- The bundled example, `plugins/daily-tips`, stays plain JavaScript so it runs without a build step.
- `plugins/pressbase-seo` is the first first-party plugin: TypeScript built with esbuild like the scaffolded template, a workspace package (`plugins/*`) so `pnpm build` and `pnpm dev` build it and turbo typechecks and tests it after the SDK. Its tests copy it into a test site's plugin folder and activate it through REST. See [Pressbase SEO](../architecture/seo-plugin.md).
