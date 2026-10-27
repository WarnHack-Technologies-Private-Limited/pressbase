import { useBlockProps } from '@wordpress/block-editor';
import { getBlockType, registerBlockType } from '@wordpress/blocks';
import { ServerSideRender } from '@wordpress/server-side-render';
import type { RestBlockType } from './features';

/**
 * Blocks the server knows but the browser doesn't (plugins' dynamic blocks)
 * get a generic editor: a server-side preview through /wp/v2/block-renderer.
 * This is what WordPress does with blocks registered only in PHP
 * (block-library's registerCoreBlocks, `__unstableAutoRegisterBlocks`).
 */

function ServerBlockEdit({
  name,
  attributes,
}: {
  name: string;
  attributes: Record<string, unknown>;
}) {
  const blockProps = useBlockProps();
  return (
    <div {...blockProps}>
      <ServerSideRender block={name} attributes={attributes} />
    </div>
  );
}

/** Registers every dynamic server block the browser lacks. Returns their names. */
export function registerServerBlocks(types: readonly RestBlockType[]): string[] {
  const added: string[] = [];
  for (const type of types) {
    if (!type.is_dynamic || getBlockType(type.name)) continue;
    const registered = registerBlockType(type.name, {
      apiVersion: 3,
      title: type.title || type.name,
      description: type.description,
      category: type.category || 'widgets',
      icon: type.icon || 'block-default',
      keywords: type.keywords,
      attributes: (type.attributes ?? {}) as never,
      supports: { ...type.supports, html: false },
      usesContext: [...new Set([...(type.uses_context ?? []), 'postId'])],
      parent: type.parent ?? undefined,
      ancestor: type.ancestor ?? undefined,
      edit: ServerBlockEdit as never,
      save: () => null,
    });
    if (registered) added.push(type.name);
  }
  return added;
}
