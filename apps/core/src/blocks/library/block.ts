import { type BlockAttributes, parseBlocks } from '@pressbase/blocks';
import type { CoreBlock } from '../helpers';

/**
 * core/block — a synced pattern reference. render_block_core_block()
 * (wordpress/wp-includes/blocks/block.php): renders the published `wp_block`
 * post's content in place, in this block's context. A pattern that contains
 * itself, directly or through other patterns, renders as nothing at the
 * point where it would repeat.
 */
export async function renderBlockReference(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const ref = Number(attributes.ref);
  if (!Number.isInteger(ref) || ref <= 0) return '';
  const pattern = await block.services.kernel.posts.get(ref);
  if (pattern?.type !== 'wp_block') return '';
  if (pattern.status !== 'publish' || pattern.password) return '';
  return block.withRecursionGuard(
    `core/block:${ref}`,
    () => block.renderInnerBlocks(parseBlocks(pattern.content)),
    '',
  );
}
