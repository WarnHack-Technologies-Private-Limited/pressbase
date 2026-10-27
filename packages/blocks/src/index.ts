/**
 * @pressbase/blocks — the block engine: WordPress's parse_blocks(),
 * serialize_blocks(), WP_Block_Type_Registry, WP_Block and do_blocks(),
 * framework-agnostic. The host injects its hook bus and services; nothing
 * here touches a database.
 */
import type {} from '@pressbase/hooks';
import type { WPBlock } from './block';
import type { BlockContext, ParsedBlock } from './types';

export {
  type FilterHooks,
  type RenderOptions,
  renderBlock,
  renderBlocks,
  WPBlock,
} from './block';
export { ALLOWED_PROTOCOLS, escAttr, escHtml, escUrl, stripAllTags } from './escape';
export { hasBlocks, parseBlocks } from './parser';
export {
  type BlockStyle,
  type BlockSupports,
  BlockType,
  type BlockTypeArgs,
  BlockTypeRegistry,
  blockHasSupport,
  type RenderCallback,
} from './registry';
export { sanitizeValueFromSchema, validateValueFromSchema } from './schema';
export {
  getCommentDelimitedBlockContent,
  serializeBlock,
  serializeBlockAttributes,
  serializeBlocks,
  stripCoreBlockNamespace,
} from './serializer';
export {
  cssValue,
  getBlockDefaultClassname,
  getBlockWrapperAttributes,
  shouldSkipSerialization,
  toKebabCase,
  type WrapperAttributes,
} from './supports';
export type {
  AttributeSchema,
  BlockAttributes,
  BlockContext,
  ParsedBlock,
  SchemaType,
} from './types';

// The rendering filters, typed for HookBus users (see docs/architecture/hooks.md).
declare module '@pressbase/hooks' {
  interface FilterRegistry {
    pre_render_block: [
      preRender: string | null,
      parsedBlock: ParsedBlock,
      parentBlock: WPBlock<unknown> | null,
    ];
    render_block_data: [
      parsedBlock: ParsedBlock,
      sourceBlock: ParsedBlock,
      parentBlock: WPBlock<unknown> | null,
    ];
    render_block_context: [
      context: BlockContext,
      parsedBlock: ParsedBlock,
      parentBlock: WPBlock<unknown> | null,
    ];
    render_block: [content: string, parsedBlock: ParsedBlock, block: WPBlock<unknown>];
  }
}
