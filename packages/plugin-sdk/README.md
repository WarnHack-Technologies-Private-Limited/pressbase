# @pressbase/plugin-sdk

Types and a few tiny helpers for writing [Pressbase](https://github.com/WarnHack-Technologies-Private-Limited/pressbase) plugins in TypeScript.

```sh
npx create-pressbase-plugin my-plugin   # a plugin that uses it, with a build and a pack script
# or
npm install --save-dev @pressbase/plugin-sdk
```

```ts
import { allowAnyone, defineLifecycle, definePlugin } from '@pressbase/plugin-sdk';

export default definePlugin((api) => {
  // Hook names autocomplete; callbacks are typed.
  api.hooks.addFilter('wp_robots', (robots) => ({ ...robots, 'max-snippet': '-1' }));

  api.rest.registerRoute('my-plugin/v1', '/hello', {
    permission: allowAnyone,
    handler: (c) => ({ hello: c.req.query('name') ?? 'world' }),
  });

  api.cron.addAction('cleanup', async () => {
    /* runs daily, see activate */
  });
  api.styles.enqueue('my-plugin', 'style.css'); // public/style.css
});

export const activate = defineLifecycle(async (api) => {
  if (!(await api.cron.nextScheduled('cleanup'))) {
    await api.cron.scheduleEvent(Date.now() / 1000, 'daily', 'cleanup');
  }
});
```

## What's in it

| Export | |
| --- | --- |
| `definePlugin(register)` | types the default export, `register(api)` |
| `defineLifecycle(fn)` | types `activate`, `deactivate` and `uninstall` |
| `defineManifest(json)` | types a `plugin.json` object |
| `defineRoute(args)`, `allowAnyone`, `requireCapability(api, cap)` | REST routes and permission callbacks |
| `restError(status, code, message, data?)` | a WordPress-shaped REST error `Response` |
| `PluginApi`, `PluginModule`, `PluginManifest`, `PluginCron`, `PluginJobs`, `PluginScripts`, `PluginStyles` | the plugin API |
| `FilterRegistry`, `ActionRegistry`, `FilterName`, `ActionName`, `FilterValue<K>`, `FilterArgs<K>`, `ActionArgs<K>` | hook names and their arguments |
| `Post`, `PostTypeArgs`, `TaxonomyArgs`, `QueryArgs`, `QueryResult`, `CurrentUser`, `Job`, `PageRender`, `HtmlOutput`… | what the API hands out |

The helpers are identity functions or a few lines each; everything else is types. Bundling a plugin with esbuild adds well under a kilobyte.

Declare your plugin's own hooks to type them too:

```ts
declare module '@pressbase/plugin-sdk' {
  interface FilterRegistry {
    my_plugin_greeting: [greeting: string, name: string];
  }
}
```

Use `"moduleResolution": "Bundler"` (or `NodeNext`) and `@types/node`. The type declarations import `hono`, `drizzle-orm` and `zod` for types only (they are this package's dependencies); none of them reach your bundle.

## How the types are made

They are core's own: `scripts/generate-types.mjs` bundles `apps/core/src/plugins/sdk-types.ts` and everything it references into `dist/core.generated.d.ts`, folding every module's hook declarations into `FilterRegistry` and `ActionRegistry`. See [ADR 0012](../../docs/adr/0012-plugin-sdk-types.md).

```sh
pnpm --filter @pressbase/plugin-sdk build       # generate the types and compile dist/
pnpm --filter @pressbase/plugin-sdk typecheck   # includes test/usage.ts, a plugin that must compile
```

Docs: [Plugins](../../docs/architecture/plugins.md), [Writing plugins](../../docs/development/writing-plugins.md).

GPL-2.0-or-later.
