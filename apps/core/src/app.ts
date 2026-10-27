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
import { dashboardRoutes } from './routes/dashboard';
import { installRoutes } from './routes/install';
import { settingsRoutes } from './routes/settings';
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
  installed.route('/wp/v2/users', userRoutes());
  installed.route('/wp/v2/settings', settingsRoutes());
  api.route('/', installed);

  app.route('/wp-json', api);
  return app;
}
