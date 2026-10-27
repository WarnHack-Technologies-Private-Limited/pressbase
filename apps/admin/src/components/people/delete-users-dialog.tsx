'use client';

import { useEffect, useId, useState } from 'react';
import { api } from '@/lib/api';
import type { EditUser } from '@/lib/people';
import { ConfirmDialog } from '../ui/dialog';
import styles from './people.module.css';

/**
 * WordPress's "Delete users" confirmation (wp-admin/users.php?action=delete):
 * the user's content goes to someone else, or is deleted with them. Moving it
 * is the default, because it's the choice that can't lose anything.
 */
export function DeleteUsersDialog({
  users,
  postCount,
  busy,
  onCancel,
  onConfirm,
}: {
  /** Who is being deleted; null when closed. */
  users: { id: number; name: string }[] | null;
  /** Their posts and pages, when known. */
  postCount?: number;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reassign: number | false) => void;
}) {
  const [others, setOthers] = useState<EditUser[]>([]);
  const [mode, setMode] = useState<'reassign' | 'delete'>('reassign');
  const [target, setTarget] = useState('');
  const name = useId();
  const open = users !== null;

  useEffect(() => {
    if (!users) return;
    setMode('reassign');
    const ids = new Set(users.map((u) => u.id));
    api<EditUser[]>('/wp/v2/users?context=edit&per_page=100&orderby=name')
      .then((all) => {
        // Content can only go to people who can write.
        const candidates = all.filter(
          (u) => !ids.has(u.id) && (u.capabilities.edit_posts || u.roles.includes('administrator')),
        );
        setOthers(candidates);
        setTarget(String(candidates[0]?.id ?? ''));
        if (!candidates.length) setMode('delete');
      })
      .catch(() => setOthers([]));
  }, [users]);

  const many = (users?.length ?? 0) > 1;
  const who = many ? `${users?.length} users` : (users?.[0]?.name ?? 'this user');
  const content =
    postCount === undefined
      ? 'their posts, pages and media'
      : `${postCount.toLocaleString()} ${postCount === 1 ? 'post or page' : 'posts and pages'}, plus any media`;

  return (
    <ConfirmDialog
      open={open}
      title={many ? `Delete ${users?.length} users?` : `Delete ${who}?`}
      confirmLabel={many ? 'Delete users' : 'Delete user'}
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => onConfirm(mode === 'delete' ? false : Number(target))}
    >
      <p>
        {many ? 'They' : who} won’t be able to log in again, and this can’t be undone. What should
        happen to {content}?
      </p>
      <fieldset className={styles.choices}>
        <legend className="visually-hidden">Content</legend>
        <label className={styles.choice}>
          <input
            type="radio"
            name={name}
            checked={mode === 'reassign'}
            onChange={() => setMode('reassign')}
            disabled={!others.length}
          />
          <span className={styles.choiceBody}>
            <span>Give it to another user</span>
            <select
              aria-label="User to give the content to"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setMode('reassign');
              }}
              disabled={!others.length}
            >
              {others.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.username})
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className={styles.choice}>
          <input
            type="radio"
            name={name}
            checked={mode === 'delete'}
            onChange={() => setMode('delete')}
          />
          <span>Delete it too</span>
        </label>
      </fieldset>
    </ConfirmDialog>
  );
}
