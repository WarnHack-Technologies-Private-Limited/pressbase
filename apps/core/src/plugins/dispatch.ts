import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { PostType } from '../content/post-types';
import type { Taxonomy } from '../content/taxonomies';
import { type AppEnv, restError } from '../http';
import { postsRoutes } from '../routes/posts';
import { termsRoutes } from '../routes/terms';

/**
 * Dynamic routing for what plugins register while the site runs.
 *
 * Hono compiles its router on the first request, so routes can't be added to
 * the app afterwards. Instead, createApp() ends with one catch-all handler,
 * `pluginRoutes`, which looks up the registry on every request and hands the
 * request to a small Hono app built for that post type, taxonomy or plugin
 * namespace (and cached until it's unregistered). Deactivating a plugin
 * removes the registration, and the next request gets a 404.
 */

interface ParentEnv {
  parent: Context<AppEnv>;
}

/** Copies the request's kernel and user into a sub-app run with `dispatch()`. */
const inheritContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const parent = (c.env as unknown as ParentEnv).parent;
  c.set('kernel', parent.get('kernel'));
  c.set('user', parent.get('user'));
  await next();
};

/** A fresh app that serves routes at their full paths (`/wp-json/...`) for `dispatch()`. */
export function createSubApp(onError?: (error: Error, c: Context<AppEnv>) => Response) {
  const app = new Hono<AppEnv>({ strict: false });
  app.use(inheritContext);
  app.onError(
    onError ??
      ((error, c) => {
        console.error(error);
        return restError(c, 500, 'pressbase_internal_error', 'Something went wrong on the server.');
      }),
  );
  app.notFound((c) =>
    restError(c, 404, 'rest_no_route', 'No route was found matching the URL and request method.'),
  );
  return app;
}

/** Runs the request through a sub-app made with `createSubApp()`. */
export function dispatch(app: Hono<AppEnv>, c: Context<AppEnv>): Response | Promise<Response> {
  return app.fetch(c.req.raw, { parent: c } satisfies ParentEnv as never);
}

const typeApps = new WeakMap<PostType | Taxonomy, Hono<AppEnv>>();

function typeApp(entry: PostType | Taxonomy, kind: 'postType' | 'taxonomy'): Hono<AppEnv> {
  let app = typeApps.get(entry);
  if (!app) {
    app = createSubApp();
    const base = `/wp-json/wp/v2/${entry.restBase}`;
    if (kind === 'postType') app.route(base, postsRoutes(entry as PostType));
    else app.route(base, termsRoutes(entry as Taxonomy));
    typeApps.set(entry, app);
  }
  return app;
}

const WP_V2 = /^\/wp-json\/wp\/v2\/([^/]+)(?:\/|$)/;

/**
 * The catch-all at the end of createApp(): plugin post types and taxonomies
 * at /wp/v2/{rest_base}, then plugin REST namespaces. Anything else is a 404.
 */
export const pluginRoutes: MiddlewareHandler<AppEnv> = async (c) => {
  const kernel = c.get('kernel');
  const path = c.req.path;
  const base = WP_V2.exec(path)?.[1];
  if (base) {
    const type = kernel.postTypes.byRestBase(base);
    if (type && kernel.plugins.ownerOf('postType', type.name)) {
      return dispatch(typeApp(type, 'postType'), c);
    }
    const taxonomy = kernel.taxonomies.byRestBase(base);
    if (taxonomy && kernel.plugins.ownerOf('taxonomy', taxonomy.name)) {
      return dispatch(typeApp(taxonomy, 'taxonomy'), c);
    }
  }
  const runtime = kernel.plugins.runtimeForPath(path);
  if (runtime) return dispatch(runtime.restApp(), c);
  return restError(
    c,
    404,
    'rest_no_route',
    'No route was found matching the URL and request method.',
  );
};
