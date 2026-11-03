'use client';

/**
 * Studio: the full-screen site editor at /admin/studio (#28). Loaded only in
 * the browser, through ./index.tsx. It is our own editor around
 * @wordpress/block-editor, built from the same kit as the post editor
 * (../block-editor/kit.tsx). See docs/architecture/studio.md and ADR 0021.
 *
 * ```
 * Studio                      data: theme settings, templates, parts, the page
 *   TopBar                    page picker · devices · undo/redo · Ask AI · Preview · Publish
 *   StudioEditor (per page)   BlockEditorProvider ← one block tree (canvas-model.ts)
 *     Rail · RailPanelView    Pages · Elements · Sections · Layers · Styles · Media · AI
 *     BlockCanvas (iframe)    the template, its parts and the page, in the theme's styles
 *     Breadcrumb              Site › Page › Section › Block
 *     Inspector               Content · Style · Layout
 * ```
 */

import {
  BlockCanvas,
  BlockContextProvider,
  BlockEditorProvider,
  BlockList,
  store as blockEditorStore,
} from '@wordpress/block-editor';
import { type Block as BlockInstance, parse, serialize } from '@wordpress/blocks';
import { Popover } from '@wordpress/components';
import { useStateWithHistory } from '@wordpress/compose';
import { useDispatch, useRegistry } from '@wordpress/data';
import { ShortcutProvider } from '@wordpress/keyboard-shortcuts';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { lightScope } from '../block-editor';
import { CANVAS_STYLESHEETS, type EditorStylesheet } from '../block-editor/assets';
import {
  EditorUiStylesheets,
  editorSettings,
  MediaCategories,
  NoticesBridge,
  resolvedAssets,
  UndoShortcuts,
  useEditorFeatures,
  usePluginBlocks,
} from '../block-editor/kit';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { useToast } from '../ui/toast';
import { Breadcrumb } from './breadcrumb';
import { type CanvasBlock, composeCanvas, editingModes, pageBlocks } from './canvas-model';
import { Inspector, type PageSummary } from './inspector';
import { DEVICES, type Device, type InspectorTabId, type RailPanelId } from './layout-model';
import { Rail, RailPanelView } from './rail';
import { type PartInfo, registerStudioRegions, StudioRegionsProvider } from './regions';
import {
  type CanvasTarget,
  initialTarget,
  isHome,
  pageTitle,
  pickTemplate,
  type ReadingSettings,
  type StudioPage,
  templateCandidates,
} from './site-model';
import styles from './studio.module.css';
import { TopBar } from './top-bar';

registerStudioRegions();

/* -------------------------------------------------------------------- data */

/** /wp/v2/templates and /wp/v2/template-parts items (context=edit), the fields Studio reads. */
interface RestTemplate {
  id: string;
  slug: string;
  theme: string;
  title: { raw?: string; rendered?: string };
  content: { raw?: string };
  area?: string;
}

/** GET /wp-block-editor/v1/settings: the theme's part of the editor settings. */
interface ThemeEditorSettings {
  styles: { css: string; __unstableType: string; isGlobalStyles: boolean }[];
  __unstableResolvedAssets: { styles: string; scripts: string };
  [setting: string]: unknown;
}

interface Library {
  theme: ThemeEditorSettings;
  templates: RestTemplate[];
  parts: RestTemplate[];
}

interface EditablePage extends StudioPage {
  content: { raw?: string };
}

/** One document on the canvas: a page (or the latest posts) in its template. */
interface CanvasDoc {
  key: string;
  target: CanvasTarget;
  page?: EditablePage;
  template: RestTemplate;
  blocks: BlockInstance[];
  /** The page's content after one parse/serialize pass; null without a page. */
  baseline: string | null;
}

export interface StudioProps {
  site: { name: string; url: string };
  reading: ReadingSettings;
  pages: StudioPage[];
  /** `?page=` from the URL. */
  requestedPage?: number;
  canUnfilteredHtml: boolean;
}

/** Studio's iframe: WordPress's content styles and Studio's outlines; no stand-in theme. */
const STUDIO_CANVAS_STYLESHEETS: EditorStylesheet[] = [
  ...CANVAS_STYLESHEETS.filter(
    (name) => name !== 'canvas.css' && name !== 'block-library-theme.css',
  ),
  'studio-canvas.css',
];

/** Adds the theme to template-part blocks, as WordPress does when it reads a template. */
function withTheme(blocks: BlockInstance[], theme: string): BlockInstance[] {
  return blocks.map((block) => {
    const inner = block.innerBlocks.length
      ? withTheme(block.innerBlocks, theme)
      : block.innerBlocks;
    if (block.name === 'core/template-part' && !block.attributes.theme) {
      return { ...block, attributes: { ...block.attributes, theme }, innerBlocks: inner };
    }
    return inner === block.innerBlocks ? block : { ...block, innerBlocks: inner };
  });
}

function buildDoc(
  target: CanvasTarget,
  library: Library,
  reading: ReadingSettings,
  page?: EditablePage,
): CanvasDoc | null {
  const template = pickTemplate(templateCandidates(target, reading, page), library.templates);
  if (!template) return null;
  const parts = new Map(library.parts.map((part) => [part.slug, part.content.raw ?? '']));
  const content = page ? parse(page.content.raw ?? '') : null;
  const blocks = composeCanvas(
    withTheme(parse(template.content.raw ?? ''), template.theme) as unknown as CanvasBlock[],
    {
      // Parsed for each use, so every block on the canvas has its own clientId.
      blocks: (slug) => {
        const raw = parts.get(slug);
        return raw === undefined
          ? undefined
          : (withTheme(parse(raw), template.theme) as unknown as CanvasBlock[]);
      },
    },
    content as unknown as CanvasBlock[] | null,
  ) as unknown as BlockInstance[];
  return {
    key: `${target.kind === 'page' ? target.id : 'posts'}:${Date.now()}`,
    target,
    page,
    template,
    blocks,
    baseline: content ? serialize(content) : null,
  };
}

/** A page's address with the changeset's preview parameter, as its preview_link adds it to the home page. */
function previewUrl(link: string, changeset: Pick<Changeset, 'uuid' | 'preview_link'>): string {
  try {
    const url = new URL(link, window.location.origin);
    url.searchParams.set('changeset_uuid', changeset.uuid);
    return url.toString();
  } catch {
    return changeset.preview_link;
  }
}

const errorMessage = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

interface Changeset {
  uuid: string;
  entries: Record<string, unknown>;
  preview_link: string;
}

/* ------------------------------------------------------------------ studio */

export default function Studio(props: StudioProps) {
  const { __, sprintf } = useI18n();
  const toast = useToast();
  const plugins = usePluginBlocks();
  const features = useEditorFeatures();
  const [library, setLibrary] = useState<Library | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [target, setTarget] = useState<CanvasTarget>(() =>
    initialTarget(props.requestedPage, props.reading, props.pages),
  );
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [device, setDevice] = useState<Device>('desktop');
  const [panel, setPanel] = useState<RailPanelId | null>(null);
  const [tab, setTab] = useState<InspectorTabId>('content');
  const [narrow, setNarrow] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'publish' | null>(null);
  const [pendingTarget, setPendingTarget] = useState<CanvasTarget | null>(null);
  const [confirmPublish, setConfirmPublish] = useState<{ uuid: string; others: number } | null>(
    null,
  );
  const handle = useRef<StudioEditorHandle | null>(null);

  const postsOnFront = props.reading.show_on_front !== 'page' || !props.reading.page_on_front;
  const frontPageId = Number(props.reading.page_on_front) || 0;

  // Narrow screens: the inspector becomes a drawer.
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  // The theme's editor settings, templates and parts: once.
  useEffect(() => {
    let live = true;
    Promise.all([
      api<ThemeEditorSettings>('/wp-block-editor/v1/settings?context=site-editor'),
      api<RestTemplate[]>('/wp/v2/templates?context=edit'),
      api<RestTemplate[]>('/wp/v2/template-parts?context=edit'),
    ])
      .then(([theme, templates, parts]) => live && setLibrary({ theme, templates, parts }))
      .catch((error) => live && setFailed(errorMessage(error)));
    return () => {
      live = false;
    };
  }, []);

  // The page on the canvas, whenever the target changes.
  useEffect(() => {
    if (!library) return;
    let live = true;
    setDoc(null);
    setDirty(false);
    const load = async () => {
      const page =
        target.kind === 'page'
          ? await api<EditablePage>(`/wp/v2/pages/${target.id}?context=edit`)
          : undefined;
      const next = buildDoc(target, library, props.reading, page);
      if (!next) throw new Error(__('The theme has no template for this page.', 'pressbase-admin'));
      if (live) setDoc(next);
    };
    load().catch((error) => live && setFailed(errorMessage(error)));
    // Keep the address in step, so a reload opens the same page.
    const url = new URL(window.location.href);
    if (target.kind === 'page') url.searchParams.set('page', String(target.id));
    else url.searchParams.delete('page');
    window.history.replaceState(window.history.state, '', url);
    return () => {
      live = false;
    };
  }, [library, target, props.reading, __]);

  // Unpublished edits: the browser asks before leaving.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const chooseTarget = (next: CanvasTarget) => {
    if (
      next.kind === target.kind &&
      (next.kind === 'posts' || (target.kind === 'page' && next.id === target.id))
    ) {
      return;
    }
    if (dirty) setPendingTarget(next);
    else setTarget(next);
  };

  const assets = useMemo(
    () =>
      library
        ? resolvedAssets(
            plugins.blockStyles,
            STUDIO_CANVAS_STYLESHEETS,
            library.theme.__unstableResolvedAssets.styles,
          )
        : null,
    [library, plugins.blockStyles],
  );

  /** Writes the page's content into the user's open changeset (ADR 0022). */
  const saveDraft = async (): Promise<Changeset | null> => {
    const content = handle.current?.getPageContent();
    if (!doc?.page || content === undefined || content === null) return null;
    return api<Changeset>('/pressbase/v1/changesets', {
      method: 'POST',
      body: { entries: { [`page:${doc.page.id}`]: { content } } },
    });
  };

  const preview = async () => {
    const link = doc?.page?.link ?? props.site.url;
    // Opened now, while the click still counts as the user's: popup blockers allow it.
    const win = window.open('about:blank', '_blank');
    if (win) win.opener = null;
    if (!dirty) {
      if (win) win.location.href = link;
      return;
    }
    setBusy('preview');
    try {
      const changeset = await saveDraft();
      // The page itself, with the draft laid over it (changeset_uuid; see changesets.md#preview).
      const url = changeset ? previewUrl(link, changeset) : link;
      if (win) win.location.href = url;
      else window.open(url, '_blank', 'noopener');
    } catch (error) {
      win?.close();
      toast(errorMessage(error), { tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const publishNow = async (uuid: string) => {
    setBusy('publish');
    try {
      await api(`/pressbase/v1/changesets/${encodeURIComponent(uuid)}/publish`, { method: 'POST' });
      handle.current?.markSaved();
      setDirty(false);
      const link = doc?.page?.link;
      toast(__('Published. Your changes are live.', 'pressbase-admin'), {
        action: link
          ? {
              label: __('View page', 'pressbase-admin'),
              onClick: () => window.open(link, '_blank', 'noopener'),
            }
          : undefined,
      });
    } catch (error) {
      toast(errorMessage(error), { tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    setBusy('publish');
    let changeset: Changeset | null = null;
    try {
      changeset = await saveDraft();
    } catch (error) {
      toast(errorMessage(error), { tone: 'danger' });
    }
    setBusy(null);
    if (!changeset || !doc?.page) return;
    // The draft can hold changes made elsewhere; say so before they go live too.
    const others = Object.keys(changeset.entries).filter((key) => key !== `page:${doc.page?.id}`);
    if (others.length) setConfirmPublish({ uuid: changeset.uuid, others: others.length });
    else await publishNow(changeset.uuid);
  };

  const summary: PageSummary | null = doc
    ? {
        title: doc.page ? pageTitle(doc.page) : __('Latest posts', 'pressbase-admin'),
        isHome: isHome(doc.target, props.reading),
        status: doc.page ? statusLabel(doc.page.status, __) : undefined,
        template: doc.template.title.raw || doc.template.title.rendered || doc.template.slug,
        editLink: doc.page ? `/admin/pages/${doc.page.id}` : undefined,
        hasContent:
          Boolean(doc.page) && pageBlocks(doc.blocks as unknown as CanvasBlock[]) !== null,
      }
    : null;

  const parts = useMemo(
    () =>
      new Map<string, PartInfo>(
        (library?.parts ?? []).map((part) => [
          part.slug,
          { title: part.title.raw || part.title.rendered || part.slug, area: part.area ?? '' },
        ]),
      ),
    [library],
  );

  const chrome: Chrome = {
    topBar: (editor) => (
      <TopBar
        pages={props.pages}
        target={target}
        postsOnFront={postsOnFront}
        frontPageId={frontPageId}
        onTarget={chooseTarget}
        device={device}
        onDevice={setDevice}
        canUndo={editor?.canUndo ?? false}
        canRedo={editor?.canRedo ?? false}
        onUndo={() => editor?.undo()}
        onRedo={() => editor?.redo()}
        onAskAi={() =>
          toast(
            __(
              'Ask AI arrives with #63: select something on the page and ask for a change in your own words.',
              'pressbase-admin',
            ),
          )
        }
        canPublish={dirty && Boolean(doc?.page) && !busy}
        busy={busy}
        onPreview={preview}
        onPublish={publish}
        inspectorOpen={!narrow || inspectorOpen}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
        disabled={!editor}
      />
    ),
    rail: <Rail open={panel} onToggle={(id) => setPanel((open) => (open === id ? null : id))} />,
    panel: panel && (
      <RailPanelView
        id={panel}
        onClose={() => setPanel(null)}
        pages={props.pages}
        target={target}
        postsOnFront={postsOnFront}
        frontPageId={frontPageId}
        onTarget={(next) => {
          chooseTarget(next);
          if (narrow) setPanel(null);
        }}
      />
    ),
  };

  let content: ReactNode;
  if (failed) {
    content = (
      <StudioFrame chrome={chrome} editor={null}>
        <div className={styles.failure} role="alert">
          <h2>{__('Studio couldn’t open this page.', 'pressbase-admin')}</h2>
          <p>{failed}</p>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            {__('Try again', 'pressbase-admin')}
          </Button>
        </div>
      </StudioFrame>
    );
  } else if (!doc || !library || !assets || !plugins.ready || !summary) {
    content = (
      <StudioFrame chrome={chrome} editor={null}>
        <div className={styles.canvasLoading} aria-busy="true">
          <span className="visually-hidden">{__('Opening the page…', 'pressbase-admin')}</span>
          <div className={styles.loadingHeader} />
          <div className={styles.loadingHero} />
          <div className={styles.loadingLine} />
          <div className={styles.loadingLine} data-short />
        </div>
      </StudioFrame>
    );
  } else {
    content = (
      <StudioEditor
        key={doc.key}
        doc={doc}
        library={library}
        assets={assets}
        features={features}
        canUnfilteredHtml={props.canUnfilteredHtml}
        site={props.site.name}
        summary={summary}
        parts={parts}
        device={device}
        tab={tab}
        onTab={setTab}
        narrow={narrow}
        inspectorOpen={inspectorOpen}
        onCloseInspector={() => setInspectorOpen(false)}
        chrome={chrome}
        onDirty={setDirty}
        onReady={(h) => {
          handle.current = h;
        }}
        onNotice={(message, tone) => toast(message, { tone })}
      />
    );
  }

  return (
    <ShortcutProvider className={styles.root}>
      <EditorUiStylesheets />
      {content}
      <ConfirmDialog
        open={pendingTarget !== null}
        title={__('Leave this page without publishing?', 'pressbase-admin')}
        confirmLabel={__('Discard changes', 'pressbase-admin')}
        onCancel={() => setPendingTarget(null)}
        onConfirm={() => {
          if (pendingTarget) setTarget(pendingTarget);
          setPendingTarget(null);
        }}
      >
        <p>
          {__(
            'Your changes to this page aren’t published. If you open another page now, they’re lost.',
            'pressbase-admin',
          )}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmPublish !== null}
        tone="primary"
        title={__('Publish everything in your draft?', 'pressbase-admin')}
        confirmLabel={__('Publish all', 'pressbase-admin')}
        busy={busy === 'publish'}
        onCancel={() => setConfirmPublish(null)}
        onConfirm={async () => {
          const uuid = confirmPublish?.uuid;
          setConfirmPublish(null);
          if (uuid) await publishNow(uuid);
        }}
      >
        <p>
          {sprintf(
            __(
              'Your draft also holds %d other change made elsewhere. Publishing makes all of them live together.',
              'pressbase-admin',
            ),
            confirmPublish?.others ?? 0,
          )}
        </p>
      </ConfirmDialog>
    </ShortcutProvider>
  );
}

function statusLabel(status: string, __: ReturnType<typeof useI18n>['__']): string {
  switch (status) {
    case 'publish':
      return __('Published', 'pressbase-admin');
    case 'draft':
    case 'auto-draft':
      return __('Draft', 'pressbase-admin');
    case 'pending':
      return __('Pending review', 'pressbase-admin');
    case 'private':
      return __('Private', 'pressbase-admin');
    case 'future':
      return __('Scheduled', 'pressbase-admin');
    default:
      return status;
  }
}

/* ------------------------------------------------------------------ layout */

/** What the top bar needs from the editor; null while the canvas loads. */
interface EditorState {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

interface Chrome {
  topBar: (editor: EditorState | null) => ReactNode;
  rail: ReactNode;
  panel: ReactNode;
}

/** The screen's layout, around whatever the canvas area holds. */
function StudioFrame({
  chrome,
  editor,
  children,
  footer,
  inspector,
}: {
  chrome: Chrome;
  editor: EditorState | null;
  children: ReactNode;
  footer?: ReactNode;
  inspector?: ReactNode;
}) {
  const { __ } = useI18n();
  return (
    <div className={styles.frame}>
      <a href="#studio-canvas" className="skip-link">
        {__('Skip to the page', 'pressbase-admin')}
      </a>
      {chrome.topBar(editor)}
      <div className={styles.workspace}>
        {chrome.rail}
        {chrome.panel}
        <main id="studio-canvas" className={styles.stage} tabIndex={-1}>
          {children}
          {footer}
        </main>
        {inspector}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ editor */

export interface StudioEditorHandle {
  /** The page's content as block markup; null when the canvas shows no page. */
  getPageContent(): string | null;
  /** After publishing: the current content becomes the new baseline. */
  markSaved(): void;
}

interface StudioEditorProps {
  doc: CanvasDoc;
  library: Library;
  assets: ReturnType<typeof resolvedAssets>;
  features: ReturnType<typeof useEditorFeatures>;
  canUnfilteredHtml: boolean;
  site: string;
  summary: PageSummary;
  parts: ReadonlyMap<string, PartInfo>;
  device: Device;
  tab: InspectorTabId;
  onTab: (tab: InspectorTabId) => void;
  narrow: boolean;
  inspectorOpen: boolean;
  onCloseInspector: () => void;
  chrome: Chrome;
  onDirty: (dirty: boolean) => void;
  onReady: (handle: StudioEditorHandle) => void;
  onNotice: (message: string, tone: 'success' | 'danger') => void;
}

function StudioEditor(props: StudioEditorProps) {
  const { __ } = useI18n();
  const { doc, onDirty } = props;
  const history = useStateWithHistory<{ blocks: BlockInstance[]; selection?: unknown }>({
    blocks: doc.blocks,
  });
  const value = history.value as { blocks: BlockInstance[]; selection?: unknown };
  const blocksRef = useRef(value.blocks);
  blocksRef.current = value.blocks;
  const baseline = useRef(doc.baseline);

  const currentContent = useCallback(() => {
    const blocks = pageBlocks(blocksRef.current as unknown as CanvasBlock[]);
    return blocks ? serialize(blocks as unknown as BlockInstance[]) : null;
  }, []);

  useEffect(() => {
    props.onReady({
      getPageContent: currentContent,
      markSaved: () => {
        baseline.current = currentContent();
      },
    });
  }, []);

  // Unpublished changes, compared with what was loaded (debounced: serializing is the expensive part).
  useEffect(() => {
    if (value.blocks === doc.blocks) {
      onDirty(false);
      return;
    }
    const timer = setTimeout(() => {
      const content = currentContent();
      onDirty(content !== null && content !== baseline.current);
    }, 300);
    return () => clearTimeout(timer);
  }, [value.blocks, doc.blocks, onDirty, currentContent]);

  const settings = useMemo(() => {
    const {
      styles: themeStyles,
      __unstableResolvedAssets: _assets,
      ...themeSettings
    } = props.library.theme;
    return {
      ...editorSettings({
        features: props.features,
        canUnfilteredHtml: props.canUnfilteredHtml,
        postId: doc.page?.id,
        assets: props.assets,
      }),
      // The theme's palette, font sizes, spacing and layout (theme.json), as WordPress's site editor gets them.
      ...themeSettings,
      styles: themeStyles,
      // Sections from patterns stay fully editable: Studio is for building pages.
      disableContentOnlyForUnsyncedPatterns: true,
    };
  }, [props.features, props.canUnfilteredHtml, props.assets, props.library.theme, doc.page?.id]);

  const editor: EditorState = {
    canUndo: history.hasUndo,
    canRedo: history.hasRedo,
    undo: history.undo,
    redo: history.redo,
  };
  const width = DEVICES.find((d) => d.id === props.device)?.width ?? null;
  const showInspector = !props.narrow || props.inspectorOpen;

  return (
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
      <MediaCategories enabled={props.features.media} />
      <EditingModes blocks={doc.blocks} />
      <StudioRegionsProvider
        value={{
          parts: props.parts,
          partLabel: (slug) =>
            `${props.parts.get(slug)?.title ?? slug} · ${__('every page', 'pressbase-admin')}`,
        }}
      >
        <StudioFrame
          chrome={props.chrome}
          editor={editor}
          footer={<Breadcrumb site={props.site} page={props.summary.title} parts={props.parts} />}
          inspector={
            showInspector && (
              <Inspector
                page={props.summary}
                parts={props.parts}
                tab={props.tab}
                onTab={props.onTab}
                onClose={props.narrow ? props.onCloseInspector : undefined}
              />
            )
          }
        >
          <div className={styles.canvasArea} data-device={props.device}>
            <div
              className={styles.canvasFrame}
              style={width ? { maxWidth: `${width}px` } : undefined}
            >
              <BlockContextProvider
                value={doc.page ? { postId: doc.page.id, postType: 'page' } : {}}
              >
                <BlockCanvas height="100%" styles={settings.styles as never}>
                  <BlockList className="wp-site-blocks" />
                </BlockCanvas>
              </BlockContextProvider>
            </div>
          </div>
        </StudioFrame>
      </StudioRegionsProvider>
      <div className={lightScope}>
        <Popover.Slot />
      </div>
    </BlockEditorProvider>
  );
}

/**
 * Applies the canvas's editing modes (canvas-model.ts editingModes()) once
 * the blocks are in the store. The template's block IDs never change while
 * the page is open, undo included.
 */
function EditingModes({ blocks }: { blocks: BlockInstance[] }) {
  const registry = useRegistry();
  const { setBlockEditingMode } = useDispatch(blockEditorStore) as unknown as {
    setBlockEditingMode: (clientId: string, mode: string) => void;
  };
  useEffect(() => {
    const canvas = blocks as unknown as CanvasBlock[];
    registry.batch(() => {
      for (const [clientId, mode] of editingModes(canvas)) setBlockEditingMode(clientId, mode);
    });
  }, [blocks, registry, setBlockEditingMode]);
  return null;
}
