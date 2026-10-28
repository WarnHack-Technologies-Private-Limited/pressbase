/**
 * @pressbase/plugin-sdk: types and a few tiny helpers for Pressbase plugins.
 *
 * The types are core's own (`PluginApi`, the hook registries, posts, jobs…),
 * generated from apps/core into `core.generated.d.ts` at build time. The
 * helpers below are the only runtime code, and they are identity functions
 * or a few lines each: a bundled plugin carries well under a kilobyte of SDK.
 *
 * See README.md and docs/architecture/plugins.md.
 */

import type {
  ActionArgs,
  ActionRegistry,
  FilterArgs,
  FilterRegistry,
  PluginApi,
  PluginManifestInput,
  PluginRequestContext,
  PluginRouteArgs,
} from './core.generated.js';

export type * from './core.generated.js';

/** What `register`, `activate`, `deactivate` and `uninstall` look like. */
export type PluginCallback = (api: PluginApi) => unknown;

/**
 * Types a plugin's `register(api)`, its default export. Returns it unchanged.
 *
 * ```ts
 * export default definePlugin((api) => {
 *   api.hooks.addFilter('the_title', (title) => title.toUpperCase());
 * });
 * ```
 */
export function definePlugin(register: PluginCallback): PluginCallback {
  return register;
}

/** Types an `activate`, `deactivate` or `uninstall` export. Returns it unchanged. */
export function defineLifecycle(callback: PluginCallback): PluginCallback {
  return callback;
}

/** Types a plugin.json object (for tools that write it). Returns it unchanged. */
export function defineManifest<const M extends PluginManifestInput>(manifest: M): M {
  return manifest;
}

/** Types a REST route's arguments for `api.rest.registerRoute()`. Returns them unchanged. */
export function defineRoute(args: PluginRouteArgs): PluginRouteArgs {
  return args;
}

/** A permission callback for public routes: `permission: allowAnyone`. */
export const allowAnyone = (): boolean => true;

/** A permission callback that allows users with `capability` (current_user_can()). */
export function requireCapability(
  api: Pick<PluginApi, 'rest'>,
  capability: string,
): (c: PluginRequestContext) => boolean {
  return (c) => api.rest.userCan(c, capability);
}

/**
 * A WordPress-shaped REST error, `{ code, message, data: { status } }`, as
 * core's own routes answer (WP_Error in a REST response).
 */
export function restError(
  status: number,
  code: string,
  message: string,
  data: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify({ code, message, data: { status, ...data } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Names of the filters core declares (any other string works with `addFilter` too). */
export type FilterName = keyof FilterRegistry;
/** Names of the actions core declares. */
export type ActionName = keyof ActionRegistry;
/** The value a filter passes through. */
export type FilterValue<K extends string> = FilterArgs<K>[0];
/** The arguments an action's callbacks receive. */
export type ActionParameters<K extends string> = ActionArgs<K>;
