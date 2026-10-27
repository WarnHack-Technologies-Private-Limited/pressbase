import { Hono } from 'hono';
import { type AppEnv, requireInstalled } from '../http';
import { applicationPasswordRoutes } from './application-passwords';
import { passwordResetRoutes } from './password-reset';
import { userCountRoutes } from './users';

/**
 * The People routes that sit beside the users controller: application
 * passwords, role and post counts for the Users screen, and password reset.
 * (The users controller itself is mounted with the other wp/v2 routes.)
 * Mounted at the API root, so each path checks the site is installed itself.
 */
export function peopleRoutes() {
  const app = new Hono<AppEnv>({ strict: false });
  for (const path of ['/wp/v2/users/*', '/pressbase/v1/user-counts', '/pressbase/v1/auth/*']) {
    app.use(path, requireInstalled);
  }
  app.route('/wp/v2/users', applicationPasswordRoutes());
  app.route('/pressbase/v1/user-counts', userCountRoutes());
  app.route('/pressbase/v1/auth', passwordResetRoutes());
  return app;
}
