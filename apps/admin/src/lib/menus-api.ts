/**
 * The REST shapes Appearance → Menus reads and writes: `wp_navigation` posts
 * at /wp/v2/navigation, and Pressbase's navigation fallback (which menu the
 * header shows) at /pressbase/v1/navigation-fallback.
 */

export interface RestMenu {
  id: number;
  status: string;
  date: string;
  modified: string;
  title: { raw: string; rendered: string };
  content: { raw: string; rendered?: string };
}

export interface FallbackState {
  /** The menu chosen for the header; 0 when none is. */
  id: number;
  /** The menu the header shows now (the chosen one, else the newest); 0 for the page list. */
  current: number;
}

/** A menu's display name. */
export function menuName(menu: Pick<RestMenu, 'id' | 'title'>): string {
  return menu.title.raw.trim() || `Menu #${menu.id}`;
}

/** A name for a new menu that isn't taken: "Main menu", then "Menu 2", "Menu 3"… */
export function newMenuName(menus: readonly Pick<RestMenu, 'id' | 'title'>[]): string {
  const taken = new Set(menus.map((m) => menuName(m).toLowerCase()));
  if (!taken.has('main menu')) return 'Main menu';
  for (let n = 2; ; n++) if (!taken.has(`menu ${n}`)) return `Menu ${n}`;
}

/** A published page, as /wp/v2/pages lists it (only the fields the menu needs). */
export interface RestPageLink {
  id: number;
  title: { rendered: string };
  link: string;
  parent: number;
  menu_order: number;
}
