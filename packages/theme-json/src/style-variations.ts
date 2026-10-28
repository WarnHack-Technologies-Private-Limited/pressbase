import { PRESETS_METADATA } from './constants';
import type { JsonObject, JsonValue, Origin, ThemeJsonData } from './types';
import { arrayGet, arraySet, clone, isObject } from './util';

/**
 * Theme style variations — the `styles/*.json` files of a block theme.
 *
 * WordPress (WP_Theme_JSON_Resolver::get_style_variations(), wordpress/wp-includes/class-wp-theme-json-resolver.php)
 * lists every JSON file under `styles/`, recursively, child theme first; files
 * with `blockTypes` are block style variations (scope `block`), the rest are
 * theme style variations (scope `theme`). The site editor then tells full
 * variations from colour-only and typography-only ones, and choosing one
 * writes it into the user's global styles (the custom origin). These are
 * ports of that editor logic (@wordpress/global-styles-engine and
 * @wordpress/edit-site: `filterObjectByProperties()`,
 * `isVariationWithProperties()`, `removePropertiesFromObject()`,
 * `mergeBaseAndUserConfigs()`, `areGlobalStyleConfigsEqual()`).
 */

/** A theme style variation: a theme.json partial with a title. */
export interface StyleVariation extends ThemeJsonData {
  title?: string;
  slug?: string;
  description?: string;
}

/** The user global styles document, as stored in a `wp_global_styles` post. */
export interface GlobalStylesConfig extends ThemeJsonData {
  isGlobalStylesUserThemeJSON?: boolean;
}

export type StyleVariationKind = 'full' | 'color' | 'typography';

/** style_variation_has_scope() */
export function styleVariationScope(variation: ThemeJsonData): 'block' | 'theme' {
  return variation.blockTypes !== undefined ? 'block' : 'theme';
}

/**
 * The constructor's preset keying (WP_Theme_JSON::__construct()): preset
 * lists become `{ [origin]: list }`, as get_raw_data() returns them and the
 * global styles endpoints answer. Values are left as written (`var:preset|…`).
 */
export function keyPresetsByOrigin<T extends ThemeJsonData>(input: T, origin: Origin): T {
  const data = clone(input);
  const settings = data.settings;
  if (!isObject(settings)) return data;
  const nodes: JsonObject[] = [settings];
  if (isObject(settings.blocks)) {
    for (const node of Object.values(settings.blocks)) if (isObject(node)) nodes.push(node);
  }
  for (const node of nodes) {
    for (const preset of PRESETS_METADATA) {
      const value = arrayGet(node, preset.path);
      if (Array.isArray(value)) arraySet(node, preset.path, { [origin]: value });
    }
  }
  return data;
}

/** filterObjectByProperties(): keeps only the branches that hold one of the keys. */
export function filterObjectByProperties(object: JsonValue, properties: string[]): JsonValue {
  if (!isObject(object)) return object;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue;
    if (properties.includes(key)) out[key] = clone(value);
    else if (isObject(value)) {
      const filtered = filterObjectByProperties(value, properties);
      if (isObject(filtered) && Object.keys(filtered).length) out[key] = filtered;
    }
  }
  return out;
}

/** removePropertiesFromObject(): drops every branch keyed by one of the properties. */
export function removePropertiesFromObject(object: JsonValue, properties: string[]): JsonValue {
  if (!isObject(object)) return object;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || properties.includes(key)) continue;
    out[key] = isObject(value) ? removePropertiesFromObject(value, properties) : clone(value);
  }
  return out;
}

/** Deep equality for JSON values (fast-deep-equal, as the editor uses). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a).filter((k) => a[k] !== undefined);
    const other = Object.keys(b).filter((k) => b[k] !== undefined);
    return keys.length === other.length && keys.every((k) => jsonEqual(a[k], b[k]));
  }
  return false;
}

const isEmptyBranch = (value: unknown) =>
  value === undefined || (isObject(value) && Object.keys(value).length === 0);

/** areGlobalStyleConfigsEqual(): settings and styles only; missing and `{}` are the same. */
export function areGlobalStyleConfigsEqual(a: ThemeJsonData, b: ThemeJsonData): boolean {
  for (const key of ['settings', 'styles'] as const) {
    const x = a[key];
    const y = b[key];
    if (isEmptyBranch(x) && isEmptyBranch(y)) continue;
    if (!jsonEqual(x, y)) return false;
  }
  return true;
}

/** isVariationWithProperties(): every value in the variation lives under one of the keys. */
export function isVariationWithProperties(variation: ThemeJsonData, properties: string[]): boolean {
  const filtered = filterObjectByProperties(
    { settings: variation.settings ?? {}, styles: variation.styles ?? {} },
    properties,
  ) as ThemeJsonData;
  return areGlobalStyleConfigsEqual(filtered, variation);
}

/** The editor's properties for each kind of partial variation. */
export const VARIATION_PROPERTIES: Record<Exclude<StyleVariationKind, 'full'>, string[]> = {
  color: ['color'],
  typography: ['typography'],
};

/**
 * Which list the site editor shows a variation in: Colors (only colour
 * values), Typography (only typography values) or the full style
 * variations. A variation with nothing in it counts as full.
 */
export function styleVariationKind(variation: ThemeJsonData): StyleVariationKind {
  const empty = isEmptyBranch(variation.settings) && isEmptyBranch(variation.styles);
  if (empty) return 'full';
  if (isVariationWithProperties(variation, VARIATION_PROPERTIES.color)) return 'color';
  if (isVariationWithProperties(variation, VARIATION_PROPERTIES.typography)) return 'typography';
  return 'full';
}

/** mergeBaseAndUserConfigs(): a deep merge where lists are replaced, never merged. */
export function mergeGlobalStylesConfigs<T extends ThemeJsonData>(
  base: T,
  incoming: ThemeJsonData,
): T {
  const merge = (a: JsonValue | undefined, b: JsonValue): JsonValue => {
    if (isObject(a) && isObject(b)) {
      const out: JsonObject = { ...clone(a) };
      for (const [key, value] of Object.entries(b)) {
        if (value !== undefined) out[key] = merge(out[key], value);
      }
      return out;
    }
    return clone(b);
  };
  return merge(base, incoming) as T;
}

/**
 * Choosing a style variation in the site editor, as a new user config:
 *
 * - a full variation replaces the user's settings and styles with its own
 *   (what selecting a card in Styles → Browse styles does);
 * - a colour or typography variation keeps everything else the user set,
 *   drops their colour (or typography) values and merges the variation's in
 *   (`useCurrentMergeThemeStyleVariationsWithUserConfig()`).
 */
export function applyStyleVariation(
  user: GlobalStylesConfig,
  variation: StyleVariation,
): GlobalStylesConfig {
  const kind = styleVariationKind(variation);
  const out: GlobalStylesConfig = { version: user.version ?? 3 };
  if (user.isGlobalStylesUserThemeJSON) out.isGlobalStylesUserThemeJSON = true;
  if (kind === 'full') {
    if (variation.settings) out.settings = clone(variation.settings);
    if (variation.styles) out.styles = clone(variation.styles);
    return out;
  }
  const properties = VARIATION_PROPERTIES[kind];
  const kept = removePropertiesFromObject(
    { settings: user.settings ?? {}, styles: user.styles ?? {} },
    properties,
  ) as ThemeJsonData;
  const merged = mergeGlobalStylesConfigs(kept, {
    settings: variation.settings ?? {},
    styles: variation.styles ?? {},
  });
  if (merged.settings && Object.keys(merged.settings).length) out.settings = merged.settings;
  if (merged.styles && Object.keys(merged.styles).length) out.styles = merged.styles;
  return out;
}

/** True when every value the variation sets is set the same way in the user config. */
export function isStyleVariationApplied(user: ThemeJsonData, variation: ThemeJsonData): boolean {
  const contains = (outer: unknown, inner: unknown): boolean => {
    if (isObject(inner)) {
      return isObject(outer) && Object.entries(inner).every(([k, v]) => contains(outer[k], v));
    }
    return jsonEqual(outer, inner);
  };
  const branches = ['settings', 'styles'] as const;
  if (branches.every((b) => isEmptyBranch(variation[b]))) {
    return branches.every((b) => isEmptyBranch(user[b]));
  }
  return branches.every((b) => isEmptyBranch(variation[b]) || contains(user[b], variation[b]));
}

/**
 * get_resolved_theme_uris(): `file:./` URLs in a theme.json tree (font face
 * sources, background images), with where they are and what they resolve to.
 */
export function resolvedThemeUris(
  data: ThemeJsonData,
  resolve: (relativePath: string) => string,
): { name: string; href: string; target: string }[] {
  const found: { name: string; href: string; target: string }[] = [];
  const visit = (value: unknown, path: string[]) => {
    if (typeof value === 'string') {
      if (value.startsWith('file:./')) {
        found.push({ name: value, href: resolve(value.slice(7)), target: path.join('.') });
      }
    } else if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) visit(item, [...path, String(i)]);
    } else if (isObject(value)) {
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
    }
  };
  visit(data.settings, ['settings']);
  visit(data.styles, ['styles']);
  return found;
}
