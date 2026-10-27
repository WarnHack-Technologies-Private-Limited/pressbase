'use client';

import { MessageSquare, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import {
  ACTION_LABELS,
  ACTION_STATUS,
  avatarHue,
  bulkActions,
  COMMENT_TABS,
  type CommentAction,
  type CommentCounts,
  type CommentTab,
  commentPlainText,
  initials,
  type RestComment,
  statusMessage,
  tabCount,
  tabQuery,
  UNDO,
} from '@/lib/comments';
import { formatLocalDate, plainTitle, type RestPost } from '@/lib/content';
import listStyles from '../content/list.module.css';
import { useCurrentUser } from '../shell/current-user';
import { PageHeader } from '../shell/page-header';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { TextAreaField, TextField } from '../ui/field';
import { EmptyState, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './comments.module.css';

const PER_PAGE = 20;

interface PostRef {
  id: number;
  title: string;
  type: string;
}

type Panel = { id: number; kind: 'reply' | 'edit' } | null;

/** edit-comments.php: moderate, reply to and edit comments. */
export function CommentsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const me = useCurrentUser();
  const toast = useToast();

  const tab = (params.get('comment_status') ?? 'all') as CommentTab;
  const search = params.get('s') ?? '';
  const page = Number(params.get('paged') ?? '1') || 1;
  const only = Number(params.get('c') ?? '0') || 0;

  const [rows, setRows] = useState<RestComment[] | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [counts, setCounts] = useState<CommentCounts | null>(null);
  const [posts, setPosts] = useState<Map<number, PostRef>>(new Map());
  const [parents, setParents] = useState<Map<number, string>>(new Map());
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState(search);
  const [confirm, setConfirm] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);

  const setParams = useCallback(
    (changes: Record<string, string | undefined>) => {
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      if (!('paged' in changes)) next.delete('paged');
      router.replace(`${pathname}${next.size ? `?${next}` : ''}`);
    },
    [params, pathname, router],
  );

  const load = useCallback(async () => {
    setError(undefined);
    const q = new URLSearchParams({
      context: 'edit',
      per_page: String(PER_PAGE),
      page: String(page),
      ...(only ? { include: String(only), status: 'any' } : tabQuery(tab, me.id)),
    });
    if (search && !only) q.set('search', search);
    try {
      const [res, countData] = await Promise.all([
        fetch(`/wp-json/wp/v2/comments?${q}`, { credentials: 'same-origin' }),
        api<CommentCounts>('/pressbase/v1/comment-counts'),
      ]);
      const data = await res.json();
      if (!res.ok) throw new ApiError(res.status, data.code, data.message, data.data);
      const comments = data as RestComment[];
      setTotal(Number(res.headers.get('X-WP-Total') ?? comments.length));
      setTotalPages(Number(res.headers.get('X-WP-TotalPages') ?? 1));
      setCounts(countData);
      setRows(comments);
      setSelected(new Set());

      // The posts the comments belong to, and the authors of the comments they answer.
      const postIds = [...new Set(comments.map((c) => c.post))];
      if (postIds.length) {
        const include = postIds.join(',');
        const [postList, pageList] = await Promise.all(
          ['posts', 'pages'].map((base) =>
            api<RestPost[]>(
              `/wp/v2/${base}?include=${include}&status=any&per_page=100&context=edit`,
            ).catch(() => [] as RestPost[]),
          ),
        );
        setPosts(
          new Map(
            [...(postList ?? []), ...(pageList ?? [])].map((p) => [
              p.id,
              { id: p.id, title: plainTitle(p.title.rendered) || '(no title)', type: p.type },
            ]),
          ),
        );
      }
      const known = new Map(comments.map((c) => [c.id, c.author_name]));
      const missing = [...new Set(comments.map((c) => c.parent).filter((p) => p && !known.has(p)))];
      if (missing.length) {
        const parentList = await api<RestComment[]>(
          `/wp/v2/comments?include=${missing.join(',')}&status=any&per_page=100&context=edit`,
        ).catch(() => []);
        for (const p of parentList) known.set(p.id, p.author_name);
      }
      setParents(known);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load comments.');
      setRows([]);
    }
  }, [tab, search, page, only, me.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Arriving from a theme's "Edit" link (?c=ID) opens that comment's editor.
  useEffect(() => {
    if (only && rows?.some((r) => r.id === only)) setPanel({ id: only, kind: 'edit' });
  }, [only, rows]);

  /* ---------------------------------------------------------- actions */

  const run = async (action: CommentAction, ids: number[], undoable = true) => {
    setBusy(true);
    const results = await Promise.allSettled(
      ids.map((id) =>
        action === 'delete'
          ? api(`/wp/v2/comments/${id}?force=true`, { method: 'DELETE' })
          : api(`/wp/v2/comments/${id}`, {
              method: 'POST',
              body: { status: ACTION_STATUS[action] },
            }),
      ),
    );
    setBusy(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    const done = ids.length - failed;
    if (failed) {
      toast(`${failed} of ${ids.length} could not be changed. Try again.`, { tone: 'danger' });
    }
    const undo = UNDO[action];
    if (done) {
      toast(
        statusMessage(action, done),
        undoable && undo ? { action: { label: 'Undo', onClick: () => run(undo, ids, false) } } : {},
      );
    }
    setConfirm(null);
    await load();
  };

  const toggleAll = (checked: boolean) =>
    setSelected(checked ? new Set(rows?.map((r) => r.id)) : new Set());

  /* ------------------------------------------------------------ render */

  const filtered = Boolean(search || only);
  const pending = counts?.moderated ?? 0;

  return (
    <>
      <PageHeader
        title="Comments"
        description={
          pending
            ? `${pending.toLocaleString('en')} ${pending === 1 ? 'comment is' : 'comments are'} waiting for your review.`
            : 'Read, reply to and moderate the conversation on your site.'
        }
      />

      <div className={listStyles.toolbar}>
        <ul className={listStyles.tabs} aria-label="Filter by status">
          {COMMENT_TABS.map((t) => {
            const n = tabCount(t.id, counts);
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className={listStyles.tab}
                  aria-pressed={tab === t.id && !only}
                  onClick={() =>
                    setParams({
                      comment_status: t.id === 'all' ? undefined : t.id,
                      c: undefined,
                    })
                  }
                >
                  {t.label}
                  {n !== undefined && (
                    <span
                      className={
                        t.id === 'moderated' && n > 0 ? styles.pendingCount : listStyles.count
                      }
                    >
                      {n.toLocaleString('en')}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <search>
          <form
            className={listStyles.filters}
            onSubmit={(e) => {
              e.preventDefault();
              setParams({ s: query.trim() || undefined, c: undefined });
            }}
          >
            <div className={listStyles.search}>
              <Search size={16} aria-hidden="true" />
              <input
                className={listStyles.input}
                type="search"
                placeholder="Search comments"
                aria-label="Search comments"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </form>
        </search>
      </div>

      {error && <Notice tone="danger" title={error} />}

      <div className={listStyles.card}>
        {selected.size > 0 && (
          <section className={`${listStyles.bulkbar} ${styles.bulkbar}`} aria-label="Bulk actions">
            <span className={styles.selectedCount}>{selected.size} selected</span>
            <span className={listStyles.spacer} />
            <div className={styles.bulkButtons}>
              {bulkActions(tab).map((action) => (
                <Button
                  key={action}
                  size="sm"
                  variant={action === 'delete' ? 'danger' : 'secondary'}
                  disabled={busy}
                  onClick={() =>
                    action === 'delete' ? setConfirm([...selected]) : run(action, [...selected])
                  }
                >
                  {ACTION_LABELS[action]}
                </Button>
              ))}
            </div>
          </section>
        )}

        {rows === null ? (
          <table className={listStyles.table} aria-busy="true">
            <tbody>
              {[0, 1, 2].map((i) => (
                <tr key={i}>
                  <td>
                    <div className={listStyles.skeleton} style={{ width: `${70 - i * 12}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<MessageSquare size={28} />}
            title={
              filtered
                ? 'No comments match'
                : tab === 'moderated'
                  ? 'Nothing waiting for review'
                  : tab === 'spam'
                    ? 'No spam'
                    : tab === 'trash'
                      ? 'The Trash is empty'
                      : 'No comments yet'
            }
            action={
              filtered ? (
                <Button
                  onClick={() => {
                    setQuery('');
                    setParams({ s: undefined, c: undefined });
                  }}
                >
                  Clear search
                </Button>
              ) : undefined
            }
          >
            <p>
              {filtered
                ? 'Try different words, or search by name, email or IP address.'
                : tab === 'moderated'
                  ? 'You’re all caught up. New comments that need approval will appear here.'
                  : tab === 'trash'
                    ? 'Trashed comments stay here until you delete them permanently.'
                    : 'When readers comment on your posts, their comments will appear here.'}
            </p>
          </EmptyState>
        ) : (
          <table className={`${listStyles.table} ${styles.table}`}>
            <thead>
              <tr>
                <th className={listStyles.check}>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={selected.size === rows.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && selected.size < rows.length;
                    }}
                    onChange={(e) => toggleAll(e.target.checked)}
                  />
                </th>
                <th className={styles.authorCol}>Author</th>
                <th>Comment</th>
                <th className={listStyles.hideNarrow}>In response to</th>
                <th className={listStyles.hideNarrow}>Submitted on</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((comment) => (
                <CommentRow
                  key={comment.id}
                  comment={comment}
                  post={posts.get(comment.post)}
                  parentName={comment.parent ? parents.get(comment.parent) : undefined}
                  selected={selected.has(comment.id)}
                  onSelect={(checked) => {
                    const next = new Set(selected);
                    if (checked) next.add(comment.id);
                    else next.delete(comment.id);
                    setSelected(next);
                  }}
                  panel={panel?.id === comment.id ? panel.kind : null}
                  setPanel={(kind) => setPanel(kind ? { id: comment.id, kind } : null)}
                  busy={busy}
                  onAction={(action) =>
                    action === 'delete' ? setConfirm([comment.id]) : run(action, [comment.id])
                  }
                  onSaved={async (message) => {
                    setPanel(null);
                    toast(message);
                    await load();
                  }}
                />
              ))}
            </tbody>
          </table>
        )}

        {rows && rows.length > 0 && (
          <div className={listStyles.footer}>
            <span>
              {total.toLocaleString('en')} {total === 1 ? 'comment' : 'comments'}
            </span>
            {totalPages > 1 && (
              <nav className={listStyles.pager} aria-label="Pagination">
                <Button
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setParams({ paged: String(page - 1) })}
                >
                  Previous
                </Button>
                <span>
                  Page {page} of {totalPages}
                </span>
                <Button
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setParams({ paged: String(page + 1) })}
                >
                  Next
                </Button>
              </nav>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm && confirm.length > 1
            ? `Delete ${confirm.length} comments permanently?`
            : 'Delete permanently?'
        }
        confirmLabel="Delete permanently"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && run('delete', confirm)}
      >
        This can’t be undone. Replies stay, and move up to the comment above.
      </ConfirmDialog>
    </>
  );
}

/* ------------------------------------------------------------------ row */

function Avatar({ name }: { name: string }) {
  return (
    <span
      className={styles.avatar}
      style={{ '--hue': avatarHue(name || '?') } as CSSProperties}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

function CommentRow({
  comment,
  post,
  parentName,
  selected,
  onSelect,
  panel,
  setPanel,
  busy,
  onAction,
  onSaved,
}: {
  comment: RestComment;
  post: PostRef | undefined;
  parentName: string | undefined;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  panel: 'reply' | 'edit' | null;
  setPanel: (kind: 'reply' | 'edit' | null) => void;
  busy: boolean;
  onAction: (action: CommentAction) => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const name = comment.author_name || 'Anonymous';
  const text = commentPlainText(comment.content.rendered);
  const pending = comment.status === 'hold';
  const editHref = post
    ? `/admin/${post.type === 'page' ? 'pages' : 'posts'}/${post.id}`
    : undefined;
  const label = `comment by ${name}`;

  const actions: { action: CommentAction | 'reply' | 'edit'; label: string; danger?: boolean }[] =
    comment.status === 'spam'
      ? [
          { action: 'unspam', label: 'Not spam' },
          { action: 'delete', label: 'Delete permanently', danger: true },
        ]
      : comment.status === 'trash'
        ? [
            { action: 'untrash', label: 'Restore' },
            { action: 'delete', label: 'Delete permanently', danger: true },
          ]
        : [
            pending
              ? { action: 'approve', label: 'Approve' }
              : { action: 'unapprove', label: 'Unapprove' },
            { action: 'reply', label: pending ? 'Approve and reply' : 'Reply' },
            { action: 'edit', label: 'Quick edit' },
            { action: 'spam', label: 'Spam', danger: true },
            { action: 'trash', label: 'Trash', danger: true },
          ];

  return (
    <tr aria-selected={selected} data-status={comment.status} className={styles.row}>
      <td className={listStyles.check}>
        <input
          type="checkbox"
          aria-label={`Select ${label}`}
          checked={selected}
          onChange={(e) => onSelect(e.target.checked)}
        />
      </td>
      <td className={styles.authorCol}>
        <div className={styles.author}>
          <Avatar name={name} />
          <div className={styles.authorText}>
            <strong className={styles.authorName}>{name}</strong>
            {comment.author_url && (
              <a
                className={styles.meta}
                href={comment.author_url}
                rel="nofollow ugc noopener"
                target="_blank"
              >
                {comment.author_url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
              </a>
            )}
            {comment.author_email && (
              <a className={styles.meta} href={`mailto:${comment.author_email}`}>
                {comment.author_email}
              </a>
            )}
            {comment.author_ip && (
              <span className={styles.meta}>
                <span className="visually-hidden">IP address </span>
                {comment.author_ip}
              </span>
            )}
          </div>
        </div>
      </td>
      <td className={styles.commentCell}>
        {pending && <span className={styles.pendingBadge}>Pending</span>}
        {parentName !== undefined && (
          <p className={styles.replyTo}>
            In reply to{' '}
            <a href={`/admin/comments?c=${comment.parent}`} className={styles.replyLink}>
              {parentName || 'Anonymous'}
            </a>
          </p>
        )}
        <div className={styles.text}>
          {text.split(/\n{2,}/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
        {/* On narrow screens, the post and date columns fold in here. */}
        <p className={styles.narrowMeta}>
          {post && <>On {post.title} · </>}
          {formatLocalDate(comment.date)}
        </p>
        {!panel && (
          <div className={listStyles.rowActions}>
            {actions.map((a) => (
              <button
                key={a.action}
                type="button"
                className={listStyles.rowAction}
                data-tone={a.danger ? 'danger' : undefined}
                disabled={busy}
                aria-label={`${a.label}: ${label}`}
                onClick={() => {
                  if (a.action === 'reply' || a.action === 'edit') setPanel(a.action);
                  else onAction(a.action);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
        {panel === 'reply' && (
          <ReplyBox
            comment={comment}
            name={name}
            onCancel={() => setPanel(null)}
            onSaved={onSaved}
          />
        )}
        {panel === 'edit' && (
          <QuickEdit comment={comment} onCancel={() => setPanel(null)} onSaved={onSaved} />
        )}
      </td>
      <td className={`${listStyles.meta} ${listStyles.hideNarrow}`}>
        {/* The public site (and so "View comment") arrives with themes in v0.4. */}
        {post && editHref ? (
          <Link href={editHref} className={styles.postLink}>
            {post.title}
          </Link>
        ) : (
          '—'
        )}
      </td>
      <td className={`${listStyles.meta} ${listStyles.hideNarrow} ${styles.date}`}>
        {formatLocalDate(comment.date)}
      </td>
    </tr>
  );
}

/** The inline reply box (WordPress's #replyrow). */
function ReplyBox({
  comment,
  name,
  onCancel,
  onSaved,
}: {
  comment: RestComment;
  name: string;
  onCancel: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pending = comment.status === 'hold';

  useEffect(() => {
    ref.current?.querySelector('textarea')?.focus();
  }, []);

  const submit = async () => {
    if (!content.trim()) {
      setError('Write a reply first.');
      ref.current?.querySelector('textarea')?.focus();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      // Replying to a held comment approves it first, as WordPress does.
      if (pending) {
        await api(`/wp/v2/comments/${comment.id}`, {
          method: 'POST',
          body: { status: 'approved' },
        });
      }
      await api('/wp/v2/comments', {
        method: 'POST',
        body: { post: comment.post, parent: comment.id, content },
      });
      await onSaved(pending ? 'Comment approved and reply posted.' : 'Reply posted.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your reply couldn’t be posted. Try again.');
      setBusy(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the inline editor.
    <div
      className={styles.panel}
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
      }}
    >
      <TextAreaField
        label={`Reply to ${name}`}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={4}
        error={error}
        hint="Your reply is published right away, under your name."
      />
      <div className={styles.panelActions}>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={submit} loading={busy}>
          {busy ? 'Posting…' : pending ? 'Approve and reply' : 'Reply'}
        </Button>
      </div>
    </div>
  );
}

/** Quick edit: name, email, website and text, in place. */
function QuickEdit({
  comment,
  onCancel,
  onSaved,
}: {
  comment: RestComment;
  onCancel: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [values, setValues] = useState({
    author_name: comment.author_name,
    author_email: comment.author_email ?? '',
    author_url: comment.author_url,
    content: comment.content.raw ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector('input')?.focus();
  }, []);

  const set = (key: keyof typeof values, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors(({ [key]: _, ...rest }) => rest);
  };

  const save = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      await api(`/wp/v2/comments/${comment.id}`, { method: 'POST', body: values });
      await onSaved('Comment updated.');
    } catch (err) {
      if (err instanceof ApiError && err.data.params) setErrors(err.data.params);
      else setProblem(err instanceof ApiError ? err.message : 'Couldn’t save. Try again.');
      setBusy(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the inline editor.
    <div
      className={styles.panel}
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
      }}
    >
      {problem && <Notice tone="danger" title={problem} />}
      <div className={styles.editGrid}>
        <TextField
          label="Name"
          value={values.author_name}
          onChange={(e) => set('author_name', e.target.value)}
          error={errors.author_name}
          optional
        />
        <TextField
          label="Email"
          type="email"
          value={values.author_email}
          onChange={(e) => set('author_email', e.target.value)}
          error={errors.author_email}
          optional
        />
        <TextField
          label="Website"
          type="url"
          value={values.author_url}
          onChange={(e) => set('author_url', e.target.value)}
          error={errors.author_url}
          optional
        />
      </div>
      <TextAreaField
        label="Comment"
        value={values.content}
        onChange={(e) => set('content', e.target.value)}
        rows={5}
        error={errors.content}
      />
      <div className={styles.panelActions}>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={save} loading={busy}>
          {busy ? 'Saving…' : 'Update comment'}
        </Button>
      </div>
    </div>
  );
}
