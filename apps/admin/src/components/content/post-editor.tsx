'use client';

import { ArrowLeft, ChevronDown, PanelRight, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, api } from '@/lib/api';
import {
  AUTOSAVE_INTERVAL_MS,
  backupKey,
  browserStorage,
  clearBackup,
  type EditableFields,
  fieldsOfAutosave,
  type LocalBackup,
  newerAutosave,
  type RestAutosave,
  readBackup,
  usefulBackup,
  writeBackup,
} from '@/lib/autosave';
import {
  type ContentType,
  formatLocalDate,
  plainTitle,
  type RestPost,
  type RestRevision,
  type RestTerm,
  STATUS_LABELS,
} from '@/lib/content';
import { SLOTS } from '@/lib/extensions/registry';
import { BlockEditor, type BlockEditorHandle, lightScope } from '../block-editor';
import { Slot } from '../extensions/host';
import { useCurrentUser } from '../shell/current-user';
import { Button, ButtonLink } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { Badge, EmptyState, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './editor.module.css';
import { FeaturedImage } from './featured-image';
import { TagInput, type TagToken } from './tag-input';

type Mode = 'visual' | 'code';
type Visibility = 'public' | 'password' | 'private';
type SidebarTab = 'post' | 'block';
/** Revisions include autosaves (as in WordPress); the history panel leaves those out. */
type Revision = RestRevision & { slug?: string };

/** Everything in the sidebar and the title. The content is tracked separately. */
interface Form {
  title: string;
  excerpt: string;
  slug: string;
  visibility: Visibility;
  password: string;
  schedule: boolean;
  /** datetime-local value in the site's time zone: "YYYY-MM-DDTHH:MM". */
  date: string;
  comments: boolean;
  sticky: boolean;
  categories: number[];
  tags: TagToken[];
  parent: number;
  menuOrder: number;
  featuredMedia: number;
}

const EMPTY: Form = {
  title: '',
  excerpt: '',
  slug: '',
  visibility: 'public',
  password: '',
  schedule: false,
  date: '',
  comments: true,
  sticky: false,
  categories: [],
  tags: [],
  parent: 0,
  menuOrder: 0,
  featuredMedia: 0,
};

function formFrom(post: RestPost, tags: TagToken[]): Form {
  return {
    title: post.title.raw,
    excerpt: post.excerpt.raw,
    slug: post.slug,
    visibility: post.status === 'private' ? 'private' : post.password ? 'password' : 'public',
    password: post.password,
    schedule: post.status === 'future',
    date: post.date.slice(0, 16),
    comments: post.comment_status === 'open',
    sticky: Boolean(post.sticky),
    categories: post.categories ?? [],
    tags,
    parent: post.parent ?? 0,
    menuOrder: post.menu_order ?? 0,
    featuredMedia: post.featured_media ?? 0,
  };
}

/** A textarea that grows with its content. */
function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    // Re-measured whenever the text changes.
    if (!el || value === undefined) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function Panel({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className={styles.panel} open={defaultOpen}>
      <summary>
        {title}
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <div className={styles.panelBody}>{children}</div>
    </details>
  );
}

/** Categories as an indented checklist, children under their parents. */
function categoryTree(categories: RestTerm[]): (RestTerm & { depth: number })[] {
  const out: (RestTerm & { depth: number })[] = [];
  const walk = (parent: number, depth: number) => {
    for (const c of categories.filter((x) => (x.parent ?? 0) === parent)) {
      out.push({ ...c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(0, 0);
  return out;
}

const timeOf = (local: string) => formatLocalDate(local).split(' at ')[1] ?? local;

/** A restore offer shown above the editor: an autosave or the browser's copy. */
type RestoreOffer =
  | { kind: 'autosave'; fields: EditableFields; when: string }
  | { kind: 'backup'; fields: EditableFields; when: string };

export function PostEditor({ config, id }: { config: ContentType; id?: number }) {
  const router = useRouter();
  const me = useCurrentUser();
  const toast = useToast();
  const can = (cap: string) => Boolean(me.capabilities[cap]);
  const narrow = useMediaQuery('(max-width: 1100px)');

  const [post, setPost] = useState<RestPost | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saved, setSaved] = useState<Form>(EMPTY);
  const [loading, setLoading] = useState(Boolean(id));
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<{ title: string; hint?: string }>();
  const [busy, setBusy] = useState<string | null>(null);
  const [categories, setCategories] = useState<RestTerm[]>([]);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [pages, setPages] = useState<RestPost[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [confirm, setConfirm] = useState<'unpublish' | 'trash' | 'leave' | null>(null);

  // Content. In the visual editor the blocks live inside BlockEditor; `content`
  // is what it was mounted with (or the code view's text), `current` the
  // latest serialized content, `savedContent` the last saved content.
  const [mode, setMode] = useState<Mode>('visual');
  const [content, setContent] = useState('');
  const [current, setCurrent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const editor = useRef<BlockEditorHandle | null>(null);
  const savedContentRef = useRef('');
  savedContentRef.current = savedContent;

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tab, setTab] = useState<SidebarTab>('post');
  const [inspector, setInspector] = useState<HTMLDivElement | null>(null);
  const [offer, setOffer] = useState<RestoreOffer | null>(null);
  const [autosavedAt, setAutosavedAt] = useState<string | null>(null);
  const [backupReady, setBackupReady] = useState(false);

  const titleRef = useAutoGrow(form.title);
  const codeRef = useAutoGrow(mode === 'code' ? content : '');
  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const status = post?.status;
  const isLive = status === 'publish' || status === 'private' || status === 'future';
  const isOwn = !post || post.author === me.id;
  const canPublish = can(config.cap.publish);
  const canSticky = config.type === 'post' && can(config.cap.editOthers) && canPublish;
  const canUpload = can('upload_files');
  const formDirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(saved), [form, saved]);
  const dirty = formDirty || current !== savedContent;
  const storageKey = backupKey(config.type, post?.id ?? id);

  // The sidebar starts closed on tablets and phones, where it covers the canvas.
  useEffect(() => setSidebarOpen(!narrow), [narrow]);

  /** The content right now, without waiting for the editor's debounce. */
  const readContent = useCallback(
    () => (mode === 'visual' && editor.current ? editor.current.getContent() : content),
    [mode, content],
  );

  /** Replaces the content (a revision, an autosave): the visual editor remounts. */
  const replaceContent = useCallback((next: string) => {
    editor.current = null;
    setContent(next);
    setCurrent(next);
    setEditorKey((k) => k + 1);
  }, []);

  /* ------------------------------------------------------------ loading */

  const loadRevisions = useCallback(
    async (postId: number) => {
      const all = await api<Revision[]>(`/wp/v2/${config.base}/${postId}/revisions`).catch(
        () => [],
      );
      setRevisions(all.filter((r) => !r.slug?.includes('-autosave-')));
    },
    [config.base],
  );

  useEffect(() => {
    const storage = browserStorage();
    if (config.taxonomies) {
      api<RestTerm[]>('/wp/v2/categories?per_page=100&orderby=name')
        .then(setCategories)
        .catch(() => {});
    }
    if (config.hierarchical) {
      api<RestPost[]>(
        `/wp/v2/pages?context=edit&per_page=100&status=publish,future,draft,pending,private&orderby=title&order=asc`,
      )
        .then(setPages)
        .catch(() => {});
    }
    if (!id) {
      const backup = usefulBackup(readBackup(storage, backupKey(config.type)), {
        title: '',
        content: '',
        excerpt: '',
      });
      if (backup) setOffer({ kind: 'backup', fields: backup, when: timeOfMs(backup.savedAt) });
      setBackupReady(true);
      return;
    }
    (async () => {
      try {
        const loaded = await api<RestPost>(`/wp/v2/${config.base}/${id}?context=edit`);
        const tagIds = loaded.tags ?? [];
        const tags = tagIds.length
          ? (await api<RestTerm[]>(`/wp/v2/tags?include=${tagIds.join(',')}&per_page=100`)).map(
              (t) => ({
                id: t.id,
                name: t.name,
              }),
            )
          : [];
        const initial = formFrom(loaded, tags);
        setPost(loaded);
        setForm(initial);
        setSaved(initial);
        setContent(loaded.content.raw);
        setCurrent(loaded.content.raw);
        setSavedContent(loaded.content.raw);
        loadRevisions(loaded.id);

        // Offer a newer autosave first, else a newer local copy.
        const savedFields = {
          title: loaded.title.raw,
          content: loaded.content.raw,
          excerpt: loaded.excerpt.raw,
        };
        const autosaves = await api<RestAutosave[]>(
          `/wp/v2/${config.base}/${loaded.id}/autosaves?context=edit`,
        ).catch(() => []);
        const autosave = newerAutosave(
          { ...savedFields, id: loaded.id, modified_gmt: loaded.modified_gmt },
          autosaves,
          me.id,
        );
        const backup = usefulBackup(
          readBackup(storage, backupKey(config.type, loaded.id)),
          savedFields,
          loaded.modified_gmt,
        );
        if (autosave) {
          setOffer({
            kind: 'autosave',
            fields: fieldsOfAutosave(autosave),
            when: formatLocalDate(autosave.modified),
          });
        } else if (backup) {
          setOffer({ kind: 'backup', fields: backup, when: timeOfMs(backup.savedAt) });
        }
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.status === 404 || err.status === 403 || err.status === 401)
        )
          setMissing(true);
        else setError({ title: 'Could not load this item.' });
      } finally {
        setLoading(false);
        setBackupReady(true);
      }
    })();
  }, [id, config, loadRevisions, me.id]);

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // The browser's copy: written shortly after each change, removed once saved.
  useEffect(() => {
    if (!backupReady || offer) return;
    const storage = browserStorage();
    const timer = setTimeout(() => {
      if (!dirty) return clearBackup(storage, storageKey);
      const backup: LocalBackup = {
        title: form.title,
        excerpt: form.excerpt,
        content: current,
        savedAt: Date.now(),
      };
      writeBackup(storage, storageKey, backup);
    }, 500);
    return () => clearTimeout(timer);
  }, [backupReady, offer, dirty, form.title, form.excerpt, current, storageKey]);

  /* ------------------------------------------------------------- saving */

  const save = useCallback(
    async (target: 'draft' | 'pending' | 'publish' | 'private' | 'keep', label: string) => {
      setBusy(label);
      setError(undefined);
      try {
        // Menus edited through a Navigation block in the post are saved with it.
        await editor.current?.saveMenus();
        // New tags are created first, so the post can reference their IDs.
        const tagIds: number[] = [];
        const tags: TagToken[] = [];
        for (const tag of form.tags) {
          if (tag.id) {
            tagIds.push(tag.id);
            tags.push(tag);
            continue;
          }
          try {
            const created = await api<RestTerm>('/wp/v2/tags', {
              method: 'POST',
              body: { name: tag.name },
            });
            tagIds.push(created.id);
            tags.push({ id: created.id, name: created.name });
          } catch (err) {
            const existing =
              err instanceof ApiError ? (err.data as { term_id?: number }).term_id : undefined;
            if (!existing) throw err;
            tagIds.push(existing);
            tags.push({ id: existing, name: tag.name });
          }
        }

        let nextStatus: string | undefined;
        if (target === 'keep')
          nextStatus = status === 'future' || status === 'publish' ? 'publish' : status;
        else if (target === 'publish' && form.visibility === 'private') nextStatus = 'private';
        else nextStatus = target;
        // A scheduled date makes "publish" become "future" on the server.

        const sentContent = readContent();
        const body: Record<string, unknown> = {
          title: form.title,
          content: sentContent,
          excerpt: form.excerpt,
          status: nextStatus,
          password: form.visibility === 'password' ? form.password : '',
          comment_status: form.comments ? 'open' : 'closed',
        };
        if (post || form.slug) body.slug = form.slug;
        if (form.schedule && form.date) {
          body.date = `${form.date}:00`;
        } else if (
          (target === 'publish' && !isLive) ||
          (status === 'future' && target === 'keep')
        ) {
          // Publishing now: drafts and scheduled posts take the current time, as in WordPress.
          body.date_gmt = new Date().toISOString().slice(0, 19);
        }
        if (config.taxonomies) {
          body.categories = form.categories;
          body.tags = tagIds;
        }
        if (canUpload) body.featured_media = form.featuredMedia;
        if (canSticky) body.sticky = form.sticky;
        if (config.hierarchical) {
          body.parent = form.parent;
          body.menu_order = form.menuOrder;
        }

        const result = await api<RestPost>(
          post ? `/wp/v2/${config.base}/${post.id}` : `/wp/v2/${config.base}`,
          {
            method: 'POST',
            body,
          },
        );
        const next = formFrom(result, tags);
        setPost(result);
        setForm(next);
        setSaved(next);
        // The editor keeps what the writer sees; the server only normalises markup.
        setSavedContent(sentContent);
        setCurrent(sentContent);
        if (mode === 'code') setContent(sentContent);
        setAutosavedAt(null);
        setOffer(null);
        clearBackup(browserStorage(), storageKey);
        clearBackup(browserStorage(), backupKey(config.type));
        loadRevisions(result.id);

        const noun = config.singular;
        const messages: Record<string, string> = {
          draft: 'Draft saved.',
          pending: 'Submitted for review.',
          publish: post?.status === 'publish' ? `${noun} updated.` : `${noun} published.`,
          private: `${noun} published privately.`,
          future: `${noun} scheduled for ${formatLocalDate(result.date)}.`,
        };
        toast(messages[result.status] ?? `${noun} saved.`);
        if (!post) router.replace(`/admin/${config.base}/${result.id}`);
      } catch (err) {
        if (err instanceof ApiError) {
          const firstParam = err.data.params ? Object.values(err.data.params)[0] : undefined;
          setError({ title: err.message, hint: firstParam });
        } else {
          setError({ title: 'Could not save. Check your connection and try again.' });
        }
      } finally {
        setBusy(null);
      }
    },
    [
      form,
      post,
      status,
      isLive,
      config,
      canSticky,
      loadRevisions,
      toast,
      router,
      readContent,
      mode,
      storageKey,
    ],
  );

  // Cmd/Ctrl+S saves without leaving the keyboard (also from inside the canvas,
  // whose key presses the block editor forwards to this window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (busy) return;
        if (isLive || status === 'pending') save('keep', 'update');
        else save('draft', 'draft');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, isLive, status, busy]);

  /* ----------------------------------------------------------- autosave */

  // Every minute while there are unsaved changes, as WordPress's editor does.
  const autosaveState = useRef({ dirty, busy, post, form, readContent, offer });
  autosaveState.current = { dirty, busy, post, form, readContent, offer };
  useEffect(() => {
    let running = false;
    const timer = setInterval(async () => {
      const state = autosaveState.current;
      if (running || !state.dirty || state.busy || !state.post || state.offer) return;
      running = true;
      const fields = {
        title: state.form.title,
        excerpt: state.form.excerpt,
        content: state.readContent(),
      };
      try {
        const result = await api<RestAutosave>(`/wp/v2/${config.base}/${state.post.id}/autosaves`, {
          method: 'POST',
          body: fields,
        });
        if (result.id === state.post.id) {
          // A draft by its author: the post itself was updated.
          setSaved((s) => ({ ...s, title: fields.title, excerpt: fields.excerpt }));
          setSavedContent(fields.content);
          setPost((p) =>
            p ? { ...p, modified: result.modified, modified_gmt: result.modified_gmt } : p,
          );
        }
        setAutosavedAt(result.modified);
      } catch {
        // Silent: the local copy still protects the writing, and saving reports errors.
      } finally {
        running = false;
      }
    }, AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [config.base]);

  const restore = () => {
    if (!offer) return;
    setForm((f) => ({ ...f, title: offer.fields.title, excerpt: offer.fields.excerpt }));
    replaceContent(offer.fields.content);
    setOffer(null);
    toast(
      offer.kind === 'autosave'
        ? 'Autosave restored. Save to keep it.'
        : 'Copy restored. Save to keep it.',
    );
  };
  const dismissOffer = () => {
    if (offer?.kind === 'backup') clearBackup(browserStorage(), storageKey);
    setOffer(null);
  };

  /* -------------------------------------------------------------- other */

  const trash = async () => {
    if (!post) return;
    setBusy('trash');
    try {
      await api(`/wp/v2/${config.base}/${post.id}`, { method: 'DELETE' });
      setSaved(form);
      setSavedContent(current);
      toast(`${config.singular} moved to the Trash.`);
      router.push(`/admin/${config.base}`);
    } catch (err) {
      setError({ title: err instanceof ApiError ? err.message : 'Could not move to the Trash.' });
      setBusy(null);
      setConfirm(null);
    }
  };

  const addCategory = async () => {
    const name = newCategory?.trim();
    if (!name) return;
    try {
      const created = await api<RestTerm>('/wp/v2/categories', { method: 'POST', body: { name } });
      setCategories((all) => [...all, created]);
      set('categories', [...form.categories, created.id]);
      setNewCategory(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add the category.', {
        tone: 'danger',
      });
    }
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    if (next === 'code') {
      const markup = readContent();
      editor.current = null;
      setContent(markup);
      setCurrent(markup);
    }
    setMode(next);
  };

  const onEditorReady = useCallback(
    (handle: BlockEditorHandle) => {
      editor.current = handle;
      // Untouched content: compare against the editor's own serialization,
      // so a first parse/serialize pass doesn't count as a change.
      setSavedContent((s) => (s === content ? handle.baseline : s));
      setCurrent(handle.baseline);
    },
    [content],
  );
  const onNotice = useCallback(
    (message: string, tone: 'success' | 'danger') => toast(message, { tone }),
    [toast],
  );
  const onSelectionChange = useCallback((selected: boolean) => {
    setTab(selected ? 'block' : 'post');
  }, []);

  const onTabKey = (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = tab === 'post' ? 'block' : 'post';
    setTab(next);
    document.getElementById(`editor-tab-${next}`)?.focus();
  };

  /* ------------------------------------------------------------ render */

  const listHref = `/admin/${config.base}`;
  const leave = () => (dirty ? setConfirm('leave') : router.push(listHref));

  if (loading) {
    return (
      <div className={styles.loading} aria-busy="true">
        <p className={styles.hint}>Loading…</p>
      </div>
    );
  }
  if (missing) {
    return (
      <EmptyState
        icon={<ArrowLeft size={28} />}
        title={`This ${config.singular.toLowerCase()} can’t be found`}
        action={<ButtonLink href={listHref}>Back to {config.plural.toLowerCase()}</ButtonLink>}
      >
        <p>It may have been deleted, or you may not have permission to edit it.</p>
      </EmptyState>
    );
  }

  const scheduledFuture =
    form.schedule && form.date && new Date(`${form.date}:00`).getTime() > Date.now();
  let primaryLabel: string;
  let primaryAction: () => void;
  if (!canPublish) {
    primaryLabel = status === 'pending' ? 'Update' : 'Submit for review';
    primaryAction = () => save('pending', 'primary');
  } else if (isLive) {
    primaryLabel = status === 'future' && !scheduledFuture ? 'Publish now' : 'Update';
    primaryAction = () => save('keep', 'primary');
  } else {
    primaryLabel = scheduledFuture
      ? 'Schedule'
      : form.visibility === 'private'
        ? 'Publish privately'
        : 'Publish';
    primaryAction = () => save('publish', 'primary');
  }

  const editableParents = pages.filter((p) => {
    if (!post) return true;
    // Exclude this page and its descendants.
    let cursor: RestPost | undefined = p;
    for (let i = 0; cursor && i < 50; i++) {
      if (cursor.id === post.id) return false;
      const parentId: number | undefined = cursor.parent;
      cursor = parentId ? pages.find((x) => x.id === parentId) : undefined;
    }
    return true;
  });

  const saveState = busy
    ? 'Saving…'
    : dirty
      ? autosavedAt
        ? `Unsaved changes · autosaved ${timeOf(autosavedAt)}`
        : 'Unsaved changes'
      : post
        ? 'All changes saved'
        : '';

  const modeSwitch = (
    <fieldset className={styles.modes}>
      <legend className="visually-hidden">Editor view</legend>
      <button
        type="button"
        className={styles.mode}
        aria-pressed={mode === 'visual'}
        onClick={() => switchMode('visual')}
      >
        Visual
      </button>
      <button
        type="button"
        className={styles.mode}
        aria-pressed={mode === 'code'}
        onClick={() => switchMode('code')}
      >
        Code
      </button>
    </fieldset>
  );

  return (
    <>
      <h1 className="visually-hidden">
        {post
          ? `Edit ${config.singular.toLowerCase()}`
          : `Add new ${config.singular.toLowerCase()}`}
      </h1>
      <div className={styles.bar}>
        <button type="button" className={styles.back} onClick={leave}>
          <ArrowLeft size={16} aria-hidden="true" /> {config.plural}
        </button>
        <span className={styles.hideTiny}>
          {status ? (
            <Badge
              tone={status === 'publish' ? 'success' : status === 'future' ? 'accent' : undefined}
            >
              {STATUS_LABELS[status]}
            </Badge>
          ) : (
            <Badge>New</Badge>
          )}
        </span>
        <span className={styles.saveState} aria-live="polite">
          {saveState}
        </span>
        <span className={styles.spacer} />
        {isLive && canPublish ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirm('unpublish')}
            disabled={Boolean(busy)}
          >
            Switch to draft
          </Button>
        ) : (
          status !== 'pending' && (
            <Button
              size="sm"
              onClick={() => save('draft', 'draft')}
              loading={busy === 'draft'}
              disabled={Boolean(busy)}
            >
              Save draft
            </Button>
          )
        )}
        <Button
          size="sm"
          variant="primary"
          onClick={primaryAction}
          loading={busy === 'primary'}
          disabled={Boolean(busy)}
        >
          {primaryLabel}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className={styles.sidebarToggle}
          icon={<PanelRight size={18} aria-hidden="true" />}
          aria-label="Settings"
          title="Settings"
          aria-expanded={sidebarOpen}
          aria-controls="editor-sidebar"
          data-active={sidebarOpen || undefined}
          onClick={() => setSidebarOpen((open) => !open)}
        />
      </div>

      {error && (
        <div className={styles.notice}>
          <Notice tone="danger" title={error.title}>
            {error.hint}
          </Notice>
        </div>
      )}

      {offer && (
        <div className={styles.notice}>
          <Notice
            tone="info"
            title={
              offer.kind === 'autosave'
                ? `There’s an autosave from ${offer.when} that’s newer than this version.`
                : `This browser has unsaved changes from ${offer.when}.`
            }
          >
            <span className={styles.noticeActions}>
              <Button size="sm" onClick={restore}>
                {offer.kind === 'autosave' ? 'Restore the autosave' : 'Restore the changes'}
              </Button>
              <Button size="sm" variant="ghost" onClick={dismissOffer}>
                Dismiss
              </Button>
            </span>
          </Notice>
        </div>
      )}

      <div className={styles.layout} data-sidebar={sidebarOpen ? 'open' : 'closed'}>
        <section className={styles.canvas} aria-label="Content">
          {mode === 'visual' ? (
            <BlockEditor
              key={editorKey}
              initialContent={content}
              title={form.title}
              onTitleChange={(title) => set('title', title)}
              onContentChange={setCurrent}
              onReady={onEditorReady}
              inspector={inspector}
              onSelectionChange={onSelectionChange}
              toolbarEnd={modeSwitch}
              postId={post?.id}
              canUnfilteredHtml={can('unfiltered_html')}
              focusTitle={!id}
              onNotice={onNotice}
            />
          ) : (
            <div className={styles.code}>
              <div className={styles.codeBar}>
                <span>Editing block markup</span>
                {modeSwitch}
              </div>
              <div className={styles.codeBody}>
                <textarea
                  ref={titleRef}
                  className={styles.title}
                  rows={1}
                  placeholder="Add title"
                  aria-label="Add title"
                  value={form.title}
                  onChange={(e) => set('title', e.target.value.replace(/\n/g, ' '))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      codeRef.current?.focus();
                    }
                  }}
                />
                <textarea
                  ref={codeRef}
                  className={styles.body}
                  placeholder="<!-- wp:paragraph -->…"
                  aria-label="Block markup"
                  spellCheck={false}
                  value={content}
                  onChange={(e) => {
                    setContent(e.target.value);
                    setCurrent(e.target.value);
                  }}
                />
              </div>
            </div>
          )}
        </section>

        <aside
          id="editor-sidebar"
          className={styles.sidebar}
          aria-label={`${config.singular} settings`}
          hidden={!sidebarOpen}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && narrow && !event.defaultPrevented) {
              setSidebarOpen(false);
              document
                .querySelector<HTMLButtonElement>('[aria-controls="editor-sidebar"]')
                ?.focus();
            }
          }}
        >
          <div className={styles.tabsRow}>
            <div className={styles.tabs} role="tablist" aria-label="Settings" onKeyDown={onTabKey}>
              {(['post', 'block'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  id={`editor-tab-${value}`}
                  aria-controls={`editor-tabpanel-${value}`}
                  aria-selected={tab === value}
                  tabIndex={tab === value ? 0 : -1}
                  className={styles.tab}
                  onClick={() => setTab(value)}
                >
                  {value === 'post' ? config.singular : 'Block'}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className={styles.sidebarClose}
              aria-label="Close settings"
              icon={<X size={16} aria-hidden="true" />}
              onClick={() => setSidebarOpen(false)}
            />
          </div>

          <div
            role="tabpanel"
            id="editor-tabpanel-post"
            aria-labelledby="editor-tab-post"
            hidden={tab !== 'post'}
            className={styles.tabPanel}
          >
            <Panel title="Publishing">
              <fieldset className={styles.radios}>
                <legend>Visibility</legend>
                {(
                  [
                    ['public', 'Public', true],
                    ['password', 'Password protected', true],
                    ['private', 'Private', canPublish],
                  ] as const
                ).map(([value, label, allowed]) =>
                  allowed ? (
                    <label key={value} className={styles.radio}>
                      <input
                        type="radio"
                        name="visibility"
                        checked={form.visibility === value}
                        onChange={() => set('visibility', value)}
                      />
                      {label}
                    </label>
                  ) : null,
                )}
                {form.visibility === 'password' && (
                  <input
                    className={styles.small}
                    aria-label="Password"
                    placeholder="Choose a password"
                    value={form.password}
                    onChange={(e) => set('password', e.target.value)}
                  />
                )}
              </fieldset>

              {canPublish && (
                <fieldset className={styles.radios}>
                  <legend>Publish</legend>
                  <label className={styles.radio}>
                    <input
                      type="radio"
                      name="when"
                      checked={!form.schedule}
                      onChange={() => set('schedule', false)}
                    />
                    {status === 'publish' && post
                      ? `Published ${formatLocalDate(post.date)}`
                      : 'Immediately'}
                  </label>
                  <label className={styles.radio}>
                    <input
                      type="radio"
                      name="when"
                      checked={form.schedule}
                      onChange={() =>
                        setForm((f) => ({
                          ...f,
                          schedule: true,
                          date: f.date || new Date(Date.now() + 864e5).toISOString().slice(0, 16),
                        }))
                      }
                    />
                    {status === 'publish' ? 'Change date' : 'Schedule for later'}
                  </label>
                  {form.schedule && (
                    <input
                      type="datetime-local"
                      className={styles.small}
                      aria-label="Publish date and time (site time zone)"
                      value={form.date}
                      onChange={(e) => set('date', e.target.value)}
                    />
                  )}
                </fieldset>
              )}

              <div className={styles.field}>
                <label className={styles.label} htmlFor="slug">
                  URL slug
                </label>
                <input
                  id="slug"
                  className={styles.small}
                  value={form.slug}
                  placeholder="Generated from the title"
                  onChange={(e) => set('slug', e.target.value)}
                  spellCheck={false}
                />
                {post?.status === 'publish' && (
                  <span className={styles.urlPreview}>{post.link}</span>
                )}
              </div>

              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={form.comments}
                  onChange={(e) => set('comments', e.target.checked)}
                />
                Allow comments
              </label>
              {canSticky && (
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={form.sticky}
                    onChange={(e) => set('sticky', e.target.checked)}
                  />
                  Stick to the top of the blog
                </label>
              )}
            </Panel>

            {/* Between Publishing and the taxonomies, where WordPress puts it. */}
            {canUpload && (
              <Panel title="Featured image" defaultOpen={Boolean(form.featuredMedia)}>
                <FeaturedImage
                  value={form.featuredMedia}
                  onChange={(id) => set('featuredMedia', id)}
                />
              </Panel>
            )}

            {config.taxonomies && (
              <Panel title="Categories">
                <ul className={styles.termList}>
                  {categoryTree(categories).map((c) => (
                    <li key={c.id} style={{ paddingLeft: `${c.depth * 1.25}rem` }}>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={form.categories.includes(c.id)}
                          onChange={(e) =>
                            set(
                              'categories',
                              e.target.checked
                                ? [...form.categories, c.id]
                                : form.categories.filter((x) => x !== c.id),
                            )
                          }
                        />
                        {c.name}
                      </label>
                    </li>
                  ))}
                </ul>
                {can('manage_categories') &&
                  (newCategory === null ? (
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setNewCategory('')}
                    >
                      + Add new category
                    </button>
                  ) : (
                    <div className={styles.inlineAdd}>
                      <input
                        className={styles.small}
                        aria-label="New category name"
                        value={newCategory}
                        // biome-ignore lint/a11y/noAutofocus: the user just asked to type a name.
                        autoFocus
                        onChange={(e) => setNewCategory(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addCategory();
                          }
                          if (e.key === 'Escape') {
                            e.stopPropagation();
                            setNewCategory(null);
                          }
                        }}
                      />
                      <Button size="sm" onClick={addCategory}>
                        Add
                      </Button>
                    </div>
                  ))}
              </Panel>
            )}

            {config.taxonomies && (
              <Panel title="Tags">
                <TagInput value={form.tags} onChange={(tags) => set('tags', tags)} />
              </Panel>
            )}

            {config.hierarchical && (
              <Panel title="Page attributes">
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="parent">
                    Parent page
                  </label>
                  <select
                    id="parent"
                    className={styles.small}
                    value={form.parent}
                    onChange={(e) => set('parent', Number(e.target.value))}
                  >
                    <option value={0}>(no parent)</option>
                    {editableParents.map((p) => (
                      <option key={p.id} value={p.id}>
                        {plainTitle(p.title.rendered) || '(no title)'}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="order">
                    Order
                  </label>
                  <input
                    id="order"
                    type="number"
                    className={styles.small}
                    value={form.menuOrder}
                    onChange={(e) => set('menuOrder', Number(e.target.value) || 0)}
                  />
                </div>
              </Panel>
            )}

            <Panel title="Excerpt" defaultOpen={Boolean(form.excerpt)}>
              <div className={styles.field}>
                <label className="visually-hidden" htmlFor="excerpt">
                  Excerpt
                </label>
                <textarea
                  id="excerpt"
                  className={styles.small}
                  value={form.excerpt}
                  onChange={(e) => set('excerpt', e.target.value)}
                />
                <span className={styles.hint}>
                  A short summary for lists and search results. Leave empty to use the opening
                  words.
                </span>
              </div>
            </Panel>

            {/* Plugins' panels (the `editor.document-settings` slot). */}
            <Slot
              name={SLOTS.editorDocumentSettings}
              place="editor panel"
              fillProps={{ postId: post?.id ?? id ?? null, postType: config.type }}
              wrap={(fill, content) => (
                <Panel title={typeof fill.props.title === 'string' ? fill.props.title : 'Plugin'}>
                  {content}
                </Panel>
              )}
            />

            {revisions.length > 0 && (
              <Panel title={`Revisions (${revisions.length})`} defaultOpen={false}>
                <ul className={styles.revisions}>
                  {revisions.slice(0, 10).map((r, i) => (
                    <li key={r.id}>
                      <span>
                        {formatLocalDate(r.date)}
                        {i === 0 ? ' · current' : ''}
                      </span>
                      {i > 0 && (
                        <button
                          type="button"
                          className={styles.linkButton}
                          onClick={() => {
                            setForm((f) => ({ ...f, title: r.title.raw, excerpt: r.excerpt.raw }));
                            replaceContent(r.content.raw);
                            toast('Revision loaded. Save to keep it.');
                          }}
                        >
                          Load
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            {post && (isOwn ? can(config.cap.delete) : can(config.cap.editOthers)) && (
              <button
                type="button"
                className={styles.linkButton}
                data-tone="danger"
                onClick={() => setConfirm('trash')}
              >
                Move to Trash
              </button>
            )}
          </div>

          <div
            role="tabpanel"
            id="editor-tabpanel-block"
            aria-labelledby="editor-tab-block"
            hidden={tab !== 'block'}
            className={`${styles.tabPanel} ${styles.inspector} ${lightScope}`}
          >
            {mode === 'code' ? (
              <p className={styles.inspectorEmpty}>
                Block settings are in the visual editor. Switch to Visual to use them.
              </p>
            ) : (
              <div ref={setInspector} />
            )}
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirm === 'unpublish'}
        title="Switch to draft?"
        tone="primary"
        confirmLabel="Switch to draft"
        busy={busy === 'draft'}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          await save('draft', 'draft');
          setConfirm(null);
        }}
      >
        It will no longer be visible on your site until you publish it again.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'trash'}
        title="Move to the Trash?"
        confirmLabel="Move to Trash"
        busy={busy === 'trash'}
        onCancel={() => setConfirm(null)}
        onConfirm={trash}
      >
        You can restore it from the Trash later.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'leave'}
        title="Leave without saving?"
        confirmLabel="Discard changes"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setSaved(form);
          setSavedContent(current);
          clearBackup(browserStorage(), storageKey);
          router.push(listHref);
        }}
      >
        Your unsaved changes will be lost.
      </ConfirmDialog>
    </>
  );
}

/** "3:04 PM" from a timestamp, in the browser's time zone. */
function timeOfMs(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
