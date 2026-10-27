/**
 * Themes as /wp/v2/themes returns them (WP_REST_Themes_Controller), and the
 * small helpers the Appearance screen needs.
 */

export interface RestTheme {
  stylesheet: string;
  template: string;
  name: { raw: string; rendered: string };
  description: { raw: string; rendered: string };
  version: string;
  author: { raw: string; rendered: string };
  author_uri: { raw: string; rendered: string };
  theme_uri: { raw: string; rendered: string };
  screenshot: string;
  status: 'active' | 'inactive';
  tags: { raw: string[]; rendered: string };
  requires_wp: string;
  requires_php: string;
  textdomain: string;
  is_block_theme: boolean;
}

/** The active theme first, then the rest by name, as wp-admin/themes.php lists them. */
export function sortThemes(themes: readonly RestTheme[]): RestTheme[] {
  return [...themes].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return themeName(a).localeCompare(themeName(b));
  });
}

/** The theme's display name, falling back to its folder name. */
export function themeName(theme: RestTheme): string {
  return theme.name.raw.trim() || theme.stylesheet;
}

/**
 * Theme headers are plain text (style.css). The raw values are used and
 * rendered by React, so nothing here is ever injected as HTML.
 */
export function themeAuthor(theme: RestTheme): string {
  return theme.author.raw.trim();
}
