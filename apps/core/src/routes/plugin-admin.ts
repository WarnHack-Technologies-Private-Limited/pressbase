import path from 'node:path';
import { type Context, Hono } from 'hono';
import { userCan } from '../auth/users';
import { type AppEnv, readJson, restError } from '../http';
import type { Kernel } from '../kernel';
import {
  fieldItem,
  moduleUrl,
  type PluginAdmin,
  pageItem,
  pageSettings,
  SettingSanitizeError,
  saveSetting,
} from '../plugins/admin';
import { notFoundResponse, safeSegments, serveStaticFile } from '../themes/static-files';

/**
 * What the admin needs to show plugins' pages, settings and browser modules.
 * See docs/architecture/plugins.md#admin-pages-and-settings.
 *
 * - GET /pressbase/v1/admin-extensions: the plugin pages the user may open
 *   (capabilities checked here, as WordPress builds $menu per user) and the
 *   active plugins' admin modules.
 * - GET|POST /pressbase/v1/plugin-pages/{plugin}/{page}: a page, its settings
 *   schema and values; POST saves them, all or nothing, like options.php.
 */
export function pluginAdminRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  app.get('/admin-extensions', (c) => {
    const user = c.get('user');
    if (!user) {
      return restError(c, 401, 'rest_not_logged_in', 'You are not currently logged in.');
    }
    const kernel = c.get('kernel');
    const pages = [];
    const modules = [];
    for (const admin of kernel.plugins.adminRegistrations()) {
      for (const page of admin.allPages()) {
        if (userCan(user, page.capability)) pages.push(pageItem(admin, page));
      }
      if (admin.module) {
        modules.push({
          plugin: admin.slug,
          title: admin.plugin.manifest.title,
          url: moduleUrl(admin.plugin, admin.module),
        });
      }
    }
    return c.json({ pages, modules });
  });

  /** The plugin's page, or an error response: 404 when missing, 401/403 without the capability. */
  const findPage = (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    const slug = c.req.param('plugin');
    const admin = kernel.plugins.adminRegistrations().find((a) => a.slug === slug);
    const page = admin?.allPages().find((p) => p.slug === c.req.param('page'));
    if (!admin || !page) {
      return {
        error: restError(c, 404, 'rest_plugin_page_not_found', 'This plugin page doesn’t exist.'),
      };
    }
    const user = c.get('user');
    if (!userCan(user, page.capability)) {
      return {
        error: restError(
          c,
          user ? 403 : 401,
          'rest_forbidden',
          'Sorry, you are not allowed to access this page.',
        ),
      };
    }
    return { admin, page };
  };

  const describe = async (c: Context<AppEnv>, admin: PluginAdmin, slug: string) => {
    const kernel = c.get('kernel');
    const page = admin.allPages().find((p) => p.slug === slug);
    if (!page) throw new Error('Page vanished.');
    const { settings, sections } = pageSettings(admin, slug, c.get('user'));
    const values: Record<string, unknown> = {};
    for (const s of settings) values[s.option] = await kernel.options.get(s.option, s.default);
    return {
      ...pageItem(admin, page),
      sections: sections.map((section) => ({
        id: section.id,
        title: section.title,
        description: section.description,
        fields: section.fields.map(fieldItem),
      })),
      values,
    };
  };

  app.get('/plugin-pages/:plugin/:page', async (c) => {
    const found = findPage(c);
    if ('error' in found) return found.error;
    return c.json(await describe(c, found.admin, found.page.slug));
  });

  const save = async (c: Context<AppEnv>) => {
    const found = findPage(c);
    if ('error' in found) return found.error;
    const { admin, page } = found;
    const kernel = c.get('kernel');
    const body = await readJson(c);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return restError(c, 400, 'rest_invalid_json', 'The request body must be a JSON object.');
    }
    // As options.php: only this page's settings the user can change; others are ignored.
    const { settings } = pageSettings(admin, page.slug, c.get('user'));
    const params: Record<string, string> = {};
    const values = body as Record<string, unknown>;
    // Validate everything first, so a refused field saves nothing.
    for (const setting of settings) {
      if (!(setting.option in values)) continue;
      const parsed = setting.schema.safeParse(values[setting.option]);
      if (!parsed.success) {
        params[setting.option] = parsed.error.issues[0]?.message ?? 'Invalid value.';
      }
    }
    if (!Object.keys(params).length) {
      for (const setting of settings) {
        if (!(setting.option in values)) continue;
        try {
          await saveSetting(kernel, setting, values[setting.option]);
        } catch (error) {
          if (!(error instanceof SettingSanitizeError)) throw error;
          params[setting.option] = error.message;
        }
      }
    }
    if (Object.keys(params).length) {
      return restError(
        c,
        400,
        'rest_invalid_param',
        `Invalid parameter(s): ${Object.keys(params).join(', ')}`,
        { params },
      );
    }
    return c.json(await describe(c, admin, page.slug));
  };
  app.post('/plugin-pages/:plugin/:page', save);
  app.put('/plugin-pages/:plugin/:page', save);
  app.patch('/plugin-pages/:plugin/:page', save);

  return app;
}

const PREFIX = '/wp-content/plugins/';

/**
 * /wp-content/plugins/{plugin}/{file}: an active plugin's browser modules and
 * their assets, for the admin to import(). Only files inside the folders that
 * hold the plugin's declared modules (`admin.module`, pages' `entry`), never
 * the server module (`main`), and only while the plugin is active. With
 * `?ver=` matching the plugin's version the response is cached for a year
 * (immutable); otherwise it must be revalidated.
 */
export function pluginAssetRoutes(kernel: Kernel) {
  const app = new Hono<AppEnv>({ strict: true });
  app.on(['GET', 'HEAD'], `${PREFIX}*`, async (c) => {
    if (kernel.state !== 'ready') return notFoundResponse();
    const segments = safeSegments(new URL(c.req.url).pathname, PREFIX);
    if (!segments || segments.length < 2) return notFoundResponse();
    const [slug = '', ...rest] = segments;
    const admin = kernel.plugins.adminRegistrations().find((a) => a.slug === slug);
    if (!admin) return notFoundResponse();
    const file = rest.join('/');
    if (!servable(admin, file)) return notFoundResponse();
    const response = await serveStaticFile(c, admin.plugin.dir, rest);
    if (!response.ok && response.status !== 304) return response;
    const headers = new Headers(response.headers);
    // Same origin only: the admin proxies this path; nothing else needs it.
    headers.delete('access-control-allow-origin');
    headers.set(
      'cache-control',
      c.req.query('ver') === admin.plugin.manifest.version
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    );
    return new Response(response.body, { status: response.status, headers });
  });
  return app;
}

/** Whether a file of the plugin may be served: a declared module or in its folder, and not `main`. */
export function servable(admin: PluginAdmin, file: string): boolean {
  const manifest = admin.plugin.manifest;
  if (file === path.posix.normalize(manifest.main)) return false;
  const modules = [admin.module, ...admin.allPages().map((p) => p.entry)].filter((m): m is string =>
    Boolean(m),
  );
  return modules.some((module) => {
    const dir = path.posix.dirname(module);
    // A module at the plugin's root is served alone; one in a folder shares it (chunks, CSS).
    return file === module || (dir !== '.' && file.startsWith(`${dir}/`));
  });
}
