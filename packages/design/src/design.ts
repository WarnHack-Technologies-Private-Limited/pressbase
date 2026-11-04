import { CONTRAST_MINIMUMS, type ContrastLevel } from './color';
import { FONT_PAIR_IDS, FONT_PAIRS, type FontPairId, fontPair } from './fonts';
import { type ColorScheme, generatePalette, MOODS, type Mood, type PaletteEntry } from './palette';
import {
  blockGap,
  DENSITIES,
  type Density,
  RADII,
  type Radius,
  radiusPresets,
  spacingPresets,
} from './presets';

/**
 * A design direction: what the model (the plan's Design stage) or a person
 * chooses. Code turns it into colours and presets.
 */
export interface DesignChoice {
  mood: Mood;
  /** The accent's hue in degrees, 0–359. */
  hue: number;
  contrast: ContrastLevel;
  scheme: ColorScheme;
  fontPair: FontPairId;
  radius: Radius;
  density: Density;
}

/** A design ready to apply: a palette (generated, or adjusted by a person) and the preset choices. */
export interface Design {
  palette: PaletteEntry[];
  fontPair: FontPairId;
  radius: Radius;
  density: Density;
}

/** The JSON Schema of a {@link DesignChoice}, for `asJsonResponse()`. */
export const DESIGN_CHOICE_SCHEMA = {
  type: 'object',
  properties: {
    mood: {
      type: 'string',
      enum: [...MOODS],
      description: 'The feel of the colours: how colourful the accent is and how tinted the page.',
    },
    hue: {
      type: 'integer',
      minimum: 0,
      maximum: 359,
      description:
        'The accent colour as a hue in degrees: 0 red, 30 orange, 60 yellow, 140 green, 200 blue-green, 250 blue, 300 purple, 340 pink.',
    },
    contrast: {
      type: 'string',
      enum: Object.keys(CONTRAST_MINIMUMS),
      description: '`high` for audiences who need stronger contrast; otherwise `standard`.',
    },
    scheme: {
      type: 'string',
      enum: ['light', 'dark'],
      description: 'Light or dark pages.',
    },
    fontPair: {
      type: 'string',
      enum: [...FONT_PAIR_IDS],
      description: `Headings and body fonts. ${FONT_PAIRS.map((p) => `${p.id}: ${p.description}`).join(' ')}`,
    },
    radius: {
      type: 'string',
      enum: [...RADII],
      description: 'Corners of buttons, cards and images.',
    },
    density: {
      type: 'string',
      enum: [...DENSITIES],
      description: 'Space between and around sections.',
    },
  },
  required: ['mood', 'hue', 'contrast', 'scheme', 'fontPair', 'radius', 'density'],
  additionalProperties: false,
} as const;

/** The design for a choice: its palette generated from the hue and the mood. */
export function createDesign(choice: DesignChoice): Design {
  if (!fontPair(choice.fontPair)) throw new Error(`Unknown font pair: ${choice.fontPair}`);
  return {
    palette: generatePalette({
      hue: choice.hue,
      mood: choice.mood,
      contrast: choice.contrast,
      scheme: choice.scheme,
    }),
    fontPair: choice.fontPair,
    radius: choice.radius,
    density: choice.density,
  };
}

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
/** A JSON object, as theme.json data is typed in @pressbase/theme-json. */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** A user global styles document (the `wp_global_styles` post's content). */
export interface DesignGlobalStyles extends JsonObject {
  version: 3;
  isGlobalStylesUserThemeJSON: true;
  settings: JsonObject;
  styles: JsonObject;
}

const fontVar = (slug: string) => `var:preset|font-family|${slug}`;

/**
 * User global styles (`wp_global_styles`) that apply a design to the
 * Pressbase theme: its palette, corner and spacing presets replace the
 * theme's (presets keyed by the `theme` origin, as applying a style
 * variation does), system font stacks are added (`custom` origin), and the
 * body, headings, buttons, site title and quotes take the pair's fonts.
 * Merge it into the site's existing user styles to keep other changes.
 */
export function toGlobalStyles(design: Design): DesignGlobalStyles {
  const pair = fontPair(design.fontPair);
  if (!pair) throw new Error(`Unknown font pair: ${design.fontPair}`);
  const systemFonts = [pair.heading, pair.body]
    .filter((font, index, all) => font.source === 'system' && all.indexOf(font) === index)
    .map((font) => ({ name: font.name, slug: font.slug, fontFamily: font.fontFamily }));
  const heading = { typography: { fontFamily: fontVar(pair.heading.slug) } };
  const body = { typography: { fontFamily: fontVar(pair.body.slug) } };
  return {
    version: 3,
    isGlobalStylesUserThemeJSON: true,
    settings: {
      color: { palette: { theme: design.palette.map((entry) => ({ ...entry })) } },
      border: { radiusSizes: { theme: radiusPresets(design.radius).map((p) => ({ ...p })) } },
      spacing: { spacingSizes: { theme: spacingPresets(design.density).map((p) => ({ ...p })) } },
      ...(systemFonts.length ? { typography: { fontFamilies: { custom: systemFonts } } } : {}),
    },
    styles: {
      spacing: { blockGap: blockGap(design.density) },
      typography: body.typography,
      elements: { heading, button: body },
      blocks: {
        'core/site-title': heading,
        'core/pullquote': heading,
        'core/quote': { ...heading, elements: { cite: body } },
      },
    },
  };
}
