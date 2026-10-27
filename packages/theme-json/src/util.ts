import type { JsonObject, JsonValue } from './types';

/**
 * Small ports of the PHP array helpers WP_Theme_JSON relies on:
 * _wp_array_get(), _wp_array_set(), array_replace_recursive() and
 * _wp_to_kebab_case().
 */

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** PHP's is_array(): lists and maps. */
export function isArrayLike(value: unknown): value is JsonObject | JsonValue[] {
  return typeof value === 'object' && value !== null;
}

/** _wp_array_get(): reads a nested value; a key holding null returns null, a missing one the default. */
export function arrayGet(input: unknown, path: readonly string[], fallback?: unknown): unknown {
  let value = input;
  for (const key of path) {
    if (!isArrayLike(value)) return fallback;
    const container = value as Record<string, unknown>;
    if (!Object.hasOwn(container, key)) return fallback;
    value = container[key];
  }
  return value;
}

/** _wp_array_set(): creates intermediate objects as needed. */
export function arraySet(input: JsonObject, path: readonly string[], value: JsonValue): void {
  let node: JsonObject = input;
  path.forEach((key, index) => {
    if (index === path.length - 1) {
      node[key] = value;
      return;
    }
    const next = node[key];
    if (!isObject(next)) node[key] = {};
    node = node[key] as JsonObject;
  });
}

export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * array_replace_recursive(): maps merge key by key; PHP lists merge by index
 * too (WordPress replaces presets explicitly afterwards).
 */
export function replaceRecursive(base: JsonValue | undefined, incoming: JsonValue): JsonValue {
  if (isArrayLike(base) && isArrayLike(incoming)) {
    if (Array.isArray(base) && Array.isArray(incoming)) {
      const out = [...base];
      incoming.forEach((item, i) => {
        out[i] = replaceRecursive(out[i], item);
      });
      return out;
    }
    const out: JsonObject = Array.isArray(base)
      ? Object.fromEntries(base.map((v, i) => [String(i), v]))
      : { ...(base as JsonObject) };
    for (const [key, value] of Object.entries(incoming)) {
      if (value === undefined) continue;
      out[key] = replaceRecursive(out[key], value);
    }
    return out;
  }
  return clone(incoming);
}

/**
 * _wp_to_kebab_case() (lodash's kebabCase): `fooBar2` → `foo-bar-2`,
 * `accent-1` → `accent-1`, `x-large` → `x-large`.
 */
export function toKebabCase(input: string): string {
  const words = input
    .replace(/'/g, '')
    .match(
      /[A-Z]?[a-z\xdf-\xff]+(?=[^a-zA-Z0-9\xc0-\xff]|[A-Z]|$)|[A-Z]+(?=[^a-zA-Z0-9\xc0-\xff]|[A-Z][a-z]|$)|[A-Z]?[a-z\xdf-\xff]+|[A-Z]+|\d+/g,
    );
  return (words ?? []).join('-').toLowerCase();
}

/** PHP's empty() for the values theme.json holds. */
export function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '' || value === 0) {
    return true;
  }
  if (value === '0') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** PHP's is_numeric() for strings and numbers. */
export function isNumeric(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(value);
}

/**
 * The CSS value check WordPress applies to theme.json values before printing
 * them (safecss_filter_attr()): no way to break out of the declaration.
 */
export function isSafeCssValue(value: string): boolean {
  return !/[{}<>\\]|\/\*|expression\s*\(|javascript:|behavior\s*:/i.test(value);
}

/** `var:preset|color|base` → `var(--wp--preset--color--base)` (convert_custom_properties()). */
export function convertCustomProperties(value: string): string {
  if (!value.startsWith('var:')) return value;
  return `var(--wp--${value.slice(4).replaceAll('|', '--')})`;
}

/** resolve_custom_css_format(): applies convertCustomProperties() through a tree. */
export function resolveCustomCssFormat(tree: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string' && value.startsWith('var:')) {
      out[key] = convertCustomProperties(value);
    } else if (isObject(value)) {
      out[key] = resolveCustomCssFormat(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        isObject(item)
          ? resolveCustomCssFormat(item)
          : typeof item === 'string'
            ? convertCustomProperties(item)
            : item,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}
