/**
 * @pressbase/theme-json — WordPress's theme.json engine (WP_Theme_JSON,
 * WP_Theme_JSON_Resolver, wp_get_global_stylesheet(), fluid typography,
 * the layout block support's styles and @font-face output). Pure: no file
 * system, no database. See docs/architecture/themes.md.
 */
export { blockElementSelectors, blockRootSelector, getBlocksMetadata } from './blocks-metadata';
export {
  ELEMENTS,
  LAYOUT_DEFINITIONS,
  type LayoutDefinition,
  PRESETS_METADATA,
} from './constants';
export { CORE_BLOCK_STYLE_METADATA } from './data/core-blocks';
export { WORDPRESS_THEME_JSON } from './data/wordpress-theme-json';
export { fontFaceCss } from './fonts';
export {
  type CssRule,
  getChildLayoutStyle,
  getLayoutStyle,
  type LayoutStyleInput,
  spacingValue,
  stylesheetFromRules,
} from './layout';
export {
  blockStyleVariationInstanceStyles,
  type GlobalStylesheetOptions,
  getGlobalStylesheet,
  partialVariationName,
  type ResolvedThemeJson,
  type ResolveInput,
  resolveThemeJson,
  type ThemeJsonPartial,
} from './resolver';
export {
  appendToSelector,
  blockStyleVariationSelector,
  prependToSelector,
  scopeSelector,
  splitSelectorList,
} from './selectors';
export { computeSpacingSizes, supportsLayout, ThemeJson } from './theme-json';
export type * from './types';
export {
  computedFluidTypographyValue,
  typographyFontSizeValue,
  typographyValueAndUnit,
} from './typography';
export { arrayGet, convertCustomProperties, isObject, toKebabCase } from './util';
