# 0012: The plugin SDK's types are generated from core

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Plugins are written in TypeScript against `PluginApi` ([ADR 0009](0009-plugin-runtime.md)) and ship compiled ESM. `@pressbase/plugin-sdk` has to give them that type, every hook name with its arguments, and the types the API hands out (posts, post types, queries, jobs, the page being rendered), with:

- no runtime dependency on core: a plugin's bundle must not pull in Hono, Drizzle or core's services;
- a plain `tsc` or esbuild build, outside the monorepo;
- no drift: `PluginApi` lives in `apps/core/src/plugins/runtime.ts` and grows in the same pull requests that add features (v0.5 alone adds cron, jobs, scripts, styles, settings and admin members). Hook argument types are declared next to the code that fires them, in about fifteen modules, through `declare module '@pressbase/hooks'`.

## Decision

**Core stays the source of truth. The SDK's build bundles core's declarations into one `.d.ts`.**

- `apps/core/src/plugins/sdk-types.ts` lists what the SDK exports (`PluginApi`, `PluginModule`, the hook registries, `Post`, `QueryArgs`, `Job`, `PageRender`…) and pulls in, with `export type {} from …`, every module that adds hooks.
- `packages/plugin-sdk/scripts/generate-types.mjs` bundles it with `rollup-plugin-dts` into `src/core.generated.d.ts` (git-ignored, rebuilt by `pnpm build`). Workspace packages (`@pressbase/hooks`, `db`, `blocks`…) are inlined; Hono, Drizzle and zod stay `import type`s, satisfied by the SDK's dependencies and erased at build time.
- The `declare module '@pressbase/hooks' { … }` blocks are unwrapped into top-level interfaces, which merge with the inlined `FilterRegistry` and `ActionRegistry`. Plugins extend the registries with `declare module '@pressbase/plugin-sdk'`.
- The generator fails when a module that adds hooks is missing from the entry, or when an augmentation of a workspace module survives.
- The SDK's runtime code is a few identity helpers (`definePlugin`, `defineManifest`, `defineRoute`…) and `restError()`, compiled by `tsc`.
- `test/usage.ts` in the SDK is a plugin that must typecheck (with `@ts-expect-error` checks that hook types are enforced), and `create-pressbase-plugin`'s test typechecks, builds, installs and runs a scaffolded plugin.

## Consequences

- A member added to `PluginApi`, or a hook declared anywhere in core, reaches plugin authors on the next build without anyone editing the SDK.
- The SDK depends on `hono`, `drizzle-orm` and `zod` for their types (installing them is the cost; bundles don't change). Types that name core classes (`PostsService`, `PageRender`) are exposed with their public members, so what core makes public on them becomes part of the plugin surface; review `sdk-types.ts` diffs as API changes.
- The generated file (~4,500 lines today) isn't committed, so its diff isn't reviewed directly. Freezing the API for 1.0 may add an API report (a committed, summarised declaration) checked in CI.
- The SDK's `typecheck` depends on its `build` (turbo: `@pressbase/plugin-sdk#typecheck`), and the build's inputs include core's sources so the turbo cache doesn't serve stale types.

## Alternatives considered

- **Move the types into the SDK and have core import them.** The cleanest dependency direction, but `PluginApi` references core's services and registries, which would have to become hand-written interfaces in the SDK and stay in sync with the classes; hook declarations would move away from the code that fires them; and every feature touching the API would edit two packages. Worth revisiting when the API is frozen at 1.0.
- **Ship core's `tsc --declaration` output.** Hundreds of files mirroring core's tree, still importing workspace packages plugin authors don't have.
- **`dts-bundle-generator` or API Extractor.** Both handle module augmentation of inlined packages poorly; `rollup-plugin-dts` plus a small unwrap step did what was needed.
