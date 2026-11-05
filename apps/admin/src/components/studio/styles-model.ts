/**
 * Studio's Styles panel (#46) and style book (#47): the site's design
 * system as a draft entry, per-block styles, corners, button sizes and the
 * style book's categories. Data and pure functions only, tested in
 * styles-model.test.ts. The panel edits the user's global styles (the
 * custom origin of theme.json) and saves them as the changeset entry
 * `wp_global_styles:{stylesheet}`, which core prepares as
 * POST /wp/v2/global-styles/{id} does. See docs/architecture/studio.md#styles.
 */

import {
  configsEqual,
  type GlobalStylesConfig,
  getPath,
  type Json,
  presetRef,
  presetSlug,
  setPath,
} from '../../lib/global-styles';
import { msgid } from '../../lib/i18n/locale';

/* ---------------------------------------------------------- the draft entry */

/** The changeset entry that holds the site's styles (changesets.md). */
export const stylesKey = (stylesheet: string) => `wp_global_styles:${stylesheet}`;

const isObject = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Settings and styles only: what an entry may hold (core refuses anything else). */
export function pickConfig(value: unknown): GlobalStylesConfig {
  const config = isObject(value) ? value : {};
  return {
    settings: isObject(config.settings) ? config.settings : {},
    styles: isObject(config.styles) ? config.styles : {},
  };
}

/** The entry the draft needs for these styles: none when they're what visitors see. */
export function stylesEntry(
  config: GlobalStylesConfig,
  live: GlobalStylesConfig,
): GlobalStylesConfig | null {
  return configsEqual(config, live) ? null : pickConfig(config);
}

/**
 * Whether a draft entry came from somewhere other than this panel (History
 * restoring a version, an AI edit, Publish or Discard), so the panel and the
 * canvas should take it up. The panel's own last value doesn't count.
 */
export function isForeignEntry(
  entry: unknown,
  local: GlobalStylesConfig,
  lastSent: GlobalStylesConfig | null,
): boolean {
  if (entry === undefined) return false;
  const config = pickConfig(entry);
  if (configsEqual(config, local)) return false;
  return !(lastSent && configsEqual(config, lastSent));
}

/* ------------------------------------------------------------ block styles */

/** What the Styles panel can change for a block type, from its `supports`. */
export interface BlockStyleSupports {
  text: boolean;
  background: boolean;
  link: boolean;
  fontFamily: boolean;
  fontSize: boolean;
  padding: boolean;
  radius: boolean;
  border: boolean;
  shadow: boolean;
}

/**
 * A block type's style supports, as WordPress reads them
 * (wp-includes/block-supports/*.php): `color` gives text and background
 * unless either is `false`; borders come from `__experimentalBorder` (or
 * `border`).
 */
export function blockStyleSupports(supports: Json): BlockStyleSupports {
  const s = isObject(supports) ? supports : {};
  const color = s.color;
  const colorOn = color === true || isObject(color);
  const typography = isObject(s.typography) ? s.typography : {};
  const spacing = isObject(s.spacing) ? s.spacing : {};
  const borderSupport = s.__experimentalBorder ?? s.border;
  const border = isObject(borderSupport) ? borderSupport : borderSupport === true ? {} : null;
  const borderAll = borderSupport === true;
  return {
    text: colorOn && !(isObject(color) && color.text === false),
    background: colorOn && !(isObject(color) && color.background === false),
    link: isObject(color) && color.link === true,
    fontFamily: Boolean(typography.__experimentalFontFamily ?? typography.fontFamily),
    fontSize: Boolean(typography.fontSize),
    padding: Boolean(spacing.padding),
    radius: Boolean(border && (borderAll || border.radius)),
    border: Boolean(border && (borderAll || border.width || border.color || border.style)),
    shadow: Boolean(s.shadow),
  };
}

/** Whether the panel has anything to offer for a block. */
export const hasStyleControls = (supports: BlockStyleSupports) =>
  Object.values(supports).some(Boolean);

/** Where a block's global styles live. */
export const blockPath = (name: string, ...path: string[]) => ['styles', 'blocks', name, ...path];

/**
 * Where a block's look comes from when its own styles don't say: the
 * elements WordPress styles it through (a Button is the `button` element, a
 * Heading the `heading` element), so the panel shows what the page shows.
 */
export const BLOCK_ELEMENTS: Readonly<Record<string, readonly string[]>> = {
  'core/button': ['elements', 'button'],
  'core/heading': ['elements', 'heading'],
};

/** Whether the user's styles change this block at all. */
export function hasBlockStyles(config: GlobalStylesConfig, name: string): boolean {
  const node = getPath(config, ['styles', 'blocks', name]);
  return isObject(node) && Object.keys(node).length > 0;
}

/** The block back to the theme's design. */
export function resetBlockStyles(config: GlobalStylesConfig, name: string): GlobalStylesConfig {
  return setPath(config, ['styles', 'blocks', name], undefined);
}

/** A padding preset on all four sides (spacing presets are `var:preset|spacing|{slug}`). */
export function setPadding(
  config: GlobalStylesConfig,
  path: readonly string[],
  slug: string | undefined,
): GlobalStylesConfig {
  if (!slug) return setPath(config, [...path, 'spacing', 'padding'], undefined);
  const value = presetRef('spacing', slug);
  return setPath(config, [...path, 'spacing', 'padding'], {
    top: value,
    right: value,
    bottom: value,
    left: value,
  });
}

/** The spacing preset used on every side, if it's one preset everywhere. */
export function paddingPreset(value: Json): string | undefined {
  if (!isObject(value)) return presetSlug(typeof value === 'string' ? value : undefined, 'spacing');
  const sides = ['top', 'right', 'bottom', 'left'].map((side) =>
    presetSlug(typeof value[side] === 'string' ? value[side] : undefined, 'spacing'),
  );
  return sides.every((s) => s && s === sides[0]) ? sides[0] : undefined;
}

/* --------------------------------------------------------------- presets */

export interface SizePreset {
  slug: string;
  name?: string;
  size: string;
}

export interface ShadowPreset {
  slug: string;
  name?: string;
  shadow: string;
}

/** A preset list keyed by origin: the user's, else the theme's, else WordPress's. */
function presetList<T>(base: GlobalStylesConfig, user: GlobalStylesConfig, path: string[]): T[] {
  for (const config of [user, base]) {
    const value = getPath(config.settings, path);
    if (Array.isArray(value)) return value as T[];
    if (isObject(value)) {
      for (const origin of ['custom', 'theme', 'default']) {
        if (Array.isArray(value[origin])) return value[origin] as T[];
      }
    }
  }
  return [];
}

export const spacingSizes = (base: GlobalStylesConfig, user: GlobalStylesConfig) =>
  presetList<SizePreset>(base, user, ['spacing', 'spacingSizes']).filter(
    (s) => typeof s?.slug === 'string',
  );

export const radiusSizes = (base: GlobalStylesConfig, user: GlobalStylesConfig) =>
  presetList<SizePreset>(base, user, ['border', 'radiusSizes']).filter(
    (s) => typeof s?.slug === 'string' && typeof s.size === 'string',
  );

export const shadowPresets = (base: GlobalStylesConfig, user: GlobalStylesConfig) =>
  presetList<ShadowPreset>(base, user, ['shadow', 'presets']).filter(
    (s) => typeof s?.slug === 'string' && typeof s.shadow === 'string',
  );

/* ----------------------------------------------------------------- corners */

/**
 * Corners for the whole site: the theme's corner sizes (`border.radiusSizes`)
 * scaled together, so every card, image and button that uses them follows.
 * A size of 999px or more (a pill) stays a pill.
 */
export const CORNER_SCALES: readonly { id: string; label: string; factor: number }[] = [
  { id: 'square', label: msgid('Square'), factor: 0 },
  { id: 'subtle', label: msgid('Subtle'), factor: 0.5 },
  { id: 'theme', label: msgid('As designed'), factor: 1 },
  { id: 'round', label: msgid('Round'), factor: 1.75 },
];

const PILL = 999;

function scaleLength(size: string, factor: number): string {
  const match = /^\s*([\d.]+)\s*(px|rem|em|%)?\s*$/.exec(size);
  if (!match) return size;
  const n = Number(match[1]);
  const unit = match[2] ?? 'px';
  if (unit === 'px' && n >= PILL) return size;
  const scaled = Math.round(n * factor * 1000) / 1000;
  return scaled === 0 ? '0' : `${scaled}${unit}`;
}

/** Sets the site's corners to a scale of the theme's sizes; 1 goes back to the theme's. */
export function setCornerScale(
  base: GlobalStylesConfig,
  user: GlobalStylesConfig,
  factor: number,
): GlobalStylesConfig {
  const path = ['settings', 'border', 'radiusSizes'];
  if (factor === 1) return setPath(user, path, undefined);
  const theme = radiusSizes(base, {});
  return setPath(
    user,
    [...path, 'theme'],
    theme.map((s) => ({ ...s, size: scaleLength(s.size, factor) })),
  );
}

/** Which corner scale the user's styles use (`theme` when they don't change corners). */
export function cornerScale(
  base: GlobalStylesConfig,
  user: GlobalStylesConfig,
): string | undefined {
  const theme = radiusSizes(base, {});
  const current = radiusSizes(base, user);
  return CORNER_SCALES.find((scale) =>
    theme.every((s, i) => current[i]?.size === scaleLength(s.size, scale.factor)),
  )?.id;
}

/* ----------------------------------------------------------------- buttons */

export const BUTTON_PATH = ['styles', 'elements', 'button'] as const;

/** Button sizes, as their padding. The theme's own stays until one is chosen. */
export const BUTTON_SIZES: readonly { id: string; label: string; padding: Json }[] = [
  {
    id: 'small',
    label: msgid('Small'),
    padding: { top: '0.5rem', bottom: '0.5rem', left: '1rem', right: '1rem' },
  },
  {
    id: 'medium',
    label: msgid('Medium'),
    padding: { top: '0.75rem', bottom: '0.75rem', left: '1.5rem', right: '1.5rem' },
  },
  {
    id: 'large',
    label: msgid('Large'),
    padding: { top: '1rem', bottom: '1rem', left: '2.25rem', right: '2.25rem' },
  },
];

export function buttonSize(user: GlobalStylesConfig): string | undefined {
  const padding = getPath(user, [...BUTTON_PATH, 'spacing', 'padding']);
  return BUTTON_SIZES.find((s) => JSON.stringify(s.padding) === JSON.stringify(padding))?.id;
}

/**
 * A button colour. Hovering keeps it, slightly lighter, as Appearance →
 * Styles does (setRoleColor()), so the theme's own hover colour doesn't
 * snap back to the old one.
 */
export function setButtonColor(
  user: GlobalStylesConfig,
  which: 'background' | 'text',
  value: string | undefined,
): GlobalStylesConfig {
  let next = setPath(user, [...BUTTON_PATH, 'color', which], value);
  const slug = presetSlug(value, 'color');
  const css = slug ? `var(--wp--preset--color--${slug})` : value;
  const hover =
    value === undefined
      ? undefined
      : which === 'background'
        ? `color-mix(in srgb, ${css} 85%, transparent)`
        : value;
  next = setPath(next, [...BUTTON_PATH, ':hover', 'color', which], hover);
  return next;
}

/* ------------------------------------------------------------- the panel */

export type StylesScreen =
  | { id: 'home' }
  | { id: 'looks' }
  | { id: 'colors' }
  | { id: 'fonts' }
  | { id: 'spacing' }
  | { id: 'buttons' }
  | { id: 'blocks' }
  | { id: 'block'; name: string }
  | { id: 'css' };

/** The panel's screens, in order, and who sees them (mode-model.ts's controls). */
export const STYLES_SCREENS: readonly {
  id: Exclude<StylesScreen['id'], 'home' | 'block'>;
  label: string;
  summary: string;
  /** The mode-model control that shows it; none: every mode. */
  control?: string;
  /** Needs `edit_css` (Additional CSS). */
  css?: boolean;
}[] = [
  { id: 'looks', label: msgid('Looks'), summary: msgid('Complete designs from your theme') },
  { id: 'colors', label: msgid('Colours'), summary: msgid('Your palette, text and accent') },
  { id: 'fonts', label: msgid('Fonts'), summary: msgid('Headings, text and sizes') },
  {
    id: 'spacing',
    label: msgid('Spacing and corners'),
    summary: msgid('Room between blocks, page widths, rounded corners'),
  },
  { id: 'buttons', label: msgid('Buttons'), summary: msgid('Colour, size and shape') },
  {
    id: 'blocks',
    label: msgid('Blocks'),
    summary: msgid('How each kind of block looks everywhere'),
  },
  {
    id: 'css',
    label: msgid('Additional CSS'),
    summary: msgid('Your own CSS, added after the theme’s'),
    control: 'additional-css',
    css: true,
  },
];

/* ---------------------------------------------------------- the style book */

export interface StyleBookCategory {
  slug: string;
  title: string;
  /** The block categories (`category` in block.json) whose blocks it holds. */
  categories: readonly string[];
  /** Blocks shown first, in this order, from any category. */
  blocks: readonly string[];
}

/**
 * The style book's categories: WordPress's STYLE_BOOK_CATEGORIES
 * (@wordpress/editor) in plain words, each led by the blocks the Pressbase
 * patterns use most (headings, text, buttons, images, lists, separators,
 * quotes, questions and answers, columns and groups). Embeds are left out:
 * their examples load other sites.
 */
export const STYLE_BOOK_CATEGORIES: readonly StyleBookCategory[] = [
  {
    slug: 'text',
    title: msgid('Text'),
    categories: ['text'],
    blocks: [
      'core/heading',
      'core/paragraph',
      'core/list',
      'core/quote',
      'core/pullquote',
      'core/details',
      'core/table',
      'core/code',
    ],
  },
  {
    slug: 'buttons',
    title: msgid('Buttons and forms'),
    categories: [],
    blocks: ['core/buttons', 'core/search'],
  },
  {
    slug: 'media',
    title: msgid('Images and media'),
    categories: ['media'],
    blocks: ['core/image', 'core/gallery', 'core/cover', 'core/media-text'],
  },
  {
    slug: 'layout',
    title: msgid('Layout'),
    categories: ['design'],
    blocks: ['core/separator', 'core/columns', 'core/group', 'core/social-links'],
  },
  {
    slug: 'site',
    title: msgid('Site'),
    categories: ['theme'],
    blocks: ['core/site-title', 'core/site-tagline'],
  },
  { slug: 'widgets', title: msgid('Widgets'), categories: ['widgets'], blocks: [] },
];

/** The block whose styles an example opens: the Buttons example styles each Button. */
export function styleTarget(name: string): string {
  return name === 'core/buttons' ? 'core/button' : name;
}

/** What the style book needs to know about a registered block type. */
export interface StyleBookType {
  name: string;
  title: string;
  category?: string;
  /** It has an `example`. */
  example: boolean;
  /** `supports.inserter` isn't false. */
  inserter: boolean;
}

/**
 * The style book's sections: every block type WordPress's style book shows
 * (getExamples(): one with an example, offered in the inserter; Headings
 * are made for it), by category, the leading blocks first and the rest by
 * title. Empty sections are left out.
 */
export function styleBookSections(
  types: readonly StyleBookType[],
): { slug: string; title: string; blocks: string[] }[] {
  const shown = types.filter(
    (t) => t.inserter && (t.example || t.name === 'core/heading') && t.category !== 'embed',
  );
  const names = new Set(shown.map((t) => t.name));
  const placed = new Set<string>();
  const sections = STYLE_BOOK_CATEGORIES.map((category) => {
    const blocks = category.blocks.filter((name) => names.has(name) && !placed.has(name));
    for (const name of blocks) placed.add(name);
    return { category, blocks };
  });
  for (const section of sections) {
    const rest = shown
      .filter((t) => !placed.has(t.name) && section.category.categories.includes(t.category ?? ''))
      .sort((a, b) => a.title.localeCompare(b.title));
    for (const t of rest) placed.add(t.name);
    section.blocks.push(...rest.map((t) => t.name));
  }
  return sections
    .filter((section) => section.blocks.length > 0)
    .map(({ category, blocks }) => ({ slug: category.slug, title: category.title, blocks }));
}

/** A neutral picture for media examples, so the style book never loads images from elsewhere. */
export const EXAMPLE_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c9cbd6"/><stop offset="1" stop-color="#8d92ad"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="880" cy="250" r="110" fill="#eef0f6" opacity=".8"/><path d="M0 800 L380 380 L640 640 L820 470 L1200 800Z" fill="#5d6386" opacity=".75"/></svg>',
)}`;

/**
 * A block example's attributes for the style book: without its `style`
 * (instance styles would hide the global ones, as WordPress's style book
 * removes them) and with remote pictures swapped for EXAMPLE_IMAGE.
 */
export function exampleAttributes(attributes: Json): Json {
  if (!isObject(attributes)) return attributes;
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'style') continue;
    if (
      (key === 'url' || key === 'mediaUrl') &&
      typeof value === 'string' &&
      /^https?:/.test(value)
    ) {
      out[key] = EXAMPLE_IMAGE;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => exampleAttributes(item));
    } else out[key] = value;
  }
  return out;
}

/** An example's inner blocks, prepared the same way. */
export function exampleInnerBlocks(inner: Json): Json {
  if (!Array.isArray(inner)) return inner;
  return inner.map((block) =>
    isObject(block)
      ? {
          ...block,
          attributes: exampleAttributes(block.attributes),
          innerBlocks: exampleInnerBlocks(block.innerBlocks),
        }
      : block,
  );
}
