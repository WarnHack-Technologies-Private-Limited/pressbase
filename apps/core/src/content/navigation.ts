import { AsyncLocalStorage } from 'node:async_hooks';
import { schema } from '@pressbase/db';
import { and, desc, eq } from 'drizzle-orm';
import type { Kernel } from '../kernel';
import type { Post } from './posts';

/**
 * Navigation menus (`wp_navigation` posts) — WordPress's WP_Navigation_Fallback
 * (wordpress/wp-includes/class-wp-navigation-fallback.php) plus Pressbase's
 * one addition, the *chosen* fallback menu.
 *
 * A Navigation block with neither a `ref` nor inner blocks (Twenty
 * Twenty-Five's header) shows the fallback menu:
 *
 * 1. the menu chosen in Appearance → Menus ("Use in the header"), stored as the
 *    `pressbase_navigation_fallback` option, while it is a published menu;
 * 2. otherwise the most recently published menu, as WordPress does;
 * 3. otherwise nothing here, and the block shows a page list.
 *
 * WordPress creates a menu from the page list the first time step 3 happens,
 * even while rendering the public site. Pressbase only creates it when the
 * editor asks (`GET /wp-block-editor/v1/navigation-fallback`), so viewing a
 * page never writes to the database. The result looks the same.
 *
 * Hooks:
 * - filter `wp_navigation_should_create_fallback` (create) — as WordPress.
 */

export const FALLBACK_OPTION = 'pressbase_navigation_fallback';

const NAVIGATION = 'wp_navigation';

/** WP_Navigation_Fallback::get_most_recently_published_navigation() */
export async function mostRecentNavigation(kernel: Kernel): Promise<Post | undefined> {
  const [post] = await kernel.db
    .select()
    .from(schema.posts)
    .where(and(eq(schema.posts.type, NAVIGATION), eq(schema.posts.status, 'publish')))
    .orderBy(desc(schema.posts.date), desc(schema.posts.id))
    .limit(1);
  return post;
}

/** A published `wp_navigation` post, or undefined. */
export async function publishedNavigation(kernel: Kernel, id: unknown): Promise<Post | undefined> {
  const ref = Number(id);
  if (!Number.isInteger(ref) || ref <= 0) return undefined;
  const post = await kernel.posts.get(ref);
  return post?.type === NAVIGATION && post.status === 'publish' ? post : undefined;
}

/** The menu chosen in Appearance → Menus, while it's still a published menu. */
export async function chosenNavigation(kernel: Kernel): Promise<Post | undefined> {
  return publishedNavigation(kernel, await kernel.options.get<number>(FALLBACK_OPTION, 0));
}

/** The fallback menu without creating one: chosen, else most recent. */
export async function findFallbackNavigation(kernel: Kernel): Promise<Post | undefined> {
  return (await chosenNavigation(kernel)) ?? (await mostRecentNavigation(kernel));
}

/**
 * WP_Navigation_Fallback::get_fallback(): the fallback menu, creating one
 * from the page list when there's none (create_default_fallback()). There are
 * no classic menus in Pressbase, so create_classic_menu_fallback() has
 * nothing to convert.
 */
export async function getFallbackNavigation(kernel: Kernel): Promise<Post | undefined> {
  const shouldCreate = await kernel.hooks.applyFilters(
    'wp_navigation_should_create_fallback',
    true,
  );
  const existing = await findFallbackNavigation(kernel);
  if (existing || !shouldCreate) return existing;
  const pageList = kernel.blocks.registry.isRegistered('core/page-list');
  return kernel.posts.insert(NAVIGATION, {
    title: 'Navigation',
    slug: 'navigation',
    status: 'publish',
    content: pageList ? '<!-- wp:page-list /-->' : '',
  });
}

/** Chooses the fallback menu; `0` goes back to the most recent one. */
export async function setChosenNavigation(kernel: Kernel, id: number): Promise<void> {
  await kernel.options.set(FALLBACK_OPTION, id);
}

/**
 * A menu being previewed (Appearance → Menus): while a preview renders, the
 * Navigation blocks that would show the fallback menu show this markup
 * instead, so unsaved changes can be seen in the theme's header.
 */
export interface NavigationPreview {
  content: string;
  title: string;
}

const previews = new AsyncLocalStorage<NavigationPreview>();

export function currentNavigationPreview(): NavigationPreview | undefined {
  return previews.getStore();
}

export function withNavigationPreview<T>(
  preview: NavigationPreview,
  fn: () => Promise<T>,
): Promise<T> {
  return previews.run(preview, fn);
}
