import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { userCan } from '../auth/users';
import { type AppEnv, invalidParams, readJson, restError } from '../http';
import type { Kernel } from '../kernel';
import { maxUploadBytes } from '../media/service';
import type { InstalledPlugin, InvalidPlugin } from '../plugins/discovery';
import { PluginError, type PluginStatus } from '../plugins/manager';
import { authorName, authorUrl, PLUGIN_PERMISSIONS } from '../plugins/manifest';

/**
 * /wp/v2/plugins: WP_REST_Plugins_Controller
 * (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-plugins-controller.php).
 *
 * Differences from WordPress, all documented in docs/architecture/plugins.md:
 * - `plugin` is the plugin's slug (its folder), not "folder/file".
 * - Creating a plugin uploads a .zip (multipart field `file`); there's no
 *   plugin directory to install a `slug` from.
 * - Activating a plugin that declares permissions needs `permissions` in the
 *   request body, listing what the administrator agreed to.
 * - Extra fields: requires_pressbase, permissions, granted_permissions,
 *   admin, source, compatible, error, runtime_errors.
 */

/** Largest plugin archive accepted: the upload limit, at most 32 MB. */
export function maxPluginBytes(kernel: Kernel): number {
  return Math.min(maxUploadBytes(kernel), 32 * 1024 * 1024);
}

const statusParam = z.enum(['active', 'inactive']);

const updateBody = z.object({
  status: statusParam.optional(),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).optional(),
});

function denied(c: Context<AppEnv>, code: string, message: string) {
  return restError(c, c.get('user') ? 403 : 401, code, message);
}

function pluginError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof PluginError) {
    return restError(c, error.status, error.code, error.message, error.data);
  }
  throw error;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function links(c: Context<AppEnv>, slug: string) {
  const origin = new URL(c.req.url).origin;
  return { self: [{ href: `${origin}/wp-json/wp/v2/plugins/${slug}` }] };
}

/** prepare_item_for_response() */
export function pluginItem(c: Context<AppEnv>, status: PluginStatus) {
  const { plugin, active } = status;
  const m = plugin.manifest;
  return {
    plugin: plugin.slug,
    status: active ? 'active' : 'inactive',
    name: m.title,
    plugin_uri: m.homepage ?? '',
    author: authorName(m),
    author_uri: authorUrl(m),
    description: { raw: m.description, rendered: escapeHtml(m.description) },
    version: m.version,
    network_only: false,
    requires_wp: '',
    requires_php: '',
    textdomain: plugin.slug,
    requires_pressbase: m.requires,
    permissions: m.permissions,
    granted_permissions: status.grant?.permissions ?? [],
    admin: m.admin ?? null,
    source: plugin.source,
    compatible: status.compatible,
    error: status.error,
    runtime_errors: status.runtimeErrors,
    _links: links(c, plugin.slug),
  };
}

/** A plugin folder whose plugin.json is missing or invalid, listed so it can be fixed or deleted. */
function invalidItem(c: Context<AppEnv>, plugin: InvalidPlugin) {
  return {
    plugin: plugin.slug,
    status: 'inactive',
    name: plugin.slug,
    plugin_uri: '',
    author: '',
    author_uri: '',
    description: { raw: '', rendered: '' },
    version: '',
    network_only: false,
    requires_wp: '',
    requires_php: '',
    textdomain: plugin.slug,
    requires_pressbase: '',
    permissions: [],
    granted_permissions: [],
    admin: null,
    source: plugin.source,
    compatible: false,
    error: { message: plugin.error, during: 'manifest', time: '' },
    runtime_errors: [],
    _links: links(c, plugin.slug),
  };
}

export function pluginsRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  const canManage = (c: Context<AppEnv>) => userCan(c.get('user'), 'activate_plugins');

  const find = async (kernel: Kernel, slug: string): Promise<InstalledPlugin> => {
    const plugin = await kernel.plugins.get(slug);
    if (!plugin) throw new PluginError('rest_plugin_not_found', 'Plugin not found.', 404);
    return plugin;
  };

  app.get('/', async (c) => {
    if (!canManage(c)) {
      return denied(
        c,
        'rest_cannot_view_plugins',
        'Sorry, you are not allowed to manage plugins for this site.',
      );
    }
    const kernel = c.get('kernel');
    const status = statusParam.optional().safeParse(c.req.query('status') || undefined);
    if (!status.success) return invalidParams(c, status.error);
    const search = (c.req.query('search') ?? '').toLowerCase();
    const { plugins, invalid } = await kernel.plugins.discover();
    const items = [];
    for (const plugin of plugins) {
      const item = pluginItem(c, await kernel.plugins.status(plugin));
      if (status.data && item.status !== status.data) continue;
      const m = plugin.manifest;
      if (
        search &&
        ![m.title, m.description, plugin.slug].some((t) => t.toLowerCase().includes(search))
      ) {
        continue;
      }
      items.push(item);
    }
    if (!search && status.data !== 'active') {
      items.push(...invalid.map((p) => invalidItem(c, p)));
    }
    return c.json(items);
  });

  const getItem = async (c: Context<AppEnv>) => {
    if (!canManage(c)) {
      return denied(
        c,
        'rest_cannot_view_plugin',
        'Sorry, you are not allowed to manage this plugin.',
      );
    }
    const kernel = c.get('kernel');
    try {
      const plugin = await find(kernel, c.req.param('plugin') ?? '');
      return c.json(pluginItem(c, await kernel.plugins.status(plugin)));
    } catch (error) {
      return pluginError(c, error);
    }
  };

  /** Upload limit plus room for the multipart framing. */
  const limitBody = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const max = maxPluginBytes(c.get('kernel'));
    return bodyLimit({
      maxSize: max + 1024 * 1024,
      onError: (ctx) =>
        restError(
          ctx,
          413,
          'rest_upload_file_too_big',
          `This file is too big. Plugin archives must be smaller than ${Math.round(max / 1024 / 1024)} MB.`,
        ),
    })(c, next);
  };

  app.post('/', limitBody, async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    if (!userCan(user, 'install_plugins')) {
      return denied(
        c,
        'rest_cannot_install_plugin',
        'Sorry, you are not allowed to install plugins on this site.',
      );
    }
    const contentType = (c.req.header('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('multipart/form-data')) {
      return restError(
        c,
        400,
        'pressbase_plugin_directory_unavailable',
        'Pressbase has no plugin directory to install from. Upload the plugin’s .zip file as `file` (multipart/form-data).',
      );
    }
    let body: Record<string, string | File>;
    try {
      body = (await c.req.parseBody({ all: false })) as Record<string, string | File>;
    } catch {
      return restError(c, 400, 'rest_upload_no_data', 'No data supplied.');
    }
    const file = body.file;
    if (!(file instanceof File))
      return restError(c, 400, 'rest_upload_no_data', 'No data supplied.');
    const fields = z
      .object({
        status: statusParam.default('inactive'),
        permissions: z
          .string()
          .optional()
          .transform((v) => (v ? v.split(',').map((p) => p.trim()) : undefined)),
      })
      .safeParse({ status: body.status || undefined, permissions: body.permissions || undefined });
    if (!fields.success) return invalidParams(c, fields.error);
    if (fields.data.status === 'active' && !userCan(user, 'activate_plugins')) {
      return denied(
        c,
        'rest_cannot_activate_plugin',
        'Sorry, you are not allowed to activate plugins.',
      );
    }

    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const plugin = await kernel.plugins.install(data, { maxBytes: maxPluginBytes(kernel) });
      let status = await kernel.plugins.status(plugin);
      if (fields.data.status === 'active') {
        status = await kernel.plugins.activate(plugin.slug, {
          permissions: fields.data.permissions,
          userId: user?.id ?? null,
        });
      }
      c.header('Location', `${new URL(c.req.url).origin}/wp-json/wp/v2/plugins/${plugin.slug}`);
      return c.json(pluginItem(c, status), 201);
    } catch (error) {
      return pluginError(c, error);
    }
  });

  const update = async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    if (!canManage(c)) {
      return denied(
        c,
        'rest_cannot_manage_plugins',
        'Sorry, you are not allowed to manage plugins for this site.',
      );
    }
    const parsed = updateBody.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    try {
      const plugin = await find(kernel, c.req.param('plugin') ?? '');
      const current = await kernel.plugins.status(plugin);
      const wanted = parsed.data.status;
      if (wanted === 'active' && !current.active) {
        await kernel.plugins.activate(plugin.slug, {
          permissions: parsed.data.permissions,
          userId: user?.id ?? null,
        });
      } else if (wanted === 'inactive' && current.active) {
        await kernel.plugins.deactivate(plugin.slug);
      }
      return c.json(pluginItem(c, await kernel.plugins.status(plugin)));
    } catch (error) {
      return pluginError(c, error);
    }
  };

  const remove = async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    if (!canManage(c) || !userCan(c.get('user'), 'delete_plugins')) {
      return denied(
        c,
        'rest_cannot_manage_plugins',
        'Sorry, you are not allowed to delete plugins for this site.',
      );
    }
    const slug = c.req.param('plugin') ?? '';
    try {
      const { plugins, invalid } = await kernel.plugins.discover();
      const plugin = plugins.find((p) => p.slug === slug);
      const broken = invalid.find((p) => p.slug === slug);
      const previous = plugin
        ? pluginItem(c, await kernel.plugins.status(plugin))
        : broken
          ? invalidItem(c, broken)
          : null;
      if (!previous) throw new PluginError('rest_plugin_not_found', 'Plugin not found.', 404);
      await kernel.plugins.delete(slug);
      return c.json({ deleted: true, previous });
    } catch (error) {
      return pluginError(c, error);
    }
  };

  // WordPress addresses a plugin as "folder/file"; Pressbase accepts the
  // folder alone or with any file part, so both URL shapes work.
  for (const path of ['/:plugin{[a-z0-9-]+}', '/:plugin{[a-z0-9-]+}/:file{[^/]+}']) {
    app.get(path, getItem);
    app.post(path, update);
    app.put(path, update);
    app.patch(path, update);
    app.delete(path, remove);
  }

  return app;
}
