import { getBlocksMetadata } from './blocks-metadata';
import { CORE_BLOCK_STYLE_METADATA } from './data/core-blocks';
import { WORDPRESS_THEME_JSON } from './data/wordpress-theme-json';
import { fontFaceCss } from './fonts';
import { blockStyleVariationSelector } from './selectors';
import { ThemeJson } from './theme-json';
import type {
  BlockStyleMetadata,
  BlocksMetadata,
  JsonObject,
  JsonValue,
  ThemeJsonData,
} from './types';
import { arrayGet, arraySet, clone, isObject, toKebabCase } from './util';

/**
 * WP_Theme_JSON_Resolver (wordpress/wp-includes/class-wp-theme-json-resolver.php)
 * without the file system: the caller reads the theme's files and passes
 * them in. Origins merge in WordPress's order: default (core) → theme →
 * custom (user global styles).
 */

/** A theme.json partial from a theme's styles/ folder (style variation files). */
export interface ThemeJsonPartial extends ThemeJsonData {
  blockTypes?: JsonValue[];
}

export interface ResolveInput {
  /** The theme's theme.json (parent first, then child, already merged by the caller). */
  theme?: ThemeJsonData;
  /**
   * Block style variation partials (styles/blocks/*.json, styles/sections/*.json):
   * files whose `blockTypes` lists blocks. wp_register_block_style_variations_from_theme_json_partials().
   */
  blockStyleVariations?: ThemeJsonPartial[];
  /** User global styles (the `wp_global_styles` post), the custom origin. */
  user?: ThemeJsonData;
  /** Registered block types; defaults to WordPress's core blocks. */
  blocks?: Record<string, BlockStyleMetadata>;
  /** Style variations registered in code (register_block_style()), per block. */
  registeredStyles?: Record<string, string[]>;
}

export interface ResolvedThemeJson {
  tree: ThemeJson;
  blocks: BlocksMetadata;
  /** Style variation names per block, including those from partials. */
  variations: Record<string, string[]>;
}

/** The variation name of a partial: its slug, or its title in kebab case. */
export function partialVariationName(partial: ThemeJsonPartial): string | undefined {
  if (typeof partial.slug === 'string' && partial.slug) return partial.slug;
  if (typeof partial.title === 'string' && partial.title) return toKebabCase(partial.title);
  return undefined;
}

/** get_merged_data() */
export function resolveThemeJson(input: ResolveInput = {}): ResolvedThemeJson {
  const variations: Record<string, string[]> = {};
  const addVariation = (block: string, name: string) => {
    const list = variations[block] ?? [];
    if (!list.includes(name)) list.push(name);
    variations[block] = list;
  };
  for (const [block, names] of Object.entries(input.registeredStyles ?? {})) {
    for (const name of names) addVariation(block, name);
  }

  // inject_variations_from_block_style_variation_files()
  const theme = clone(input.theme ?? { version: 3 }) as ThemeJsonData;
  for (const partial of input.blockStyleVariations ?? []) {
    const name = partialVariationName(partial);
    if (!name || !Array.isArray(partial.blockTypes) || !isObject(partial.styles)) continue;
    for (const blockType of partial.blockTypes) {
      if (typeof blockType !== 'string') continue;
      addVariation(blockType, name);
      const path = ['styles', 'blocks', blockType, 'variations', name];
      if (arrayGet(theme, path) === undefined) arraySet(theme, path, clone(partial.styles));
    }
  }

  const blocks = getBlocksMetadata(input.blocks ?? CORE_BLOCK_STYLE_METADATA, variations);
  const tree = new ThemeJson(WORDPRESS_THEME_JSON, 'default', blocks);
  tree.merge(new ThemeJson(theme, 'theme', blocks));
  if (input.user) tree.merge(new ThemeJson(input.user, 'custom', blocks));
  return { tree, blocks, variations };
}

export interface GlobalStylesheetOptions {
  /** get_theme_file_uri() for `file:./` URLs in fontFace declarations. */
  resolveFileUri?: (relativePath: string) => string;
}

/**
 * wp_get_global_stylesheet() followed by the global styles' custom CSS, plus
 * the @font-face rules wp_print_font_faces() prints for theme.json fonts.
 */
export function getGlobalStylesheet(
  resolved: ResolvedThemeJson,
  options: GlobalStylesheetOptions = {},
): { stylesheet: string; customCss: string; fontFaces: string } {
  const origins = ['default', 'theme', 'custom'] as const;
  const variables = resolved.tree.getStylesheet(['variables'], origins);
  const rest = resolved.tree.getStylesheet(['styles', 'presets'], origins);
  const customCss = resolved.tree.getStylesheet(['custom-css'], origins);
  const fontFaces = fontFaceCss(
    arrayGet(resolved.tree.getSettings(), ['typography', 'fontFamilies']),
    options.resolveFileUri ?? ((p) => p),
  );
  return { stylesheet: variables + rest, customCss, fontFaces };
}

/**
 * wp_render_block_style_variation_support_styles(): the CSS for one block
 * instance using a style variation that styles inner elements or blocks,
 * scoped to its instance class (`is-style-section-1--3`). Returns '' when
 * the variation has no data.
 */
export function blockStyleVariationInstanceStyles(
  resolved: ResolvedThemeJson,
  blockName: string,
  variation: string,
  instance: string,
): string {
  const raw = resolved.tree.getRawData();
  const data = clone(arrayGet(raw, ['styles', 'blocks', blockName, 'variations', variation]));
  if (!isObject(data) || !Object.keys(data).length) return '';
  resolveRefs(data, raw);
  const elements = isObject(data.elements) ? data.elements : {};
  const blocksData: JsonObject = isObject(data.blocks) ? data.blocks : {};
  delete data.elements;
  delete data.blocks;
  arraySet(blocksData, [blockName, 'variations', instance], data);

  const blocks: BlocksMetadata = { ...resolved.blocks };
  const metadata = blocks[blockName];
  if (metadata) {
    blocks[blockName] = {
      ...metadata,
      styleVariations: {
        ...metadata.styleVariations,
        [instance]: blockStyleVariationSelector(instance, metadata.selector),
      },
    };
  }
  const config: ThemeJsonData = {
    version: 3,
    settings: { spacing: { blockGap: true } },
    styles: { elements, blocks: blocksData },
  };
  return new ThemeJson(config, 'blocks', blocks).getStylesheet(['styles'], ['custom'], {
    includeBlockStyleVariations: true,
    skipRootLayoutStyles: true,
    scope: `.is-style-${instance}`,
  });
}

/** wp_resolve_block_style_variation_ref_values() */
function resolveRefs(data: JsonObject, tree: JsonObject): void {
  for (const [key, value] of Object.entries(data)) {
    if (!isObject(value)) continue;
    if ('ref' in value) {
      const ref =
        typeof value.ref === 'string' && value.ref ? arrayGet(tree, value.ref.split('.')) : null;
      if (ref === null || ref === undefined) delete data[key];
      else data[key] = clone(ref) as JsonObject;
    } else resolveRefs(value, tree);
  }
}
