import { type Context, Hono } from 'hono';
import { userCan } from '../auth/users';
import { type AppEnv, readJson, requireCapability, restError } from '../http';
import type { Kernel } from '../kernel';
import { SettingSanitizeError, sanitizeSettingValue } from '../options/settings';

async function readSettings(kernel: Kernel, user: Parameters<typeof userCan>[0]) {
  const result: Record<string, unknown> = {};
  for (const [name, setting] of kernel.settings.entries()) {
    if (!userCan(user, setting.capability)) continue;
    result[name] = await kernel.options.get(setting.option, setting.default);
  }
  return result;
}

/**
 * /wp/v2/settings — same field names and behaviour as WordPress: unknown
 * fields are ignored, and every field is validated before anything is saved.
 */
export function settingsRoutes() {
  const app = new Hono<AppEnv>();

  app.use(requireCapability('manage_options'));

  // rest_send_allow_header(), on every answer: the block editor asks before
  // offering to edit the site title, tagline or logo (core-data's
  // canUser( 'update', { kind: 'root', name: 'site' } )), and takes the
  // answer from the GET it reads the settings with too.
  const ALLOW = 'GET, POST, PUT, PATCH';

  app.get('/', async (c) => {
    c.header('Allow', ALLOW);
    return c.json(await readSettings(c.get('kernel'), c.get('user')));
  });

  app.options('/', (c) => {
    c.header('Allow', ALLOW);
    return c.json({ namespace: 'wp/v2', methods: ['GET', 'POST', 'PUT', 'PATCH'] });
  });

  const update = async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const body = await readJson(c);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return restError(c, 400, 'rest_invalid_json', 'The request body must be a JSON object.');
    }

    const changes: [string, unknown][] = [];
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(body)) {
      const setting = kernel.settings.get(name);
      if (!setting || !userCan(user, setting.capability)) continue;
      // The schema, the setting's sanitize callback and the sanitize_option_ /
      // pre_update_option_ filters, as update_option() runs them.
      try {
        changes.push([setting.option, await sanitizeSettingValue(kernel, setting, value)]);
      } catch (error) {
        if (!(error instanceof SettingSanitizeError)) throw error;
        params[name] = error.message;
      }
    }
    if (Object.keys(params).length > 0) {
      return restError(
        c,
        400,
        'rest_invalid_param',
        `Invalid parameter(s): ${Object.keys(params).join(', ')}`,
        { params },
      );
    }

    for (const [option, value] of changes) await kernel.options.set(option, value);
    return c.json(await readSettings(kernel, user));
  };

  app.post('/', update);
  app.put('/', update);
  app.patch('/', update);

  return app;
}
