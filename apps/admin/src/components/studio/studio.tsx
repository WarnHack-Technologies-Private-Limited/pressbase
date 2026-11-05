'use client';

/**
 * Studio: the full-screen site editor at /admin/studio (#28). Loaded only in
 * the browser, through ./index.tsx. It is our own editor around
 * @wordpress/block-editor, built from the same kit as the post editor
 * (../block-editor/kit.tsx). See docs/architecture/studio.md and ADR 0021.
 *
 * ```
 * Studio                      data: theme settings, templates, parts, the page, the draft
 *   TopBar                    page picker · devices · undo/redo · Ask AI · saved · Preview · Publish N
 *   StudioEditor (per page)   BlockEditorProvider ← one block tree (canvas-model.ts)
 *     Rail · RailPanelView    Pages · Elements · Sections · Layers · Styles · Media · AI
 *     BlockCanvas (iframe)    the template, its parts and the page, in the theme's styles
 *     Breadcrumb              Site › Page › Section › Block
 *     Inspector               Content · Style · Layout
 * ```
 *
 * Every edit is saved to the user's open changeset (use-draft.ts, #31): the
 * editor works out which entries the canvas needs (the page's content, each
 * template part) and the draft writes them after a pause. Publish makes them
 * live together; nothing reaches the live site before that.
 */

import {
  BlockCanvas,
  BlockContextProvider,
  BlockEditorProvider,
  BlockList,
  store as blockEditorStore,
} from '@wordpress/block-editor';
import { type Block as BlockInstance, createBlock, parse, serialize } from '@wordpress/blocks';
import { Popover } from '@wordpress/components';
import { useDispatch, useRegistry } from '@wordpress/data';
import { ShortcutProvider } from '@wordpress/keyboard-shortcuts';
import {
  ArrowLeft,
  Eye,
  FileText,
  Info,
  Lock,
  Monitor,
  Send,
  SlidersHorizontal,
  Smartphone,
  Tablet,
  Trash2,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import type { SiteIndex } from '@/lib/core';
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
import { SiteBuilderNote } from '../site-builder/studio-note';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { useToast } from '../ui/toast';
import { navigationRef, withInnerBlocks } from './ai-edits-model';
import { AiPanel, AiReview } from './ai-panel';
import { AskAiDialog, AskAiProvider, registerAskAiControls, useAskAi } from './ask-ai';
import { Breadcrumb } from './breadcrumb';
import {
  ChecklistPanel,
  ChecklistSelect,
  PlaceholderMarks,
  PublishCheckDialog,
  PublishChecklistNote,
  useChecklist,
} from './checklist';
import type { ChecklistItem } from './checklist-model';
import { CanvasDragAssist } from './canvas-drag';
import {
  type CanvasBlock,
  composeCanvas,
  editingModes,
  findRegions,
  pageBlocks,
  partOf,
  regionBlocks,
  withoutNavigationRef,
} from './canvas-model';
import {
  type Changeset,
  changedSince,
  describeChange,
  desiredEntry,
  type EntryValue,
  type LiveModified,
  pageKey,
  parseKey,
  partKey,
  type RegionState,
  regionChanged,
  type StoredEntry,
} from './changes-model';
import {
  CommandPalette,
  isPaletteShortcut,
  usePaletteShortcut,
  useStudioCommands,
} from './command-palette';
import { EditorCommands } from './editor-commands';
import { ElementsPanel } from './elements-panel';
import { useEntityEdits } from './entity-edits';
import { type CanvasValue, HistoryPanel } from './history-panel';
import { Inspector, type PageSummary } from './inspector';
import {
  DEVICES,
  type Device,
  type InspectorTabId,
  RAIL_PANELS,
  type RailPanelId,
} from './layout-model';
import { DEFAULT_MODE, modeEditorSettings, STUDIO_MODE_META, type StudioMode } from './mode-model';
import {
  arrangementChanges,
  draftPages,
  draftReading,
  editablePages,
  fieldChange,
  homePageEntries,
  movePage,
  newPageEntry,
  newPageLink,
  refOfKey,
} from './pages-model';
import { PagesPanel } from './pages-panel';
import type { PendingChange } from './publish-panel';
import { RAIL_ICONS, Rail, RailPanelView } from './rail';
import {
  type PartInfo,
  registerStudioRegions,
  StudioRegionsProvider,
  useSelectedPart,
} from './regions';
import { SectionToolbar } from './section-toolbar';
import { SectionsPanel } from './sections-panel';
import {
  type CanvasTarget,
  frontPage,
  initialTarget,
  isHome,
  isNewPage,
  pageTitle,
  pickTemplate,
  type ReadingSettings,
  type StudioPage,
  sameTarget,
  templateCandidates,
} from './site-model';
import styles from './studio.module.css';
import { StylesPanel } from './styles-panel';
import { CanvasEventsProvider } from './swap-layout';
import { TopBar } from './top-bar';
import type { AiCanvas } from './use-ai-edits';
import { useDraft } from './use-draft';
import { type StudioHistory, useStudioHistory } from './use-history';
import { useSiteStyles } from './use-site-styles';
import { useStudioAi } from './use-studio-ai';

registerStudioRegions();
registerAskAiControls();

/* -------------------------------------------------------------------- data */

/** /wp/v2/templates and /wp/v2/template-parts items (context=edit), the fields Studio reads. */
interface RestTemplate {
  id: string;
  slug: string;
  theme: string;
  title: { raw?: string; rendered?: string };
  content: { raw?: string };
  area?: string;
  /** `theme` (the theme's file) or `custom` (a customised copy, or the site's own). */
  source?: string;
  has_theme_file?: boolean;
  /** Site time, as WordPress gives it. */
  modified?: string | null;
}

/** GET /wp-block-editor/v1/settings: the theme's part of the editor settings. */
interface ThemeEditorSettings {
  styles: { css: string; __unstableType: string; isGlobalStyles: boolean }[];
  __unstableResolvedAssets: { styles: string; scripts: string };
  [setting: string]: unknown;
}

/** A template part as visitors see it now, and its theme's file when it's a customised copy. */
interface LivePart {
  part: RestTemplate;
  /** The theme file's markup, for a customised copy of one. */
  themeFile?: string;
}

interface Library {
  theme: ThemeEditorSettings;
  templates: RestTemplate[];
  /** The custom templates a page may choose (`/wp/v2/templates?post_type=page`). */
  pageTemplates: { slug: string; title: string }[];
  /** The menu a Navigation block without one shows (and fills in as its `ref`). */
  navigationFallback: number | null;
}

interface EditablePage extends StudioPage {
  content: { raw?: string };
}

/** What a region saves to, and what it held when the canvas opened. */
interface RegionInfo {
  key: string;
  kind: 'content' | 'part';
  slug?: string;
  /** What visitors see now (block markup after a parse/serialize pass). */
  live: string;
  /** What the canvas opened with: the draft's version, or `live`. */
  initial: string;
  /** Parts: the theme file's markup (for a part that isn't customised, that's `live`). */
  theme?: string;
  /** Parts: visitors see a customised copy of the theme's file. */
  customised?: boolean;
}

/** One document on the canvas: a page (or the latest posts) in its template. */
interface CanvasDoc {
  key: string;
  target: CanvasTarget;
  page?: EditablePage;
  template: RestTemplate;
  blocks: BlockInstance[];
  regions: Map<string, RegionInfo>;
}

export interface StudioProps {
  site: { name: string; url: string };
  reading: ReadingSettings;
  /** The site's time zone (`timezone_string`), for reading REST `modified` dates. */
  timeZone: string;
  pages: StudioPage[];
  /** `?page=` from the URL. */
  requestedPage?: number;
  /** `?changeset_uuid=` from the URL: *Back to Studio* in a preview. */
  requestedChangeset?: string;
  /** `?run=`: a site the guided flow just built (#60), for the note above the canvas. */
  requestedRun?: number;
  /** `?panel=`: a rail panel to open with (the guided flow's Review links to the checklist, #61). */
  requestedPanel?: RailPanelId;
  canUnfilteredHtml: boolean;
  /** Who's editing, and what they may change (#29). */
  user: StudioUser;
  /** Simple or Advanced (#32), as the person last chose (user meta). */
  mode?: StudioMode;
}

/** What the person in Studio may do. Without `edit_theme_options`, the header, footer and styles are read-only. */
export interface StudioUser {
  id: number;
  canEditTheme: boolean;
  /** `manage_options`: choosing the home page. */
  canManageOptions: boolean;
  /** `publish_pages`: adding pages, which go live on Publish. */
  canPublishPages: boolean;
  /** `edit_others_pages`: without it, only the person's own pages open. */
  canEditOthersPages: boolean;
}

/** The pages Studio lists: every status an editor works with, as the page picker shows them. */
const PAGES_PATH =
  '/wp/v2/pages?context=edit&per_page=100&status=publish,draft,pending,private,future&orderby=menu_order&order=asc';

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

/**
 * The template's Title blocks as headings with the page's title, for a page
 * the draft adds (the template is never saved from the canvas). Same level,
 * classes and styles, so it looks as it will.
 */
function withDraftTitle(blocks: BlockInstance[], title: string): BlockInstance[] {
  return blocks.map((block) => {
    if (block.name === 'core/post-title') {
      const {
        level,
        textAlign,
        className,
        isLink: _link,
        linkTarget: _t,
        rel: _r,
        ...rest
      } = block.attributes as Record<string, unknown>;
      return createBlock('core/heading', {
        ...rest,
        content: title,
        level: typeof level === 'number' && level > 0 ? level : 2,
        textAlign,
        className: ['wp-block-post-title', className].filter(Boolean).join(' '),
      });
    }
    return block.innerBlocks.length
      ? { ...block, innerBlocks: withDraftTitle(block.innerBlocks, title) }
      : block;
  });
}

/** A part's markup as the canvas holds it: parsed, with the theme on nested parts, serialized. */
const partMarkup = (raw: string, theme: string) => serialize(withTheme(parse(raw), theme));

const entryContent = (value: unknown): string | undefined => {
  const content = (value as { content?: unknown } | null)?.content;
  return typeof content === 'string' ? content : undefined;
};

function buildDoc(
  target: CanvasTarget,
  library: Library,
  liveParts: ReadonlyMap<string, LivePart>,
  reading: ReadingSettings,
  draft: Readonly<Record<string, { value: unknown }>>,
  page?: EditablePage,
): CanvasDoc | null {
  const template = pickTemplate(templateCandidates(target, reading, page), library.templates);
  if (!template) return null;
  const regions = new Map<string, RegionInfo>();

  // Template parts: what visitors see, with the draft's version on the canvas.
  const partsOnCanvas = new Map<string, string>();
  for (const [slug, { part, themeFile }] of liveParts) {
    const key = partKey(slug);
    const live = partMarkup(part.content.raw ?? '', template.theme);
    const customised =
      part.source === 'custom' && Boolean(part.has_theme_file) && themeFile !== undefined;
    const theme = customised ? partMarkup(themeFile ?? '', template.theme) : live;
    const value = draft[key]?.value as { source?: string } | undefined;
    const drafted = entryContent(value);
    const initial =
      value?.source === 'theme'
        ? theme
        : drafted !== undefined
          ? partMarkup(drafted, template.theme)
          : live;
    regions.set(key, { key, kind: 'part', slug, live, initial, theme, customised });
    partsOnCanvas.set(slug, initial);
  }

  let content: BlockInstance[] | null = null;
  if (page) {
    const key = pageKey(page.id);
    const live = serialize(parse(page.content.raw ?? ''));
    const drafted = entryContent(draft[key]?.value);
    content = parse(drafted ?? page.content.raw ?? '');
    regions.set(key, {
      key,
      kind: 'content',
      live,
      initial: drafted !== undefined ? serialize(content) : live,
    });
  }

  let templateBlocks = withTheme(parse(template.content.raw ?? ''), template.theme);
  // A page the draft adds has no post for the Title block to read: show its title in its place.
  if (page && isNewPage(page.id)) templateBlocks = withDraftTitle(templateBlocks, pageTitle(page));
  const blocks = composeCanvas(
    templateBlocks as unknown as CanvasBlock[],
    {
      // Parsed for each use, so every block on the canvas has its own clientId.
      blocks: (slug) => {
        const raw = partsOnCanvas.get(slug);
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
    regions,
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

/** The template parts as visitors see them, with the theme files of customised copies. */
async function loadLiveParts(): Promise<Map<string, LivePart>> {
  const parts = await api<RestTemplate[]>('/wp/v2/template-parts?context=edit');
  const entries = await Promise.all(
    parts.map(async (part): Promise<[string, LivePart]> => {
      if (part.source !== 'custom' || !part.has_theme_file) return [part.slug, { part }];
      const file = await api<RestTemplate>(
        `/wp/v2/template-parts/${part.id}?source=theme&context=edit`,
      ).catch(() => null);
      return [part.slug, { part, themeFile: file?.content.raw }];
    }),
  );
  return new Map(entries);
}

/* ------------------------------------------------------------------ studio */

export default function Studio(props: StudioProps) {
  const { __, _n, sprintf } = useI18n();
  const toast = useToast();
  const plugins = usePluginBlocks();
  const features = useEditorFeatures();
  const [library, setLibrary] = useState<Library | null>(null);
  const [liveParts, setLiveParts] = useState<Map<string, LivePart> | null>(null);
  const [opened, setOpened] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [target, setTarget] = useState<CanvasTarget>(() =>
    initialTarget(
      props.requestedPage,
      props.reading,
      editablePages(props.pages, { id: props.user.id, editOthers: props.user.canEditOthersPages }),
    ),
  );
  // The pages and reading settings as visitors see them; the draft's changes are laid over below.
  const [livePages, setLivePages] = useState<StudioPage[]>(props.pages);
  const [liveReading, setLiveReading] = useState<ReadingSettings>(props.reading);
  const [reloadKey, setReloadKey] = useState(0);
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [device, setDevice] = useState<Device>('desktop');
  const [panel, setPanel] = useState<RailPanelId | null>(props.requestedPanel ?? null);
  // Where the Sections panel adds the next section (＋ Add section on the canvas, #44).
  const [sectionsAt, setSectionsAt] = useState<number | null>(null);
  const [tab, setTab] = useState<InspectorTabId>('content');
  const [mode, setModeState] = useState<StudioMode>(props.mode ?? DEFAULT_MODE);
  // The command palette (#33), and its way to open the Publish list.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [publishSignal, setPublishSignal] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'publish' | 'discard' | 'revert' | null>(null);
  const [pendingTarget, setPendingTarget] = useState<CanvasTarget | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [stale, setStale] = useState<string[]>([]);
  const handle = useRef<StudioEditorHandle | null>(null);
  const draft = useDraft({ onError: (message) => toast(message, { tone: 'danger' }) });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // The site's styles as the draft leaves them, on the canvas and in the Styles panel (#46).
  const siteStyles = useSiteStyles({ draft, enabled: props.user.canEditTheme });
  // The canvas holds edits not handed to the draft yet (the editor reports them after a pause).
  const editing = useRef(false);

  // The site's pages and home page as the draft leaves them (#29).
  const allPages = useMemo(() => draftPages(livePages, draft.entries), [livePages, draft.entries]);
  const pages = useMemo(
    () => editablePages(allPages, { id: props.user.id, editOthers: props.user.canEditOthersPages }),
    [allPages, props.user.id, props.user.canEditOthersPages],
  );
  const reading = useMemo(
    () => draftReading(liveReading, draft.entries),
    [liveReading, draft.entries],
  );
  const pagesRef = useRef(allPages);
  pagesRef.current = allPages;
  const readingRef = useRef(reading);
  readingRef.current = reading;

  const postsOnFront = reading.show_on_front !== 'page' || !reading.page_on_front;
  const frontPageId = frontPage(reading);
  const homeTarget = (): CanvasTarget =>
    initialTarget(undefined, readingRef.current, pagesRef.current);

  // Narrow screens: the inspector becomes a drawer.
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  // The theme's editor settings, templates and parts, and the user's open draft: once.
  useEffect(() => {
    let live = true;
    Promise.all([
      api<ThemeEditorSettings>('/wp-block-editor/v1/settings?context=site-editor'),
      api<RestTemplate[]>('/wp/v2/templates?context=edit'),
      loadLiveParts(),
      api<{ id: number }>('/wp-block-editor/v1/navigation-fallback').catch(() => null),
      api<Changeset[]>('/pressbase/v1/changesets').catch(() => [] as Changeset[]),
      api<RestTemplate[]>('/wp/v2/templates?post_type=page&context=edit').catch(
        () => [] as RestTemplate[],
      ),
    ])
      .then(([theme, templates, parts, fallback, open, forPages]) => {
        if (!live) return;
        const changeset = open.find((c) => c.uuid === props.requestedChangeset) ?? open[0] ?? null;
        draftRef.current.resume(changeset);
        setLibrary({
          theme,
          templates,
          pageTemplates: forPages.map((t) => ({
            slug: t.slug,
            title: t.title.raw || t.title.rendered || t.slug,
          })),
          navigationFallback: fallback?.id || null,
        });
        setLiveParts(parts);
        setOpened(true);
        if (changeset?.count) {
          toast(
            sprintf(
              _n(
                'Your draft is back: %d change isn’t published yet.',
                'Your draft is back: %d changes aren’t published yet.',
                changeset.count,
                'pressbase-admin',
              ),
              changeset.count,
            ),
          );
          checkStale(changeset, parts, props.timeZone).then((keys) => live && setStale(keys));
        }
      })
      .catch((error) => live && setFailed(errorMessage(error)));
    return () => {
      live = false;
    };
  }, []);

  // The page on the canvas, whenever the target changes (or the draft is discarded).
  useEffect(() => {
    if (!library || !liveParts || !opened) return;
    let live = true;
    setDoc(null);
    const load = async () => {
      let page: EditablePage | undefined;
      if (target.kind === 'page') {
        // The page as the draft leaves it: its template may be a draft change (#29).
        const drafted = pagesRef.current.find((p) => p.id === target.id);
        if (isNewPage(target.id)) {
          // A page the draft adds: nothing on it yet but what the draft holds.
          if (!drafted) {
            throw new Error(__('This page isn’t in your draft any more.', 'pressbase-admin'));
          }
          page = { ...drafted, content: { raw: '' } };
        } else {
          const fetched = await api<EditablePage>(`/wp/v2/pages/${target.id}?context=edit`);
          page = { ...fetched, template: drafted?.template ?? fetched.template };
        }
      }
      const next = buildDoc(
        target,
        library,
        liveParts,
        readingRef.current,
        draftRef.current.entries,
        page,
      );
      if (!next) throw new Error(__('The theme has no template for this page.', 'pressbase-admin'));
      if (live) setDoc(next);
    };
    load().catch((error) => live && setFailed(errorMessage(error)));
    // Keep the address in step, so a reload opens the same page.
    const url = new URL(window.location.href);
    if (target.kind === 'page' && !isNewPage(target.id)) {
      url.searchParams.set('page', String(target.id));
    } else url.searchParams.delete('page');
    url.searchParams.delete('changeset_uuid');
    window.history.replaceState(window.history.state, '', url);
    return () => {
      live = false;
    };
    // liveParts and the reading settings are read when a page opens; a change to them doesn't rebuild the canvas.
  }, [library, opened, target, reloadKey, __]);

  // The latest posts stop being a page of their own once a page is the home page (#29).
  const leavingPosts = useRef(false);
  useEffect(() => {
    if (!opened || target.kind !== 'posts' || postsOnFront || leavingPosts.current) return;
    leavingPosts.current = true;
    chooseTarget(homeTarget()).finally(() => {
      leavingPosts.current = false;
    });
  });

  // Edits not in the draft yet: the browser asks before leaving.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      handle.current?.report();
      if (editing.current || draftRef.current.unsaved) event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /** Hands the canvas's edits to the draft and writes them now. */
  const saveNow = useCallback(async () => {
    handle.current?.report();
    return draftRef.current.flush();
  }, []);

  const chooseTarget = async (next: CanvasTarget) => {
    if (sameTarget(next, target)) return;
    try {
      // Saved first, so the page opens with the header as just edited.
      await saveNow();
      setTarget(next);
    } catch {
      setPendingTarget(next);
    }
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

  /** Saves the canvas to the draft, then opens the page again (a new template, say). */
  const reloadCanvas = async () => {
    try {
      await saveNow();
      setReloadKey((k) => k + 1);
    } catch (error) {
      toast(errorMessage(error), { tone: 'danger' });
    }
  };

  const preview = async () => {
    const link = doc?.page
      ? doc.page.link || newPageLink(props.site.url, pagesRef.current, doc.page.id)
      : props.site.url;
    // Opened now, while the click still counts as the user's: popup blockers allow it.
    const win = window.open('about:blank', '_blank');
    if (win) win.opener = null;
    setBusy('preview');
    try {
      const changeset = await saveNow();
      // The page itself, with the draft laid over it (changeset_uuid; see changesets.md#preview).
      const url = changeset?.count ? previewUrl(link, changeset) : link;
      if (win) win.location.href = url;
      else window.open(url, '_blank', 'noopener');
    } catch (error) {
      win?.close();
      toast(errorMessage(error), { tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const publish = async (): Promise<boolean> => {
    setBusy('publish');
    try {
      handle.current?.report();
      await draft.publish();
      await handle.current?.markPublished();
      setStale([]);
      const link = doc?.page?.link;
      toast(__('Published. Your changes are live.', 'pressbase-admin'), {
        action: link
          ? {
              label: __('View page', 'pressbase-admin'),
              onClick: () => window.open(link, '_blank', 'noopener'),
            }
          : undefined,
      });
      // Pages opened from now on start from the parts as published.
      loadLiveParts()
        .then(setLiveParts)
        .catch(() => {});
      // The pages and home page as published; a page the draft added has its ID now.
      const openedTarget = target;
      Promise.all([api<StudioPage[]>(PAGES_PATH), api<SiteIndex>('/')])
        .then(([nextPages, index]) => {
          setLivePages(nextPages);
          setLiveReading({
            show_on_front: index.show_on_front ?? 'posts',
            page_on_front: Number(index.page_on_front) || 0,
          });
          if (openedTarget.kind === 'page' && isNewPage(openedTarget.id)) {
            const created = nextPages.find((p) => p.slug === openedTarget.id);
            if (created) setTarget({ kind: 'page', id: created.id });
          }
        })
        .catch(() => {});
      return true;
    } catch (error) {
      toast(errorMessage(error), { tone: 'danger' });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const revert = async (key: string) => {
    setBusy('revert');
    try {
      // On the canvas: put the region back (one undo step); the draft follows.
      const onCanvas = handle.current?.revertRegion(key) ?? false;
      if (onCanvas) await saveNow();
      // A page's entry also holds the Pages panel's changes (title, place, template).
      const ref = refOfKey(key);
      const fields = (draft.entries[key]?.value ?? {}) as { template?: string };
      if (!onCanvas || ref !== null) await draft.revert(key);
      if (ref !== null && target.kind === 'page' && target.id === ref) {
        if (isNewPage(ref)) setTarget(homeTarget());
        else if (fields.template !== undefined) setReloadKey((k) => k + 1);
      }
    } catch (error) {
      toast(errorMessage(error), { tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const discardAll = async () => {
    setBusy('discard');
    try {
      handle.current?.discardEdits();
      await draft.discard();
      setStale([]);
      // A page the draft added is gone with it.
      if (target.kind === 'page' && isNewPage(target.id)) setTarget(homeTarget());
      else setReloadKey((k) => k + 1);
      toast(
        __('Your changes were discarded. The page shows what visitors see.', 'pressbase-admin'),
      );
    } catch (error) {
      toast(errorMessage(error), { tone: 'danger' });
    } finally {
      setBusy(null);
      setConfirmDiscard(false);
    }
  };

  const drafted = doc?.page ? allPages.find((p) => p.id === doc.page?.id) : undefined;
  const summary: PageSummary | null = doc
    ? {
        title: doc.page ? pageTitle(drafted ?? doc.page) : __('Latest posts', 'pressbase-admin'),
        isHome: isHome(doc.target, reading),
        status: doc.page
          ? isNewPage(doc.page.id)
            ? __('New: goes live when you publish', 'pressbase-admin')
            : statusLabel(drafted?.status ?? doc.page.status, __)
          : undefined,
        template: doc.template.title.raw || doc.template.title.rendered || doc.template.slug,
        editLink: doc.page && !isNewPage(doc.page.id) ? `/admin/pages/${doc.page.id}` : undefined,
        hasContent:
          Boolean(doc.page) && pageBlocks(doc.blocks as unknown as CanvasBlock[]) !== null,
        templateSlug: drafted?.template ?? doc.page?.template ?? '',
        templates: library?.pageTemplates,
        onTemplate:
          doc.page && library?.pageTemplates.length
            ? (slug) => {
                const ref = doc.page?.id;
                if (ref === undefined) return;
                draft.wantFields(fieldChange(ref, 'template', slug, livePages));
                reloadCanvas();
              }
            : undefined,
      }
    : null;

  const parts = useMemo(
    () =>
      new Map<string, PartInfo>(
        [...(liveParts?.values() ?? [])].map(({ part, themeFile }) => [
          part.slug,
          {
            title: part.title.raw || part.title.rendered || part.slug,
            area: part.area ?? '',
            customised:
              part.source === 'custom' && Boolean(part.has_theme_file) && themeFile !== undefined,
          },
        ]),
      ),
    [liveParts],
  );

  const changes: PendingChange[] = draft.keys.map((key) => ({
    key,
    ...describeChange(
      key,
      draft.entries[key],
      {
        page: (id) => {
          const found = allPages.find((p) => p.id === id);
          return found ? pageTitle(found) : undefined;
        },
        part: (slug) => parts.get(slug)?.title,
      },
      __,
    ),
  }));

  const staleNames = stale.map((key) => changes.find((c) => c.key === key)?.title ?? key);

  /** Simple or Advanced (#32): shown at once, remembered for the person in their user meta. */
  const setMode = (next: StudioMode) => {
    if (next === mode) return;
    setModeState(next);
    api('/wp/v2/users/me', {
      method: 'POST',
      body: { meta: { [STUDIO_MODE_META]: next } },
    }).catch(() =>
      toast(
        __(
          'Studio couldn’t remember this choice for next time. It applies until you leave.',
          'pressbase-admin',
        ),
        { tone: 'danger' },
      ),
    );
  };

  // Studio's AI panel and AI edits (#62, #57): the conversation, and a set waiting for Keep or Undo.
  const ai = useStudioAi({
    edits: {
      draft,
      pages: allPages,
      siteUrl: props.site.url,
      can: {
        styles: props.user.canEditTheme,
        parts: props.user.canEditTheme,
        pages: props.user.canPublishPages,
      },
    },
    changesetUuid: draft.changeset?.uuid ?? null,
    page: doc?.page ? { id: doc.page.id, slug: doc.page.slug } : null,
    saveNow,
  });

  // Ask AI on a section or selected text, and prompts to a section or page (#63).
  const ask = useAskAi({
    ai,
    page: doc?.page ? { id: doc.page.id, slug: doc.page.slug } : null,
    pages: allPages,
    saveNow,
    onOpenPage: (id) => chooseTarget({ kind: 'page', id }),
    onOpenHome: useCallback(() => setTarget(homeTarget()), []),
    onOpenPanel: () => openPanel('ai'),
    onDone: (message) => toast(message),
  });
  // "Before you publish" (#61): what's left in the draft; Publish asks first when something is.
  const checklist = useChecklist({ saveNow, changesetUuid: draft.changeset?.uuid ?? null });
  const goToItem = (item: ChecklistItem) => {
    checklist.select(item);
    if (item.page !== null && !sameTarget({ kind: 'page', id: item.page }, target)) {
      chooseTarget({ kind: 'page', id: item.page });
    }
  };
  const publishChecked = () => checklist.guard(publish);
  const editorReady = Boolean(doc && library && assets && plugins.ready && summary);

  /* ------------------------------------------------- command palette (#33) */

  usePaletteShortcut(() => setPaletteOpen(true));
  // Commands call the latest version of each action, whatever render registered them.
  const actions = useRef({ chooseTarget, preview, setMode });
  actions.current = { chooseTarget, preview, setMode };
  const openPanel = (id: RailPanelId) => {
    setPanel(id);
    setSectionsAt(null);
  };
  const changeCount = changes.length;
  const targetKey = target.kind === 'page' ? String(target.id) : 'posts';
  useStudioCommands(() => {
    const deviceIcons = { desktop: Monitor, tablet: Tablet, mobile: Smartphone } as const;
    const now = __('Open now', 'pressbase-admin');
    return [
      {
        id: 'pressbase/preview',
        label: __('Preview in a new tab', 'pressbase-admin'),
        group: 'actions',
        keywords: [__('see', 'pressbase-admin'), __('view', 'pressbase-admin')],
        icon: <Eye size={16} />,
        disabled: !editorReady,
        run: () => actions.current.preview(),
      },
      {
        id: 'pressbase/publish',
        label: changeCount
          ? sprintf(
              _n('Publish %d change', 'Publish %d changes', changeCount, 'pressbase-admin'),
              changeCount,
            )
          : __('Publish', 'pressbase-admin'),
        group: 'actions',
        keywords: [__('go live', 'pressbase-admin'), __('save', 'pressbase-admin')],
        hint: changeCount ? undefined : __('Nothing to publish yet', 'pressbase-admin'),
        icon: <Send size={16} />,
        disabled: !changeCount || !editorReady,
        run: () => setPublishSignal((n) => n + 1),
      },
      {
        id: 'pressbase/discard',
        label: __('Discard all changes', 'pressbase-admin'),
        group: 'actions',
        icon: <Trash2 size={16} />,
        disabled: !changeCount,
        run: () => setConfirmDiscard(true),
      },
      {
        id: 'pressbase/dashboard',
        label: __('Back to the dashboard', 'pressbase-admin'),
        group: 'actions',
        keywords: [__('leave', 'pressbase-admin'), __('exit', 'pressbase-admin')],
        icon: <ArrowLeft size={16} />,
        run: () => {
          window.location.href = '/admin';
        },
      },
      ...(postsOnFront
        ? [
            {
              id: 'pressbase/page/posts',
              label: __('Home (latest posts)', 'pressbase-admin'),
              group: 'pages',
              keywords: [__('home page', 'pressbase-admin')],
              hint: targetKey === 'posts' ? now : undefined,
              icon: <FileText size={16} />,
              run: () => actions.current.chooseTarget({ kind: 'posts' }),
            },
          ]
        : []),
      ...pages.map((page) => {
        const current = String(page.id) === targetKey;
        const home = page.id === frontPageId && !postsOnFront;
        return {
          id: `pressbase/page/${page.id}`,
          label: pageTitle(page),
          group: 'pages',
          keywords: [
            __('page', 'pressbase-admin'),
            ...(home ? [__('home page', 'pressbase-admin')] : []),
          ],
          hint: current
            ? now
            : home
              ? __('Home page', 'pressbase-admin')
              : isNewPage(page.id)
                ? __('New', 'pressbase-admin')
                : page.status !== 'publish'
                  ? __('Draft', 'pressbase-admin')
                  : undefined,
          icon: <FileText size={16} />,
          run: () => actions.current.chooseTarget({ kind: 'page', id: page.id }),
        };
      }),
      ...RAIL_PANELS.map((railPanel) => {
        const Icon = RAIL_ICONS[railPanel.id];
        return {
          id: `pressbase/panel/${railPanel.id}`,
          label: sprintf(
            __('Open the %s panel', 'pressbase-admin'),
            __(railPanel.label, 'pressbase-admin'),
          ),
          group: 'panels',
          keywords: [__(railPanel.summary, 'pressbase-admin')],
          hint: panel === railPanel.id ? now : undefined,
          icon: <Icon size={16} />,
          run: () => openPanel(railPanel.id),
        };
      }),
      {
        id: 'pressbase/mode',
        label:
          mode === 'simple'
            ? __('Switch to Advanced settings', 'pressbase-admin')
            : __('Switch to Simple settings', 'pressbase-admin'),
        group: 'view',
        keywords: [__('mode', 'pressbase-admin'), __('inspector', 'pressbase-admin')],
        icon: <SlidersHorizontal size={16} />,
        run: () => actions.current.setMode(mode === 'simple' ? 'advanced' : 'simple'),
      },
      ...DEVICES.map((d) => {
        const Icon = deviceIcons[d.id];
        return {
          id: `pressbase/device/${d.id}`,
          label: sprintf(
            __('Switch to %s view', 'pressbase-admin'),
            __(d.label, 'pressbase-admin'),
          ),
          group: 'view',
          keywords: [__('device', 'pressbase-admin'), __('size', 'pressbase-admin')],
          hint: device === d.id ? now : undefined,
          icon: <Icon size={16} />,
          run: () => setDevice(d.id),
        };
      }),
    ];
  }, [
    __,
    _n,
    sprintf,
    pages,
    targetKey,
    postsOnFront,
    frontPageId,
    panel,
    mode,
    device,
    changeCount,
    editorReady,
  ]);

  const chrome: Chrome = {
    topBar: (editor) => (
      <TopBar
        pages={pages}
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
        onAskAi={() => openPanel('ai')}
        changes={changes}
        draftStatus={draft.status}
        onRetrySave={() => {
          saveNow().catch((error) => toast(errorMessage(error), { tone: 'danger' }));
        }}
        busy={busy}
        onPreview={preview}
        onPublish={publishChecked}
        onRevert={revert}
        onDiscardAll={() => setConfirmDiscard(true)}
        onOpenPalette={() => setPaletteOpen(true)}
        publishSignal={publishSignal}
        publishNote={
          <PublishChecklistNote checklist={checklist} onOpen={() => openPanel('checklist')} />
        }
        inspectorOpen={!narrow || inspectorOpen}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
        disabled={!editor}
      />
    ),
    rail: (
      <Rail
        open={panel}
        onToggle={(id) => {
          setPanel((open) => (open === id ? null : id));
          setSectionsAt(null);
        }}
      />
    ),
    panel: (editor) =>
      panel && (
        <RailPanelView
          id={panel}
          onClose={() => {
            setPanel(null);
            setSectionsAt(null);
          }}
          note={
            panel === 'styles' && !props.user.canEditTheme ? (
              <p className={styles.panelNote}>
                <Lock size={16} aria-hidden="true" />
                <span>
                  {__(
                    'Only people who can change the site’s design can change its styles. You can edit your pages.',
                    'pressbase-admin',
                  )}
                </span>
              </p>
            ) : undefined
          }
          content={
            panel === 'pages' ? (
              <PagesPanel
                pages={pages}
                target={target}
                postsOnFront={postsOnFront}
                frontPageId={frontPageId}
                onTarget={(next) => {
                  chooseTarget(next);
                  if (narrow) setPanel(null);
                }}
                can={{
                  add: props.user.canPublishPages,
                  arrange: props.user.canEditOthersPages,
                  home: props.user.canManageOptions,
                }}
                onAdd={(title) => {
                  const entry = newPageEntry(title, allPages);
                  draft.wantFields(new Map([[entry.key, entry.value as Record<string, unknown>]]));
                  chooseTarget({ kind: 'page', id: entry.slug });
                }}
                onRename={(ref, title) =>
                  draft.wantFields(fieldChange(ref, 'title', title, livePages))
                }
                onMove={(ref, to) => {
                  const arranged = movePage(allPages, ref, to);
                  if (!arranged) return false;
                  if (arranged.size) draft.wantFields(arrangementChanges(arranged, livePages));
                  return true;
                }}
                onHome={(id) => {
                  draft.want(homePageEntries(id, liveReading));
                  // A theme with a front-page template shows the home page in it.
                  if (library?.templates.some((t) => t.slug === 'front-page')) reloadCanvas();
                }}
              />
            ) : panel === 'elements' ? (
              editorReady ? (
                <ElementsPanel />
              ) : (
                <p className={styles.pagesEmpty} aria-busy="true">
                  {__('Opening the page…', 'pressbase-admin')}
                </p>
              )
            ) : panel === 'sections' ? (
              editorReady ? (
                <SectionsPanel
                  insertAt={sectionsAt}
                  onClearInsertAt={() => setSectionsAt(null)}
                  onInserting={(title) =>
                    editor?.labelNext(sprintf(__('Added section “%s”', 'pressbase-admin'), title))
                  }
                  onInserted={(title) =>
                    toast(sprintf(__('Section added: %s.', 'pressbase-admin'), title))
                  }
                />
              ) : (
                <p className={styles.pagesEmpty} aria-busy="true">
                  {__('Opening the page…', 'pressbase-admin')}
                </p>
              )
            ) : panel === 'styles' ? (
              props.user.canEditTheme && (
                <StylesPanel
                  site={siteStyles}
                  mode={mode}
                  onMode={setMode}
                  canEditCss={props.canUnfilteredHtml}
                  canPreview={Boolean(editor)}
                />
              )
            ) : panel === 'history' ? (
              editor && doc ? (
                <HistoryPanel
                  entries={editor.history.entries}
                  index={editor.history.index}
                  onGo={editor.history.go}
                  partTitle={(slug) => parts.get(slug)?.title ?? slug}
                  page={
                    doc.page && typeof doc.page.id === 'number' && !isNewPage(doc.page.id)
                      ? {
                          id: doc.page.id,
                          title: pageTitle(drafted ?? doc.page),
                          live: doc.regions.get(pageKey(doc.page.id))?.live ?? '',
                        }
                      : undefined
                  }
                  onRestorePage={(content, when) => {
                    const label = sprintf(
                      __('Restored the version from %s', 'pressbase-admin'),
                      when,
                    );
                    if (editor.restorePage(content, label)) {
                      toast(
                        sprintf(
                          __(
                            'The version from %s is on the page and in your draft. Publish to make it live.',
                            'pressbase-admin',
                          ),
                          when,
                        ),
                      );
                    }
                  }}
                  canEditStyles={props.user.canEditTheme}
                  onRestoreStyles={(stylesheet, config, when) => {
                    draft.want(new Map([[`wp_global_styles:${stylesheet}`, config]]));
                    toast(
                      sprintf(
                        __(
                          'The site’s styles from %s are in your draft. Preview to see them; they go live when you publish.',
                          'pressbase-admin',
                        ),
                        when,
                      ),
                    );
                  }}
                  siteUrl={props.site.url}
                  userId={props.user.id}
                />
              ) : (
                <p className={styles.pagesEmpty} aria-busy="true">
                  {__('Opening the page…', 'pressbase-admin')}
                </p>
              )
            ) : panel === 'ai' ? (
              <AiPanel ai={ai} />
            ) : panel === 'checklist' ? (
              <ChecklistPanel checklist={checklist} onGo={goToItem} />
            ) : undefined
          }
        />
      ),
    // AI edits (#57): the highlight, Keep and Undo over the canvas, and the AI commands.
    overlay: (editor) => (
      <>
        <AiReview
          ai={ai}
          canvas={editor?.canvas ?? null}
          panelOpen={panel === 'ai'}
          onOpenPanel={() => openPanel('ai')}
        />
        {/* The checklist (#61): placeholders marked on the canvas, and the block an item opens. */}
        {editor && (
          <>
            <PlaceholderMarks />
            <ChecklistSelect
              checklist={checklist}
              canvas={editor.canvas}
              onNotFound={() =>
                toast(
                  __('That block isn’t on the page any more. Check again.', 'pressbase-admin'),
                )
              }
            />
          </>
        )}
      </>
    ),
    notice: (
      <>
        {props.requestedRun && opened && (
          <SiteBuilderNote
            runId={props.requestedRun}
            isOpenable={(slug) => allPages.some((p) => p.slug === slug)}
            onOpenChecklist={() => openPanel('checklist')}
            onOpenPage={(slug) => {
              const page = allPages.find((p) => p.slug === slug);
              if (page) chooseTarget({ kind: 'page', id: page.id });
            }}
          />
        )}
        {stale.length > 0 && (
          <div className={styles.stageNotice} role="status" data-tone="warning">
            <Info size={16} aria-hidden="true" />
            <p>
              {sprintf(
                __(
                  'Since you last worked on your draft, someone published changes to %s. If you publish your draft, your version replaces theirs.',
                  'pressbase-admin',
                ),
                staleNames.join(', '),
              )}
            </p>
            <Button
              size="sm"
              variant="ghost"
              className={styles.iconButton}
              icon={<X size={16} aria-hidden="true" />}
              aria-label={__('Dismiss', 'pressbase-admin')}
              onClick={() => setStale([])}
            />
          </div>
        )}
      </>
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
        library={siteStyles.withStyles(library)}
        assets={assets}
        features={features}
        canUnfilteredHtml={props.canUnfilteredHtml}
        site={props.site.name}
        summary={summary}
        parts={parts}
        device={device}
        tab={tab}
        onTab={setTab}
        mode={mode}
        onMode={setMode}
        narrow={narrow}
        inspectorOpen={inspectorOpen}
        onCloseInspector={() => setInspectorOpen(false)}
        chrome={chrome}
        onEditing={(value) => {
          editing.current = value;
        }}
        onWant={(entries) => {
          // Page entries are shared with the Pages panel: the canvas sets only `content`.
          const plain = new Map<string, EntryValue | null>();
          const fields = new Map<string, Record<string, unknown>>();
          for (const [key, value] of entries) {
            if (refOfKey(key) !== null) fields.set(key, { content: entryContent(value) });
            else plain.set(key, value);
          }
          if (plain.size) draft.want(plain);
          if (fields.size) draft.wantFields(fields);
        }}
        partsLocked={!props.user.canEditTheme}
        onAddSection={(index) => {
          setSectionsAt(index);
          setPanel('sections');
        }}
        onOpenPalette={() => setPaletteOpen(true)}
        onSectionAdded={(title, phase) => {
          if (phase === 'after') toast(sprintf(__('Section added: %s.', 'pressbase-admin'), title));
        }}
        drafted={(key) => key in draft.entries}
        draftEntries={draft.entries}
        onReady={(h) => {
          handle.current = h;
        }}
        onNotice={(message, tone) => toast(message, { tone })}
        onSwapped={(message, undo) =>
          toast(message, { action: { label: __('Undo', 'pressbase-admin'), onClick: undo } })
        }
      />
    );
  }

  return (
    <ShortcutProvider className={styles.root}>
      <EditorUiStylesheets />
      <AskAiProvider value={ask.open}>{content}</AskAiProvider>
      <AskAiDialog ask={ask} />
      <PublishCheckDialog checklist={checklist} onGo={goToItem} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ConfirmDialog
        open={pendingTarget !== null}
        title={__('Your latest changes aren’t saved', 'pressbase-admin')}
        confirmLabel={__('Leave without them', 'pressbase-admin')}
        onCancel={() => setPendingTarget(null)}
        onConfirm={() => {
          if (pendingTarget) setTarget(pendingTarget);
          setPendingTarget(null);
        }}
      >
        <p>
          {__(
            'Studio couldn’t save them to your draft. Stay to try again, or open the other page and lose them.',
            'pressbase-admin',
          )}
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDiscard}
        title={__('Discard all your changes?', 'pressbase-admin')}
        confirmLabel={__('Discard all', 'pressbase-admin')}
        busy={busy === 'discard'}
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={discardAll}
      >
        <p>
          {sprintf(
            _n(
              'The %d change in your draft will be thrown away. Your site stays as visitors see it now. This can’t be undone.',
              'The %d changes in your draft will be thrown away. Your site stays as visitors see it now. This can’t be undone.',
              changes.length,
              'pressbase-admin',
            ),
            changes.length,
          )}
        </p>
      </ConfirmDialog>
    </ShortcutProvider>
  );
}

/**
 * The draft's pages and parts that changed on the live site after the draft
 * did (changedSince()): someone else published them meanwhile.
 */
async function checkStale(
  changeset: Changeset,
  parts: ReadonlyMap<string, LivePart>,
  timeZone: string,
): Promise<string[]> {
  const live = new Map<string, LiveModified>();
  const pageIds = Object.keys(changeset.entries)
    .map(parseKey)
    .filter((k) => k.type === 'page' && Number(k.id) > 0)
    .map((k) => Number(k.id));
  if (pageIds.length) {
    const pages = await api<{ id: number; modified_gmt: string }[]>(
      `/wp/v2/pages?context=edit&per_page=100&status=publish,draft,pending,private,future&include=${pageIds.join(',')}`,
    ).catch(() => []);
    for (const page of pages) live.set(pageKey(page.id), { gmt: page.modified_gmt });
  }
  for (const [slug, { part }] of parts) {
    if (part.source === 'custom' && part.modified)
      live.set(partKey(slug), { local: part.modified });
  }
  return changedSince(changeset.entries, live, timeZone);
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
  /** The steps for the History panel (#34). */
  history: Pick<StudioHistory<CanvasValue>, 'entries' | 'index' | 'go'>;
  /** Names the next step (a section added from a panel). */
  labelNext: (label: string) => void;
  /** Puts a version of the page's content on the canvas as one named step; false if it can't. */
  restorePage: (content: string, label: string) => boolean;
  /** AI edits (#57): the canvas's regions, and replacing some as one named step. */
  canvas: AiCanvas;
}

interface Chrome {
  topBar: (editor: EditorState | null) => ReactNode;
  rail: ReactNode;
  panel: (editor: EditorState | null) => ReactNode;
  /** Over the canvas: AI changes waiting for Keep or Undo (#57). */
  overlay?: (editor: EditorState | null) => ReactNode;
  /** A note above the canvas (the draft changed on the live site meanwhile). */
  notice?: ReactNode;
}

/** The screen's layout, around whatever the canvas area holds. */
function StudioFrame({
  chrome,
  editor,
  children,
  footer,
  inspector,
  notice,
}: {
  chrome: Chrome;
  editor: EditorState | null;
  children: ReactNode;
  footer?: ReactNode;
  inspector?: ReactNode;
  notice?: ReactNode;
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
        {chrome.panel(editor)}
        {chrome.overlay?.(editor)}
        <main id="studio-canvas" className={styles.stage} tabIndex={-1}>
          {chrome.notice}
          {notice}
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
  /** Hands the canvas's edits to the draft now (instead of after the pause). */
  report(): void;
  /** Puts a region on the canvas back to what visitors see; false when it isn't on the canvas. */
  revertRegion(key: string): boolean;
  /** After publishing: what the canvas shows is what visitors see. */
  markPublished(): Promise<void>;
  /** Before discarding: drops edits held outside the canvas's blocks (site title, menus). */
  discardEdits(): void;
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
  mode: StudioMode;
  onMode: (mode: StudioMode) => void;
  narrow: boolean;
  inspectorOpen: boolean;
  onCloseInspector: () => void;
  chrome: Chrome;
  /** True while the canvas holds edits it hasn't reported yet. */
  onEditing: (editing: boolean) => void;
  /** The entries the canvas needs in the draft (null: none). */
  onWant: (entries: ReadonlyMap<string, EntryValue | null>) => void;
  /** Whether the draft has an entry for this key. */
  drafted: (key: string) => boolean;
  /** The draft's entries when the canvas opened (site title, menus: laid over core-data). */
  draftEntries: Readonly<Record<string, StoredEntry>>;
  onReady: (handle: StudioEditorHandle) => void;
  onNotice: (message: string, tone: 'success' | 'danger') => void;
  /** The header and footer are read-only for this person (no `edit_theme_options`, #29). */
  partsLocked: boolean;
  /** ＋ Add section on the canvas: opens the Sections panel at that place (#44). */
  onAddSection: (index: number) => void;
  /** ⌘K / Ctrl+K pressed in the canvas (#33). */
  onOpenPalette: () => void;
  /** A section added from the palette: before it goes in, and after. */
  onSectionAdded: (title: string, phase: 'before' | 'after') => void;
  /** A section swapped its layout (#45): says which, and offers Undo. */
  onSwapped: (message: string, undo: () => void) => void;
}

/** The block-editor store calls the editor makes outside React's render. */
interface StoreBridge {
  getBlocks: () => BlockInstance[];
  replaceInnerBlocks: (clientId: string, blocks: BlockInstance[], update?: boolean) => void;
  /** The block and its parents, outermost first. */
  chain: (clientId: string) => Pick<CanvasBlock, 'name' | 'clientId' | 'attributes'>[];
}

/** How long the canvas waits after an edit before working out what changed (serializing costs). */
const REPORT_DELAY = 300;

function StudioEditor(props: StudioEditorProps) {
  const { __, sprintf } = useI18n();
  const { doc } = props;
  const history = useStudioHistory<{ blocks: BlockInstance[]; selection?: unknown }>({
    blocks: doc.blocks,
  });
  const value = history.value as { blocks: BlockInstance[]; selection?: unknown };
  const blocksRef = useRef(value.blocks);
  blocksRef.current = value.blocks;
  const store = useRef<StoreBridge | null>(null);
  // Regions' live and opening markup; updated when a publish makes the canvas live.
  const regions = useRef(new Map(doc.regions));
  // Regions changed since opening: they always say what they need, even when back to the start.
  const touched = useRef(new Set<string>());
  const [, setVersion] = useState(0);
  const propsRef = useRef(props);
  propsRef.current = props;
  // Blocks that finish loading on their own (the Navigation block picking its
  // menu, say) can change the tree just after it opens. Those changes aren't
  // the user's, so they don't become undo steps: until the person first
  // presses a key or the pointer (or three seconds pass), changes are staged.
  const settled = useRef(false);
  const settle = () => {
    settled.current = true;
  };
  useEffect(() => {
    const timer = setTimeout(() => {
      settled.current = true;
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // The header's fallback menu. On a new site, the first request creates it, and the
  // Navigation block may have asked at the same moment; asked again once the canvas is up.
  const fallbackMenu = useRef(props.library.navigationFallback);

  /** Each region's state now: markup, and markup without changes nobody made. */
  const regionStates = useCallback((): RegionState[] => {
    const tree = (store.current?.getBlocks() ?? blocksRef.current) as unknown as CanvasBlock[];
    const { content, parts } = regionBlocks(tree);
    const fallback = fallbackMenu.current;
    const out: RegionState[] = [];
    for (const region of regions.current.values()) {
      const blocks = region.kind === 'content' ? content : parts.get(region.slug ?? '')?.blocks;
      if (!blocks) continue;
      const current = serialize(blocks as unknown as BlockInstance[]);
      const normalized = fallback
        ? serialize(withoutNavigationRef(blocks, fallback) as unknown as BlockInstance[])
        : undefined;
      out.push({
        key: region.key,
        live: region.live,
        initial: region.initial,
        current,
        normalized: normalized === current ? undefined : normalized,
        themeFile: region.customised ? region.theme : undefined,
      });
    }
    return out;
  }, []);

  // Site title, tagline, logo and menus: edited in core-data, saved as entries too.
  const [entityTick, setEntityTick] = useState(0);
  const entities = useEntityEdits({
    draft: props.draftEntries,
    onChange: () => setEntityTick((t) => t + 1),
  });
  const entitiesRef = useRef(entities);
  entitiesRef.current = entities;

  // Regions edited where the person was working: a change arrives with the
  // selection in it. Blocks that adjust themselves elsewhere on the canvas
  // (the Navigation block picking its menu, a block migrating its markup)
  // don't make the header or footer an edit.
  const edited = useRef(new Set<string>());
  const noteEdit = (selection: unknown) => {
    const clientId = (selection as { selectionStart?: { clientId?: string } } | undefined)
      ?.selectionStart?.clientId;
    if (!clientId || !store.current) return;
    const chain = store.current.chain(clientId);
    const part = partOf(chain);
    if (part) edited.current.add(partKey(part.slug));
    else if (chain.some((b) => b.name === 'core/post-content') && doc.page) {
      edited.current.add(pageKey(doc.page.id));
    }
  };

  const report = useCallback(() => {
    const wants = entitiesRef.current.wants();
    for (const state of regionStates()) {
      if (!touched.current.has(state.key) && !edited.current.has(state.key)) continue;
      if (!touched.current.has(state.key) && !regionChanged(state)) continue;
      touched.current.add(state.key);
      wants.set(state.key, desiredEntry(state));
    }
    propsRef.current.onEditing(false);
    if (wants.size) propsRef.current.onWant(wants);
  }, [regionStates]);

  useEffect(() => {
    if (!entityTick) return;
    const timer = setTimeout(report, REPORT_DELAY);
    return () => clearTimeout(timer);
  }, [entityTick, report]);

  const replaceRegion = useCallback(
    (key: string, markup: string): boolean => {
      const region = regions.current.get(key);
      if (!region || !store.current) return false;
      const tree = store.current.getBlocks() as unknown as CanvasBlock[];
      const clientId =
        region.kind === 'content'
          ? findRegions(tree).find((r) => r.kind === 'content')?.clientId
          : regionBlocks(tree).parts.get(region.slug ?? '')?.clientId;
      if (!clientId) return false;
      const blocks = parse(markup);
      store.current.replaceInnerBlocks(
        clientId,
        region.kind === 'part' ? withTheme(blocks, doc.template.theme) : blocks,
      );
      touched.current.add(key);
      report();
      setVersion((v) => v + 1);
      return true;
    },
    [doc.template.theme, report],
  );

  useEffect(() => {
    props.onReady({
      report,
      revertRegion: (key) => {
        const region = regions.current.get(key);
        if (region) return replaceRegion(key, region.live);
        if (!entitiesRef.current.revert(key)) return false;
        report();
        return true;
      },
      discardEdits: () => entitiesRef.current.clear(),
      markPublished: async () => {
        for (const state of regionStates()) {
          const region = regions.current.get(state.key);
          // Regions the draft didn't change are as they were.
          if (!region || (!touched.current.has(state.key) && region.initial === region.live)) {
            continue;
          }
          regions.current.set(state.key, {
            ...region,
            live: state.current,
            initial: state.current,
            // Back to the theme's file (a reset), or a customised copy of it now.
            customised:
              region.kind === 'part'
                ? (state.normalized ?? state.current) !== region.theme
                : undefined,
          });
        }
        touched.current.clear();
        edited.current.clear();
        setVersion((v) => v + 1);
        await entitiesRef.current.refresh();
      },
    });
  }, []);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api<{ id: number }>('/wp-block-editor/v1/navigation-fallback')
        .then((menu) => {
          if (!live || !menu?.id || menu.id === fallbackMenu.current) return;
          fallbackMenu.current = menu.id;
          if (touched.current.size) report();
        })
        .catch(() => {});
    }, 1500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [report]);

  // What changed, a moment after each edit (serializing is the expensive part).
  useEffect(() => {
    if (value.blocks === doc.blocks) return;
    propsRef.current.onEditing(true);
    const timer = setTimeout(report, REPORT_DELAY);
    return () => clearTimeout(timer);
  }, [value.blocks, doc.blocks, report]);

  const settings = useMemo(() => {
    const {
      styles: themeStyles,
      __unstableResolvedAssets: _assets,
      ...themeSettings
    } = props.library.theme;
    const base = {
      ...editorSettings({
        features: props.features,
        canUnfilteredHtml: props.canUnfilteredHtml,
        // A page the draft adds has no ID yet: nothing to attach uploads to.
        postId: typeof doc.page?.id === 'number' ? doc.page.id : undefined,
        assets: props.assets,
        context: 'studio',
      }),
      // The theme's palette, font sizes, spacing and layout (theme.json), as WordPress's site editor gets them.
      ...themeSettings,
      styles: themeStyles,
      // Sections from patterns stay fully editable: Studio is for building pages.
      disableContentOnlyForUnsyncedPatterns: true,
    };
    // Simple offers the theme's presets only (#32, mode-model.ts).
    return modeEditorSettings(base, props.mode);
  }, [
    props.features,
    props.canUnfilteredHtml,
    props.assets,
    props.library.theme,
    doc.page?.id,
    props.mode,
  ]);

  const editor: EditorState = {
    canUndo: history.hasUndo,
    canRedo: history.hasRedo,
    undo: history.undo,
    redo: history.redo,
    history: history as unknown as EditorState['history'],
    labelNext: history.labelNext,
    restorePage: (content, label) => {
      if (!doc.page) return false;
      history.labelNext(label);
      return replaceRegion(pageKey(doc.page.id), content);
    },
    canvas: {
      key: doc.key,
      regions: () => {
        const tree = (store.current?.getBlocks() ?? blocksRef.current) as unknown as CanvasBlock[];
        const { content, parts } = regionBlocks(tree);
        const out = new Map<string, BlockInstance[]>();
        for (const region of regions.current.values()) {
          const blocks = region.kind === 'content' ? content : parts.get(region.slug ?? '')?.blocks;
          if (blocks) out.set(region.key, blocks as unknown as BlockInstance[]);
        }
        return out;
      },
      replace: (next, label) => {
        const tree = (store.current?.getBlocks() ?? blocksRef.current) as unknown as CanvasBlock[];
        const { parts } = regionBlocks(tree);
        const inner = new Map<string, BlockInstance[]>();
        for (const [key, blocks] of next) {
          const region = regions.current.get(key);
          const clientId =
            region?.kind === 'content'
              ? findRegions(tree).find((r) => r.kind === 'content')?.clientId
              : parts.get(region?.slug ?? '')?.clientId;
          if (!region || !clientId) return null;
          inner.set(
            clientId,
            region.kind === 'part' ? withTheme(blocks, doc.template.theme) : blocks,
          );
        }
        for (const key of next.keys()) touched.current.add(key);
        // One step, named after the set: History lists it, and undo takes it all back.
        history.labelNext(label);
        history.setValue({
          blocks: withInnerBlocks(tree, inner) as unknown as BlockInstance[],
        });
        setVersion((v) => v + 1);
        return history.index + 1;
      },
      step: () => history.index,
      undo: history.undo,
      menuId: () => {
        const tree = (store.current?.getBlocks() ?? blocksRef.current) as unknown as CanvasBlock[];
        for (const part of regionBlocks(tree).parts.values()) {
          const ref = navigationRef(part.blocks);
          if (ref) return ref;
        }
        return fallbackMenu.current;
      },
    },
  };
  const canvasEvents = useMemo(
    () => ({
      labelNext: history.labelNext,
      onSwapped: (message: string) => propsRef.current.onSwapped(message, history.undo),
    }),
    [history.labelNext, history.undo],
  );
  const width = DEVICES.find((d) => d.id === props.device)?.width ?? null;
  const frameRef = useRef<HTMLDivElement>(null);
  const showInspector = !props.narrow || props.inspectorOpen;

  /** A part can go back to the theme's design: it's customised, or edited in the draft. */
  const canReset = (slug: string) => {
    const region = regions.current.get(partKey(slug));
    if (region?.kind !== 'part') return false;
    return (
      Boolean(region.customised) || props.drafted(region.key) || touched.current.has(region.key)
    );
  };

  return (
    <BlockEditorProvider
      value={value.blocks}
      selection={value.selection as never}
      onInput={(blocks, { selection }) => {
        noteEdit(selection);
        history.setValue({ blocks, selection }, true);
      }}
      onChange={(blocks, { selection }) => {
        noteEdit(selection);
        history.setValue({ blocks, selection }, !settled.current);
      }}
      settings={settings}
      useSubRegistry
    >
      <UndoShortcuts undo={history.undo} redo={history.redo} />
      <NoticesBridge onNotice={props.onNotice} />
      <MediaCategories enabled={props.features.media} />
      <EditingModes blocks={doc.blocks} partsEditable={!props.partsLocked} />
      <StoreBridgeSetter bridge={store} />
      <EditorCommands
        canUndo={history.hasUndo}
        canRedo={history.hasRedo}
        undo={history.undo}
        redo={history.redo}
        onSectionAdded={(title, phase) => {
          if (phase === 'before') {
            history.labelNext(sprintf(__('Added section “%s”', 'pressbase-admin'), title));
          }
          props.onSectionAdded(title, phase);
        }}
      />
      {/* React events bubble out of the canvas iframe's portal, so this sees typing there too. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: listens for keys pressed in the canvas. */}
      <div
        className={styles.contents}
        onKeyDownCapture={settle}
        onPointerDownCapture={settle}
        onKeyDown={(event) => {
          // ⌘K / Ctrl+K in the canvas: Studio's own window doesn't hear key presses in the iframe.
          const target = event.target as Node;
          if (target.ownerDocument === document || event.nativeEvent.defaultPrevented) return;
          if (!isPaletteShortcut(event)) return;
          event.preventDefault();
          props.onOpenPalette();
        }}
      >
        <CanvasEventsProvider value={canvasEvents}>
          <StudioRegionsProvider
            value={{
              parts: props.parts,
              partLabel: (slug) =>
                `${props.parts.get(slug)?.title ?? slug} · ${__('all pages', 'pressbase-admin')}`,
            }}
          >
            <StudioFrame
              chrome={props.chrome}
              editor={editor}
              notice={<PartNotice parts={props.parts} locked={props.partsLocked} />}
              footer={
                <Breadcrumb site={props.site} page={props.summary.title} parts={props.parts} />
              }
              inspector={
                showInspector && (
                  <Inspector
                    page={props.summary}
                    parts={props.parts}
                    tab={props.tab}
                    onTab={props.onTab}
                    canReset={canReset}
                    onReset={(slug) => {
                      const region = regions.current.get(partKey(slug));
                      if (region?.theme !== undefined) replaceRegion(region.key, region.theme);
                    }}
                    onClose={props.narrow ? props.onCloseInspector : undefined}
                    partsLocked={props.partsLocked}
                    mode={props.mode}
                    onMode={props.onMode}
                  />
                )
              }
            >
              <div className={styles.canvasArea} data-device={props.device}>
                <div
                  ref={frameRef}
                  className={styles.canvasFrame}
                  style={width ? { maxWidth: `${width}px` } : undefined}
                >
                  <BlockContextProvider
                    value={
                      typeof doc.page?.id === 'number'
                        ? { postId: doc.page.id, postType: 'page' }
                        : {}
                    }
                  >
                    <BlockCanvas height="100%" styles={settings.styles as never}>
                      <BlockList className="wp-site-blocks" />
                    </BlockCanvas>
                  </BlockContextProvider>
                  <CanvasDragAssist frameRef={frameRef} />
                  <SectionToolbar frameRef={frameRef} onAddSection={props.onAddSection} />
                </div>
              </div>
            </StudioFrame>
          </StudioRegionsProvider>
        </CanvasEventsProvider>
      </div>
      <div className={lightScope}>
        <Popover.Slot />
      </div>
    </BlockEditorProvider>
  );
}

/** Gives the editor the store's getBlocks() and replaceInnerBlocks(), for reverts and resets. */
function StoreBridgeSetter({ bridge }: { bridge: { current: StoreBridge | null } }) {
  const registry = useRegistry();
  const { replaceInnerBlocks } = useDispatch(blockEditorStore) as unknown as Pick<
    StoreBridge,
    'replaceInnerBlocks'
  >;
  useEffect(() => {
    const select = registry.select(blockEditorStore) as unknown as {
      getBlocks: () => BlockInstance[];
      getBlockParents: (id: string) => string[];
      getBlockName: (id: string) => string | null;
      getBlockAttributes: (id: string) => Record<string, unknown> | null;
    };
    bridge.current = {
      getBlocks: () => select.getBlocks(),
      replaceInnerBlocks,
      chain: (clientId) =>
        [...select.getBlockParents(clientId), clientId].map((id) => ({
          clientId: id,
          name: select.getBlockName(id) ?? '',
          attributes: select.getBlockAttributes(id) ?? {},
        })),
    };
    return () => {
      bridge.current = null;
    };
  }, [registry, replaceInnerBlocks, bridge]);
  return null;
}

/**
 * Above the canvas while something in a template part is selected: the
 * header and footer are on every page, so the person knows before they type.
 */
function PartNotice({ parts, locked }: { parts: ReadonlyMap<string, PartInfo>; locked: boolean }) {
  const { __, sprintf } = useI18n();
  const part = useSelectedPart();
  if (!part) return null;
  const title = parts.get(part.slug)?.title ?? part.slug;
  return (
    <div className={styles.stageNotice} role="status" data-tone="accent" data-floating>
      {locked ? <Lock size={16} aria-hidden="true" /> : <Info size={16} aria-hidden="true" />}
      <p>
        {sprintf(
          locked
            ? __(
                'The %s is on every page, so only people who can change the site’s design can edit it.',
                'pressbase-admin',
              )
            : __(
                'You’re editing the %s. It’s on every page, so your changes show everywhere once you publish.',
                'pressbase-admin',
              ),
          title,
        )}
      </p>
    </div>
  );
}

/**
 * Applies the canvas's editing modes (canvas-model.ts editingModes()) once
 * the blocks are in the store. The template's block IDs never change while
 * the page is open, undo included.
 */
function EditingModes({
  blocks,
  partsEditable,
}: {
  blocks: BlockInstance[];
  partsEditable: boolean;
}) {
  const registry = useRegistry();
  const { setBlockEditingMode } = useDispatch(blockEditorStore) as unknown as {
    setBlockEditingMode: (clientId: string, mode: string) => void;
  };
  useEffect(() => {
    const canvas = blocks as unknown as CanvasBlock[];
    registry.batch(() => {
      for (const [clientId, mode] of editingModes(canvas, { partsEditable })) {
        setBlockEditingMode(clientId, mode);
      }
    });
  }, [blocks, partsEditable, registry, setBlockEditingMode]);
  return null;
}
