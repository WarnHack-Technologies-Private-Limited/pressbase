import {
  CONTRAST_MINIMUMS,
  type ContrastLevel,
  type ContrastUse,
  contrastRatio,
  type Oklch,
  oklchToHex,
} from './color';

/**
 * Palettes from a hue and a mood. The model (or a person) chooses the
 * direction; code chooses the colours, so every generated site passes WCAG
 * 2.2 AA (ADR 0024). Colours are built in OKLCH, where equal lightness looks
 * equally light across hues, converted to hex, then each text colour is
 * darkened (or, on a dark scheme, lightened) until every pair the theme uses
 * passes.
 */

/** The mood of a palette: how colourful its accent is, how tinted its paper, how far its second colour turns. */
export const MOODS = [
  'calm',
  'warm',
  'vibrant',
  'elegant',
  'earthy',
  'minimal',
  'playful',
] as const;
export type Mood = (typeof MOODS)[number];

export type ColorScheme = 'light' | 'dark';

/**
 * The slugs of the Pressbase theme's palette (themes/pressbase/theme.json),
 * so a generated palette restyles it and its style variations' patterns.
 * `violet` is the theme's name for its second brand colour (the end of the
 * accent gradient); a generated one may be any hue.
 */
export const PALETTE_SLUGS = [
  'base',
  'surface',
  'contrast',
  'muted',
  'border',
  'accent',
  'accent-text',
  'accent-soft',
  'on-accent',
  'violet',
] as const;
export type PaletteSlug = (typeof PALETTE_SLUGS)[number];

/** A theme.json palette entry (`settings.color.palette`). */
export interface PaletteEntry {
  name: string;
  slug: string;
  color: string;
}

const NAMES: Record<PaletteSlug, string> = {
  base: 'Base',
  surface: 'Surface',
  contrast: 'Contrast',
  muted: 'Muted',
  border: 'Border',
  accent: 'Accent',
  'accent-text': 'Accent text',
  'accent-soft': 'Accent soft',
  'on-accent': 'On accent',
  violet: 'Secondary',
};

/**
 * Every foreground/background pair the Pressbase theme and its patterns
 * draw, and what it's used for: body text on the page, on cards (`surface`)
 * and on soft sections; the page colours swapped (the Ink section style);
 * button text; links and pills; the accent and the gradient's second colour
 * as large text (marquee, italic heading accents) and focus rings.
 * `border` is decorative (separators) and has no minimum.
 */
export const PALETTE_PAIRS: readonly {
  text: PaletteSlug;
  background: PaletteSlug;
  use: ContrastUse;
}[] = [
  { text: 'contrast', background: 'base', use: 'text' },
  { text: 'contrast', background: 'surface', use: 'text' },
  { text: 'contrast', background: 'accent-soft', use: 'text' },
  { text: 'base', background: 'contrast', use: 'text' },
  { text: 'muted', background: 'base', use: 'text' },
  { text: 'muted', background: 'surface', use: 'text' },
  { text: 'muted', background: 'accent-soft', use: 'text' },
  { text: 'accent-text', background: 'base', use: 'text' },
  { text: 'accent-text', background: 'surface', use: 'text' },
  { text: 'accent-text', background: 'accent-soft', use: 'text' },
  { text: 'on-accent', background: 'accent', use: 'text' },
  { text: 'accent', background: 'base', use: 'large' },
  { text: 'accent', background: 'surface', use: 'large' },
  { text: 'violet', background: 'base', use: 'large' },
  { text: 'violet', background: 'surface', use: 'large' },
];

interface MoodRecipe {
  /** Accent chroma. */
  accent: number;
  /** Chroma of the page colours (their tint). */
  tint: number;
  /** Hue of the tint, when it isn't the accent's (warm paper, earthy cream). */
  tintHue?: number;
  /** How far the second colour's hue turns from the accent's, in degrees. */
  shift: number;
  /** Chroma of the second colour. */
  secondary: number;
}

const RECIPES: Record<Mood, MoodRecipe> = {
  calm: { accent: 0.11, tint: 0.008, shift: 35, secondary: 0.09 },
  warm: { accent: 0.15, tint: 0.014, tintHue: 75, shift: 30, secondary: 0.14 },
  vibrant: { accent: 0.22, tint: 0.01, shift: 60, secondary: 0.2 },
  elegant: { accent: 0.07, tint: 0.006, shift: 180, secondary: 0.05 },
  earthy: { accent: 0.1, tint: 0.018, tintHue: 85, shift: 40, secondary: 0.09 },
  minimal: { accent: 0.03, tint: 0.002, shift: 0, secondary: 0.03 },
  playful: { accent: 0.19, tint: 0.012, shift: 120, secondary: 0.18 },
};

/** Starting lightness of each colour per scheme, before contrast is enforced. */
const LIGHTNESS: Record<ColorScheme, Record<Exclude<PaletteSlug, 'on-accent'>, number>> = {
  light: {
    base: 0.975,
    surface: 0.995,
    contrast: 0.24,
    muted: 0.5,
    border: 0.9,
    accent: 0.58,
    'accent-text': 0.52,
    'accent-soft': 0.955,
    violet: 0.6,
  },
  dark: {
    base: 0.18,
    surface: 0.22,
    contrast: 0.96,
    muted: 0.75,
    border: 0.32,
    accent: 0.7,
    'accent-text': 0.8,
    'accent-soft': 0.28,
    violet: 0.72,
  },
};

export interface PaletteOptions {
  /** The accent's hue, 0–360 (any number; it wraps). */
  hue: number;
  mood: Mood;
  /** `standard`: WCAG AA. `high`: AAA for text (7:1). Default `standard`. */
  contrast?: ContrastLevel;
  /** Default `light`. */
  scheme?: ColorScheme;
}

const wrap = (hue: number) => ((hue % 360) + 360) % 360 || 0;

/**
 * The colour at `start`, made darker (`direction` -1) or lighter (+1) in
 * small steps until it has at least each minimum against each background.
 * Black or white end the search; against the light or dark page colours
 * this function is given, they always pass.
 */
function fit(start: Oklch, against: [string, number][], direction: 1 | -1): string {
  const color = { ...start };
  for (;;) {
    const hex = oklchToHex(color);
    if (against.every(([background, min]) => contrastRatio(hex, background) >= min)) return hex;
    color.l += direction * 0.005;
    if (color.l <= 0) return '#000000';
    if (color.l >= 1) return '#ffffff';
  }
}

/**
 * A theme.json palette (`settings.color.palette`) with the Pressbase
 * theme's slugs, from a hue and a mood. Every pair in {@link PALETTE_PAIRS}
 * passes the contrast level's minimums; checkPalette() verifies it.
 */
export function generatePalette(options: PaletteOptions): PaletteEntry[] {
  const recipe = RECIPES[options.mood];
  if (!recipe) throw new Error(`Unknown mood: ${String(options.mood)}`);
  if (!Number.isFinite(options.hue)) throw new Error('The hue must be a number of degrees.');
  const hue = wrap(options.hue);
  const scheme = options.scheme ?? 'light';
  const min = CONTRAST_MINIMUMS[options.contrast ?? 'standard'];
  const L = LIGHTNESS[scheme];
  // Text gets darker on a light page and lighter on a dark one.
  const away: 1 | -1 = scheme === 'light' ? -1 : 1;
  const tintHue = recipe.tintHue ?? hue;

  const base = oklchToHex({ l: L.base, c: recipe.tint, h: tintHue });
  const surface = oklchToHex({ l: L.surface, c: recipe.tint / 3, h: tintHue });
  const border = oklchToHex({ l: L.border, c: recipe.tint + 0.006, h: tintHue });
  const soft = oklchToHex({
    l: L['accent-soft'],
    c: Math.min(0.045, recipe.accent * 0.3),
    h: hue,
  });
  const pages = [base, surface, soft];
  const text = (start: Oklch) =>
    fit(
      start,
      pages.map((bg) => [bg, min.text]),
      away,
    );

  const contrast = text({ l: L.contrast, c: Math.min(0.03, recipe.tint * 2 + 0.01), h: tintHue });
  const muted = text({ l: L.muted, c: Math.min(0.03, recipe.tint + 0.012), h: tintHue });
  const accentText = text({ l: L['accent-text'], c: recipe.accent, h: hue });
  // Button text: white on a light scheme's accent, the dark page colour on a dark one's.
  const onAccent = scheme === 'light' ? '#ffffff' : base;
  const accent = fit(
    { l: L.accent, c: recipe.accent, h: hue },
    [
      [base, min.large],
      [surface, min.large],
      [onAccent, min.text],
    ],
    away,
  );
  const violet = fit(
    { l: L.violet, c: recipe.secondary, h: wrap(hue + recipe.shift) },
    [
      [base, min.large],
      [surface, min.large],
    ],
    away,
  );

  const colors: Record<PaletteSlug, string> = {
    base,
    surface,
    contrast,
    muted,
    border,
    accent,
    'accent-text': accentText,
    'accent-soft': soft,
    'on-accent': onAccent,
    violet,
  };
  return PALETTE_SLUGS.map((slug) => ({ name: NAMES[slug], slug, color: colors[slug] }));
}

export interface ContrastFailure {
  text: string;
  background: string;
  use: ContrastUse;
  ratio: number;
  min: number;
}

/**
 * The pairs of {@link PALETTE_PAIRS} (or `pairs`) below the level's
 * minimums. Pairs whose colours the palette lacks are skipped.
 */
export function checkPalette(
  palette: readonly PaletteEntry[],
  level: ContrastLevel = 'standard',
  pairs: readonly { text: string; background: string; use: ContrastUse }[] = PALETTE_PAIRS,
): ContrastFailure[] {
  const color = new Map(palette.map((entry) => [entry.slug, entry.color]));
  const failures: ContrastFailure[] = [];
  for (const pair of pairs) {
    const fg = color.get(pair.text);
    const bg = color.get(pair.background);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    const min = CONTRAST_MINIMUMS[level][pair.use];
    if (ratio < min) failures.push({ ...pair, ratio, min });
  }
  return failures;
}
