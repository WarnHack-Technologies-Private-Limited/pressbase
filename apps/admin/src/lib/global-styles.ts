/**
 * Global styles as the Styles screen edits them: the REST shapes of
 * /wp/v2/global-styles (WP_REST_Global_Styles_Controller), and the small
 * pieces of the site editor's logic the screen needs — choosing a style
 * variation, reading the effective value of a style, editing the palette,
 * the font pairing, the base size and the layout widths. Pure functions, no
 * React: the user config is never mutated, every edit returns a new one.
 *
 * Choosing variations follows @wordpress/global-styles-engine
 * (filterObjectByProperties, isVariationWithProperties,
 * removePropertiesFromObject, mergeBaseAndUserConfigs); core has the same
 * port in packages/theme-json/src/style-variations.ts and is the authority
 * on what gets stored.
 */

// biome-ignore lint/suspicious/noExplicitAny: theme.json is open-ended JSON.
export type Json = any;
type JsonObject = Record<string, Json>;

export interface GlobalStylesConfig {
  version?: number;
  settings?: JsonObject;
  styles?: JsonObject;
}

/** GET /wp/v2/global-styles/{id} */
export interface RestGlobalStyles extends GlobalStylesConfig {
  id: number;
  title: { raw: string; rendered: string };
  _links?: Record<string, { href: string; count?: number }[]>;
}

/** GET /wp/v2/global-styles/themes/{stylesheet}/variations, one item. */
export interface StyleVariation extends GlobalStylesConfig {
  title?: string;
  slug?: string;
  description?: string;
}

/** GET /wp/v2/global-styles/{id}/revisions, one item. */
export interface GlobalStylesRevision extends GlobalStylesConfig {
  id: number;
  author: number;
  date: string;
  date_gmt: string;
  parent: number;
}

export interface PaletteColor {
  slug: string;
  name: string;
  color: string;
}

export interface FontFamily {
  slug: string;
  name: string;
  fontFamily: string;
  fontFace?: {
    src?: string | string[];
    fontFamily?: string;
    fontWeight?: string;
    fontStyle?: string;
  }[];
}

export interface FontSize {
  slug: string;
  name?: string;
  size: string;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T =>
  value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);

/* ------------------------------------------------------------ comparing */

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
export function configsEqual(a: GlobalStylesConfig, b: GlobalStylesConfig): boolean {
  return (['settings', 'styles'] as const).every(
    (key) => (isEmptyBranch(a[key]) && isEmptyBranch(b[key])) || jsonEqual(a[key], b[key]),
  );
}

/* ----------------------------------------------------------- variations */

function filterByProperties(object: Json, properties: string[]): Json {
  if (!isObject(object)) return object;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(object)) {
    if (properties.includes(key)) out[key] = clone(value);
    else if (isObject(value)) {
      const filtered = filterByProperties(value, properties);
      if (Object.keys(filtered).length) out[key] = filtered;
    }
  }
  return out;
}

function removeProperties(object: Json, properties: string[]): Json {
  if (!isObject(object)) return object;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(object)) {
    if (properties.includes(key)) continue;
    out[key] = isObject(value) ? removeProperties(value, properties) : clone(value);
  }
  return out;
}

/** mergeBaseAndUserConfigs(): deep merge, lists replaced. */
export function mergeConfigs<T extends GlobalStylesConfig>(
  base: T,
  incoming: GlobalStylesConfig,
): T {
  const merge = (a: Json, b: Json): Json => {
    if (isObject(a) && isObject(b)) {
      const out: JsonObject = { ...clone(a) };
      for (const [key, value] of Object.entries(b)) {
        if (value !== undefined) out[key] = merge(out[key], value);
      }
      return out;
    }
    return clone(b);
  };
  return merge(base, incoming);
}

export type VariationKind = 'full' | 'color' | 'typography';
const KIND_PROPERTIES: Record<Exclude<VariationKind, 'full'>, string[]> = {
  color: ['color'],
  typography: ['typography'],
};

function hasOnly(variation: GlobalStylesConfig, properties: string[]): boolean {
  const filtered = filterByProperties(
    { settings: variation.settings ?? {}, styles: variation.styles ?? {} },
    properties,
  );
  return configsEqual(filtered, variation);
}

/** Which list the site editor shows a variation in. */
export function variationKind(variation: GlobalStylesConfig): VariationKind {
  if (isEmptyBranch(variation.settings) && isEmptyBranch(variation.styles)) return 'full';
  if (hasOnly(variation, KIND_PROPERTIES.color)) return 'color';
  if (hasOnly(variation, KIND_PROPERTIES.typography)) return 'typography';
  return 'full';
}

/**
 * Choosing a variation: a full one replaces the user's styles; a colour or
 * typography one replaces only those values, keeping everything else.
 */
export function applyVariation(
  user: GlobalStylesConfig,
  variation: GlobalStylesConfig,
): GlobalStylesConfig {
  const kind = variationKind(variation);
  if (kind === 'full') {
    return {
      version: 3,
      settings: clone(variation.settings ?? {}),
      styles: clone(variation.styles ?? {}),
    };
  }
  const kept = removeProperties(
    { settings: user.settings ?? {}, styles: user.styles ?? {} },
    KIND_PROPERTIES[kind],
  );
  return {
    version: 3,
    ...mergeConfigs(kept, { settings: variation.settings ?? {}, styles: variation.styles ?? {} }),
  };
}

/** The "Default" palette or pairing: the user's colour (or typography) values removed. */
export function removeKind(
  user: GlobalStylesConfig,
  kind: Exclude<VariationKind, 'full'>,
): GlobalStylesConfig {
  const kept = removeProperties(
    { settings: user.settings ?? {}, styles: user.styles ?? {} },
    KIND_PROPERTIES[kind],
  );
  return { version: 3, ...kept };
}

/** True when the user config has no colour (or typography) values of its own. */
export function hasNoKind(user: GlobalStylesConfig, kind: Exclude<VariationKind, 'full'>): boolean {
  const filtered = filterByProperties(
    { settings: user.settings ?? {}, styles: user.styles ?? {} },
    KIND_PROPERTIES[kind],
  );
  return Object.keys(filtered).length === 0;
}

/** True when everything the variation sets is set the same way in the user config. */
export function isVariationApplied(
  user: GlobalStylesConfig,
  variation: GlobalStylesConfig,
): boolean {
  const contains = (outer: Json, inner: Json): boolean =>
    isObject(inner)
      ? isObject(outer) && Object.entries(inner).every(([k, v]) => contains(outer[k], v))
      : jsonEqual(outer, inner);
  const branches = ['settings', 'styles'] as const;
  if (branches.every((b) => isEmptyBranch(variation[b]))) {
    return branches.every((b) => isEmptyBranch(user[b]));
  }
  return branches.every((b) => isEmptyBranch(variation[b]) || contains(user[b], variation[b]));
}

/* ------------------------------------------------------- reading values */

export function getPath(config: Json, path: readonly string[]): Json {
  let node = config;
  for (const key of path) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** Sets (or, with `undefined`, removes) a value, pruning branches left empty. */
export function setPath<T extends GlobalStylesConfig>(
  config: T,
  path: readonly string[],
  value: Json,
): T {
  const out = clone(config) ?? ({} as T);
  const set = (node: JsonObject, i: number): void => {
    const key = path[i] as string;
    if (i === path.length - 1) {
      if (value === undefined) delete node[key];
      else node[key] = clone(value);
      return;
    }
    if (!isObject(node[key])) {
      if (value === undefined) return;
      node[key] = {};
    }
    set(node[key], i + 1);
    if (value === undefined && Object.keys(node[key]).length === 0) delete node[key];
  };
  set(out as JsonObject, 0);
  return out;
}

/** A preset list from origin-keyed settings: the user's, else the theme's, else the defaults. */
function presets<T>(base: GlobalStylesConfig, user: GlobalStylesConfig, path: string[]): T[] {
  for (const config of [user, base]) {
    const value = getPath(config.settings, path);
    if (Array.isArray(value)) return value as T[];
    if (isObject(value)) {
      for (const origin of ['custom', 'theme']) {
        if (Array.isArray(value[origin])) return value[origin] as T[];
      }
    }
  }
  const value = getPath(base.settings, path);
  return isObject(value) && Array.isArray(value.default) ? (value.default as T[]) : [];
}

export const palette = (base: GlobalStylesConfig, user: GlobalStylesConfig) =>
  presets<PaletteColor>(base, user, ['color', 'palette']).filter(
    (c) => typeof c?.slug === 'string' && typeof c.color === 'string',
  );

export const fontFamilies = (base: GlobalStylesConfig, user: GlobalStylesConfig) =>
  presets<FontFamily>(base, user, ['typography', 'fontFamilies']).filter(
    (f) => typeof f?.slug === 'string' && typeof f.fontFamily === 'string',
  );

export const fontSizes = (base: GlobalStylesConfig, user: GlobalStylesConfig) =>
  presets<FontSize>(base, user, ['typography', 'fontSizes']).filter(
    (f) => typeof f?.slug === 'string' && typeof f.size === 'string',
  );

/** A style value: the user's, else the theme's. */
export function styleValue(
  base: GlobalStylesConfig,
  user: GlobalStylesConfig,
  path: readonly string[],
): string | undefined {
  for (const config of [user, base]) {
    const value = getPath(config.styles, path);
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return undefined;
}

/** A setting value: the user's, else the theme's. */
export function settingValue(
  base: GlobalStylesConfig,
  user: GlobalStylesConfig,
  path: readonly string[],
): string | undefined {
  for (const config of [user, base]) {
    const value = getPath(config.settings, path);
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return undefined;
}

/** `var:preset|color|base` or `var(--wp--preset--color--base)` → `base`. */
export function presetSlug(value: string | undefined, kind: string): string | undefined {
  if (!value) return undefined;
  const short = new RegExp(`^var:preset\\|${kind}\\|([\\w-]+)$`).exec(value);
  if (short) return short[1];
  return new RegExp(`^var\\(--wp--preset--${kind}--([\\w-]+)\\)$`).exec(value)?.[1];
}

export const presetRef = (kind: string, slug: string) => `var:preset|${kind}|${slug}`;

/** The colour a style value shows: a palette colour's value, or the value itself. */
export function resolveColor(
  value: string | undefined,
  colors: PaletteColor[],
): string | undefined {
  if (!value) return undefined;
  const slug = presetSlug(value, 'color');
  if (slug) return colors.find((c) => c.slug === slug)?.color;
  return value;
}

/** The CSS font-family a style value names. */
export function resolveFontFamily(
  value: string | undefined,
  families: FontFamily[],
): string | undefined {
  if (!value) return undefined;
  const slug = presetSlug(value, 'font-family');
  if (slug) return families.find((f) => f.slug === slug)?.fontFamily;
  return value;
}

/* -------------------------------------------------------------- editing */

/** Changes one palette colour; the whole list is stored, as the site editor does. */
export function setPaletteColor(
  user: GlobalStylesConfig,
  colors: PaletteColor[],
  slug: string,
  color: string,
): GlobalStylesConfig {
  const next = colors.map((c) => (c.slug === slug ? { ...c, color } : c));
  return setPath(user, ['settings', 'color', 'palette', 'theme'], next);
}

export type ColorRole = 'background' | 'text' | 'accent';

export const COLOR_ROLES: { role: ColorRole; label: string; hint: string }[] = [
  { role: 'background', label: 'Background', hint: 'Behind everything.' },
  { role: 'text', label: 'Text', hint: 'Body copy and headings.' },
  { role: 'accent', label: 'Accent', hint: 'Buttons and links.' },
];

/** Where each role reads its colour from. */
export const ROLE_PATHS: Record<ColorRole, string[]> = {
  background: ['color', 'background'],
  text: ['color', 'text'],
  accent: ['elements', 'button', 'color', 'background'],
};

/** WCAG relative luminance of a #rgb / #rrggbb(aa) colour, or undefined. */
export function luminance(color: string | undefined): number | undefined {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color?.trim() ?? '')?.[1];
  if (!hex || ![3, 4, 6, 8].includes(hex.length)) return undefined;
  const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two colours, or undefined if either can't be read. */
export function contrastRatio(a: string | undefined, b: string | undefined): number | undefined {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === undefined || lb === undefined) return undefined;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Gives a role a colour: a palette slug (stored as a preset reference) or a
 * custom value. The accent colours buttons and links; the button's text gets
 * whichever of the background and text colours reads best on it.
 */
export function setRoleColor(
  base: GlobalStylesConfig,
  user: GlobalStylesConfig,
  role: ColorRole,
  value: string,
): GlobalStylesConfig {
  if (role !== 'accent') return setPath(user, ['styles', ...ROLE_PATHS[role]], value);
  const colors = palette(base, user);
  let next = setPath(user, ['styles', 'elements', 'button', 'color', 'background'], value);
  next = setPath(next, ['styles', 'elements', 'link', 'color', 'text'], value);
  const slug = presetSlug(value, 'color');
  const cssValue = slug ? `var(--wp--preset--color--${slug})` : value;
  next = setPath(
    next,
    ['styles', 'elements', 'button', ':hover', 'color', 'background'],
    `color-mix(in srgb, ${cssValue} 85%, transparent)`,
  );
  const accent = resolveColor(value, colors);
  const candidates = (['background', 'text'] as const)
    .map((r) => styleValue(base, next, ROLE_PATHS[r]))
    .filter((v): v is string => Boolean(v));
  const best = candidates
    .map((candidate) => ({
      candidate,
      ratio: contrastRatio(accent, resolveColor(candidate, colors)) ?? 0,
    }))
    .sort((a, b) => b.ratio - a.ratio)[0];
  if (best) {
    next = setPath(next, ['styles', 'elements', 'button', 'color', 'text'], best.candidate);
    next = setPath(
      next,
      ['styles', 'elements', 'button', ':hover', 'color', 'text'],
      best.candidate,
    );
  }
  return next;
}

/** Body and heading fonts, as preset references. */
export function setFont(
  user: GlobalStylesConfig,
  target: 'body' | 'heading',
  slug: string,
): GlobalStylesConfig {
  const path =
    target === 'body'
      ? ['styles', 'typography', 'fontFamily']
      : ['styles', 'elements', 'heading', 'typography', 'fontFamily'];
  return setPath(user, path, presetRef('font-family', slug));
}

/** A CSS length in px, rem or em → px (16px root), or undefined. */
export function lengthToPx(value: string | undefined): number | undefined {
  const match = /^\s*([\d.]+)\s*(px|rem|em)?\s*$/.exec(value ?? '');
  if (!match) return undefined;
  const n = Number(match[1]);
  return match[2] === 'rem' || match[2] === 'em' ? n * 16 : n;
}

/** Accepts the CSS lengths the layout and size fields allow. */
export const CSS_LENGTH = /^\d+(\.\d+)?(px|rem|em|%|vw|ch)$/;

/** The theme.json `fontFace` declarations of these families as @font-face rules (for previews). */
export function fontFaceCss(families: FontFamily[], themeUrl: string): string {
  const rules = new Set<string>();
  for (const family of families) {
    for (const face of family.fontFace ?? []) {
      const sources = (Array.isArray(face.src) ? face.src : [face.src])
        .filter((s): s is string => typeof s === 'string')
        .map((s) => (s.startsWith('file:./') ? `${themeUrl}/${s.slice(7)}` : s))
        .filter((s) => /^(https?:\/\/|\/)[^"'()\\\s]+$/.test(s));
      const name = (face.fontFamily ?? family.name).replace(/["\\]/g, '');
      if (!sources.length || !name) continue;
      const weight = /^[\d ]+$/.test(face.fontWeight ?? '') ? face.fontWeight : '400';
      const style = face.fontStyle === 'italic' ? 'italic' : 'normal';
      rules.add(
        `@font-face{font-family:"${name}";font-style:${style};font-weight:${weight};font-display:swap;src:${sources
          .map((s) => `url("${s}")`)
          .join(',')};}`,
      );
    }
  }
  return [...rules].join('\n');
}
