'use client';

/**
 * Gutenberg inside Pressbase. Loaded only on the post and page editors,
 * client-side (see ./index.tsx); everything WordPress-specific stays in this
 * folder. Wiring is documented in docs/architecture/block-editor.md.
 */

import {
  BlockCanvas,
  BlockEditorProvider,
  BlockInspector,
  BlockList,
  store as blockEditorStore,
  __experimentalLibrary as InserterLibrary,
  __experimentalListView as ListView,
} from '@wordpress/block-editor';
import { type Block as BlockInstance, parse, serialize } from '@wordpress/blocks';
import { Popover } from '@wordpress/components';
import { useStateWithHistory } from '@wordpress/compose';
import { useDispatch, useRegistry, useSelect } from '@wordpress/data';
// The editor's own toolbar uses WordPress's strings, translated with Gutenberg's (translations.ts).
import { __ } from '@wordpress/i18n';
import { ShortcutProvider } from '@wordpress/keyboard-shortcuts';
import { ListTree, Plus, Redo2, Undo2, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/button';
import styles from './block-editor.module.css';
import { countWords, readingMinutes } from './blocks';
import {
  EditorUiStylesheets,
  editorSettings,
  MediaCategories,
  NoticesBridge,
  type ResolvedAssets,
  resolvedAssets,
  saveEditedMenus,
  UndoShortcuts,
  useEditorFeatures,
  usePluginBlocks,
} from './kit';
import { EditorSkeleton } from './skeleton';

/* -------------------------------------------------------------------- types */

export interface BlockEditorHandle {
  /** The current content as block markup (serialize()). */
  getContent(): string;
  /** Parses block markup (`@wordpress/blocks` parse()), for plugins reading the blocks. */
  parse(markup: string): BlockInstance[];
  /** The initial content after one parse/serialize pass, to compare against. */
  baseline: string;
  /**
   * Saves navigation menus (`wp_navigation`) edited through a Navigation
   * block in this post, as WordPress's multi-entity save does.
   */
  saveMenus(): Promise<void>;
}

export interface BlockEditorProps {
  /** Block markup; parsed once when the editor mounts. Remount to replace it. */
  initialContent: string;
  title: string;
  onTitleChange: (title: string) => void;
  /** Serialized content, at most every 300ms while editing. */
  onContentChange: (content: string) => void;
  onReady: (handle: BlockEditorHandle) => void;
  /** Where the Block tab of the sidebar is; BlockInspector renders there. */
  inspector: HTMLElement | null;
  /** True when a block becomes selected, false when the selection clears. */
  onSelectionChange?: (hasSelection: boolean) => void;
  /** Shown at the end of the editor toolbar (the Visual/Code switch). */
  toolbarEnd?: ReactNode;
  postId?: number;
  canUnfilteredHtml: boolean;
  /** Focus the title once the canvas is ready (new posts). */
  focusTitle?: boolean;
  onNotice: (message: string, tone: 'success' | 'danger') => void;
}

type Panel = 'inserter' | 'list' | null;

/* --------------------------------------------------------------- the editor */

/**
 * Plugin blocks first (their editor modules and the server's block types),
 * then the editor, so saved plugin blocks parse as themselves.
 */
export default function BlockEditor(props: BlockEditorProps) {
  const { ready, blockStyles } = usePluginBlocks();
  const assets = useMemo(() => resolvedAssets(blockStyles), [blockStyles]);
  if (!ready) return <EditorSkeleton />;
  return <Editor {...props} resolvedAssets={assets} />;
}

function Editor(props: BlockEditorProps & { resolvedAssets: ResolvedAssets }) {
  const { initialContent, onContentChange, onReady, postId, canUnfilteredHtml } = props;
  const [initial] = useState(() => {
    const blocks = parse(initialContent);
    return { blocks, baseline: serialize(blocks) };
  });
  const history = useStateWithHistory<{ blocks: BlockInstance[]; selection?: unknown }>({
    blocks: initial.blocks,
  });
  const value = history.value as { blocks: BlockInstance[]; selection?: unknown };
  const features = useEditorFeatures();
  const [panel, setPanel] = useState<Panel>(null);
  const [words, setWords] = useState(() => countWords(initial.baseline));

  const blocksRef = useRef(value.blocks);
  blocksRef.current = value.blocks;

  // Hand the parent a way to read the content on demand (saving, autosave).
  const registry = useRegistry();
  useEffect(() => {
    onReady({
      getContent: () => serialize(blocksRef.current),
      parse: (markup: string) => parse(markup),
      baseline: initial.baseline,
      saveMenus: () => saveEditedMenus(registry),
    });
  }, []);

  // Report content changes, debounced: serializing is the expensive part.
  useEffect(() => {
    if (value.blocks === initial.blocks) return;
    const timer = setTimeout(() => {
      const content = serialize(value.blocks);
      setWords(countWords(content));
      onContentChange(content);
    }, 300);
    return () => clearTimeout(timer);
  }, [value.blocks, initial.blocks, onContentChange]);

  const settings = useMemo(
    () =>
      editorSettings({ features, canUnfilteredHtml, postId, assets: props.resolvedAssets }),
    [features, canUnfilteredHtml, postId, props.resolvedAssets],
  );

  const togglePanel = (next: Exclude<Panel, null>) =>
    setPanel((current) => (current === next ? null : next));

  return (
    <ShortcutProvider className={styles.root}>
      <EditorUiStylesheets />
      <BlockEditorProvider
        value={value.blocks}
        selection={value.selection as never}
        onInput={(blocks, { selection }) => history.setValue({ blocks, selection }, true)}
        onChange={(blocks, { selection }) => history.setValue({ blocks, selection }, false)}
        settings={settings}
        useSubRegistry
      >
        <UndoShortcuts undo={history.undo} redo={history.redo} />
        <NoticesBridge onNotice={props.onNotice} />
        <MediaCategories enabled={features.media} />
        <SelectionReporter onSelectionChange={props.onSelectionChange} />

        <div className={styles.toolbar} role="toolbar" aria-label="Editor tools">
          <Button
            size="sm"
            variant={panel === 'inserter' ? 'primary' : 'secondary'}
            icon={<Plus size={16} aria-hidden="true" />}
            aria-expanded={panel === 'inserter'}
            data-panel-toggle="inserter"
            aria-controls="pressbase-editor-panel"
            onClick={() => togglePanel('inserter')}
          >
            {__('Add block')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Undo2 size={16} aria-hidden="true" />}
            aria-label={__('Undo')}
            title="Undo (Ctrl+Z)"
            aria-disabled={!history.hasUndo}
            onClick={() => history.hasUndo && history.undo()}
            className={styles.iconButton}
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<Redo2 size={16} aria-hidden="true" />}
            aria-label={__('Redo')}
            title="Redo (Ctrl+Shift+Z)"
            aria-disabled={!history.hasRedo}
            onClick={() => history.hasRedo && history.redo()}
            className={styles.iconButton}
          />
          <Button
            size="sm"
            variant="ghost"
            icon={<ListTree size={16} aria-hidden="true" />}
            aria-label="List view"
            title="List view"
            aria-expanded={panel === 'list'}
            data-panel-toggle="list"
            aria-controls="pressbase-editor-panel"
            onClick={() => togglePanel('list')}
            className={styles.iconButton}
            data-active={panel === 'list' || undefined}
          />
          <span className={styles.spacer} />
          <span className={styles.meta}>
            {words.toLocaleString('en')} {words === 1 ? 'word' : 'words'}
            {words > 0 && ` · ${readingMinutes(words)} min read`}
          </span>
          {props.toolbarEnd}
        </div>

        <div className={styles.body}>
          {panel && <SidePanel kind={panel} onClose={() => setPanel(null)} />}
          <div className={styles.canvas}>
            <BlockCanvas height="100%">
              <TitleField
                value={props.title}
                onChange={props.onTitleChange}
                autoFocus={props.focusTitle}
              />
              <BlockList className={styles.blockList} />
            </BlockCanvas>
          </div>
        </div>

        {props.inspector && createPortal(<BlockInspector />, props.inspector)}
        <div className={styles.light}>
          <Popover.Slot />
        </div>
      </BlockEditorProvider>
    </ShortcutProvider>
  );
}

/* ----------------------------------------------------------------- pieces */

/** The inserter or list view, over the left edge of the canvas. */
function SidePanel({ kind, onClose }: { kind: Exclude<Panel, null>; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);

  // Start where the keyboard user wants to be: the search field, or the tree.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target =
        kind === 'inserter'
          ? ref.current?.querySelector<HTMLElement>('input[type="search"]')
          : ref.current?.querySelector<HTMLElement>(
              '[role="treegrid"] a, [role="treegrid"] button',
            );
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [kind]);

  /** Closes and puts focus back on the toggle that opened the panel. */
  const close = () => {
    const toggle = ref.current
      ?.closest(`.${styles.root}`)
      ?.querySelector<HTMLButtonElement>(`[data-panel-toggle="${kind}"]`);
    onClose();
    requestAnimationFrame(() => toggle?.focus());
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation();
      close();
    }
  };
  const title = kind === 'inserter' ? 'Add a block' : 'List view';
  return (
    <aside
      ref={ref}
      id="pressbase-editor-panel"
      className={styles.panel}
      data-kind={kind}
      aria-label={title}
      onKeyDown={onKeyDown}
    >
      {kind === 'list' && (
        <header className={styles.panelHeader}>
          <h2>{title}</h2>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Close list view"
            icon={<X size={16} aria-hidden="true" />}
            onClick={close}
            className={styles.iconButton}
          />
        </header>
      )}
      <div className={styles.panelBody} data-kind={kind}>
        {kind === 'inserter' ? (
          // Its own tabs row carries the close button. Choosing a block
          // closes the panel and focuses the new block.
          <InserterLibrary
            showInserterHelpPanel={false}
            showMostUsedBlocks
            shouldFocusBlock
            onSelect={onClose}
            onClose={close}
          />
        ) : (
          <ListView isExpanded showBlockMovers description="Blocks in this post" />
        )}
      </div>
    </aside>
  );
}

/** The post title, inside the canvas so it reads like the published page. */
function TitleField({
  value,
  onChange,
  autoFocus,
}: {
  value: string;
  onChange: (title: string) => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { insertDefaultBlock, selectBlock } = useDispatch(blockEditorStore) as unknown as {
    insertDefaultBlock: (attributes?: object, rootClientId?: string, index?: number) => void;
    selectBlock: (clientId: string, initialPosition?: number) => void;
  };
  const firstBlock = useSelect((select) => {
    const editor = select(blockEditorStore) as unknown as {
      getBlocks: () => BlockInstance[];
    };
    return editor.getBlocks()[0];
  }, []);

  // Grows with the title; measured inside the iframe.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <div className="pressbase-title-wrapper">
      <textarea
        ref={ref}
        className="pressbase-title"
        rows={1}
        placeholder={__('Add title')}
        aria-label={__('Add title')}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\n/g, ' '))}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          // As in WordPress: Enter moves to the first paragraph, adding one if needed.
          const isEmptyParagraph =
            firstBlock?.name === 'core/paragraph' &&
            !String(firstBlock.attributes.content ?? '').trim();
          if (firstBlock && isEmptyParagraph) selectBlock(firstBlock.clientId, 0);
          else insertDefaultBlock(undefined, undefined, 0);
        }}
      />
    </div>
  );
}

function SelectionReporter({
  onSelectionChange,
}: {
  onSelectionChange?: (hasSelection: boolean) => void;
}) {
  const selected = useSelect(
    (select) =>
      Boolean(
        (
          select(blockEditorStore) as unknown as { getSelectedBlockClientId: () => string | null }
        ).getSelectedBlockClientId(),
      ),
    [],
  );
  useEffect(() => {
    onSelectionChange?.(selected);
  }, [selected, onSelectionChange]);
  return null;
}
