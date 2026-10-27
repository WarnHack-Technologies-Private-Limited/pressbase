import type { BlockAttributes, ParsedBlock } from './types';

/**
 * Block serialisation — serialize_block_attributes(), strip_core_block_namespace(),
 * get_comment_delimited_block_content(), serialize_block() and serialize_blocks()
 * (wordpress/wp-includes/blocks.php). serializeBlocks(parseBlocks(x)) === x
 * for any content WordPress itself would have saved.
 */

const ATTRIBUTE_ESCAPES: Record<string, string> = {
  '\\\\': '\\u005c',
  '\\"': '\\u0022',
  '--': '\\u002d\\u002d',
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/**
 * serialize_block_attributes(): JSON that can sit safely inside an HTML
 * comment. `--`, `<`, `>`, `&`, `\\` and escaped quotes become unicode escapes,
 * so the comment can never be closed early and the markup stays valid.
 */
export function serializeBlockAttributes(attributes: BlockAttributes): string {
  return JSON.stringify(attributes).replace(
    /\\\\|\\"|--|[<>&\u2028\u2029]/g,
    (match) => ATTRIBUTE_ESCAPES[match] ?? match,
  );
}

/** strip_core_block_namespace(): `core/paragraph` → `paragraph`. */
export function stripCoreBlockNamespace(blockName: string): string {
  return blockName.startsWith('core/') ? blockName.slice(5) : blockName;
}

/** get_comment_delimited_block_content() */
export function getCommentDelimitedBlockContent(
  blockName: string | null,
  attributes: BlockAttributes | null | undefined,
  content: string,
): string {
  if (blockName === null) return content;
  const name = stripCoreBlockNamespace(blockName);
  const attrs =
    attributes && Object.keys(attributes).length > 0
      ? `${serializeBlockAttributes(attributes)} `
      : '';
  if (!content) return `<!-- wp:${name} ${attrs}/-->`;
  return `<!-- wp:${name} ${attrs}-->${content}<!-- /wp:${name} -->`;
}

/** serialize_block(): a parsed block back to markup, inner blocks included. */
export function serializeBlock(block: ParsedBlock): string {
  let content = '';
  let index = 0;
  for (const chunk of block.innerContent) {
    if (typeof chunk === 'string') content += chunk;
    else {
      const inner = block.innerBlocks[index++];
      if (inner) content += serializeBlock(inner);
    }
  }
  return getCommentDelimitedBlockContent(block.blockName, block.attrs, content);
}

/** serialize_blocks() */
export function serializeBlocks(blocks: ParsedBlock[]): string {
  return blocks.map(serializeBlock).join('');
}
