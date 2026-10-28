# create-pressbase-plugin

Creates a [Pressbase](https://github.com/WarnHack-Technologies-Private-Limited/pressbase) plugin: `plugin.json`, TypeScript typed with `@pressbase/plugin-sdk`, an esbuild build, a migration, and a script that packs an installable `.zip`.

```sh
npx create-pressbase-plugin reading-time
# or
pnpm create pressbase-plugin reading-time

cd reading-time
npm install
npm run pack        # → reading-time-0.1.0.zip, ready for Plugins → Upload plugin
```

Asked in a terminal, given as flags otherwise:

```
create-pressbase-plugin <name> [--title <title>] [--description <text>] [--author <name>]
                               [--dir <path>] [--no-database] [--requires <range>]
                               [--sdk <spec>] [--yes]
```

Names use lowercase letters, numbers and single dashes (at most 64 characters), like plugin.json's `name`. Scaffolding needs no network; `npm install` fetches the SDK, esbuild and TypeScript.

The generated plugin has a `wp_head` hook, a stylesheet in `public/`, `GET /wp-json/<name>/v1/hello`, an authenticated route reading a table its migration creates, and `activate` / `uninstall` callbacks. See its README and [Writing plugins](../../docs/development/writing-plugins.md).

## In this repository

```sh
node packages/create-pressbase-plugin/bin.mjs my-plugin --dir /tmp/my-plugin
pnpm --filter create-pressbase-plugin test   # scaffolds, builds, typechecks, packs, installs and runs a plugin
```

The template is in `template/` (placeholders `__PLUGIN_SLUG__`, `__PLUGIN_TITLE__`, `__PLUGIN_DESCRIPTION__`, `__PLUGIN_PREFIX__`; `@database-start` / `@database-end` blocks are dropped with `--no-database`). The code is plain Node with no dependencies (`src/scaffold.mjs`).

GPL-2.0-or-later.
