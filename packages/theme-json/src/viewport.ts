import { isObject } from './util';

/**
 * Responsive breakpoints (WordPress 7.1): `settings.viewport` and the
 * `@mobile` / `@tablet` style states. Ports of WP_Theme_JSON's
 * DEFAULT_VIEWPORT_BREAKPOINTS, get_viewport_media_queries(),
 * is_valid_viewport_breakpoint_size(), get_viewport_breakpoint_value_in_pixels()
 * and sanitize_viewport_settings() (wordpress/wp-includes/class-wp-theme-json.php).
 */

export type ViewportName = 'mobile' | 'tablet';

/** A style state key that holds styles for one viewport: `@mobile`, `@tablet`. */
export type ViewportState = `@${ViewportName}`;

export interface ViewportBreakpoints {
  mobile?: string;
  tablet?: string;
}

/** WP_Theme_JSON::DEFAULT_VIEWPORT_BREAKPOINTS */
export const DEFAULT_VIEWPORT_BREAKPOINTS: Readonly<Required<ViewportBreakpoints>> = {
  mobile: '480px',
  tablet: '782px',
};

/** The viewport style states WordPress 7.1 knows, smallest breakpoint first. */
export const VIEWPORT_STATES: readonly ViewportState[] = ['@mobile', '@tablet'];

/** is_valid_viewport_breakpoint_size(): numeric `px`, `em` or `rem` lengths only. */
function isValidBreakpointSize(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return /^(?:\d+|\d*\.\d+)(?:px|em|rem)$/.test(trimmed);
}

/** get_viewport_breakpoint_value_in_pixels(): `em` and `rem` count as 16px, for ordering only. */
function breakpointInPixels(value: unknown): number | null {
  if (!isValidBreakpointSize(value)) return null;
  const trimmed = value.trim();
  if (trimmed.endsWith('rem')) return Number.parseFloat(trimmed.slice(0, -3)) * 16;
  const unit = trimmed.slice(-2);
  const number = Number.parseFloat(trimmed.slice(0, -2));
  return unit === 'px' ? number : number * 16;
}

/**
 * sanitize_viewport_settings(): keeps `mobile` and `tablet` when they are
 * valid lengths (trimmed). No valid value gives the defaults; a single valid
 * value stays alone; `tablet` is dropped unless it is larger than `mobile`.
 */
export function sanitizeViewportSettings(settings: unknown): ViewportBreakpoints {
  if (!isObject(settings) && !Array.isArray(settings)) return { ...DEFAULT_VIEWPORT_BREAKPOINTS };
  const source = (isObject(settings) ? settings : {}) as Record<string, unknown>;
  const breakpoints: Partial<Record<ViewportName, { value: string; px: number }>> = {};
  for (const name of ['mobile', 'tablet'] as const) {
    const value = source[name];
    const px = breakpointInPixels(value);
    if (px !== null) breakpoints[name] = { value: (value as string).trim(), px };
  }
  const found = Object.keys(breakpoints) as ViewportName[];
  if (found.length === 0) return { ...DEFAULT_VIEWPORT_BREAKPOINTS };
  if (found.length === 1) {
    const name = found[0] as ViewportName;
    return { [name]: breakpoints[name]?.value };
  }
  const mobile = breakpoints.mobile as { value: string; px: number };
  const tablet = breakpoints.tablet as { value: string; px: number };
  const sanitized: ViewportBreakpoints = { mobile: mobile.value };
  if (mobile.px < tablet.px) sanitized.tablet = tablet.value;
  return sanitized;
}

export interface ViewportMediaQueryOptions {
  /** Add `@desktop` (wider than the largest breakpoint), as block visibility does. */
  includeDesktop?: boolean;
}

/**
 * get_viewport_media_queries(): the media query of each viewport style
 * state, keyed `@mobile`, `@tablet` (and `@desktop` on request). With the
 * defaults:
 *
 * - `@mobile`: `@media (width <= 480px)`
 * - `@tablet`: `@media (480px < width <= 782px)`
 * - `@desktop`: `@media (width > 782px)`
 *
 * The ranges don't overlap, so a tablet value never reaches phones.
 */
export function getViewportMediaQueries(
  viewportSettings?: unknown,
  options: ViewportMediaQueryOptions = {},
): Record<string, string> {
  const breakpoints = sanitizeViewportSettings(viewportSettings);
  const queries: Record<string, string> = {};
  if (breakpoints.mobile !== undefined) {
    queries['@mobile'] = `@media (width <= ${breakpoints.mobile})`;
  }
  if (breakpoints.tablet !== undefined) {
    queries['@tablet'] =
      breakpoints.mobile !== undefined
        ? `@media (${breakpoints.mobile} < width <= ${breakpoints.tablet})`
        : `@media (width <= ${breakpoints.tablet})`;
  }
  if (options.includeDesktop) {
    const desktop = breakpoints.tablet ?? breakpoints.mobile;
    queries['@desktop'] = `@media (width > ${desktop})`;
  }
  return queries;
}
