import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { userCan } from '../auth/users';
import { POSTPASS_COOKIE, postPasswordHash } from '../blocks/library/template';
import { renderPublicPage } from '../frontend/render';
import { type AppEnv, invalidParams, isSecureRequest, restError } from '../http';
import type { Kernel } from '../kernel';
import { userGlobalStylesPost } from '../themes/global-styles';
import { maxThemeBytes, ThemeError } from '../themes/install';
import { THEMES_URL_PATH, type ThemeInfo } from '../themes/service';
import { notFoundResponse, safeSegments, serveStaticFile } from '../themes/static-files';

/**
 * The public site and themes over HTTP:
 *
 * - GET /pressbase/v1/render?url=/path/ — a page of the public site as
 *   `{ status, headers, html }` (see ADR 0007);
 * - GET /wp/v2/themes, /wp/v2/themes/{stylesheet} — WP_REST_Themes_Controller;
 * - POST /pressbase/v1/themes/{stylesheet}/activate — switch_theme();
 * - POST /pressbase/v1/themes — upload a theme .zip (Theme_Upgrader::install(),
 *   wp-admin/update.php?action=upload-theme);
 * - DELETE /pressbase/v1/themes/{stylesheet} — delete_theme();
 * - GET /wp-content/themes/{theme}/… and /wp-includes/… — theme assets and
 *   WordPress's front-end CSS, outside /wp-json;
 * - POST /wp-login.php?action=postpass — unlocks password-protected posts.
 */

const STATIC_ROOT = new URL('../../static/', import.meta.url);

/**
 * WP_REST_Themes_Controller::prepare_item_for_response(), plus
 * `pressbase_source` (bundled or site) and `pressbase_deletable` (installed
 * in the data directory, not active, not the active theme's parent).
 */
async function themeItem(kernel: Kernel, theme: ThemeInfo, active: string, inUse?: Set<string>) {
  const home = (await kernel.options.get<string>('home', '')).replace(/\/+$/, '');
  const text = (value: string) => ({ raw: value, rendered: value });
  return {
    stylesheet: theme.stylesheet,
    template: theme.template,
    name: text(theme.name),
    description: text(theme.description),
    version: theme.version,
    author: text(theme.author),
    author_uri: text(theme.authorUri),
    theme_uri: text(theme.themeUri),
    screenshot: theme.screenshot
      ? `${home}${THEMES_URL_PATH}/${theme.stylesheet}/${theme.screenshot}`
      : '',
    status: theme.stylesheet === active ? 'active' : 'inactive',
    tags: { raw: theme.tags, rendered: theme.tags.join(', ') },
    textdomain: theme.textDomain,
    requires_wp: theme.requiresWp,
    requires_php: theme.requiresPhp,
    is_block_theme: theme.isBlockTheme,
    stylesheet_uri: `${home}${THEMES_URL_PATH}/${theme.stylesheet}/style.css`,
    template_uri: `${home}${THEMES_URL_PATH}/${theme.template}/style.css`,
    pressbase_source: theme.source,
    pressbase_deletable: await kernel.themes.deletable(theme, inUse),
    _links: {
      self: [{ href: `${home}/wp-json/wp/v2/themes/${theme.stylesheet}` }],
      collection: [{ href: `${home}/wp-json/wp/v2/themes` }],
      ...(await userGlobalStylesLink(kernel, theme, active, home)),
    },
  };
}

/**
 * prepare_links(): the theme's user global styles, created for the active
 * theme if missing (get_user_global_styles_post_id()).
 */
async function userGlobalStylesLink(
  kernel: Kernel,
  theme: ThemeInfo,
  active: string,
  home: string,
) {
  if (!theme.isBlockTheme) return {};
  const post = await userGlobalStylesPost(kernel, theme.stylesheet, theme.stylesheet === active);
  return post
    ? { 'wp:user-global-styles': [{ href: `${home}/wp-json/wp/v2/global-styles/${post.id}` }] }
    : {};
}

/** Routes under /wp-json that need an installed site. */
export function themeRoutes(kernel: Kernel) {
  const app = new Hono<AppEnv>({ strict: false });

  app.get('/pressbase/v1/render', async (c) => {
    const target = c.req.query('url') ?? '/';
    if (!target.startsWith('/') || target.startsWith('//')) {
      return restError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): url', {
        params: { url: 'Give a path on the site, starting with "/".' },
      });
    }
    const cookies = new Map(Object.entries(getCookie(c)));
    const page = await renderPublicPage(kernel, {
      url: target,
      user: c.get('user'),
      cookies,
      ifNoneMatch: c.req.header('if-none-match'),
      referrer: c.req.header('referer') ?? '',
    });
    return c.json(page);
  });

  const canRead = (c: { get: (k: 'user') => AppEnv['Variables']['user'] }, activeOnly: boolean) => {
    const user = c.get('user');
    return (
      userCan(user, 'switch_themes') ||
      userCan(user, 'manage_network_themes') ||
      (activeOnly && userCan(user, 'edit_posts'))
    );
  };

  app.get('/wp/v2/themes', async (c) => {
    const status = c.req.query('status');
    if (!canRead(c, status === 'active')) {
      return restError(
        c,
        c.get('user') ? 403 : 401,
        'rest_cannot_view_themes',
        'Sorry, you are not allowed to view themes.',
      );
    }
    const active = await kernel.themes.activeStylesheet();
    const inUse = await kernel.themes.inUse();
    const themes = (await kernel.themes.all()).filter((t) => {
      if (status === 'active') return t.stylesheet === active;
      if (status === 'inactive') return t.stylesheet !== active;
      return true;
    });
    return c.json(await Promise.all(themes.map((t) => themeItem(kernel, t, active, inUse))));
  });

  app.get('/wp/v2/themes/:stylesheet', async (c) => {
    const active = await kernel.themes.activeStylesheet();
    const stylesheet = c.req.param('stylesheet');
    if (!canRead(c, stylesheet === active)) {
      return restError(
        c,
        c.get('user') ? 403 : 401,
        'rest_cannot_view_themes',
        'Sorry, you are not allowed to view themes.',
      );
    }
    const theme = await kernel.themes.get(stylesheet);
    if (!theme) return restError(c, 404, 'rest_theme_not_found', 'Theme not found.');
    return c.json(await themeItem(kernel, theme, active));
  });

  app.post('/pressbase/v1/themes/:stylesheet/activate', async (c) => {
    if (!userCan(c.get('user'), 'switch_themes')) {
      return restError(
        c,
        c.get('user') ? 403 : 401,
        'rest_cannot_manage_themes',
        'Sorry, you are not allowed to switch themes.',
      );
    }
    const theme = await kernel.themes.get(c.req.param('stylesheet'));
    if (!theme) return restError(c, 404, 'rest_theme_not_found', 'Theme not found.');
    if (!theme.isBlockTheme) {
      return restError(
        c,
        400,
        'pressbase_theme_not_block_theme',
        'Only block themes can be activated: this theme has no templates/index.html.',
      );
    }
    await kernel.themes.activate(theme.stylesheet);
    return c.json(await themeItem(kernel, theme, theme.stylesheet));
  });

  const themeError = (c: Context<AppEnv>, error: unknown) => {
    if (error instanceof ThemeError) {
      return restError(c, error.status, error.code, error.message, error.data);
    }
    throw error;
  };

  /** The archive limit plus room for the multipart framing, as for plugins. */
  const limitBody = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const max = maxThemeBytes(kernel);
    return bodyLimit({
      maxSize: max + 1024 * 1024,
      onError: (ctx) =>
        restError(
          ctx,
          413,
          'rest_upload_file_too_big',
          `This file is too big. Theme archives must be smaller than ${Math.round(max / 1024 / 1024)} MB.`,
        ),
    })(c, next);
  };

  // wp-admin/update.php?action=upload-theme: current_user_can( 'upload_themes' ).
  app.post('/pressbase/v1/themes', limitBody, async (c) => {
    const user = c.get('user');
    if (!(await currentUserCan(kernel, user, 'upload_themes'))) {
      return restError(
        c,
        user ? 403 : 401,
        'rest_cannot_install_theme',
        'Sorry, you are not allowed to install themes on this site.',
      );
    }
    const contentType = (c.req.header('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('multipart/form-data')) {
      return restError(
        c,
        400,
        'pressbase_theme_directory_unavailable',
        'Pressbase has no theme directory to install from. Upload the theme’s .zip file as `file` (multipart/form-data).',
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
      .object({ overwrite: z.enum(['true', 'false', '1', '0']).optional() })
      .safeParse({ overwrite: body.overwrite || undefined });
    if (!fields.success) return invalidParams(c, fields.error);
    const overwrite = fields.data.overwrite === 'true' || fields.data.overwrite === '1';
    try {
      const { theme, replaced } = await kernel.themes.install(
        new Uint8Array(await file.arrayBuffer()),
        { overwrite, filename: file.name },
      );
      const item = await themeItem(kernel, theme, await kernel.themes.activeStylesheet());
      const home = (await kernel.options.get<string>('home', '')).replace(/\/+$/, '');
      c.header('Location', `${home}/wp-json/wp/v2/themes/${theme.stylesheet}`);
      return c.json(item, replaced ? 200 : 201);
    } catch (error) {
      return themeError(c, error);
    }
  });

  app.delete('/pressbase/v1/themes/:stylesheet', async (c) => {
    const user = c.get('user');
    if (!(await currentUserCan(kernel, user, 'delete_themes'))) {
      return restError(
        c,
        user ? 403 : 401,
        'rest_cannot_delete_theme',
        'Sorry, you are not allowed to delete themes on this site.',
      );
    }
    const stylesheet = c.req.param('stylesheet');
    try {
      const theme = await kernel.themes.get(stylesheet);
      if (!theme) return restError(c, 404, 'rest_theme_not_found', 'Theme not found.');
      const previous = await themeItem(kernel, theme, await kernel.themes.activeStylesheet());
      await kernel.themes.delete(stylesheet);
      return c.json({ deleted: true, previous });
    } catch (error) {
      return themeError(c, error);
    }
  });
  return app;
}

/** Routes outside /wp-json: theme files, WordPress's CSS and the post password form. */
export function publicFileRoutes(kernel: Kernel) {
  const app = new Hono<AppEnv>({ strict: true });

  app.get('/wp-content/themes/*', async (c) => {
    const segments = safeSegments(new URL(c.req.url).pathname, `${THEMES_URL_PATH}/`);
    if (!segments || segments.length < 2) return notFoundResponse();
    const [stylesheet = '', ...rest] = segments;
    const theme = await kernel.themes.get(stylesheet);
    if (!theme) return notFoundResponse();
    return serveStaticFile(c, theme.dir, rest);
  });

  app.get('/wp-includes/*', async (c) => {
    const segments = safeSegments(new URL(c.req.url).pathname, '/');
    if (!segments) return notFoundResponse();
    return serveStaticFile(c, decodeURIComponent(STATIC_ROOT.pathname), segments, {
      maxAge: 31_536_000,
    });
  });

  // wp-login.php?action=postpass: remembers a post password for 10 days, then goes back.
  app.post('/wp-login.php', async (c) => {
    if (c.req.query('action') !== 'postpass' || kernel.state !== 'ready') return notFoundResponse();
    const form = await c.req.parseBody();
    const password = typeof form.post_password === 'string' ? form.post_password : '';
    const home = (await kernel.options.get<string>('home', '')).replace(/\/+$/, '');
    let redirect = typeof form.redirect_to === 'string' ? form.redirect_to : `${home}/`;
    // wp_safe_redirect(): only back to this site.
    if (
      !(redirect.startsWith(`${home}/`) || (redirect.startsWith('/') && !redirect.startsWith('//')))
    ) {
      redirect = `${home}/`;
    }
    setCookie(c, POSTPASS_COOKIE, postPasswordHash(password), {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: isSecureRequest(c),
      maxAge: 10 * 24 * 60 * 60,
    });
    return c.redirect(redirect, 303);
  });
  return app;
}
