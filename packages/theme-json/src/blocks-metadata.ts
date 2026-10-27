import { ELEMENTS } from './constants';
import { CORE_BLOCK_STYLE_METADATA } from './data/core-blocks';
import { blockStyleVariationSelector, prependToSelector, scopeSelector } from './selectors';
import type { BlockMetadata, BlockStyleMetadata, BlocksMetadata, JsonObject } from './types';
import { arrayGet, isObject } from './util';

/**
 * WP_Theme_JSON::get_blocks_metadata() and wp_get_block_css_selector()
 * (wordpress/wp-includes/global-styles-and-settings.php): each block's root,
 * feature and element selectors, worked out from its block.json.
 */

/** WP_Theme_JSON::BLOCK_SUPPORT_FEATURE_LEVEL_SELECTORS */
const FEATURE_LEVEL_SELECTORS: Record<string, string> = {
  __experimentalBorder: 'border',
  color: 'color',
  dimensions: 'dimensions',
  spacing: 'spacing',
  typography: 'typography',
};

/** wp_get_block_css_selector( $block_type, 'root' ) */
export function blockRootSelector(name: string, block: BlockStyleMetadata): string {
  const root = block.selectors?.root;
  if (typeof root === 'string') return root;
  const experimental = block.supports.__experimentalSelector;
  if (typeof experimental === 'string') return experimental;
  return `.wp-block-${name.replace('core/', '').replace('/', '-')}`;
}

/** wp_get_block_css_selector( $block_type, $feature ) without fallback. */
function featureSelector(block: BlockStyleMetadata, root: string, feature: string): string | null {
  if (block.selectors && Object.keys(block.selectors).length) {
    const nested = arrayGet(block.selectors, [feature, 'root']);
    if (typeof nested === 'string' && nested) return nested;
    const short = block.selectors[feature];
    return typeof short === 'string' ? short : null;
  }
  const experimental = arrayGet(block.supports, [feature, '__experimentalSelector'], null);
  if (typeof experimental !== 'string') return null;
  return scopeSelector(root, experimental);
}

/** get_block_selectors() */
function blockSelectors(block: BlockStyleMetadata, root: string): JsonObject {
  if (block.selectors && Object.keys(block.selectors).length) return block.selectors;
  const selectors: JsonObject = { root };
  for (const [key, feature] of Object.entries(FEATURE_LEVEL_SELECTORS)) {
    const selector = featureSelector(block, root, key);
    if (selector !== null) selectors[feature] = { root: selector };
  }
  return selectors;
}

/** get_block_element_selectors() */
export function blockElementSelectors(root: string): Record<string, string> {
  const blockSelectorsList = root.split(',');
  const out: Record<string, string> = {};
  for (const [name, elementSelector] of Object.entries(ELEMENTS)) {
    const parts: string[] = [];
    let exact = false;
    for (const selector of blockSelectorsList) {
      if (selector === elementSelector) {
        exact = true;
        break;
      }
      parts.push(prependToSelector(elementSelector, `${selector} `));
    }
    out[name] = exact ? elementSelector : parts.join(',');
  }
  return out;
}

/**
 * get_blocks_metadata(). `variations` adds style variations registered
 * outside block.json (register_block_style(), theme.json partials).
 */
export function getBlocksMetadata(
  blocks: Record<string, BlockStyleMetadata> = CORE_BLOCK_STYLE_METADATA,
  variations: Record<string, string[]> = {},
): BlocksMetadata {
  const out: BlocksMetadata = {};
  for (const [name, block] of Object.entries(blocks)) {
    const selector = blockRootSelector(name, block);
    const entry: BlockMetadata = {
      name,
      selector,
      selectors: blockSelectors(block, selector),
      elements: blockElementSelectors(selector),
      styleVariations: {},
      supports: block.supports,
    };
    const duotone = block.selectors ? arrayGet(block.selectors, ['filter', 'duotone']) : null;
    const legacyDuotone = arrayGet(block.supports, ['color', '__experimentalDuotone']);
    if (typeof duotone === 'string' && duotone) entry.duotone = duotone;
    else if (typeof legacyDuotone === 'string')
      entry.duotone = scopeSelector(selector, legacyDuotone);
    for (const style of [...(block.styles ?? []), ...(variations[name] ?? [])]) {
      entry.styleVariations[style] = blockStyleVariationSelector(style, selector);
    }
    if (block.selectors && isObject(block.selectors.states)) entry.states = block.selectors.states;
    out[name] = entry;
  }
  return out;
}
