import {
  availableFontPairs,
  CONTRAST_MINIMUMS,
  createDesign,
  DENSITIES,
  type DesignChoice,
  MOODS,
  RADII,
  toGlobalStyles,
} from '@pressbase/design';
import { type GlobalStylesConfig, mergeGlobalStylesConfigs } from '@pressbase/theme-json';
import { presetProblem } from '@pressbase/site-edits';
import { AbilityError } from '../abilities/registry';
import type { ChangesetData } from '../changesets/service';
import type { Kernel } from '../kernel';
import { decodeGlobalStyles, userGlobalStylesPost } from '../themes/global-styles';
import type { ActiveTheme } from '../themes/service';
import { findEntry } from './changeset';

/**
 * The design system for prompts (`core/get-design-system`) and changes to
 * user global styles (`core/update-global-styles`). The model chooses a
 * design direction or preset references; code makes the colours, so no raw
 * colour, CSS or URL is ever written by a model. See docs/architecture/site-abilities.md.
 */

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const get = (value: unknown, ...path: string[]): unknown => {
  let node = value;
  for (const key of path) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
};

/** The changeset's entry key for the active theme's global styles. */
export const globalStylesKey = (stylesheet: string) => `wp_global_styles:${stylesheet}`;

/** The user global styles as they stand: the changeset's, else the saved ones. */
export async function currentUserStyles(
  kernel: Kernel,
  stylesheet: string,
  data: ChangesetData,
): Promise<{ config: GlobalStylesConfig; fromChangeset: boolean }> {
  const entry = findEntry(data, [globalStylesKey(stylesheet)]);
  if (entry) return { config: entry.value as GlobalStylesConfig, fromChangeset: true };
  const post = await userGlobalStylesPost(kernel, stylesheet);
  return {
    config: post
      ? decodeGlobalStyles(post.content)
      : { version: 3, isGlobalStylesUserThemeJSON: true },
    fromChangeset: false,
  };
}

interface Preset {
  slug: string;
  name: string;
  [key: string]: unknown;
}

/**
 * The presets in effect at `path` of the merged settings: custom over
 * theme over default, by slug; WordPress's defaults only where the theme
 * keeps them (`defaultPalette`, `defaultFontSizes`…).
 */
function presets(settings: unknown, path: string[], defaultFlag: string | null, keep: string[]) {
  const value = get(settings, ...path);
  const bySlug = new Map<string, Preset>();
  const add = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!isObject(entry) || typeof entry.slug !== 'string') continue;
      const preset: Preset = {
        slug: entry.slug,
        name: typeof entry.name === 'string' ? entry.name : entry.slug,
      };
      for (const key of keep) {
        if (typeof entry[key] === 'string' || typeof entry[key] === 'number')
          preset[key] = entry[key];
      }
      bySlug.set(entry.slug, preset);
    }
  };
  if (Array.isArray(value)) add(value);
  else if (isObject(value)) {
    const parent = get(settings, ...path.slice(0, -1));
    if (!defaultFlag || get(parent, defaultFlag) !== false) add(value.default);
    add(value.theme);
    add(value.custom);
  }
  return [...bySlug.values()];
}

/** The top-level styles a prompt needs: colours, type, spacing and elements, without per-block styles. */
function compactStyles(styles: unknown): Json {
  if (!isObject(styles)) return {};
  const out: Json = {};
  for (const key of ['color', 'typography', 'spacing', 'border', 'dimensions']) {
    if (isObject(styles[key])) out[key] = styles[key];
  }
  const elements = get(styles, 'elements');
  if (isObject(elements)) {
    const kept: Json = {};
    for (const key of ['link', 'button', 'heading', 'h1', 'h2', 'h3', 'caption']) {
      if (isObject(elements[key])) kept[key] = elements[key];
    }
    out.elements = kept;
  }
  return out;
}

/** The font slugs a theme declares, for the font pairs it can show. */
function fontSlugs(settings: unknown): string[] {
  return presets(settings, ['typography', 'fontFamilies'], null, []).map((p) => p.slug);
}

export interface DesignSystem {
  theme: string;
  /** Whether it shows the open changeset's styles rather than the live ones. */
  from_changeset: boolean;
  palette: Preset[];
  gradients: Preset[];
  font_families: Preset[];
  font_sizes: Preset[];
  spacing_sizes: Preset[];
  shadows: Preset[];
  styles: Json;
  /** What `core/update-global-styles` takes as `design`. */
  design_options: {
    moods: string[];
    contrast: string[];
    scheme: string[];
    font_pairs: { id: string; label: string; description: string }[];
    radius: string[];
    density: string[];
  };
}

export function designSystem(theme: ActiveTheme, fromChangeset: boolean): DesignSystem {
  const settings = theme.themeJson.tree.getSettings();
  const raw = theme.themeJson.tree.getRawData();
  return {
    theme: theme.info.stylesheet,
    from_changeset: fromChangeset,
    palette: presets(settings, ['color', 'palette'], 'defaultPalette', ['color']),
    gradients: presets(settings, ['color', 'gradients'], 'defaultGradients', []),
    font_families: presets(settings, ['typography', 'fontFamilies'], null, []),
    font_sizes: presets(settings, ['typography', 'fontSizes'], 'defaultFontSizes', ['size']),
    spacing_sizes: presets(settings, ['spacing', 'spacingSizes'], 'defaultSpacingSizes', ['size']),
    shadows: presets(settings, ['shadow', 'presets'], 'defaultPresets', []),
    styles: compactStyles(raw.styles),
    design_options: {
      moods: [...MOODS],
      contrast: Object.keys(CONTRAST_MINIMUMS),
      scheme: ['light', 'dark'],
      font_pairs: availableFontPairs(fontSlugs(settings)).map(({ id, label, description }) => ({
        id,
        label,
        description,
      })),
      radius: [...RADII],
      density: [...DENSITIES],
    },
  };
}

const PRESET_LIST_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { slug: { type: 'string' }, name: { type: 'string' } },
    required: ['slug', 'name'],
  },
} as const;

export const DESIGN_SYSTEM_SCHEMA = {
  type: 'object',
  properties: {
    theme: { type: 'string', description: 'The active theme’s stylesheet.' },
    from_changeset: { type: 'boolean' },
    palette: PRESET_LIST_SCHEMA,
    gradients: PRESET_LIST_SCHEMA,
    font_families: PRESET_LIST_SCHEMA,
    font_sizes: PRESET_LIST_SCHEMA,
    spacing_sizes: PRESET_LIST_SCHEMA,
    shadows: PRESET_LIST_SCHEMA,
    styles: { type: 'object' },
    design_options: { type: 'object' },
  },
  required: [
    'theme',
    'from_changeset',
    'palette',
    'gradients',
    'font_families',
    'font_sizes',
    'spacing_sizes',
    'shadows',
    'styles',
    'design_options',
  ],
} as const;

/* ---------------------------------------------------------------- writing */

/**
 * Checks a styles change: no `css` (Additional CSS is never written by AI
 * in v1), and no raw colours, URLs or CSS in values: preset references
 * (`var:preset|color|accent`), sizes and keywords only. The check is
 * @pressbase/site-edits' presetProblem(), which the admin shares.
 */
export function assertPresetStyles(value: unknown, path = 'styles'): void {
  const problem = presetProblem(value, path);
  if (problem) {
    throw new AbilityError(
      'ability_invalid_input',
      `${inputPath(problem.path)}: ${problem.message.replace('such as var:preset|color|accent.', 'such as var:preset|color|accent (see core/get-design-system).')}`,
      400,
    );
  }
}

/** `input.styles.color` → `input[styles][color]`, as abilities name paths. */
const inputPath = (path: string) =>
  path.replace(/\.([^.[\]]+)/g, '[$1]');

/** Merges a change into styles: objects merge, `null` removes a key, anything else replaces. */
export function patchStyles(base: unknown, patch: Json): Json {
  const out: Json = isObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (isObject(value)) out[key] = patchStyles(out[key], value);
    else out[key] = value;
  }
  return out;
}

/**
 * User global styles with a design direction applied (its palette, fonts,
 * corners and spacing, as @pressbase/design writes them), merged over the
 * current ones so other changes stay. Refuses a font pair the theme can't show.
 */
export function applyDesign(
  theme: ActiveTheme,
  config: GlobalStylesConfig,
  choice: DesignChoice,
): GlobalStylesConfig {
  const allowed = availableFontPairs(fontSlugs(theme.themeJson.tree.getSettings()));
  if (!allowed.some((pair) => pair.id === choice.fontPair)) {
    throw new AbilityError(
      'ability_invalid_input',
      `input[design][fontPair]: the active theme can’t show “${choice.fontPair}”. Choose one of ${allowed.map((p) => p.id).join(', ')}.`,
      400,
    );
  }
  const design = toGlobalStyles(createDesign(choice));
  return mergeGlobalStylesConfigs(config, design as never);
}
