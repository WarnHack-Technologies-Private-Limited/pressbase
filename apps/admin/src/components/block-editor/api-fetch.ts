import type { APIFetchMiddleware, ApiFetch, FetchHandler } from '@wordpress/api-fetch';

/**
 * @wordpress/api-fetch is how every WordPress package talks to the REST API
 * (core-data, ServerSideRender, media uploads, link search…). Pressbase
 * configures it once, before the editor mounts:
 *
 * - root: `/wp-json/` on the admin's own origin (proxied to core);
 * - every request sends `X-Pressbase-Request: 1`, core's CSRF guard;
 * - cookies only go to the same origin;
 * - PUT, PATCH and DELETE keep their real method. api-fetch's built-in
 *   httpV1Middleware rewrites them to POST + X-HTTP-Method-Override for old
 *   servers; core speaks HTTP/1.1 methods natively.
 */

export const REST_ROOT = '/wp-json/';
const OVERRIDE = 'X-HTTP-Method-Override';

export const pressbaseMiddleware: APIFetchMiddleware = (options, next) =>
  next({
    ...options,
    credentials: 'same-origin',
    headers: { ...options.headers, 'x-pressbase-request': '1' },
  });

/** Wraps a fetch handler so method overrides become real methods again. */
export function withRealMethods(handler: FetchHandler): FetchHandler {
  return (options) => {
    const headers = { ...options.headers };
    const override = Object.keys(headers).find(
      (key) => key.toLowerCase() === OVERRIDE.toLowerCase(),
    );
    if (!override || (options.method ?? 'GET').toUpperCase() !== 'POST') return handler(options);
    const method = headers[override];
    delete headers[override];
    return handler({ ...options, method, headers });
  };
}

const configured = new WeakSet<ApiFetch>();

/** Idempotent: safe to call from every editor mount. */
export function configureApiFetch(apiFetch: ApiFetch): void {
  if (configured.has(apiFetch)) return;
  configured.add(apiFetch);
  apiFetch.use(apiFetch.createRootURLMiddleware(REST_ROOT));
  apiFetch.use(pressbaseMiddleware);
  apiFetch.setFetchHandler(withRealMethods(apiFetch.defaultFetchHandler));
}
