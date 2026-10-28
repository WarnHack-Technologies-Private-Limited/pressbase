/**
 * Plugin admin pages and modules as /pressbase/v1/admin-extensions returns
 * them, and where each page lives in the admin. See
 * docs/architecture/plugins.md#admin-pages-and-settings.
 *
 * | parent     | URL                                         | WordPress            |
 * | ---------- | ------------------------------------------- | -------------------- |
 * | `settings` | /admin/settings/{plugin}[/{page}]           | add_options_page()   |
 * | `tools`    | /admin/tools/{plugin}[/{page}]              | add_management_page()|
 * | none       | /admin/plugin/{plugin}[/{page}]             | add_menu_page()      |
 *
 * The page segment is left out when the page's slug is the plugin's (its main page).
 */

export type PageParent = 'settings' | 'tools';

export interface AdminPage {
  plugin: string;
  plugin_title: string;
  slug: string;
  title: string;
  parent: PageParent | null;
  capability: string;
  description: string;
  /** Same-origin URL of the page's browser module, or null for a settings page. */
  module: string | null;
  has_settings: boolean;
}

export interface AdminModule {
  plugin: string;
  title: string;
  url: string;
}

/** A plugin block's editor assets (api.blocks on the server, ADR 0020). */
export interface AdminBlock {
  plugin: string;
  title: string;
  name: string;
  /** Same-origin URL of the block's editor module, imported before the editor parses the post. */
  editor_script: string | null;
  /** Stylesheets for the editor canvas: the block's `style`, then its `editorStyle`. */
  styles: string[];
}

export interface AdminExtensions {
  pages: AdminPage[];
  modules: AdminModule[];
  /** Missing from cores before v0.7. */
  blocks?: AdminBlock[];
}

export const NO_EXTENSIONS: AdminExtensions = { pages: [], modules: [], blocks: [] };

/** Core screens under Settings and Tools, which a plugin's short URL must not shadow. */
const RESERVED: Record<PageParent, Set<string>> = {
  settings: new Set([
    'general',
    'writing',
    'reading',
    'discussion',
    'media',
    'permalinks',
    'scheduled-tasks',
  ]),
  tools: new Set(['import', 'export', 'site-health']),
};

function base(parent: PageParent | null): string {
  return parent === 'settings'
    ? '/admin/settings'
    : parent === 'tools'
      ? '/admin/tools'
      : '/admin/plugin';
}

export function pageHref(page: Pick<AdminPage, 'plugin' | 'slug' | 'parent'>): string {
  const short =
    page.slug === page.plugin && !(page.parent && RESERVED[page.parent].has(page.plugin));
  return `${base(page.parent)}/${page.plugin}${short ? '' : `/${page.slug}`}`;
}

/** The catch-all route's segments → { plugin, page }, or null when they can't name a page. */
export function parsePagePath(
  segments: readonly string[],
): { plugin: string; page: string } | null {
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (segments.length < 1 || segments.length > 2) return null;
  const [plugin = '', page = plugin] = segments;
  if (!slug.test(plugin) || !slug.test(page)) return null;
  return { plugin, page };
}

export function pagesUnder(extensions: AdminExtensions, parent: PageParent | null): AdminPage[] {
  return extensions.pages.filter((p) => p.parent === parent);
}

/**
 * Whether `pathname` is the page. Exact: a plugin's main page's URL is a
 * prefix of its other pages' URLs.
 */
export function isPageCurrent(page: AdminPage, pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === pageHref(page);
}

/** Plugins that have something in the admin, for the extension registry's owners and titles. */
export function activeOwners(extensions: AdminExtensions): { plugin: string; title: string }[] {
  const owners = new Map<string, string>();
  for (const m of extensions.modules) owners.set(m.plugin, m.title);
  for (const b of extensions.blocks ?? []) if (!owners.has(b.plugin)) owners.set(b.plugin, b.title);
  for (const p of extensions.pages) if (!owners.has(p.plugin)) owners.set(p.plugin, p.plugin_title);
  return [...owners].map(([plugin, title]) => ({ plugin, title }));
}
