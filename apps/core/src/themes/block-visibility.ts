import { getViewportMediaQueries, styleEngineStylesheet } from '@pressbase/theme-json';

/**
 * The block visibility support: a port of wp_render_block_visibility_support()
 * (wordpress/wp-includes/block-supports/block-visibility.php, WordPress 7.1).
 *
 * The block's `metadata.blockVisibility` attribute:
 *
 * - `false`: the block is hidden everywhere (renders nothing), whatever its
 *   support says;
 * - `{ "viewport": { "mobile": false, "tablet": false, "desktop": false } }`:
 *   hidden on those devices, with `wp-block-hidden-{device}` classes and
 *   `display: none !important` rules in the viewport's media query
 *   (`@desktop` is wider than the largest breakpoint).
 *
 * Blocks whose `supports.visibility` is false (HTML, Pattern, More…) ignore
 * the per-device form.
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type BlockVisibilityResult =
  | { hidden: true }
  | { hidden: false; classes: string[]; css: string }
  | null;

/**
 * What wp_render_block_visibility_support() does to a block: `hidden` when it
 * renders nothing, the classes and CSS when it is hidden on some devices, or
 * null when nothing changes.
 */
export function blockVisibility(
  attrs: Record<string, unknown>,
  supportsVisibility: boolean,
  viewport: unknown,
): BlockVisibilityResult {
  const metadata = isObject(attrs.metadata) ? attrs.metadata : undefined;
  const visibility = metadata?.blockVisibility;
  if (visibility === false) return { hidden: true };
  if (!supportsVisibility || !isObject(visibility) || !Object.keys(visibility).length) return null;
  const config = visibility.viewport;
  if (!isObject(config) || !Object.keys(config).length) return null;

  // The style-state keys (`@mobile`) become plain viewport names (`mobile`).
  const queries: Record<string, string> = {};
  for (const [state, query] of Object.entries(
    getViewportMediaQueries(viewport, { includeDesktop: true }),
  )) {
    queries[state.replace(/^@+/, '')] = query;
  }
  const hiddenOn = Object.entries(config)
    .filter(([size, visible]) => visible === false && queries[size] !== undefined)
    .map(([size]) => size)
    .sort();
  if (!hiddenOn.length) return null;
  const classes = hiddenOn.map((size) => `wp-block-hidden-${size}`);
  const css = styleEngineStylesheet(
    hiddenOn.map((size) => ({
      selector: `.wp-block-hidden-${size}`,
      declarations: { display: 'none !important' },
      rulesGroup: queries[size],
    })),
  );
  return { hidden: false, classes, css };
}

/**
 * Sets `fetchpriority="auto"` on every IMG tag, as the support does for a
 * block hidden on some devices: an image that may not show shouldn't take
 * the high priority (WP_HTML_Tag_Processor::set_attribute()).
 */
export function imagesFetchPriorityAuto(html: string): string {
  return html.replace(/<img(?=[\s/>])([^>]*)>/gi, (_tag, attributes: string) => {
    const existing = /(\s)fetchpriority\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;
    if (existing.test(attributes)) {
      return `<img${attributes.replace(existing, '$1fetchpriority="auto"')}>`;
    }
    return `<img fetchpriority="auto"${attributes}>`;
  });
}
