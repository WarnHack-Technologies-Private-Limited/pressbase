/**
 * @pressbase/design — the design generator for building sites (ADR 0024):
 * a mood and a hue become an accessible palette (OKLCH, every pair checked
 * against WCAG 2.2 AA), plus curated font pairs and corner and spacing
 * presets, written as user global styles. Pure functions, no I/O, so core,
 * the admin's live previews and the quality checks share them.
 *
 *   const design = createDesign({ mood: 'warm', hue: 30, contrast: 'standard',
 *     scheme: 'light', fontPair: 'slab-humanist', radius: 'rounded', density: 'comfortable' });
 *   checkPalette(design.palette);          // [] — always, for a generated palette
 *   const userStyles = toGlobalStyles(design);
 *
 * See docs/architecture/design-generator.md.
 */
export {
  CONTRAST_MINIMUMS,
  type ContrastLevel,
  type ContrastUse,
  contrastRatio,
  hexToOklch,
  type Oklch,
  oklchToHex,
  parseHex,
  relativeLuminance,
  toGamut,
} from './color';
export {
  createDesign,
  DESIGN_CHOICE_SCHEMA,
  type Design,
  type DesignChoice,
  type DesignGlobalStyles,
  type JsonObject,
  toGlobalStyles,
} from './design';
export {
  availableFontPairs,
  type DesignFont,
  FONT_PAIR_IDS,
  FONT_PAIRS,
  FONTS,
  type FontPair,
  type FontPairId,
  fontPair,
} from './fonts';
export {
  type ColorScheme,
  type ContrastFailure,
  checkPalette,
  generatePalette,
  MOODS,
  type Mood,
  PALETTE_PAIRS,
  PALETTE_SLUGS,
  type PaletteEntry,
  type PaletteOptions,
  type PaletteSlug,
} from './palette';
export {
  blockGap,
  DENSITIES,
  type Density,
  RADII,
  type Radius,
  type RadiusPreset,
  radiusPresets,
  type SpacingPreset,
  spacingPresets,
} from './presets';
