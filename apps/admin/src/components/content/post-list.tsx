'use client';

import { FilePlus2, PenSquare, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import {
  type ContentType,
  formatLocalDate,
  plainTitle,
  type RestPost,
  type RestTerm,
  type RestUser,
  STATUS_LABELS,
} from '@/lib/content';
import { filterQuery, listFilters } from '@/lib/extensions/lists';
import { appliesTo, type FillEntry, SLOTS } from '@/lib/extensions/registry';
import { ExtensionBoundary, extensionStore, RenderFill, useFills } from '../extensions/host';
import { useCurrentUser } from '../shell/current-user';
import { PageHeader } from '../shell/page-header';
import { Button, ButtonLink } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { EmptyState, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './list.module.css';
import { PostsSubnav } from './posts-subnav';

const PER_PAGE = 20;
const LIVE_STATUSES = 'publish,future,draft,pending,private';

type StatusTab = 'all' | RestPost['status'];
const TABS: { id: StatusTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'publish', label: 'Published' },
  { id: 'future', label: 'Scheduled' },
  { id: 'draft', label: 'Drafts' },
  { id: 'pending', label: 'Pending' },
  { id: 'private', label: 'Private' },
  { id: 'trash', label: 'Trash' },
];

interface Row extends RestPost {
  depth: number;
}

/** Orders pages as a tree (parents before children) and records each depth. */
function asTree(posts: RestPost[]): Row[] {
  const byParent = new Map<number, RestPost[]>();
  const ids = new Set(posts.map((p) => p.id));
  for (const post of posts) {
    const parent = post.parent && ids.has(post.parent) ? post.parent : 0;
    byParent.set(parent, [...(byParent.get(parent) ?? []), post]);
  }
  const out: Row[] = [];
  const walk = (parent: number, depth: number) => {
    for (const post of byParent.get(parent) ?? []) {
      out.push({ ...post, depth });
      walk(post.id, depth + 1);
    }
  };
  walk(0, 0);
  return out;
}

export function PostList({ config }: { config: ContentType }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const me = useCurrentUser();
  const toast = useToast();

  const status = (params.get('status') ?? 'all') as StatusTab;
  const search = params.get('s') ?? '';
  const page = Number(params.get('paged') ?? '1') || 1;
  const category = params.get('cat') ?? '';

  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [authors, setAuthors] = useState<Map<number, string>>(new Map());
  const [terms, setTerms] = useState<Map<number, string>>(new Map());
  const [categories, setCategories] = useState<RestTerm[]>([]);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState(search);
  const [confirm, setConfirm] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Plugins' columns, row actions and filters (PostsListColumn, …RowAction, …Filter).
  const allColumns = useFills(SLOTS.postsListColumns);
  const columns = useMemo(
    () => allColumns.filter((fill) => appliesTo(fill, config.type)),
    [allColumns, config.type],
  );
  const allActions = useFills(SLOTS.postsListRowActions);
  const rowActions = useMemo(
    () => allActions.filter((fill) => appliesTo(fill, config.type)),
    [allActions, config.type],
  );
  const allFilters = useFills(SLOTS.postsListFilters);
  const filters = useMemo(
    () => listFilters(allFilters.filter((fill) => appliesTo(fill, config.type))),
    [allFilters, config.type],
  );
  // The REST parameters the chosen plugin filters add; a string, so loading reruns only on change.
  const pluginQuery = JSON.stringify(
    filterQuery(
      filters,
      (key) => params.get(key),
      (filter, error) =>
        console.error(
          `[plugin:${filters.find((f) => f.id === filter.id)?.owner}] filter failed:`,
          error,
        ),
    ),
  );
  const pluginFiltered = filters.some((filter) => params.get(filter.id));

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

  // Pages without filters load as one tree, like WordPress's hierarchical list.
  const treeMode = config.hierarchical && !search && status !== 'trash';

  const load = useCallback(async () => {
    setError(undefined);
    const q = new URLSearchParams({
      context: 'edit',
      status: status === 'all' ? LIVE_STATUSES : status,
      per_page: String(treeMode ? 100 : PER_PAGE),
      page: String(treeMode ? 1 : page),
    });
    if (search) q.set('search', search);
    if (category) q.set('categories', category);
    for (const [key, value] of Object.entries(JSON.parse(pluginQuery) as Record<string, string>))
      q.set(key, value);
    if (config.hierarchical && !search) {
      q.set('orderby', 'title');
      q.set('order', 'asc');
    }
    try {
      const [res, countData] = await Promise.all([
        fetch(`/wp-json/wp/v2/${config.base}?${q}`, { credentials: 'same-origin' }),
        api<Record<string, number>>(`/pressbase/v1/post-counts/${config.type}`),
      ]);
      const data = await res.json();
      if (!res.ok) throw new ApiError(res.status, data.code, data.message, data.data);
      const posts = data as RestPost[];
      setTotal(Number(res.headers.get('X-WP-Total') ?? posts.length));
      setTotalPages(Number(res.headers.get('X-WP-TotalPages') ?? 1));
      setCounts(countData);
      setRows(treeMode ? asTree(posts) : posts.map((p) => ({ ...p, depth: 0 })));
      setSelected(new Set());

      const authorIds = [...new Set(posts.map((p) => p.author).filter(Boolean))];
      if (authorIds.length) {
        const users = await api<RestUser[]>(
          `/wp/v2/users?include=${authorIds.join(',')}&per_page=100`,
        );
        setAuthors(new Map(users.map((u) => [u.id, u.name])));
      }
      const termIds = [
        ...new Set(posts.flatMap((p) => [...(p.categories ?? []), ...(p.tags ?? [])])),
      ];
      if (config.taxonomies && termIds.length) {
        const [cats, tags] = await Promise.all([
          api<RestTerm[]>(`/wp/v2/categories?include=${termIds.join(',')}&per_page=100`),
          api<RestTerm[]>(`/wp/v2/tags?include=${termIds.join(',')}&per_page=100`),
        ]);
        setTerms(new Map([...cats, ...tags].map((t) => [t.id, t.name])));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the list.');
      setRows([]);
    }
  }, [config, status, search, category, page, treeMode, pluginQuery]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!config.taxonomies) return;
    api<RestTerm[]>('/wp/v2/categories?per_page=100&orderby=name')
      .then(setCategories)
      .catch(() => {});
  }, [config.taxonomies]);

  const allCount = useMemo(
    () =>
      ['publish', 'future', 'draft', 'pending', 'private'].reduce(
        (n, s) => n + (counts[s] ?? 0),
        0,
      ),
    [counts],
  );
  const countFor = (tab: StatusTab) => (tab === 'all' ? allCount : (counts[tab] ?? 0));

  /* ---------------------------------------------------------- actions */

  const each = async (ids: number[], run: (id: number) => Promise<unknown>) => {
    setBusy(true);
    const results = await Promise.allSettled(ids.map(run));
    setBusy(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) toast(`${failed} of ${ids.length} could not be changed.`, { tone: 'danger' });
    await load();
    return ids.length - failed;
  };

  const noun = (n: number) =>
    n === 1 ? config.singular.toLowerCase() : config.plural.toLowerCase();

  const trash = async (ids: number[]) => {
    const done = await each(ids, (id) => api(`/wp/v2/${config.base}/${id}`, { method: 'DELETE' }));
    if (done) {
      toast(`${done} ${noun(done)} moved to the Trash.`, {
        action: { label: 'Undo', onClick: () => restore(ids, true) },
      });
    }
  };

  const restore = async (ids: number[], undo = false) => {
    const done = await each(ids, (id) =>
      api(`/wp/v2/${config.base}/${id}`, { method: 'POST', body: { status: 'draft' } }),
    );
    if (done && !undo)
      toast(`${done} ${noun(done)} restored as ${done === 1 ? 'a draft' : 'drafts'}.`);
  };

  const destroy = async (ids: number[]) => {
    const done = await each(ids, (id) =>
      api(`/wp/v2/${config.base}/${id}?force=true`, { method: 'DELETE' }),
    );
    setConfirm(null);
    if (done) toast(`${done} ${noun(done)} permanently deleted.`);
  };

  const canEditRow = (post: RestPost) =>
    post.author === me.id
      ? Boolean(me.capabilities[config.cap.edit])
      : Boolean(me.capabilities[config.cap.editOthers]);

  const toggleAll = (checked: boolean) =>
    setSelected(checked ? new Set(rows?.map((r) => r.id)) : new Set());

  /* ------------------------------------------------------------ render */

  const isTrash = status === 'trash';
  const filtered = Boolean(search || category || pluginFiltered);
  const newHref = `/admin/${config.base}/new`;

  return (
    <>
      <PageHeader
        title={config.plural}
        actions={
          me.capabilities[config.cap.edit] && (
            <ButtonLink
              href={newHref}
              variant="primary"
              icon={<FilePlus2 size={16} aria-hidden="true" />}
            >
              Add new {config.singular.toLowerCase()}
            </ButtonLink>
          )
        }
      />
      {config.taxonomies && <PostsSubnav />}

      <div className={styles.toolbar}>
        <ul className={styles.tabs} aria-label="Filter by status">
          {TABS.filter((t) => t.id === 'all' || countFor(t.id) > 0 || t.id === status).map(
            (tab) => (
              <li key={tab.id}>
                <button
                  type="button"
                  className={styles.tab}
                  aria-pressed={status === tab.id}
                  onClick={() => setParams({ status: tab.id === 'all' ? undefined : tab.id })}
                >
                  {tab.label}
                  <span className={styles.count}>{countFor(tab.id)}</span>
                </button>
              </li>
            ),
          )}
        </ul>

        <search>
          <form
            className={styles.filters}
            onSubmit={(e) => {
              e.preventDefault();
              setParams({ s: query.trim() || undefined });
            }}
          >
            {config.taxonomies && categories.length > 1 && (
              <select
                className={styles.select}
                aria-label="Filter by category"
                value={category}
                onChange={(e) => setParams({ cat: e.target.value || undefined })}
              >
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            {filters.map((filter) => (
              <select
                key={filter.id}
                className={styles.select}
                aria-label={filter.label}
                value={params.get(filter.id) ?? ''}
                onChange={(e) => setParams({ [filter.id]: e.target.value || undefined })}
              >
                <option value="">{filter.label}</option>
                {filter.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ))}
            <div className={styles.search}>
              <Search size={16} aria-hidden="true" />
              <input
                className={styles.input}
                type="search"
                placeholder={`Search ${config.plural.toLowerCase()}`}
                aria-label={`Search ${config.plural.toLowerCase()}`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </form>
        </search>
      </div>

      {error && <Notice tone="danger" title={error} />}

      <div className={styles.card}>
        {selected.size > 0 && (
          <section className={styles.bulkbar} aria-label="Bulk actions">
            <span>{selected.size} selected</span>
            <span className={styles.spacer} />
            {isTrash ? (
              <>
                <Button size="sm" onClick={() => restore([...selected])} disabled={busy}>
                  Restore
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setConfirm([...selected])}
                  disabled={busy}
                >
                  Delete permanently
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => trash([...selected])} loading={busy}>
                Move to Trash
              </Button>
            )}
          </section>
        )}

        {rows === null ? (
          <table className={styles.table} aria-busy="true">
            <tbody>
              {[0, 1, 2, 3].map((i) => (
                <tr key={i}>
                  <td>
                    <div className={styles.skeleton} style={{ width: `${60 - i * 8}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<PenSquare size={28} />}
            title={
              filtered
                ? `No ${config.plural.toLowerCase()} match`
                : isTrash
                  ? 'The Trash is empty'
                  : `No ${config.plural.toLowerCase()} yet`
            }
            action={
              filtered ? (
                <Button
                  onClick={() => {
                    setQuery('');
                    setParams({
                      s: undefined,
                      cat: undefined,
                      ...Object.fromEntries(filters.map((f) => [f.id, undefined])),
                    });
                  }}
                >
                  Clear filters
                </Button>
              ) : !isTrash && me.capabilities[config.cap.edit] ? (
                <ButtonLink href={newHref} variant="primary">
                  Write your first {config.singular.toLowerCase()}
                </ButtonLink>
              ) : undefined
            }
          >
            <p>
              {filtered
                ? 'Try different words or another category.'
                : isTrash
                  ? 'Trashed items stay here until you delete them permanently.'
                  : `${config.plural} you create will appear here.`}
            </p>
          </EmptyState>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.check}>
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
                <th>Title</th>
                <th className={styles.hideNarrow}>Author</th>
                {config.taxonomies && (
                  <>
                    <th className={styles.hideNarrow}>Categories</th>
                    <th className={styles.hideNarrow}>Tags</th>
                  </>
                )}
                <th className={styles.hideNarrow}>Date</th>
                {columns.map((fill) => (
                  <th key={fill.id} className={styles.hideNarrow}>
                    {typeof fill.props.title === 'string' ? fill.props.title : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((post) => {
                const title = plainTitle(post.title.rendered) || '(no title)';
                const editable = canEditRow(post);
                const editHref = `/admin/${config.base}/${post.id}`;
                const stateLabel =
                  status === 'all' && post.status !== 'publish'
                    ? STATUS_LABELS[post.status]
                    : undefined;
                return (
                  <tr key={post.id} aria-selected={selected.has(post.id)}>
                    <td className={styles.check}>
                      <input
                        type="checkbox"
                        aria-label={`Select “${title}”`}
                        checked={selected.has(post.id)}
                        disabled={!editable}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(post.id);
                          else next.delete(post.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td className={styles.titleCell}>
                      {post.depth > 0 && (
                        <span className={styles.depth}>{'— '.repeat(post.depth)}</span>
                      )}
                      {editable && !isTrash ? (
                        <Link href={editHref} className={styles.titleLink}>
                          {title}
                        </Link>
                      ) : (
                        <strong>{title}</strong>
                      )}
                      {stateLabel && <span className={styles.state}> — {stateLabel}</span>}
                      {post.sticky && <span className={styles.state}> — Sticky</span>}
                      {post.password && <span className={styles.state}> — Password protected</span>}
                      {(editable || (!isTrash && rowActions.length > 0)) && (
                        <div className={styles.rowActions}>
                          {isTrash ? (
                            <>
                              <button
                                type="button"
                                className={styles.rowAction}
                                onClick={() => restore([post.id])}
                              >
                                Restore
                              </button>
                              <button
                                type="button"
                                className={styles.rowAction}
                                data-tone="danger"
                                onClick={() => setConfirm([post.id])}
                              >
                                Delete permanently
                              </button>
                            </>
                          ) : (
                            editable && (
                              <>
                                <Link href={editHref} className={styles.rowAction}>
                                  Edit
                                </Link>
                                <button
                                  type="button"
                                  className={styles.rowAction}
                                  data-tone="danger"
                                  onClick={() => trash([post.id])}
                                >
                                  Trash
                                </button>
                              </>
                            )
                          )}
                          {!isTrash &&
                            rowActions.map((fill) => (
                              <ExtensionBoundary
                                key={fill.id}
                                owner={fill.owner}
                                place="posts list row action"
                              >
                                <PluginRowAction fill={fill} post={post} reload={load} />
                              </ExtensionBoundary>
                            ))}
                        </div>
                      )}
                    </td>
                    <td className={`${styles.meta} ${styles.hideNarrow}`}>
                      {authors.get(post.author) ?? '—'}
                    </td>
                    {config.taxonomies && (
                      <>
                        <td className={`${styles.terms} ${styles.hideNarrow}`}>
                          {(post.categories ?? [])
                            .map((id) => terms.get(id))
                            .filter(Boolean)
                            .join(', ') || '—'}
                        </td>
                        <td className={`${styles.terms} ${styles.hideNarrow}`}>
                          {(post.tags ?? [])
                            .map((id) => terms.get(id))
                            .filter(Boolean)
                            .join(', ') || '—'}
                        </td>
                      </>
                    )}
                    <td className={`${styles.meta} ${styles.hideNarrow}`}>
                      <span className={styles.dateLabel}>
                        {post.status === 'publish'
                          ? 'Published'
                          : post.status === 'future'
                            ? 'Scheduled'
                            : 'Last modified'}
                      </span>
                      {formatLocalDate(
                        post.status === 'publish' || post.status === 'future'
                          ? post.date
                          : post.modified,
                      )}
                    </td>
                    {columns.map((fill) => (
                      <td key={fill.id} className={`${styles.meta} ${styles.hideNarrow}`}>
                        <RenderFill
                          fill={fill}
                          place="posts list column"
                          fillProps={{ post, postType: config.type }}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {rows && rows.length > 0 && (
          <div className={styles.footer}>
            <span>
              {total} {total === 1 ? 'item' : 'items'}
            </span>
            {!treeMode && totalPages > 1 && (
              <nav className={styles.pager} aria-label="Pagination">
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
            ? `Delete ${confirm.length} ${noun(confirm.length)}?`
            : 'Delete permanently?'
        }
        confirmLabel="Delete permanently"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && destroy(confirm)}
      >
        This can’t be undone. Revisions are deleted too.
      </ConfirmDialog>
    </>
  );
}

type ListPost = Record<string, unknown>;

/** A plugin's row action (PostsListRowAction): a link or a button, unless `isVisible` hides it. */
function PluginRowAction({
  fill,
  post,
  reload,
}: {
  fill: FillEntry;
  post: RestPost;
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const row = post as unknown as ListPost;
  const { label, href, onClick, isVisible } = fill.props as {
    label?: string | ((post: ListPost) => string);
    href?: (post: ListPost) => string;
    onClick?: (post: ListPost, list: { reload: () => Promise<void> }) => unknown;
    isVisible?: (post: ListPost) => boolean;
  };
  if (typeof isVisible === 'function' && !isVisible(row)) return null;
  const text = typeof label === 'function' ? label(row) : label;
  if (!text) return null;
  if (typeof href === 'function') {
    return (
      <a href={href(row)} className={styles.rowAction}>
        {text}
      </a>
    );
  }
  if (typeof onClick !== 'function') return null;
  return (
    <button
      type="button"
      className={styles.rowAction}
      onClick={() =>
        Promise.resolve()
          .then(() => onClick(row, { reload }))
          .catch((error) => {
            console.error(`[plugin:${fill.owner ?? 'unknown'}] row action failed:`, error);
            toast(`The ${extensionStore.title(fill.owner)} plugin couldn’t do that.`, {
              tone: 'danger',
            });
          })
      }
    >
      {text}
    </button>
  );
}
