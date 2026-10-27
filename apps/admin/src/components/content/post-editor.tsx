'use client';

import { ArrowLeft, ChevronDown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import {
  type ContentType,
  formatLocalDate,
  plainTitle,
  type RestPost,
  type RestRevision,
  type RestTerm,
  STATUS_LABELS,
} from '@/lib/content';
import { blocksToText, textToBlocks } from '@/lib/simple-blocks';
import { useCurrentUser } from '../shell/current-user';
import { Button, ButtonLink } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { Badge, EmptyState, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './editor.module.css';
import { TagInput, type TagToken } from './tag-input';

type Mode = 'write' | 'code';
type Visibility = 'public' | 'password' | 'private';

interface Form {
  title: string;
  body: string;
  mode: Mode;
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
}

const EMPTY: Form = {
  title: '',
  body: '',
  mode: 'write',
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
};

function formFrom(post: RestPost, tags: TagToken[]): Form {
  const text = blocksToText(post.content.raw);
  return {
    title: post.title.raw,
    body: text ?? post.content.raw,
    mode: text === undefined ? 'code' : 'write',
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

export function PostEditor({ config, id }: { config: ContentType; id?: number }) {
  const router = useRouter();
  const me = useCurrentUser();
  const toast = useToast();
  const can = (cap: string) => Boolean(me.capabilities[cap]);

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
  const [revisions, setRevisions] = useState<RestRevision[]>([]);
  const [confirm, setConfirm] = useState<'unpublish' | 'trash' | 'leave' | null>(null);
  const [codeNotice, setCodeNotice] = useState(false);

  const titleRef = useAutoGrow(form.title);
  const bodyRef = useAutoGrow(form.body);
  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const status = post?.status;
  const isLive = status === 'publish' || status === 'private' || status === 'future';
  const isOwn = !post || post.author === me.id;
  const canPublish = can(config.cap.publish);
  const canSticky = config.type === 'post' && can(config.cap.editOthers) && canPublish;
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(saved), [form, saved]);

  /* ------------------------------------------------------------ loading */

  const loadRevisions = useCallback(
    async (postId: number) => {
      setRevisions(
        await api<RestRevision[]>(`/wp/v2/${config.base}/${postId}/revisions`).catch(() => []),
      );
    },
    [config.base],
  );

  useEffect(() => {
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
      setTimeout(() => titleRef.current?.focus(), 0);
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
        setCodeNotice(initial.mode === 'code' && loaded.content.raw.trim() !== '');
        loadRevisions(loaded.id);
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.status === 404 || err.status === 403 || err.status === 401)
        )
          setMissing(true);
        else setError({ title: 'Could not load this item.' });
      } finally {
        setLoading(false);
      }
    })();
  }, [id, config, loadRevisions, titleRef]);

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /* ------------------------------------------------------------- saving */

  const save = useCallback(
    async (target: 'draft' | 'pending' | 'publish' | 'private' | 'keep', label: string) => {
      setBusy(label);
      setError(undefined);
      try {
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

        const body: Record<string, unknown> = {
          title: form.title,
          content: form.mode === 'write' ? textToBlocks(form.body) : form.body,
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
        // Keep the writer's text exactly as typed; the server only normalises markup.
        if (form.mode === 'write') next.body = form.body;
        setPost(result);
        setForm(next);
        setSaved(next);
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
    [form, post, status, isLive, config, canSticky, loadRevisions, toast, router],
  );

  // Cmd/Ctrl+S saves without leaving the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (busy) return;
        if (isLive || status === 'pending') save('keep', 'update');
        else save('draft', 'draft');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, isLive, status, busy]);

  const trash = async () => {
    if (!post) return;
    setBusy('trash');
    try {
      await api(`/wp/v2/${config.base}/${post.id}`, { method: 'DELETE' });
      setSaved(form);
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

  const switchMode = (mode: Mode) => {
    if (mode === form.mode) return;
    if (mode === 'code') {
      set('body', textToBlocks(form.body));
      set('mode', 'code');
      return;
    }
    const text = blocksToText(form.body);
    if (text === undefined) {
      toast('This content has blocks the writing view can’t show. Keep editing it as code.', {
        tone: 'danger',
      });
      return;
    }
    setForm((f) => ({ ...f, body: text, mode: 'write' }));
    setCodeNotice(false);
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

  const words = form.mode === 'write' ? form.body.split(/\s+/).filter(Boolean).length : 0;
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

  return (
    <>
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
          {busy ? 'Saving…' : dirty ? 'Unsaved changes' : post ? 'All changes saved' : ''}
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
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Notice tone="danger" title={error.title}>
            {error.hint}
          </Notice>
        </div>
      )}

      <div className={styles.layout}>
        <section className={styles.canvas} aria-label="Writing area">
          <textarea
            ref={titleRef}
            className={styles.title}
            rows={1}
            placeholder="Add title"
            aria-label="Title"
            value={form.title}
            onChange={(e) => set('title', e.target.value.replace(/\n/g, ' '))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                bodyRef.current?.focus();
              }
            }}
          />
          <div className={styles.modeRow}>
            <span>
              {form.mode === 'write'
                ? `${words.toLocaleString('en')} ${words === 1 ? 'word' : 'words'} · ${Math.max(1, Math.round(words / 230))} min read`
                : 'Editing block markup'}
            </span>
            <fieldset className={styles.modes}>
              <legend className="visually-hidden">Editor view</legend>
              <button
                type="button"
                className={styles.mode}
                aria-pressed={form.mode === 'write'}
                onClick={() => switchMode('write')}
              >
                Write
              </button>
              <button
                type="button"
                className={styles.mode}
                aria-pressed={form.mode === 'code'}
                onClick={() => switchMode('code')}
              >
                Code
              </button>
            </fieldset>
          </div>
          {codeNotice && (
            <Notice tone="info" title="Opened in code view">
              This content uses blocks the writing view can’t show yet. The full block editor
              arrives in v0.3.
            </Notice>
          )}
          <textarea
            ref={bodyRef}
            className={styles.body}
            data-mode={form.mode}
            placeholder={form.mode === 'write' ? 'Start writing…' : '<!-- wp:paragraph -->…'}
            aria-label="Content"
            spellCheck={form.mode === 'write'}
            value={form.body}
            onChange={(e) => set('body', e.target.value)}
          />
          {form.mode === 'write' && (
            <p className={styles.hint}>
              Shortcuts: <code>## Heading</code> <code>- list</code> <code>1. list</code>{' '}
              <code>&gt; quote</code> <code>**bold**</code> <code>*italic*</code>{' '}
              <code>[link](https://…)</code> <code>---</code>
            </p>
          )}
        </section>

        <aside className={styles.sidebar} aria-label={`${config.singular} settings`}>
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
              {post?.status === 'publish' && <span className={styles.urlPreview}>{post.link}</span>}
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
                        if (e.key === 'Escape') setNewCategory(null);
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
                A short summary for lists and search results. Leave empty to use the opening words.
              </span>
            </div>
          </Panel>

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
                          const text = blocksToText(r.content.raw);
                          setForm((f) => ({
                            ...f,
                            title: r.title.raw,
                            excerpt: r.excerpt.raw,
                            body: text ?? r.content.raw,
                            mode: text === undefined ? 'code' : 'write',
                          }));
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
          router.push(listHref);
        }}
      >
        Your unsaved changes will be lost.
      </ConfirmDialog>
    </>
  );
}
