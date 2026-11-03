/**
 * Curated font pairs. Every font is either bundled with the Pressbase theme
 * (SIL Open Font License, served from the site) or a system font stack
 * (fonts already on the visitor's device; the stacks are from Modern Font
 * Stacks, CC0). Nothing is fetched from Google or any other font service.
 */

export interface DesignFont {
  /** The font family preset's slug (`var:preset|font-family|{slug}`). */
  slug: string;
  name: string;
  /** The CSS `font-family` value. */
  fontFamily: string;
  /**
   * `theme`: a font file the Pressbase theme bundles and declares, so the
   * pair needs that theme (or one declaring the same slug). `system`: a
   * stack of fonts installed on devices; it's added to the site's fonts.
   */
  source: 'theme' | 'system';
  /** The font's licence (SPDX), or the stack's for system stacks. */
  license: string;
}

const SYSTEM_STACK_LICENSE = 'CC0-1.0';

export const FONTS = {
  platypi: {
    slug: 'platypi',
    name: 'Platypi',
    fontFamily: 'Platypi, "Platypi Fallback", ui-serif, Georgia, serif',
    source: 'theme',
    license: 'OFL-1.1',
  },
  manrope: {
    slug: 'manrope',
    name: 'Manrope',
    fontFamily: 'Manrope, "Manrope Fallback", ui-sans-serif, system-ui, sans-serif',
    source: 'theme',
    license: 'OFL-1.1',
  },
  'system-sans': {
    slug: 'system-sans',
    name: 'System sans',
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif',
    source: 'system',
    license: SYSTEM_STACK_LICENSE,
  },
  humanist: {
    slug: 'humanist',
    name: 'Humanist',
    fontFamily:
      'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif',
    source: 'system',
    license: SYSTEM_STACK_LICENSE,
  },
  'geometric-humanist': {
    slug: 'geometric-humanist',
    name: 'Geometric humanist',
    fontFamily: 'Avenir, Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif',
    source: 'system',
    license: SYSTEM_STACK_LICENSE,
  },
  rounded: {
    slug: 'rounded',
    name: 'Rounded',
    fontFamily:
      'ui-rounded, "Hiragino Maru Gothic ProN", Quicksand, Comfortaa, Manjari, "Arial Rounded MT", "Arial Rounded MT Bold", Calibri, source-sans-pro, sans-serif',
    source: 'system',
    license: SYSTEM_STACK_LICENSE,
  },
  industrial: {
    slug: 'industrial',
    name: 'Industrial',
    fontFamily:
      'Bahnschrift, "DIN Alternate", "Franklin Gothic Medium", "Nimbus Sans Narrow", sans-serif-condensed, sans-serif',
    source: 'system',
    license: SYSTEM_STACK_LICENSE,
  },
  transitional: {
    slug: 'transitional',
    name: 'Transitional',
    fontFamily: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif',
    source: 'system',
    license: SYSTEM_STACK_LICENSE,
  },
  'old-style': {
    slug: 'old-style',
    name: 'Old style',
    fontFamily: '"Iowan Old Style", "Palatino Linotype", "URW Palladio L", P052, serif',
    source: 'system',
    license: SYSTEM_STACK_LICENSE,
  },
  didone: {
    slug: 'didone',
    name: 'Didone',
    fontFamily: 'Didot, "Bodoni MT", "Noto Serif Display", "URW Palladio L", P052, Sylfaen, serif',
    source: 'system',
    license: SYSTEM_STACK_LICENSE,
  },
  'slab-serif': {
    slug: 'slab-serif',
    name: 'Slab serif',
    fontFamily: 'Rockwell, "Rockwell Nova", "Roboto Slab", "DejaVu Serif", "Sitka Small", serif',
    source: 'system',
    license: SYSTEM_STACK_LICENSE,
  },
} as const satisfies Record<string, DesignFont>;

export interface FontPair {
  id: string;
  label: string;
  /** What it suits, for people choosing and for the model's schema. */
  description: string;
  heading: DesignFont;
  body: DesignFont;
}

/** The curated pairs, the Pressbase theme's own first. */
export const FONT_PAIRS = [
  {
    id: 'platypi-manrope',
    label: 'Platypi and Manrope',
    description: 'A warm, crisp serif for headings over a clean sans. Friendly and modern.',
    heading: FONTS.platypi,
    body: FONTS.manrope,
  },
  {
    id: 'manrope',
    label: 'Manrope',
    description: 'One geometric sans throughout. Product, tech and studio sites.',
    heading: FONTS.manrope,
    body: FONTS.manrope,
  },
  {
    id: 'platypi-system',
    label: 'Platypi and system sans',
    description: 'Platypi headings over the device’s own sans. Fast and readable.',
    heading: FONTS.platypi,
    body: FONTS['system-sans'],
  },
  {
    id: 'transitional-humanist',
    label: 'Transitional and humanist',
    description: 'A sturdy book serif over a humanist sans. Professional services, law, health.',
    heading: FONTS.transitional,
    body: FONTS.humanist,
  },
  {
    id: 'old-style',
    label: 'Old style',
    description: 'A classic text serif throughout. Writers, publishers, restaurants.',
    heading: FONTS['old-style'],
    body: FONTS['old-style'],
  },
  {
    id: 'didone-humanist',
    label: 'Didone and humanist',
    description: 'High-contrast display serif over a soft sans. Fashion, beauty, events.',
    heading: FONTS.didone,
    body: FONTS.humanist,
  },
  {
    id: 'geometric',
    label: 'Geometric',
    description: 'A geometric sans for headings over the system sans. Agencies, architecture.',
    heading: FONTS['geometric-humanist'],
    body: FONTS['system-sans'],
  },
  {
    id: 'rounded',
    label: 'Rounded',
    description: 'Rounded headings over the system sans. Schools, children, playful brands.',
    heading: FONTS.rounded,
    body: FONTS['system-sans'],
  },
  {
    id: 'industrial',
    label: 'Industrial',
    description: 'Condensed, sign-like headings over a humanist sans. Trades, gyms, workshops.',
    heading: FONTS.industrial,
    body: FONTS.humanist,
  },
  {
    id: 'slab-humanist',
    label: 'Slab and humanist',
    description: 'A sturdy slab serif over a humanist sans. Cafés, craft, local shops.',
    heading: FONTS['slab-serif'],
    body: FONTS.humanist,
  },
] as const satisfies readonly FontPair[];

export type FontPairId = (typeof FONT_PAIRS)[number]['id'];
export const FONT_PAIR_IDS = FONT_PAIRS.map((pair) => pair.id) as FontPairId[];

export function fontPair(id: string): FontPair | undefined {
  return FONT_PAIRS.find((pair) => pair.id === id);
}

/**
 * The pairs a theme can show: system-stack fonts always, theme fonts only
 * when the theme declares a font family with that slug.
 */
export function availableFontPairs(themeFontSlugs: Iterable<string>): FontPair[] {
  const slugs = new Set(themeFontSlugs);
  return FONT_PAIRS.filter((pair) =>
    [pair.heading, pair.body].every((font) => font.source === 'system' || slugs.has(font.slug)),
  );
}
