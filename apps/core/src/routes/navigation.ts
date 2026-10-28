import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { userCan } from '../auth/users';
import {
  chosenNavigation,
  FALLBACK_OPTION,
  findFallbackNavigation,
  getFallbackNavigation,
  publishedNavigation,
  setChosenNavigation,
  withNavigationPreview,
} from '../content/navigation';
import type { PostType } from '../content/post-types';
import { renderPublicPage } from '../frontend/render';
import { type AppEnv, invalidParams, readJson, restError } from '../http';
import type { Kernel } from '../kernel';
import { preparePost } from './posts';
import { authStatus, contextParam } from './rest-util';

/**
 * Navigation menu routes besides /wp/v2/navigation itself (the posts
 * controller, mounted for `wp_navigation` in app.ts):
 *
 * - `GET /wp-block-editor/v1/navigation-fallback` — WordPress's
 *   WP_REST_Navigation_Fallback_Controller
 *   (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-navigation-fallback-controller.php):
 *   the menu a Navigation block without one should use, created from the page
 *   list when there's none. `?_embed` embeds the menu, with the fields
 *   WP_Navigation_Fallback::update_wp_navigation_post_schema() exposes.
 * - `GET|PUT /pressbase/v1/navigation-fallback` — Pressbase's: which menu
 *   Navigation blocks without one show (Appearance → Menus, "Use in the
 *   header"). Stored in the `pressbase_navigation_fallback` option.
 *
 * Both need `edit_theme_options`. See docs/architecture/navigation.md.
 */
export function navigationRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  app.get('/wp-block-editor/v1/navigation-fallback', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const type = kernel.postTypes.get('wp_navigation') as PostType;
    // Getting fallbacks requires creating and reading `wp_navigation` posts.
    if (
      !userCan(user, type.cap.create_posts) ||
      !userCan(user, 'edit_theme_options') ||
      !userCan(user, 'edit_posts')
    ) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_create',
        'Sorry, you are not allowed to create Navigation Menus as this user.',
      );
    }
    const context = contextParam.safeParse(c.req.query('context'));
    if (!context.success) return invalidParams(c, context.error);
    if (context.data === 'edit' && !userCan(user, type.cap.edit_posts)) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden_context',
        'Sorry, you are not allowed to edit Navigation Menus as this user.',
      );
    }

    const post = await getFallbackNavigation(kernel);
    if (!post) return restError(c, 404, 'no_fallback_menu', 'No fallback menu found.');
    const body: Record<string, unknown> = {
      id: post.id,
      _links: {
        self: [{ href: `/wp-json/wp/v2/${type.restBase}/${post.id}`, embeddable: true }],
      },
    };
    if (c.req.query('_embed') !== undefined) {
      body._embedded = { self: [await preparePost(kernel, type, user, post, 'edit')] };
    }
    return c.json(body);
  });

  /** Which menu fills Navigation blocks without one, and why. */
  const state = async (kernel: Kernel) => {
    const chosen = await chosenNavigation(kernel);
    const shown = chosen ?? (await findFallbackNavigation(kernel));
    return {
      /** The menu chosen in Appearance → Menus (0: none, or no longer published). */
      id: chosen?.id ?? 0,
      /** The menu those blocks show now: the chosen one, else the newest; 0 shows the page list. */
      current: shown?.id ?? 0,
      option: FALLBACK_OPTION,
    };
  };

  app.get('/pressbase/v1/navigation-fallback', async (c) => {
    if (!userCan(c.get('user'), 'edit_theme_options')) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_view',
        'Sorry, you are not allowed to manage navigation menus.',
      );
    }
    return c.json(await state(c.get('kernel')));
  });

  const update = async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    if (!userCan(c.get('user'), 'edit_theme_options')) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_edit',
        'Sorry, you are not allowed to manage navigation menus.',
      );
    }
    const parsed = z.object({ id: z.number().int().min(0) }).safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const { id } = parsed.data;
    if (id !== 0 && !(await publishedNavigation(kernel, id))) {
      return restError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): id', {
        params: { id: 'Choose a published navigation menu.' },
      });
    }
    await setChosenNavigation(kernel, id);
    return c.json(await state(kernel));
  };
  /**
   * A page of the public site with a menu in place of the fallback menu, for
   * the live preview in Appearance → Menus. Nothing is saved; the response is
   * never cached.
   */
  app.post('/pressbase/v1/navigation-preview', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    if (!userCan(user, 'edit_theme_options')) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_view',
        'Sorry, you are not allowed to manage navigation menus.',
      );
    }
    const parsed = z
      .object({
        content: z.string().max(200_000),
        title: z.string().max(200).default(''),
        url: z
          .string()
          .default('/')
          .refine((u) => u.startsWith('/') && !u.startsWith('//'), 'Give a path on the site.'),
      })
      .safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const { content, title, url } = parsed.data;
    const page = await withNavigationPreview({ content, title }, () =>
      renderPublicPage(kernel, { url, user }),
    );
    c.header('Cache-Control', 'no-store');
    return c.json({ status: page.status, html: page.html });
  });

  app.put('/pressbase/v1/navigation-fallback', update);
  app.post('/pressbase/v1/navigation-fallback', update);

  return app;
}
