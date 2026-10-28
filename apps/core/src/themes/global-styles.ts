import { schema } from '@pressbase/db';
import {
  encodeGlobalStylesJson,
  type GlobalStylesConfig,
  isObject,
  keyPresetsByOrigin,
  removeInsecureProperties,
  type ThemeJsonData,
  validateCustomCss,
} from '@pressbase/theme-json';
import { and, desc, eq } from 'drizzle-orm';
import { type CurrentUser, userCan } from '../auth/users';
import type { PostTypeRegistry } from '../content/post-types';
import type { Post } from '../content/posts';
import type { Kernel } from '../kernel';

/**
 * User global styles — the custom origin of theme.json, stored as WordPress
 * stores it: one `wp_global_styles` post per theme whose content is a user
 * theme.json (`{ "version": 3, "isGlobalStylesUserThemeJSON": true, … }`),
 * with revisions. Ports of WP_Theme_JSON_Resolver::get_user_data_from_wp_global_styles(),
 * get_user_data() and get_user_global_styles_post_id()
 * (wordpress/wp-includes/class-wp-theme-json-resolver.php), the
 * `wp_global_styles` registration in create_initial_post_types() (post.php)
 * and wp_filter_global_styles_post() (kses.php).
 *
 * WordPress ties the post to its theme with a `wp_theme` term; Pressbase uses
 * the slug WordPress gives it, `wp-global-styles-{stylesheet}`.
 *
 * Hook: after a theme's user global styles change (any save, including a
 * restored revision), core re-resolves the active theme's styles and fires
 * the action `pressbase_global_styles_updated` (stylesheet, post, config).
 * Caches of rendered pages should listen to it.
 */

export const GLOBAL_STYLES_POST_TYPE = 'wp_global_styles';
export const GLOBAL_STYLES_UPDATED = 'pressbase_global_styles_updated';
const EMPTY_CONFIG = '{"version": 3, "isGlobalStylesUserThemeJSON": true }';

/** create_initial_post_types(): wp_global_styles. */
export function registerGlobalStylesPostType(registry: PostTypeRegistry): void {
  registry.register(
    GLOBAL_STYLES_POST_TYPE,
    {
      label: 'Global Styles',
      singularLabel: 'Global Styles',
      description: 'Global styles to include in themes.',
      public: false,
      showInRest: true,
      restBase: 'global-styles',
      capabilities: {
        read: 'edit_posts',
        create_posts: 'edit_theme_options',
        edit_posts: 'edit_theme_options',
        edit_published_posts: 'edit_theme_options',
        delete_published_posts: 'edit_theme_options',
        edit_others_posts: 'edit_theme_options',
        delete_others_posts: 'edit_theme_options',
      },
      supports: ['title', 'editor', 'revisions'],
    },
    true,
  );
}

/** The post slug WordPress gives a theme's user global styles. */
export function globalStylesSlug(stylesheet: string): string {
  return `wp-global-styles-${encodeURIComponent(stylesheet)}`;
}

/** The stylesheet a global styles post belongs to, from its slug. */
export function stylesheetOfGlobalStyles(post: Pick<Post, 'slug'>): string | undefined {
  if (!post.slug.startsWith('wp-global-styles-')) return undefined;
  try {
    return decodeURIComponent(post.slug.slice('wp-global-styles-'.length));
  } catch {
    return undefined;
  }
}

/**
 * get_user_data_from_wp_global_styles(): the newest published global styles
 * post of a theme; with `create`, a new empty one when there is none.
 */
export async function userGlobalStylesPost(
  kernel: Kernel,
  stylesheet: string,
  create = false,
): Promise<Post | undefined> {
  const [post] = await kernel.db
    .select()
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.type, GLOBAL_STYLES_POST_TYPE),
        eq(schema.posts.status, 'publish'),
        eq(schema.posts.slug, globalStylesSlug(stylesheet)),
      ),
    )
    .orderBy(desc(schema.posts.date), desc(schema.posts.id))
    .limit(1);
  if (post || !create) return post;
  return kernel.posts.insert(GLOBAL_STYLES_POST_TYPE, {
    title: 'Custom Styles',
    content: EMPTY_CONFIG,
    status: 'publish',
    slug: globalStylesSlug(stylesheet),
  });
}

/**
 * get_user_data(): the decoded post content when it is a user theme.json
 * (isGlobalStylesUserThemeJSON), otherwise an empty config.
 */
export function decodeGlobalStyles(content: string): GlobalStylesConfig {
  try {
    const data = JSON.parse(content) as unknown;
    if (isObject(data) && data.isGlobalStylesUserThemeJSON === true) {
      return data as GlobalStylesConfig;
    }
  } catch {
    // Not JSON: treated as empty, as WordPress does after a decoding error.
  }
  return { version: 3, isGlobalStylesUserThemeJSON: true };
}

/** The config as the REST API shows it (get_raw_data() of the custom origin). */
export function globalStylesForResponse(config: GlobalStylesConfig): {
  settings: ThemeJsonData['settings'];
  styles: ThemeJsonData['styles'];
} {
  const keyed = keyPresetsByOrigin(config, 'custom');
  return {
    settings: isObject(keyed.settings) ? keyed.settings : {},
    styles: isObject(keyed.styles) ? keyed.styles : {},
  };
}

export type PreparedGlobalStyles =
  | { ok: true; config: GlobalStylesConfig }
  | { ok: false; code: string; message: string };

/**
 * prepare_item_for_database() + wp_filter_global_styles_post(): validates
 * `styles.css`, merges the request over the existing config (a missing
 * `styles` or `settings` keeps the stored one), and — for users without
 * `unfiltered_html` — removes insecure properties, keeping custom CSS only
 * for users with `edit_css`.
 */
export function prepareGlobalStyles(
  kernel: Kernel,
  user: CurrentUser | null,
  existing: GlobalStylesConfig,
  request: { styles?: unknown; settings?: unknown },
): PreparedGlobalStyles {
  if (request.styles !== undefined && !isObject(request.styles)) {
    return { ok: false, code: 'rest_invalid_param', message: 'styles must be an object.' };
  }
  if (request.settings !== undefined && !isObject(request.settings)) {
    return { ok: false, code: 'rest_invalid_param', message: 'settings must be an object.' };
  }
  const css = isObject(request.styles) ? request.styles.css : undefined;
  if (css !== undefined) {
    const result = validateCustomCss(css);
    if (!result.ok) return result;
  }
  const config: GlobalStylesConfig = {};
  const styles = request.styles ?? existing.styles;
  const settings = request.settings ?? existing.settings;
  if (isObject(styles)) config.styles = styles;
  if (isObject(settings)) config.settings = settings;
  config.isGlobalStylesUserThemeJSON = true;
  config.version = 3;

  if (userCan(user, 'unfiltered_html')) return { ok: true, config };
  const blockNames = kernel.blocks.registry.all().map((type) => type.name);
  const sanitized = removeInsecureProperties(config, {
    blockNames,
    // map_meta_cap( 'edit_css' ) → unfiltered_html, which this user doesn't have.
    canEditCss: false,
  }) as GlobalStylesConfig;
  sanitized.isGlobalStylesUserThemeJSON = true;
  return { ok: true, config: sanitized };
}

/** Stores a prepared config in the post (a revision is kept, as for any post). */
export async function saveGlobalStyles(
  kernel: Kernel,
  post: Post,
  config: GlobalStylesConfig,
  title?: string,
  userId?: number,
): Promise<Post> {
  const before = new Set((await kernel.posts.revisions(post.id)).map((r) => r.id));
  const updated = await kernel.posts.update(post.id, {
    content: encodeGlobalStylesJson(config),
    ...(title !== undefined ? { title } : {}),
  });
  // wp_insert_post() gives a revision the current user as its author, so the
  // history says who saved each version (the post itself keeps its creator).
  const created = (await kernel.posts.revisions(post.id)).find((r) => !before.has(r.id));
  if (created && userId) {
    await kernel.db
      .update(schema.posts)
      .set({ authorId: userId })
      .where(eq(schema.posts.id, created.id));
  }
  return updated;
}

/**
 * Keeps the active theme's styles in step with its global styles post, and
 * announces the change: any save of a `wp_global_styles` post re-resolves the
 * styles and fires `pressbase_global_styles_updated`.
 */
export function registerGlobalStylesHooks(kernel: Kernel): void {
  kernel.hooks.addAction(`save_post_${GLOBAL_STYLES_POST_TYPE}`, async (...args: unknown[]) => {
    const post = args[1] as Post;
    const stylesheet = stylesheetOfGlobalStyles(post);
    if (!stylesheet) return;
    if (stylesheet === (await kernel.themes.activeStylesheet()))
      await kernel.themes.refreshStyles();
    await kernel.hooks.doAction(
      GLOBAL_STYLES_UPDATED,
      stylesheet,
      post,
      decodeGlobalStyles(post.content),
    );
  });
}
