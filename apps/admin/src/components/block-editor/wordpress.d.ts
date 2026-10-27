/**
 * @wordpress/block-editor and @wordpress/block-library ship without types in
 * their package exports. These declarations cover what Pressbase uses.
 */

declare module '@wordpress/block-editor' {
  import type { Block as BlockInstance } from '@wordpress/blocks';
  import type { StoreDescriptor } from '@wordpress/data';
  import type { ComponentType, ReactNode, Ref } from 'react';

  export const store: StoreDescriptor;

  export interface BlockEditorSelection {
    selectionStart?: unknown;
    selectionEnd?: unknown;
    initialPosition?: number | null;
  }

  export const BlockEditorProvider: ComponentType<{
    value: BlockInstance[];
    selection?: BlockEditorSelection;
    onInput?: (blocks: BlockInstance[], options: { selection: BlockEditorSelection }) => void;
    onChange?: (blocks: BlockInstance[], options: { selection: BlockEditorSelection }) => void;
    settings?: Record<string | symbol, unknown>;
    useSubRegistry?: boolean;
    children?: ReactNode;
  }>;
  export const BlockCanvas: ComponentType<{
    height?: string;
    styles?: { css: string }[];
    children?: ReactNode;
  }>;
  export const BlockList: ComponentType<{ className?: string }>;
  export const BlockInspector: ComponentType;
  export const BlockBreadcrumb: ComponentType<{ rootLabelText?: string }>;
  export const __experimentalLibrary: ComponentType<{
    rootClientId?: string;
    clientId?: string;
    showInserterHelpPanel?: boolean;
    showMostUsedBlocks?: boolean;
    shouldFocusBlock?: boolean;
    onSelect?: () => void;
    onClose?: () => void;
    ref?: Ref<unknown>;
  }>;
  export const __experimentalListView: ComponentType<{
    id?: string;
    showBlockMovers?: boolean;
    isExpanded?: boolean;
    description?: string;
  }>;
  export function useBlockProps(props?: Record<string, unknown>): Record<string, unknown>;
}

declare module '@wordpress/block-library' {
  export function registerCoreBlocks(blocks?: unknown[]): void;
}
