'use client';

import { createElement, forwardRef } from 'react';
import { BlockBridge, type ClientBlockSettings } from '@/lib/extensions/blocks';

/**
 * `window.pressbase.blocks`: Gutenberg's registerBlockType() and what an edit
 * function needs, without plugins bundling Gutenberg (ADR 0020).
 *
 * Gutenberg loads only with the editor, while plugin modules load on every
 * screen, so each member here is a stable delegate that looks the real piece
 * up when it's called or rendered. Destructuring at a module's top level is
 * fine; calling outside the editor throws a clear error.
 */

/** One bridge for the page's lifetime; the editor connects it to Gutenberg. */
export const blockBridge = new BlockBridge();

/** A hook (or function) of the editor's, looked up at call time. */
function lazyFunction(name: string) {
  const fn = (...args: unknown[]) => blockBridge.impl<(...a: unknown[]) => unknown>(name)(...args);
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

/** A component of the editor's, looked up at render time; `statics` too (`RichText.Content`). */
function lazyComponent(name: string, statics: string[] = []) {
  const component = forwardRef<unknown, Record<string, unknown>>((props, ref) =>
    createElement(blockBridge.impl<never>(name), { ...props, ref }),
  );
  component.displayName = name;
  for (const key of statics) {
    Object.defineProperty(component, key, {
      get: () => (blockBridge.impl<Record<string, unknown>>(name) as Record<string, unknown>)[key],
      enumerable: true,
    });
  }
  return component;
}

const useBlockProps = Object.assign(lazyFunction('useBlockProps'), {
  save: (...args: unknown[]) =>
    blockBridge.impl<{ save: (...a: unknown[]) => unknown }>('useBlockProps').save(...args),
});

export function createBlocksHostApi(ownerFor: (name: string) => string | null) {
  return Object.freeze({
    /**
     * Gutenberg's registerBlockType() for a block the plugin registered on the
     * server (`api.blocks.register()`): pass `edit` (and `save` for a static
     * block); the server's block.json fields are merged in.
     */
    registerBlockType: (name: string, settings: ClientBlockSettings) =>
      blockBridge.registerBlockType(name, settings, ownerFor(name)),
    /** @wordpress/block-editor */
    useBlockProps,
    useInnerBlocksProps: lazyFunction('useInnerBlocksProps'),
    InspectorControls: lazyComponent('InspectorControls'),
    BlockControls: lazyComponent('BlockControls'),
    RichText: lazyComponent('RichText', ['Content']),
    InnerBlocks: lazyComponent('InnerBlocks', [
      'Content',
      'ButtonBlockAppender',
      'DefaultBlockAppender',
    ]),
    /** A preview rendered on the server through /wp/v2/block-renderer (@wordpress/server-side-render). */
    ServerSideRender: lazyComponent('ServerSideRender'),
    /** A small set of @wordpress/components. */
    components: Object.freeze({
      PanelBody: lazyComponent('PanelBody'),
      TextControl: lazyComponent('TextControl'),
      ToggleControl: lazyComponent('ToggleControl'),
      SelectControl: lazyComponent('SelectControl'),
      Placeholder: lazyComponent('Placeholder'),
    }),
  });
}
