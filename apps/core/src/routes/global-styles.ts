import {
  type GlobalStylesConfig,
  isObject,
  resolvedThemeUris,
  type ThemeJsonData,
} from '@pressbase/theme-json';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { userCan } from '../auth/users';
import { toGmtString, toLocalString } from '../content/dates';
import type { Post } from '../content/posts';
import { renderPublicPage } from '../frontend/render';
import { type AppEnv, invalidParams, readJson, restError } from '../http';
import type { Kernel } from '../kernel';
import {
  decodeGlobalStyles,
  GLOBAL_STYLES_POST_TYPE,
  globalStylesForResponse,
  prepareGlobalStyles,
  saveGlobalStyles,
} from '../themes/global-styles';
import { authStatus, rawText } from './rest-util';

/**
 * Global styles over HTTP — WP_REST_Global_Styles_Controller and
 * WP_REST_Global_Styles_Revisions_Controller
 * (wordpress/wp-includes/rest-api/endpoints/), plus Pressbase's preview:
 *
 * - GET /wp/v2/global-styles/themes/{stylesheet} — the theme's settings and styles;
 * - GET /wp/v2/global-styles/themes/{stylesheet}/variations — its style variations;
 * - GET, POST /wp/v2/global-styles/{id} — the user global styles (edit_theme_options);
 * - GET /wp/v2/global-styles/{id}/revisions[/{revision}] — their history;
 * - POST /pressbase/v1/global-styles/preview — a public page rendered with
 *   unsaved styles. Nothing is stored.
 */

/** get_theme_item_permissions_check(): anyone who can edit some content, or edit_theme_options. */
function canReadThemeStyles(kernel: Kernel, c: Context<AppEnv>): boolean {
  const user = c.get('user');
  if (userCan(user, 'edit_posts') || userCan(user, 'edit_theme_options')) return true;
  return kernel.postTypes
    .all()
    .some((type) => type.showInRest && userCan(user, type.cap.edit_posts));
}

/** WP_REST_Global_Styles_Controller::get_post() */
async function globalStylesPost(kernel: Kernel, id: number): Promise<Post | undefined> {
  if (!(id > 0)) return undefined;
  const post = await kernel.posts.get(id);
  return post?.type === GLOBAL_STYLES_POST_TYPE ? post : undefined;
}

async function homeUrl(kernel: Kernel): Promise<string> {
  return (await kernel.options.get<string>('home', '')).replace(/\/+$/, '');
}

/** The theme-file links for `file:./` URLs (get_resolved_theme_uris()). */
async function themeFileLinks(kernel: Kernel, data: ThemeJsonData) {
  const home = await homeUrl(kernel);
  const active = await kernel.themes.active();
  return resolvedThemeUris(data, (relative) => `${home}${active.fileUri(relative)}`);
}

const updateBody = z.object({
  styles: z.unknown().optional(),
  settings: z.unknown().optional(),
  title: rawText.optional(),
});

const previewBody = z.object({
  url: z
    .string()
    .default('/')
    .refine((u) => u.startsWith('/') && !u.startsWith('//'), {
      message: 'Give a path on the site, starting with "/".',
    }),
  styles: z.unknown().optional(),
  settings: z.unknown().optional(),
});

const revisionsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  context: z.enum(['view', 'edit', 'embed']).default('view'),
});

export function globalStylesRoutes(kernel: Kernel) {
  const app = new Hono<AppEnv>({ strict: false });

  /** prepare_item_for_response() */
  const item = async (c: Context<AppEnv>, post: Post) => {
    const home = await homeUrl(kernel);
    const user = c.get('user');
    const config = decodeGlobalStyles(post.content);
    const { settings, styles } = globalStylesForResponse(config);
    const revisions = await kernel.posts.revisions(post.id);
    const self = `${home}/wp-json/wp/v2/global-styles/${post.id}`;
    const links: Record<string, unknown> = {
      self: [{ href: self }],
      about: [{ href: `${home}/wp-json/wp/v2/types/${GLOBAL_STYLES_POST_TYPE}` }],
      'version-history': [{ href: `${self}/revisions`, count: revisions.length }],
    };
    const files = await themeFileLinks(kernel, config);
    if (files.length) links['wp:theme-file'] = files;
    const type = kernel.postTypes.get(GLOBAL_STYLES_POST_TYPE);
    if (type && userCan(user, type.cap.publish_posts))
      links['wp:action-publish'] = [{ href: self }];
    // map_meta_cap( 'edit_css' ) → unfiltered_html.
    if (userCan(user, 'unfiltered_html')) links['wp:action-edit-css'] = [{ href: self }];
    return {
      id: post.id,
      title: { raw: post.title, rendered: post.title },
      settings,
      styles,
      _links: links,
    };
  };

  const notFound = (c: Context<AppEnv>) =>
    restError(
      c,
      404,
      'rest_global_styles_not_found',
      'No global styles config exists with that ID.',
    );

  const activeOnly = async (c: Context<AppEnv>) => {
    const stylesheet = decodeURIComponent(c.req.param('stylesheet') ?? '');
    if (!canReadThemeStyles(kernel, c)) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_read_global_styles',
        'Sorry, you are not allowed to access the global styles on this site.',
      );
    }
    // This endpoint only supports the active theme for now (as in WordPress).
    if (stylesheet !== (await kernel.themes.activeStylesheet())) {
      return restError(c, 404, 'rest_theme_not_found', 'Theme not found.');
    }
    return null;
  };

  // get_theme_items(): the active theme's style variations.
  app.get('/wp/v2/global-styles/themes/:stylesheet/variations', async (c) => {
    const denied = await activeOnly(c);
    if (denied) return denied;
    const active = await kernel.themes.active();
    const out = [];
    for (const variation of active.variations) {
      const files = await themeFileLinks(kernel, variation);
      out.push(files.length ? { ...variation, _links: { 'wp:theme-file': files } } : variation);
    }
    return c.json(out);
  });

  // get_theme_item(): the theme's own settings and styles.
  app.get('/wp/v2/global-styles/themes/:stylesheet', async (c) => {
    const denied = await activeOnly(c);
    if (denied) return denied;
    const stylesheet = c.req.param('stylesheet');
    const home = await homeUrl(kernel);
    const { settings, styles } = await kernel.themes.themeGlobalStyles();
    const links: Record<string, unknown> = {
      self: [{ href: `${home}/wp-json/wp/v2/global-styles/themes/${stylesheet}` }],
    };
    const files = await themeFileLinks(kernel, { settings, styles });
    if (files.length) links['wp:theme-file'] = files;
    return c.json({ settings, styles, _links: links });
  });

  app.get('/wp/v2/global-styles/:id{[0-9]+}', async (c) => {
    const post = await globalStylesPost(kernel, Number(c.req.param('id')));
    if (!post) return notFound(c);
    const user = c.get('user');
    if (
      c.req.query('context') === 'edit' &&
      !(await currentUserCan(kernel, user, 'edit_post', post.id))
    ) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden_context',
        'Sorry, you are not allowed to edit this global style.',
      );
    }
    if (!(await currentUserCan(kernel, user, 'read_post', post.id))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_view',
        'Sorry, you are not allowed to view this global style.',
      );
    }
    return c.json(await item(c, post));
  });

  const update = async (c: Context<AppEnv>) => {
    const post = await globalStylesPost(kernel, Number(c.req.param('id')));
    if (!post) return notFound(c);
    const user = c.get('user');
    if (!(await currentUserCan(kernel, user, 'edit_post', post.id))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_edit',
        'Sorry, you are not allowed to edit this global style.',
      );
    }
    const body = await readJson(c);
    if (!isObject(body)) {
      return restError(c, 400, 'rest_invalid_json', 'The request body must be a JSON object.');
    }
    const parsed = updateBody.safeParse(body);
    if (!parsed.success) return invalidParams(c, parsed.error);
    const { styles, settings, title } = parsed.data;
    let updated = post;
    if (styles !== undefined || settings !== undefined) {
      const prepared = prepareGlobalStyles(kernel, user, decodeGlobalStyles(post.content), {
        styles,
        settings,
      });
      if (!prepared.ok) {
        return prepared.code === 'rest_invalid_param'
          ? restError(c, 400, 'rest_invalid_param', `Invalid parameter(s): ${prepared.message}`)
          : restError(c, 400, prepared.code, prepared.message);
      }
      updated = await saveGlobalStyles(kernel, post, prepared.config, title, user?.id);
    } else if (title !== undefined) {
      updated = await kernel.posts.update(post.id, { title });
    }
    return c.json(await item(c, updated));
  };
  app.post('/wp/v2/global-styles/:id{[0-9]+}', update);
  app.put('/wp/v2/global-styles/:id{[0-9]+}', update);
  app.patch('/wp/v2/global-styles/:id{[0-9]+}', update);

  /** WP_REST_Global_Styles_Revisions_Controller::prepare_item_for_response() */
  const revisionItem = (revision: Post, parent: Post, timeZone: string) => {
    const { settings, styles } = globalStylesForResponse(decodeGlobalStyles(revision.content));
    return {
      author: revision.authorId ?? 0,
      date: toLocalString(revision.date, timeZone),
      date_gmt: toGmtString(revision.date),
      id: revision.id,
      modified: toLocalString(revision.modified, timeZone),
      modified_gmt: toGmtString(revision.modified),
      parent: parent.id,
      settings,
      styles,
    };
  };

  const revisionsParent = async (c: Context<AppEnv>) => {
    const parent = await globalStylesPost(kernel, Number(c.req.param('parent')));
    if (!parent) {
      return { error: restError(c, 404, 'rest_post_invalid_parent', 'Invalid post parent ID.') };
    }
    if (!(await currentUserCan(kernel, c.get('user'), 'edit_post', parent.id))) {
      return {
        error: restError(
          c,
          authStatus(c),
          'rest_cannot_read',
          'Sorry, you are not allowed to view revisions of this post.',
        ),
      };
    }
    return { parent };
  };

  app.get('/wp/v2/global-styles/:parent{[0-9]+}/revisions', async (c) => {
    const { parent, error } = await revisionsParent(c);
    if (!parent) return error;
    const query = revisionsQuery.safeParse(c.req.query());
    if (!query.success) return invalidParams(c, query.error);
    const { page, per_page: perPage, offset } = query.data;
    const all = await kernel.posts.revisions(parent.id);
    const total = all.length;
    const size = perPage ?? total;
    const start = offset ?? (page - 1) * size;
    const totalPages = size > 0 ? Math.ceil(total / size) : total > 0 ? 1 : 0;
    if (total > 0 && offset !== undefined && offset >= total) {
      return restError(
        c,
        400,
        'rest_revision_invalid_offset_number',
        'The offset number requested is larger than or equal to the number of available revisions.',
      );
    }
    if (total > 0 && offset === undefined && page > totalPages) {
      return restError(
        c,
        400,
        'rest_revision_invalid_page_number',
        'The page number requested is larger than the number of pages available.',
      );
    }
    const timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
    c.header('X-WP-Total', String(total));
    c.header('X-WP-TotalPages', String(totalPages));
    return c.json(
      all.slice(start, start + (size || total)).map((r) => revisionItem(r, parent, timeZone)),
    );
  });

  app.get('/wp/v2/global-styles/:parent{[0-9]+}/revisions/:id{[0-9]+}', async (c) => {
    const { parent, error } = await revisionsParent(c);
    if (!parent) return error;
    const revision = await kernel.posts.get(Number(c.req.param('id')));
    if (revision?.type !== 'revision' || revision.parentId !== parent.id) {
      return restError(c, 404, 'rest_post_invalid_id', 'Invalid revision ID.');
    }
    const timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
    return c.json(revisionItem(revision, parent, timeZone));
  });

  // Live preview: the public page rendered with the given (unsaved) styles.
  app.post('/pressbase/v1/global-styles/preview', async (c) => {
    const user = c.get('user');
    if (!userCan(user, 'edit_theme_options')) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_edit',
        'Sorry, you are not allowed to preview global styles.',
      );
    }
    const body = await readJson(c);
    const parsed = previewBody.safeParse(body ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    const active = await kernel.themes.active();
    const prepared = prepareGlobalStyles(kernel, user, active.globalStyles.config, parsed.data);
    if (!prepared.ok) {
      return prepared.code === 'rest_invalid_param'
        ? restError(c, 400, 'rest_invalid_param', `Invalid parameter(s): ${prepared.message}`)
        : restError(c, 400, prepared.code, prepared.message);
    }
    const theme = await kernel.themes.withUserStyles(prepared.config as GlobalStylesConfig);
    const page = await renderPublicPage(kernel, {
      url: parsed.data.url,
      user,
      cookies: new Map(Object.entries(getCookie(c))),
      theme,
    });
    return c.json({
      status: page.status,
      headers: {
        ...page.headers,
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
      },
      html: page.html,
    });
  });

  return app;
}
