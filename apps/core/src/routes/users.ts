import { Hono } from 'hono';
import { type AppEnv, restError } from '../http';

/** The parts of WordPress's /wp/v2/users controller that exist so far. */
export function userRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/me', async (c) => {
    const user = c.get('user');
    if (!user) return restError(c, 401, 'rest_not_logged_in', 'You are not currently logged in.');
    const home = await c.get('kernel').options.get<string>('home', '');
    return c.json({
      id: user.id,
      username: user.login,
      name: user.displayName,
      slug: user.nicename,
      email: user.email,
      link: `${home}/author/${user.nicename}/`,
      roles: user.roles,
      capabilities: user.capabilities,
    });
  });

  return app;
}
