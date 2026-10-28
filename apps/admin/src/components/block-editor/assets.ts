/**
 * The block editor's stylesheets. They're served by
 * `app/editor-assets/[name]/route.ts` (prerendered at build time) so they can
 * be linked both from the admin page and from inside the canvas iframe.
 *
 * Which file goes where follows WordPress's script-loader.php: the admin page
 * gets the editor UI (`wp-components`, `wp-block-editor`, `wp-edit-blocks`,
 * `wp-format-library`); the iframe gets the content styles WordPress enqueues
 * in _wp_get_iframed_editor_assets().
 */

/** Published name → file, relative to the admin app's root. */
export const EDITOR_STYLESHEETS = {
  'components.css': 'node_modules/@wordpress/components/build-style/style.css',
  'block-editor.css': 'node_modules/@wordpress/block-editor/build-style/style.css',
  'block-editor-content.css': 'node_modules/@wordpress/block-editor/build-style/content.css',
  'block-library.css': 'node_modules/@wordpress/block-library/build-style/style.css',
  'block-library-editor.css': 'node_modules/@wordpress/block-library/build-style/editor.css',
  'block-library-theme.css': 'node_modules/@wordpress/block-library/build-style/theme.css',
  'format-library.css': 'node_modules/@wordpress/format-library/build-style/style.css',
  // Right-to-left copies, for RTL languages (WordPress's wp_style_add_data( …, 'rtl', 'replace' )).
  'components-rtl.css': 'node_modules/@wordpress/components/build-style/style-rtl.css',
  'block-editor-rtl.css': 'node_modules/@wordpress/block-editor/build-style/style-rtl.css',
  'block-editor-content-rtl.css':
    'node_modules/@wordpress/block-editor/build-style/content-rtl.css',
  'block-library-rtl.css': 'node_modules/@wordpress/block-library/build-style/style-rtl.css',
  'block-library-editor-rtl.css':
    'node_modules/@wordpress/block-library/build-style/editor-rtl.css',
  'block-library-theme-rtl.css': 'node_modules/@wordpress/block-library/build-style/theme-rtl.css',
  'format-library-rtl.css': 'node_modules/@wordpress/format-library/build-style/style-rtl.css',
  // Pressbase's own canvas styles: typography, layout and the title field.
  'canvas.css': 'src/components/block-editor/canvas.css',
} as const;

export type EditorStylesheet = keyof typeof EDITOR_STYLESHEETS;

/** The right-to-left copy of a stylesheet, when there is one. */
export function directional(name: EditorStylesheet, rtl: boolean): EditorStylesheet {
  if (!rtl) return name;
  const rtlName = name.replace(/\.css$/, '-rtl.css');
  return rtlName in EDITOR_STYLESHEETS ? (rtlName as EditorStylesheet) : name;
}

/** Loaded on the admin page, for toolbars, popovers, the inserter and the inspector. */
export const UI_STYLESHEETS: EditorStylesheet[] = [
  'components.css',
  'block-editor.css',
  'block-library-editor.css',
  'format-library.css',
];

/** Loaded inside the canvas iframe, in this order. */
export const CANVAS_STYLESHEETS: EditorStylesheet[] = [
  'components.css',
  'block-library.css',
  'block-library-theme.css',
  'block-editor-content.css',
  'block-library-editor.css',
  'canvas.css',
];

/**
 * Bumped with the @wordpress packages (or canvas.css) so browsers fetch the
 * new files; the URLs are cached as immutable.
 */
export const EDITOR_ASSETS_VERSION = 'wp12.0.0-1';

export const assetUrl = (name: EditorStylesheet) =>
  `/editor-assets/${name}?v=${EDITOR_ASSETS_VERSION}`;
