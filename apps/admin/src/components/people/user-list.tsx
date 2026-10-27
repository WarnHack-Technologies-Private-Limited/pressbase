'use client';

import { Search, UserPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { type EditUser, ROLES, roleLabel, type UserCounts } from '@/lib/people';
import list from '../content/list.module.css';
import { useCurrentUser } from '../shell/current-user';
import { PageHeader } from '../shell/page-header';
import { Button, ButtonLink } from '../ui/button';
import { EmptyState, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import { Avatar } from './avatar';
import { DeleteUsersDialog } from './delete-users-dialog';
import styles from './people.module.css';

const PER_PAGE = 20;

/**
 * Users (wp-admin/users.php): role tabs with counts, search, and per-row Edit
 * and Delete. Selecting rows reveals bulk "Change role" and "Delete".
 * Filters live in the URL: ?role=editor&s=grace&paged=2.
 */
export function UserList() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const me = useCurrentUser();
  const toast = useToast();

  const role = params.get('role') ?? '';
  const search = params.get('s') ?? '';
  const page = Number(params.get('paged') ?? '1') || 1;

  const [rows, setRows] = useState<EditUser[] | null>(null);
  const [counts, setCounts] = useState<UserCounts | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState(search);
  const [bulkRole, setBulkRole] = useState('');
  const [deleting, setDeleting] = useState<EditUser[] | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = Boolean(me.capabilities.create_users);
  const canPromote = Boolean(me.capabilities.promote_users);
  const canDelete = Boolean(me.capabilities.delete_users);
  const canEdit = Boolean(me.capabilities.edit_users);

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
      orderby: 'name',
    });
    if (role) q.set('roles', role);
    if (search) q.set('search', search);
    try {
      const res = await fetch(`/wp-json/wp/v2/users?${q}`, { credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok) throw new ApiError(res.status, data.code, data.message, data.data);
      const users = data as EditUser[];
      const countData = await api<UserCounts>(
        `/pressbase/v1/user-counts${users.length ? `?include=${users.map((u) => u.id).join(',')}` : ''}`,
      );
      setRows(users);
      setCounts(countData);
      setTotal(Number(res.headers.get('X-WP-Total') ?? users.length));
      setTotalPages(Number(res.headers.get('X-WP-TotalPages') ?? 1));
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load users.');
      setRows([]);
    }
  }, [role, search, page]);

  useEffect(() => {
    load();
  }, [load]);

  const tabs = [
    { id: '', label: 'All', count: counts?.total ?? 0 },
    ...ROLES.map((r) => ({ id: r.id, label: `${r.label}s`, count: counts?.roles[r.id] ?? 0 })),
  ].filter((t) => t.id === '' || t.count > 0 || t.id === role);

  /* ---------------------------------------------------------- actions */

  const changeRole = async () => {
    if (!bulkRole) return;
    const ids = [...selected];
    setBusy(true);
    const results = await Promise.allSettled(
      ids.map((id) => api(`/wp/v2/users/${id}`, { method: 'POST', body: { roles: [bulkRole] } })),
    );
    setBusy(false);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const done = ids.length - failures.length;
    if (done) toast(`${done} ${done === 1 ? 'user' : 'users'} changed to ${roleLabel(bulkRole)}.`);
    if (failures.length) {
      const reason = failures[0]?.reason;
      toast(
        reason instanceof ApiError && failures.length === 1
          ? reason.message
          : `${failures.length} of ${ids.length} couldn’t be changed.`,
        { tone: 'danger' },
      );
    }
    setBulkRole('');
    await load();
  };

  const destroy = async (reassign: number | false) => {
    if (!deleting) return;
    setBusy(true);
    const results = await Promise.allSettled(
      deleting.map((u) =>
        api(`/wp/v2/users/${u.id}?force=true&reassign=${reassign === false ? 'false' : reassign}`, {
          method: 'DELETE',
        }),
      ),
    );
    setBusy(false);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const done = deleting.length - failures.length;
    setDeleting(null);
    if (done) toast(`${done} ${done === 1 ? 'user' : 'users'} deleted.`);
    if (failures.length) {
      const reason = failures[0]?.reason;
      toast(reason instanceof ApiError ? reason.message : 'Couldn’t delete that user.', {
        tone: 'danger',
      });
    }
    await load();
  };

  const selectable = (u: EditUser) => u.id !== me.id && (canPromote || canDelete);
  const selectableRows = rows?.filter(selectable) ?? [];
  const postsOf = (ids: number[]) => ids.reduce((n, id) => n + (counts?.posts[id] ?? 0), 0);

  /* ------------------------------------------------------------ render */

  return (
    <>
      <PageHeader
        title="Users"
        actions={
          canCreate && (
            <ButtonLink
              href="/admin/users/new"
              variant="primary"
              icon={<UserPlus size={16} aria-hidden="true" />}
            >
              Add user
            </ButtonLink>
          )
        }
      />

      <div className={list.toolbar}>
        <ul className={list.tabs} aria-label="Filter by role">
          {tabs.map((tab) => (
            <li key={tab.id || 'all'}>
              <button
                type="button"
                className={list.tab}
                aria-pressed={role === tab.id}
                onClick={() => setParams({ role: tab.id || undefined })}
              >
                {tab.label}
                <span className={list.count}>{tab.count.toLocaleString()}</span>
              </button>
            </li>
          ))}
        </ul>
        <search>
          <form
            className={list.filters}
            onSubmit={(e) => {
              e.preventDefault();
              setParams({ s: query.trim() || undefined });
            }}
          >
            <div className={list.search}>
              <Search size={16} aria-hidden="true" />
              <input
                className={list.input}
                type="search"
                placeholder="Search users"
                aria-label="Search users"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </form>
        </search>
      </div>

      {error && <Notice tone="danger" title={error} />}

      <div className={list.card}>
        {selected.size > 0 && (
          <section className={list.bulkbar} aria-label="Bulk actions">
            <span>{selected.size} selected</span>
            <span className={list.spacer} />
            {canPromote && (
              <div className={styles.bulkRole}>
                <select
                  aria-label="New role for the selected users"
                  value={bulkRole}
                  onChange={(e) => setBulkRole(e.target.value)}
                >
                  <option value="">Change role to…</option>
                  {ROLES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <Button size="sm" onClick={changeRole} disabled={!bulkRole} loading={busy}>
                  Change
                </Button>
              </div>
            )}
            {canDelete && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => setDeleting(rows?.filter((r) => selected.has(r.id)) ?? [])}
                disabled={busy}
              >
                Delete
              </Button>
            )}
          </section>
        )}

        {rows === null ? (
          <table className={list.table} aria-busy="true">
            <tbody>
              {[0, 1, 2, 3].map((i) => (
                <tr key={i}>
                  <td>
                    <div className={list.skeleton} style={{ width: `${60 - i * 8}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users size={28} />}
            title={search ? 'No users match' : 'No users with this role'}
            action={
              <Button
                onClick={() => {
                  setQuery('');
                  setParams({ s: undefined, role: undefined });
                }}
              >
                Show everyone
              </Button>
            }
          >
            <p>{search ? 'Try a name, username or email address.' : 'Try another role.'}</p>
          </EmptyState>
        ) : (
          <table className={list.table}>
            <thead>
              <tr>
                <th className={list.check}>
                  {selectableRows.length > 0 && (
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={selected.size === selectableRows.length}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            selected.size > 0 && selected.size < selectableRows.length;
                      }}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked ? new Set(selectableRows.map((r) => r.id)) : new Set(),
                        )
                      }
                    />
                  )}
                </th>
                <th>Name</th>
                <th className={list.hideNarrow}>Email</th>
                <th className={list.hideNarrow}>Role</th>
                <th className={`${list.hideNarrow} ${styles.number}`}>Posts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((user) => {
                const isMe = user.id === me.id;
                const editHref = isMe ? '/admin/profile' : `/admin/users/${user.id}`;
                const editable = isMe || canEdit;
                const roleName = roleLabel(user.roles[0]);
                return (
                  <tr key={user.id} aria-selected={selected.has(user.id)}>
                    <td className={list.check}>
                      {selectable(user) && (
                        <input
                          type="checkbox"
                          aria-label={`Select ${user.name}`}
                          checked={selected.has(user.id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(user.id);
                            else next.delete(user.id);
                            setSelected(next);
                          }}
                        />
                      )}
                    </td>
                    <td className={list.titleCell}>
                      <div className={styles.person}>
                        <Avatar id={user.id} name={user.name} />
                        <div className={styles.personText}>
                          <span>
                            {editable ? (
                              <Link href={editHref} className={list.titleLink}>
                                {user.name}
                              </Link>
                            ) : (
                              <strong>{user.name}</strong>
                            )}
                            {isMe && <span className={styles.you}> — You</span>}
                          </span>
                          <span className={styles.username}>@{user.username}</span>
                          <span className={styles.mobileMeta}>
                            {roleName} · {user.email}
                          </span>
                          {(editable || (canDelete && !isMe)) && (
                            <div className={list.rowActions}>
                              {editable && (
                                <Link href={editHref} className={list.rowAction}>
                                  {isMe ? 'Edit profile' : 'Edit'}
                                </Link>
                              )}
                              {canDelete && !isMe && (
                                <button
                                  type="button"
                                  className={list.rowAction}
                                  data-tone="danger"
                                  onClick={() => setDeleting([user])}
                                >
                                  Delete
                                  <span className="visually-hidden"> {user.name}</span>
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className={`${list.hideNarrow} ${styles.email}`}>
                      <a href={`mailto:${user.email}`} className={list.rowAction}>
                        {user.email}
                      </a>
                    </td>
                    <td className={`${list.hideNarrow} ${list.meta}`}>{roleName}</td>
                    <td className={`${list.hideNarrow} ${list.meta} ${styles.number}`}>
                      {(counts?.posts[user.id] ?? 0).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {rows && rows.length > 0 && (
          <div className={list.footer}>
            <span>
              {total.toLocaleString()} {total === 1 ? 'user' : 'users'}
            </span>
            {totalPages > 1 && (
              <nav className={list.pager} aria-label="Pagination">
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

      <DeleteUsersDialog
        users={deleting}
        postCount={deleting ? postsOf(deleting.map((u) => u.id)) : undefined}
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={destroy}
      />
    </>
  );
}
