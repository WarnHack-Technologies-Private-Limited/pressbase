import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { userCan } from '../auth/users';
import { POSTPASS_COOKIE, postPasswordHash } from '../blocks/library/template';
import { renderPublicPage } from '../frontend/render';
import { type AppEnv, isSecureRequest, restError } from '../http';
import type { Kernel } from '../kernel';
import { userGlobalStylesPost } from '../themes/global-styles';
import { THEMES_URL_PATH, type ThemeInfo } from '../themes/service';
import { notFoundResponse, safeSegments, serveStaticFile } from '../themes/static-files';

/**
 * The public site and themes over HTTP:
 *
 * - GET /pressbase/v1/render?url=/path/ — a page of the public site as
 *   `{ status, headers, html }` (see ADR 0007);
 * - GET /wp/v2/themes, /wp/v2/themes/{stylesheet} — WP_REST_Themes_Controller;
 * - POST /pressbase/v1/themes/{stylesheet}/activate — switch_theme();
 * - GET /wp-content/themes/{theme}/… and /wp-includes/… — theme assets and
 *   WordPress's front-end CSS, outside /wp-json;
 * - POST /wp-login.php?action=postpass — unlocks password-protected posts.
 */

const STATIC_ROOT = new URL('../../static/', import.meta.url);

/** WP_REST_Themes_Controller::prepare_item_for_response() */
async function themeItem(kernel: Kernel, theme: ThemeInfo, active: string) {
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
    const themes = (await kernel.themes.all()).filter((t) => {
      if (status === 'active') return t.stylesheet === active;
      if (status === 'inactive') return t.stylesheet !== active;
      return true;
    });
    return c.json(await Promise.all(themes.map((t) => themeItem(kernel, t, active))));
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
