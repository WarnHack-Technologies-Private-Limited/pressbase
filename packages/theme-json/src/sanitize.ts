import {
  ELEMENTS,
  PRESETS_METADATA,
  PROPERTIES_METADATA,
  VALID_BLOCK_PSEUDO_SELECTORS,
  VALID_ELEMENT_PSEUDO_SELECTORS,
  VALID_ORIGINS,
  VALID_TOP_LEVEL_KEYS,
} from './constants';
import type { JsonObject, JsonValue, ThemeJsonData } from './types';
import { arrayGet, arraySet, clone, isObject } from './util';

/**
 * Sanitising user global styles before they are stored — ports of
 * WP_Theme_JSON::remove_insecure_properties() (wordpress/wp-includes/class-wp-theme-json.php),
 * safecss_filter_attr() and wp_filter_global_styles_post() (kses.php), and
 * WP_REST_Global_Styles_Controller::validate_custom_css().
 *
 * WordPress runs remove_insecure_properties() on save for users without
 * `unfiltered_html`; custom CSS (`styles.css`, block `css`) survives only for
 * users with `edit_css`. validate_custom_css() applies to everyone.
 */

/** WP_Theme_JSON::INDIRECT_PROPERTIES_METADATA */
const INDIRECT_PROPERTIES: [string, string[]][] = [
  ['gap', ['spacing', 'blockGap']],
  ['column-gap', ['spacing', 'blockGap', 'left']],
  ['row-gap', ['spacing', 'blockGap', 'top']],
  ['max-width', ['layout', 'contentSize']],
  ['max-width', ['layout', 'wideSize']],
  ['background-image', ['background', 'gradient']],
];

/** safecss_filter_attr()'s $css_url_data_types and $css_gradient_data_types */
const URL_PROPERTIES = new Set([
  'background',
  'background-image',
  'cursor',
  'filter',
  'list-style',
  'list-style-image',
  'clip-path',
  'fill',
  'marker',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'stroke',
]);
const GRADIENT_PROPERTIES = new Set(['background', 'background-image']);

/** The functions safecss_filter_attr() lets through (removed before the final check). */
const ALLOWED_FUNCTIONS =
  /\b(?:var|calc|min|max|minmax|clamp|repeat|matrix|matrix3d|perspective|rotate|rotate3d|rotateX|rotateY|rotateZ|scale|scale3d|scaleX|scaleY|scaleZ|skew|skewX|skewY|translate|translate3d|translateX|translateY|translateZ|circle|ellipse|inset|path|polygon|rect|shape|xywh)\([^()]*\)/g;
const GRADIENT = /(?:repeating-)?(?:linear|radial|conic)-gradient\((?:[^()]|\([^()]*\))*\)/g;

/** wp_kses_bad_protocol() for CSS urls: http, https or a relative URL. */
function isSafeUrl(url: string): boolean {
  const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === 'http' || scheme === 'https';
}

/**
 * safecss_filter_attr() for one declaration, as is_safe_css_declaration()
 * uses it: the value may use var(), calc(), clamp() and friends, gradients
 * (on background properties) and http(s) urls (on url properties), but no
 * other parentheses, `\`, `&`, `}`, `=`, comments — and, stricter than
 * WordPress, nothing that could end the declaration or the style element
 * (`;`, `{`, `<`, `>`).
 */
export function isSafeCssDeclaration(property: string, value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  if (!/^(?:--[a-zA-Z0-9_-]+|[a-z-]+)$/.test(property)) return false;
  const trimmed = value.trim();
  if (!trimmed || /[;{<>]/.test(trimmed)) return false;
  let test = trimmed;
  const isCustomProperty = property.startsWith('--');
  const urls = isCustomProperty ? trimmed.startsWith('url(') : URL_PROPERTIES.has(property);
  const gradients = isCustomProperty
    ? trimmed.includes('-gradient(')
    : GRADIENT_PROPERTIES.has(property);
  if (urls) {
    for (const match of trimmed.match(/url\([^)]+\)/g) ?? []) {
      const url = /^url\(\s*(['"]?)(.*)\1\s*\)$/.exec(match)?.[2]?.trim();
      if (!url || !isSafeUrl(url)) return false;
      test = test.replace(match, '');
    }
  }
  if (gradients) test = test.replace(GRADIENT, '');
  for (let previous = ''; previous !== test; ) {
    previous = test;
    test = test.replace(ALLOWED_FUNCTIONS, '');
  }
  return !/[\\(&=}]|\/\*/.test(test);
}

export type CustomCssResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * WP_REST_Global_Styles_Controller::validate_custom_css(): the CSS must not
 * contain a STYLE end tag (`</style` followed by whitespace, `/` or `>`), nor
 * end with a prefix of one (`<`, `</`, … `</style`) that concatenation could
 * complete.
 */
export function validateCustomCss(css: unknown): CustomCssResult {
  if (typeof css !== 'string') {
    return { ok: false, code: 'rest_custom_css_invalid_type', message: 'CSS must be a string.' };
  }
  const lower = css.toLowerCase();
  for (let at = lower.indexOf('<'); at !== -1; at = lower.indexOf('<', at + 1)) {
    const rest = lower.slice(at);
    if (rest.length < 8) {
      if ('</style'.startsWith(rest)) {
        return {
          ok: false,
          code: 'rest_custom_css_illegal_markup',
          message: `The CSS must not end in "${css.slice(at)}".`,
        };
      }
      continue;
    }
    if (rest.startsWith('</style') && /[ \t\f\r\n/>]/.test(rest.charAt(7))) {
      return {
        ok: false,
        code: 'rest_custom_css_illegal_markup',
        message: `The CSS must not contain "${css.slice(at, at + 8)}".`,
      };
    }
  }
  return { ok: true };
}

/** remove_insecure_styles(): keeps the declarations that pass safecss_filter_attr(). */
function removeInsecureStyles(input: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [property, path] of [...PROPERTIES_METADATA, ...INDIRECT_PROPERTIES]) {
    const value = arrayGet(input, path);
    // Shorthand objects (border.radius: { topLeft… }) are rebuilt from their longhands.
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    if (isSafeCssDeclaration(property, value)) arraySet(output, path, value);
  }
  return output;
}

function removeInsecureElementStyles(elements: JsonValue | undefined): JsonObject {
  const output: JsonObject = {};
  if (!isObject(elements)) return output;
  for (const name of Object.keys(ELEMENTS)) {
    const input = elements[name];
    if (!isObject(input)) continue;
    const styles = removeInsecureStyles(input);
    for (const pseudo of VALID_ELEMENT_PSEUDO_SELECTORS[name] ?? []) {
      const state = input[pseudo];
      if (isObject(state)) styles[pseudo] = removeInsecureStyles(state);
    }
    output[name] = styles;
  }
  return output;
}

function removeInsecureInnerBlockStyles(blocks: JsonValue | undefined, valid: Set<string>) {
  const output: JsonObject = {};
  if (!isObject(blocks)) return output;
  for (const [name, input] of Object.entries(blocks)) {
    if (!valid.has(name) || !isObject(input)) continue;
    const styles = removeInsecureStyles(input);
    if (input.elements !== undefined) styles.elements = removeInsecureElementStyles(input.elements);
    output[name] = styles;
  }
  return output;
}

/** A node with nested elements/blocks: a style variation (block-level or shared). */
function removeInsecureVariation(input: JsonObject, blocks: Set<string>): JsonObject {
  const output = removeInsecureStyles(input);
  if (input.blocks !== undefined)
    output.blocks = removeInsecureInnerBlockStyles(input.blocks, blocks);
  if (input.elements !== undefined) output.elements = removeInsecureElementStyles(input.elements);
  return output;
}

const NAME_IS_SAFE = (name: unknown) => typeof name === 'string' && !/[<>&"']/.test(name);
const SLUG_IS_SAFE = (slug: unknown) => typeof slug === 'string' && /^[A-Za-z0-9_-]+$/.test(slug);

/** remove_insecure_settings(): presets with safe names, slugs and values, plus plain settings. */
function removeInsecureSettings(input: JsonObject): JsonObject {
  const output: JsonObject = {};
  const presetPaths = new Set(PRESETS_METADATA.map((p) => p.path.join('.')));
  for (const preset of PRESETS_METADATA) {
    const value = arrayGet(input, preset.path);
    // Presets are keyed by origin in the stored data; a bare list is the theme's.
    const perOrigin: Record<string, JsonValue> = Array.isArray(value)
      ? { theme: value }
      : isObject(value)
        ? (value as Record<string, JsonValue>)
        : {};
    for (const origin of VALID_ORIGINS) {
      const list = perOrigin[origin];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((item) => {
        if (!isObject(item) || !NAME_IS_SAFE(item.name ?? '') || !SLUG_IS_SAFE(item.slug)) {
          return false;
        }
        const presetValue = preset.valueKey ? item[preset.valueKey] : (item.size ?? item.fluid);
        if (preset.valueFunc === 'fontSize') {
          return item.size === undefined || isSafeCssDeclaration('font-size', item.size);
        }
        return isSafeCssDeclaration('--preset', presetValue as JsonValue);
      });
      if (kept.length) arraySet(output, [...preset.path, origin], kept);
    }
  }
  // preserve_valid_typed_settings(), simplified: booleans, numbers and safe strings.
  const walk = (node: JsonObject, path: string[]) => {
    for (const [key, value] of Object.entries(node)) {
      const at = [...path, key];
      if (presetPaths.has(at.join('.')) || (path.length === 0 && key === 'blocks')) continue;
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
        arraySet(output, at, value);
      } else if (typeof value === 'string') {
        if (isSafeCssDeclaration('--setting', value)) arraySet(output, at, value);
      } else if (isObject(value)) {
        walk(value, at);
      } else if (Array.isArray(value)) {
        const safe = value.filter(
          (item) =>
            typeof item === 'boolean' ||
            typeof item === 'number' ||
            (typeof item === 'string' && isSafeCssDeclaration('--setting', item)),
        );
        if (safe.length === value.length) arraySet(output, at, clone(value));
      }
    }
  };
  walk(input, []);
  return output;
}

export interface RemoveInsecureOptions {
  /** Registered block names; styles for others are dropped (sanitize()). */
  blockNames: Iterable<string>;
  /** current_user_can( 'edit_css' ): keep `css` (custom CSS) as written. */
  canEditCss: boolean;
}

/**
 * WP_Theme_JSON::remove_insecure_properties( $theme_json, 'custom' ): keeps
 * only the style declarations and settings that are safe to print, for user
 * global styles saved by someone without `unfiltered_html`. Top-level keys
 * other than settings and styles are kept as they are (after sanitize()'s
 * allow-list).
 */
export function removeInsecureProperties(
  input: ThemeJsonData,
  options: RemoveInsecureOptions,
): ThemeJsonData {
  const blocks = new Set(options.blockNames);
  const data: ThemeJsonData = {};
  for (const key of VALID_TOP_LEVEL_KEYS) {
    if (input[key] !== undefined) data[key] = clone(input[key]);
  }
  for (const [key, value] of Object.entries(input)) {
    // Flags such as isGlobalStylesUserThemeJSON survive; wp_filter_global_styles_post() re-adds it.
    if (!(key in data) && typeof value === 'boolean') data[key] = value;
  }

  const styles: JsonObject = {};
  const input_styles = isObject(input.styles) ? input.styles : {};
  const keepCss = (from: JsonObject, to: JsonObject) => {
    if (options.canEditCss && typeof from.css === 'string') to.css = from.css;
  };

  // The root node.
  const root = removeInsecureStyles(input_styles);
  keepCss(input_styles, root);
  Object.assign(styles, root);

  // Elements, with their pseudo states.
  if (input_styles.elements !== undefined) {
    const elements = removeInsecureElementStyles(input_styles.elements);
    if (Object.keys(elements).length) styles.elements = elements;
  }

  // Blocks: styles, pseudo states, elements, and style variations.
  if (isObject(input_styles.blocks)) {
    const out: JsonObject = {};
    for (const [name, node] of Object.entries(input_styles.blocks)) {
      if (!blocks.has(name) || !isObject(node)) continue;
      const block = removeInsecureStyles(node);
      keepCss(node, block);
      for (const pseudo of VALID_BLOCK_PSEUDO_SELECTORS[name] ?? []) {
        const state = node[pseudo];
        if (isObject(state)) block[pseudo] = removeInsecureStyles(state);
      }
      if (node.elements !== undefined) block.elements = removeInsecureElementStyles(node.elements);
      if (isObject(node.variations)) {
        const variations: JsonObject = {};
        for (const [variation, variationNode] of Object.entries(node.variations)) {
          if (isObject(variationNode)) {
            variations[variation] = removeInsecureVariation(variationNode, blocks);
          }
        }
        block.variations = variations;
      }
      out[name] = block;
    }
    styles.blocks = out;
  }

  // Shared block style variations (styles.variations), unwrapped into blocks by WP_Theme_JSON.
  if (isObject(input_styles.variations)) {
    const variations: JsonObject = {};
    for (const [name, node] of Object.entries(input_styles.variations)) {
      if (isObject(node)) variations[name] = removeInsecureVariation(node, blocks);
    }
    styles.variations = variations;
  }

  if (Object.keys(styles).length) data.styles = styles;
  else delete data.styles;

  if (isObject(input.settings)) {
    const settings = removeInsecureSettings(input.settings);
    if (isObject(input.settings.blocks)) {
      const out: JsonObject = {};
      for (const [name, node] of Object.entries(input.settings.blocks)) {
        if (blocks.has(name) && isObject(node)) out[name] = removeInsecureSettings(node);
      }
      settings.blocks = out;
    }
    if (Object.keys(settings).length) data.settings = settings;
    else delete data.settings;
  }
  return data;
}

/**
 * The JSON WordPress stores in a `wp_global_styles` post: `<`, `>` and `&`
 * escaped (JSON_HEX_TAG | JSON_HEX_AMP), slashes left alone.
 */
export function encodeGlobalStylesJson(config: JsonObject): string {
  return JSON.stringify(config)
    .replaceAll('<', '\\u003C')
    .replaceAll('>', '\\u003E')
    .replaceAll('&', '\\u0026');
}
