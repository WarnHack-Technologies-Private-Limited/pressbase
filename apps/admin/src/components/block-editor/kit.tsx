'use client';

/**
 * What every block editor screen shares: the one-time setup of WordPress's
 * packages, the canvas assets, the server features and plugin blocks, the
 * editor settings, and small store bridges (undo shortcuts, notices, the
 * inserter's Media tab). The post editor (block-editor.tsx) and Studio
 * (components/studio/) are both built from these, so they behave alike.
 * See docs/architecture/block-editor.md.
 */

import apiFetch from '@wordpress/api-fetch';
import { store as blockEditorStore } from '@wordpress/block-editor';
import { registerCoreBlocks } from '@wordpress/block-library';
import { getBlockType, getBlockTypes, setFreeformContentHandlerName } from '@wordpress/blocks';
import { useDispatch, useRegistry, useSelect } from '@wordpress/data';
import { __, isRTL } from '@wordpress/i18n';
import '@wordpress/format-library';
import { store as keyboardShortcutsStore, useShortcut } from '@wordpress/keyboard-shortcuts';
import { store as noticesStore } from '@wordpress/notices';
import { useEffect, useMemo, useState } from 'react';
import { type AdminBlock, useAdminExtensions } from '../extensions/host';
import { configureApiFetch } from './api-fetch';
import {
  assetUrl,
  CANVAS_STYLESHEETS,
  directional,
  type EditorStylesheet,
  UI_STYLESHEETS,
} from './assets';
import { allowedBlockTypes } from './blocks';
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

/* ------------------------------------------------------------- one-time setup */

configureApiFetch(apiFetch);
if (!getBlockType('core/paragraph')) {
  registerCoreBlocks();
  // Content that isn't block markup (raw HTML from imports or API clients)
  // opens as a Custom HTML block, unchanged. WordPress uses the Classic block,
  // which needs TinyMCE.
  setFreeformContentHandlerName('core/html');
}

/** The inserter's Media tab (Images, Videos, Audio), once the media library exists. */
const MEDIA_CATEGORIES = createInserterMediaCategories();

/* ------------------------------------------------------------------ assets */

export interface ResolvedAssets {
  styles: string;
  scripts: string;
}

/**
 * HTML for the canvas iframe's <head>: WordPress's stylesheets, then plugin
 * blocks' `style` and `editorStyle` (as _wp_get_iframed_editor_assets() adds
 * block styles), then `extraHead` (a theme's fonts and stylesheets). Stable
 * per input, so the iframe is built once.
 */
export function resolvedAssets(
  blockStyles: readonly string[],
  stylesheets: readonly EditorStylesheet[] = CANVAS_STYLESHEETS,
  extraHead = '',
): ResolvedAssets {
  return {
    styles:
      [...stylesheets.map((name) => assetUrl(directional(name, isRTL()))), ...blockStyles]
        .map((href) => `<link rel="stylesheet" href="${href.replace(/"/g, '&quot;')}">`)
        .join('') + extraHead,
    scripts: '',
  };
}

/** WordPress's editor UI stylesheets, loaded with the editor and never on other pages. */
export function EditorUiStylesheets() {
  return UI_STYLESHEETS.map((name) => (
    <link
      key={name}
      rel="stylesheet"
      href={assetUrl(directional(name, isRTL()))}
      precedence="pressbase-editor"
    />
  ));
}

/* ------------------------------------------------------------------ hooks */

/**
 * Plugin blocks first (their editor modules and the server's block types),
 * then the editor, so saved plugin blocks parse as themselves. `blockStyles`
 * are the plugin blocks' stylesheets, for the canvas.
 */
export function usePluginBlocks(): { ready: boolean; blockStyles: string[] } {
  const { blocks = [] } = useAdminExtensions();
  const [ready, setReady] = useState(false);
  const key = JSON.stringify(blocks);
  // Once per editor, with the blocks known then.
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
  const blockStyles = useMemo(
    () => (JSON.parse(key) as AdminBlock[]).flatMap((block) => block.styles),
    [key],
  );
  return { ready, blockStyles };
}

/** The server features the editor adapts to (features.ts), probed once per page load. */
export function useEditorFeatures(): EditorFeatures {
  const [features, setFeatures] = useState<EditorFeatures>(NO_FEATURES);
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
  return features;
}

/** The settings every editor passes to BlockEditorProvider (see the table in block-editor.md). */
export function editorSettings({
  features,
  canUnfilteredHtml,
  postId,
  assets,
}: {
  features: EditorFeatures;
  canUnfilteredHtml: boolean;
  postId?: number;
  assets: ResolvedAssets;
}) {
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
    __unstableResolvedAssets: assets,
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
}

/* ---------------------------------------------------------- store bridges */

/** core-data's store, as the Navigation block uses it (only the calls made here). */
interface CoreDataStore {
  __experimentalGetDirtyEntityRecords?: () => { kind: string; name: string; key: number }[];
}

/** Saves the `wp_navigation` records the Navigation block left edited in core-data. */
export async function saveEditedMenus(registry: ReturnType<typeof useRegistry>): Promise<void> {
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

/** Undo and redo, from anywhere in the editor (WordPress's core/editor/undo). */
export function UndoShortcuts({ undo, redo }: { undo: () => void; redo: () => void }) {
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
export function MediaCategories({ enabled }: { enabled: boolean }) {
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
export function NoticesBridge({
  onNotice,
}: {
  onNotice: (message: string, tone: 'success' | 'danger') => void;
}) {
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
