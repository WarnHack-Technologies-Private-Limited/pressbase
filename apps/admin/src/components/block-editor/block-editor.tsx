'use client';

/**
 * Gutenberg inside Pressbase. Loaded only on the post and page editors,
 * client-side (see ./index.tsx); everything WordPress-specific stays in this
 * folder. Wiring is documented in docs/architecture/block-editor.md.
 */

import apiFetch from '@wordpress/api-fetch';
import {
  BlockCanvas,
  BlockEditorProvider,
  BlockInspector,
  BlockList,
  store as blockEditorStore,
  __experimentalLibrary as InserterLibrary,
  __experimentalListView as ListView,
} from '@wordpress/block-editor';
import { registerCoreBlocks } from '@wordpress/block-library';
import {
  type Block as BlockInstance,
  getBlockType,
  getBlockTypes,
  parse,
  serialize,
  setFreeformContentHandlerName,
} from '@wordpress/blocks';
import { Popover } from '@wordpress/components';
import { useStateWithHistory } from '@wordpress/compose';
import { useDispatch, useRegistry, useSelect } from '@wordpress/data';
// The editor's own toolbar uses WordPress's strings, translated with Gutenberg's (translations.ts).
import { __, isRTL } from '@wordpress/i18n';
import '@wordpress/format-library';
import {
  store as keyboardShortcutsStore,
  ShortcutProvider,
  useShortcut,
} from '@wordpress/keyboard-shortcuts';
import { store as noticesStore } from '@wordpress/notices';
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
import { configureApiFetch } from './api-fetch';
import { assetUrl, CANVAS_STYLESHEETS, directional, UI_STYLESHEETS } from './assets';
import styles from './block-editor.module.css';
import { allowedBlockTypes, countWords, readingMinutes } from './blocks';
import { type EditorFeatures, loadEditorFeatures, NO_FEATURES, toEditorPattern } from './features';
import { fetchLinkSuggestions } from './link-suggestions';
import {
  ALLOWED_MIME_TYPES,
  categoriesWithMedia,
  createInserterMediaCategories,
  type InserterMediaCategory,
} from './media-categories';
import { registerMediaLibrary } from './media-library';
import { createMediaUpload } from './media-upload';
import { preparePluginBlocks } from './server-blocks';
import { EditorSkeleton } from './skeleton';
import { type AdminBlock, useAdminExtensions } from '../extensions/host';

/* ------------------------------------------------------------- one-time setup */

configureApiFetch(apiFetch);
if (!getBlockType('core/paragraph')) {
  registerCoreBlocks();
  // Content that isn't block markup (raw HTML from imports or API clients)
  // opens as a Custom HTML block, unchanged. WordPress uses the Classic block,
  // which needs TinyMCE.
  setFreeformContentHandlerName('core/html');
}

/**
 * HTML for the canvas iframe's <head>: WordPress's stylesheets, then plugin
 * blocks' `style` and `editorStyle` (as _wp_get_iframed_editor_assets() adds
 * block styles). Stable per list, so the iframe is built once.
 */
function resolvedAssets(blockStyles: readonly string[]) {
  return {
    styles: [
      ...CANVAS_STYLESHEETS.map((name) => assetUrl(directional(name, isRTL()))),
      ...blockStyles,
    ]
      .map((href) => `<link rel="stylesheet" href="${href.replace(/"/g, '&quot;')}">`)
      .join(''),
    scripts: '',
  };
}

/** The inserter's Media tab (Images, Videos, Audio), once the media library exists. */
const MEDIA_CATEGORIES = createInserterMediaCategories();

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
  const { blocks = [] } = useAdminExtensions();
  const [ready, setReady] = useState(false);
  const key = JSON.stringify(blocks);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per editor, with the blocks known then.
  useEffect(() => {
    let live = true;
    preparePluginBlocks(JSON.parse(key) as AdminBlock[])
      .catch((error) => console.error('Plugin blocks couldn’t be prepared:', error))
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, []);
  const assets = useMemo(
    () => resolvedAssets((JSON.parse(key) as AdminBlock[]).flatMap((block) => block.styles)),
    [key],
  );
  if (!ready) return <EditorSkeleton />;
  return <Editor {...props} resolvedAssets={assets} />;
}

function Editor(props: BlockEditorProps & { resolvedAssets: ReturnType<typeof resolvedAssets> }) {
  const { initialContent, onContentChange, onReady, postId, canUnfilteredHtml } = props;
  const [initial] = useState(() => {
    const blocks = parse(initialContent);
    return { blocks, baseline: serialize(blocks) };
  });
  const history = useStateWithHistory<{ blocks: BlockInstance[]; selection?: unknown }>({
    blocks: initial.blocks,
  });
  const value = history.value as { blocks: BlockInstance[]; selection?: unknown };
  const [features, setFeatures] = useState<EditorFeatures>(NO_FEATURES);
  const [panel, setPanel] = useState<Panel>(null);
  const [words, setWords] = useState(() => countWords(initial.baseline));

  const blocksRef = useRef(value.blocks);
  blocksRef.current = value.blocks;

  useEffect(() => {
    let live = true;
    loadEditorFeatures().then((loaded) => {
      if (!live) return;
      if (loaded.media) registerMediaLibrary();
      setFeatures(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

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

  const settings = useMemo(() => {
    const names = getBlockTypes().map((type) => type.name);
    return {
      alignWide: true,
      bodyPlaceholder: __('Type / to choose a block'),
      allowedBlockTypes: allowedBlockTypes(names, features),
      __experimentalBlockPatterns: features.patterns.map(toEditorPattern),
      __experimentalBlockPatternCategories: features.patternCategories,
      __experimentalReusableBlocks: features.syncedPatterns ?? [],
      __experimentalCanUserUseUnfilteredHTML: canUnfilteredHtml,
      __experimentalFetchLinkSuggestions: fetchLinkSuggestions,
      __unstableResolvedAssets: props.resolvedAssets,
      mediaUpload: createMediaUpload({ available: features.media, postId }),
      imageEditing: features.media,
      // The Media tab only lists categories whose type is allowed here; the
      // categories themselves are registered by <MediaCategories>.
      ...(features.media ? { allowedMimeTypes: ALLOWED_MIME_TYPES } : {}),
      enableOpenverseMediaCategory: false,
      canLockBlocks: true,
      codeEditingEnabled: true,
      isRTL: isRTL(),
    };
  }, [features, canUnfilteredHtml, postId, props.resolvedAssets]);

  const togglePanel = (next: Exclude<Panel, null>) =>
    setPanel((current) => (current === next ? null : next));

  return (
    <ShortcutProvider className={styles.root}>
      {UI_STYLESHEETS.map((name) => (
        <link
          key={name}
          rel="stylesheet"
          href={assetUrl(directional(name, isRTL()))}
          precedence="pressbase-editor"
        />
      ))}
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

/** core-data's store, as the Navigation block uses it (only the calls made here). */
interface CoreDataStore {
  __experimentalGetDirtyEntityRecords?: () => { kind: string; name: string; key: number }[];
}

/** Saves the `wp_navigation` records the Navigation block left edited in core-data. */
async function saveEditedMenus(registry: ReturnType<typeof useRegistry>): Promise<void> {
  let dirty: { kind: string; name: string; key: number }[] = [];
  try {
    const select = registry.select('core') as CoreDataStore | undefined;
    dirty = select?.__experimentalGetDirtyEntityRecords?.() ?? [];
  } catch {
    return; // core-data isn't loaded: nothing was edited through it.
  }
  const dispatch = registry.dispatch('core') as {
    saveEditedEntityRecord?: (kind: string, name: string, key: number) => Promise<unknown>;
  };
  for (const record of dirty) {
    if (record.kind === 'postType' && record.name === 'wp_navigation') {
      await dispatch.saveEditedEntityRecord?.(record.kind, record.name, record.key);
    }
  }
}

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

/** Undo and redo, from anywhere in the editor (WordPress's core/editor/undo). */
function UndoShortcuts({ undo, redo }: { undo: () => void; redo: () => void }) {
  const { registerShortcut } = useDispatch(keyboardShortcutsStore) as unknown as {
    registerShortcut: (shortcut: object) => void;
  };
  useEffect(() => {
    registerShortcut({
      name: 'pressbase/editor/undo',
      category: 'global',
      description: 'Undo your last changes.',
      keyCombination: { modifier: 'primary', character: 'z' },
    });
    registerShortcut({
      name: 'pressbase/editor/redo',
      category: 'global',
      description: 'Redo your last undo.',
      keyCombination: { modifier: 'primaryShift', character: 'z' },
      aliases: [{ modifier: 'primary', character: 'y' }],
    });
  }, [registerShortcut]);
  useShortcut('pressbase/editor/undo', (event) => {
    event.preventDefault();
    undo();
  });
  useShortcut('pressbase/editor/redo', (event) => {
    event.preventDefault();
    redo();
  });
  return null;
}

/**
 * Fills the inserter's Media tab. BlockEditorProvider strips the private
 * `inserterMediaCategories` setting, so the categories are added with the
 * public registerInserterMediaCategory() action instead, once per editor
 * store, and only those that have media (as WordPress's own check does).
 */
const registeredStores = new WeakSet<object>();
function MediaCategories({ enabled }: { enabled: boolean }) {
  const registry = useRegistry();
  const { registerInserterMediaCategory } = useDispatch(blockEditorStore) as unknown as {
    registerInserterMediaCategory: (category: InserterMediaCategory) => void;
  };
  useEffect(() => {
    if (!enabled || registeredStores.has(registry)) return;
    registeredStores.add(registry);
    categoriesWithMedia(MEDIA_CATEGORIES).then((categories) => {
      for (const category of categories) registerInserterMediaCategory(category);
    });
  }, [enabled, registry, registerInserterMediaCategory]);
  return null;
}

/** WordPress notices (block copied, upload failed…) become Pressbase toasts. */
function NoticesBridge({ onNotice }: { onNotice: BlockEditorProps['onNotice'] }) {
  const notices = useSelect(
    (select) =>
      (
        select(noticesStore) as {
          getNotices: () => { id: string; content: unknown; status: string }[];
        }
      ).getNotices(),
    [],
  );
  const { removeNotice } = useDispatch(noticesStore) as unknown as {
    removeNotice: (id: string) => void;
  };
  useEffect(() => {
    for (const notice of notices) {
      const message = typeof notice.content === 'string' ? notice.content : '';
      if (message) onNotice(message, notice.status === 'error' ? 'danger' : 'success');
      removeNotice(notice.id);
    }
  }, [notices, onNotice, removeNotice]);
  return null;
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
