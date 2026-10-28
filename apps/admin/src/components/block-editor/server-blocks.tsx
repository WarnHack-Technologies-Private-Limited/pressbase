import {
  BlockControls,
  InnerBlocks,
  InspectorControls,
  RichText,
  useBlockProps,
  useInnerBlocksProps,
} from '@wordpress/block-editor';
import { getBlockType, registerBlockType, unregisterBlockType } from '@wordpress/blocks';
import {
  PanelBody,
  Placeholder,
  SelectControl,
  TextControl,
  ToggleControl,
} from '@wordpress/components';
import { createHigherOrderComponent } from '@wordpress/compose';
import { addFilter } from '@wordpress/hooks';
import { ServerSideRender } from '@wordpress/server-side-render';
import type { ComponentType } from 'react';
import { isPluginBlockName } from '@/lib/extensions/blocks';
import { useI18n } from '@/lib/i18n/context';
import { type AdminBlock, blockBridge, extensionStore, loadPluginModule } from '../extensions/host';
import { loadEditorFeatures, type RestBlockType } from './features';

/**
 * Blocks the server knows: plugins' blocks (ADR 0020).
 *
 * - A block with an editor module gets the module's `edit` (and `save`),
 *   merged with its server metadata by the block bridge
 *   (lib/extensions/blocks.ts).
 * - A dynamic block without one gets a generic editor: a server-side preview
 *   through /wp/v2/block-renderer. This is what WordPress does with blocks
 *   registered only in PHP (block-library's `__unstableAutoRegisterBlocks`).
 * - A block whose plugin is inactive parses as `core/missing`, which keeps
 *   its markup; it shows "This block's plugin is inactive".
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

/** Blocks registered here (not core's), which a module's late registration may replace. */
const registeredHere = new Set<string>();

function registrar(name: string, settings: Record<string, unknown>): boolean {
  if (getBlockType(name)) {
    if (!registeredHere.has(name)) return false;
    unregisterBlockType(name);
  }
  const registered = registerBlockType(name, settings as never);
  if (registered) registeredHere.add(name);
  return Boolean(registered);
}

/** Registers every server block the browser lacks. Returns their names. */
export function registerServerBlocks(types: readonly RestBlockType[]): string[] {
  return blockBridge.connect(types, registrar, ServerBlockEdit);
}

/** What `core/missing` shows for a plugin's block whose plugin isn't active. */
function InactivePluginBlock({ name }: { name: string }) {
  const { __ } = useI18n();
  const blockProps = useBlockProps();
  return (
    <div {...blockProps}>
      <Placeholder
        icon="admin-plugins"
        label={__('This block’s plugin is inactive', 'pressbase-admin')}
        instructions={__(
          '“%s” comes from a plugin that isn’t active, so it can’t be edited or shown on the site. It stays in the post as it is: activate the plugin to use it again.',
          'pressbase-admin',
        ).replace('%s', name)}
      />
    </div>
  );
}

let configured = false;

/**
 * Once per page: gives the bridge Gutenberg's pieces (for `pressbase.blocks`)
 * and replaces `core/missing`'s editor for plugin blocks.
 */
function configure() {
  if (configured) return;
  configured = true;
  blockBridge.provide({
    useBlockProps,
    useInnerBlocksProps,
    InspectorControls,
    BlockControls,
    RichText,
    InnerBlocks,
    ServerSideRender,
    PanelBody,
    TextControl,
    ToggleControl,
    SelectControl,
    Placeholder,
  });
  addFilter(
    'editor.BlockEdit',
    'pressbase/inactive-plugin-block',
    createHigherOrderComponent(
      (BlockEdit: ComponentType<Record<string, unknown>>) =>
        function PluginAwareBlockEdit(props: Record<string, unknown>) {
          const original = (props.attributes as { originalName?: unknown } | undefined)
            ?.originalName;
          if (props.name === 'core/missing' && isPluginBlockName(original)) {
            return <InactivePluginBlock name={original} />;
          }
          return <BlockEdit {...props} />;
        },
      'withInactivePluginBlocks',
    ),
  );
}

/**
 * Before the editor parses the post: imports active plugins' block editor
 * modules (one at a time, each attributed to its plugin), reads the server's
 * block types and registers plugin blocks, so saved plugin blocks parse as
 * themselves instead of being flagged invalid. A module that fails is
 * reported like any plugin module, and its blocks fall back to a preview.
 */
export async function preparePluginBlocks(blocks: readonly AdminBlock[]): Promise<void> {
  configure();
  const scripts = new Map<string, string>();
  for (const block of blocks) {
    if (block.editor_script && !extensionStore.isImported(block.editor_script))
      scripts.set(block.editor_script, block.plugin);
  }
  await Promise.all(
    [...scripts].map(([url, plugin]) =>
      loadPluginModule(plugin, url).catch((error) =>
        console.error(`[plugin:${plugin}] block editor module failed to load:`, error),
      ),
    ),
  );
  const features = await loadEditorFeatures();
  if (features.blockTypes) registerServerBlocks(features.blockTypes);
}
