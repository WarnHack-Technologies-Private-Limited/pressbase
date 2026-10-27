import { Hono } from 'hono';
import {
  type AppEnv,
  loadSessionUser,
  requireInstalled,
  requireRequestHeader,
  restError,
} from './http';
import type { Kernel } from './kernel';
import { authRoutes } from './routes/auth';
import { blockRoutes } from './routes/blocks';
import { dashboardRoutes, postCountRoutes } from './routes/dashboard';
import { installRoutes } from './routes/install';
import { postsRoutes } from './routes/posts';
import { settingsRoutes } from './routes/settings';
import { termsRoutes } from './routes/terms';
import { typeRoutes } from './routes/types';
import { userRoutes } from './routes/users';
import { PRESSBASE_VERSION } from './version';

/**
 * Builds the HTTP application. Everything lives under /wp-json so URLs match
 * WordPress: wp/v2 for WordPress-compatible routes, pressbase/v1 for Pressbase's own.
 */
export function createApp(kernel: Kernel) {
  // Non-strict, so /wp-json and /wp-json/ both resolve, as in WordPress.
  const app = new Hono<AppEnv>({ strict: false });

  app.use(async (c, next) => {
    c.set('kernel', kernel);
    await next();
  });

  app.onError((error, c) => {
    console.error(error);
    return restError(c, 500, 'pressbase_internal_error', 'Something went wrong on the server.');
  });

  app.notFound((c) =>
    restError(c, 404, 'rest_no_route', 'No route was found matching the URL and request method.'),
  );

  const api = new Hono<AppEnv>({ strict: false });
  api.use(requireRequestHeader);
  api.use(loadSessionUser);

  api.get('/', async (c) => {
    const ready = kernel.state === 'ready';
    return c.json({
      name: ready ? await kernel.options.get<string>('blogname', '') : '',
      description: ready ? await kernel.options.get<string>('blogdescription', '') : '',
      url: ready ? await kernel.options.get<string>('home', '') : '',
      namespaces: ['pressbase/v1', 'wp/v2'],
      pressbase: { version: PRESSBASE_VERSION, state: kernel.state },
    });
  });

  api.route('/pressbase/v1/install', installRoutes());

  const installed = new Hono<AppEnv>({ strict: false });
  installed.use(requireInstalled);
  installed.route('/pressbase/v1/auth', authRoutes());
  installed.route('/pressbase/v1/dashboard', dashboardRoutes());
  installed.route('/pressbase/v1/post-counts', postCountRoutes());
  installed.route('/wp/v2/users', userRoutes());
  installed.route('/wp/v2/settings', settingsRoutes());
  installed.route('/wp/v2', typeRoutes());
  // One controller per registered type and taxonomy, at its rest_base. Plugins
  // register theirs before the app is built (the plugin loader arrives in v0.5).
  for (const type of kernel.postTypes.all()) {
    if (type.showInRest && ['post', 'page'].includes(type.name)) {
      installed.route(`/wp/v2/${type.restBase}`, postsRoutes(type));
    }
  }
  for (const taxonomy of kernel.taxonomies.all()) {
    if (taxonomy.showInRest) installed.route(`/wp/v2/${taxonomy.restBase}`, termsRoutes(taxonomy));
  }

  // Block engine (v0.3): /wp/v2/block-types, /block-renderer, /block-patterns and
  // /blocks (synced patterns). See docs/architecture/blocks.md.
  installed.route('/wp/v2', blockRoutes(kernel));

  api.route('/', installed);

  app.route('/wp-json', api);
  return app;
}
