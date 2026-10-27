'use client';

import { ArrowLeft, KeyRound, UserX } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { displayNameOptions, type EditUser, formatGmt, ROLES, roleLabel } from '@/lib/people';
import settings from '../settings/settings.module.css';
import { useCurrentUser } from '../shell/current-user';
import { PageHeader } from '../shell/page-header';
import { Button, ButtonLink } from '../ui/button';
import { PasswordField, SelectField, TextAreaField, TextField } from '../ui/field';
import { Card, EmptyState, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import { ApplicationPasswords } from './application-passwords';
import { Avatar } from './avatar';
import { DeleteUsersDialog } from './delete-users-dialog';
import styles from './people.module.css';

interface Values {
  first_name: string;
  last_name: string;
  nickname: string;
  name: string;
  email: string;
  url: string;
  description: string;
  role: string;
}

function valuesOf(user: EditUser): Values {
  return {
    first_name: user.first_name,
    last_name: user.last_name,
    nickname: user.nickname,
    name: user.name,
    email: user.email,
    url: user.url,
    description: user.description,
    role: user.roles[0] ?? '',
  };
}

/**
 * Edit a user (wp-admin/user-edit.php) or your own profile (profile.php):
 * role, name, contact, bio, password, application passwords. Changes are
 * saved together from the save bar; only changed fields are sent.
 */
export function UserEditor({ id, self = false }: { id: number; self?: boolean }) {
  const router = useRouter();
  const me = useCurrentUser();
  const toast = useToast();
  const [user, setUser] = useState<EditUser | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [values, setValues] = useState<Values | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sendingLink, setSendingLink] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();

  const path = self ? '/wp/v2/users/me' : `/wp/v2/users/${id}`;

  const load = useCallback(async () => {
    try {
      const data = await api<EditUser>(`${path}?context=edit`);
      setUser(data);
      setValues(valuesOf(data));
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.message : 'Could not load this user.');
    }
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  const saved = useMemo(() => (user ? valuesOf(user) : null), [user]);
  const changed = useMemo(() => {
    if (!values || !saved) return {};
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(values) as (keyof Values)[]) {
      if (values[key] === saved[key]) continue;
      if (key === 'role') out.roles = [values.role];
      else out[key] = values[key];
    }
    if (password) out.password = password;
    return out;
  }, [values, saved, password]);
  const dirty = Object.keys(changed).length > 0;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((v) => (v ? { ...v, [key]: value } : v));
    setErrors(({ [key]: _, ...rest }) => rest);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const updated = await api<EditUser>(path, { method: 'POST', body: changed });
      setUser(updated);
      setValues(valuesOf(updated));
      setPassword(null);
      setErrors({});
      toast(self ? 'Profile updated.' : 'User updated.');
      // The shell shows the current user's name; refresh it.
      if (self || id === me.id) router.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.data.params) {
        const params = { ...error.data.params };
        if (params.roles) params.role = params.roles;
        setErrors(params);
        requestAnimationFrame(() =>
          formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
        );
      } else {
        setProblem(error instanceof ApiError ? error.message : 'Could not save your changes.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendResetLink() {
    if (!user) return;
    setSendingLink(true);
    try {
      await api('/pressbase/v1/auth/lost-password', {
        method: 'POST',
        body: { login: user.username },
      });
      toast(`Password reset link sent to ${user.email}.`);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Couldn’t send the link.', {
        tone: 'danger',
      });
    } finally {
      setSendingLink(false);
    }
  }

  async function destroy(reassign: number | false) {
    setBusy(true);
    try {
      await api(
        `/wp/v2/users/${id}?force=true&reassign=${reassign === false ? 'false' : reassign}`,
        {
          method: 'DELETE',
        },
      );
      toast(`${user?.name ?? 'User'} deleted.`);
      router.push('/admin/users');
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Couldn’t delete this user.', {
        tone: 'danger',
      });
      setBusy(false);
      setDeleting(false);
    }
  }

  const title = self ? 'Profile' : 'Edit user';
  const back = (
    <ButtonLink
      href="/admin/users"
      variant="ghost"
      icon={<ArrowLeft size={16} aria-hidden="true" />}
    >
      All users
    </ButtonLink>
  );

  if (loadError) {
    return (
      <>
        <PageHeader title={title} actions={!self && back} />
        <Card>
          <EmptyState
            icon={<UserX size={28} />}
            title="This user couldn’t be loaded"
            action={!self ? back : undefined}
          >
            <p>{loadError}</p>
          </EmptyState>
        </Card>
      </>
    );
  }
  if (!user || !values) {
    return (
      <>
        <PageHeader title={title} />
        <p className={styles.muted} aria-live="polite">
          Loading…
        </p>
      </>
    );
  }

  const isMe = self || user.id === me.id;
  const canPromote = Boolean(me.capabilities.promote_users) && !isMe;
  const canDelete = Boolean(me.capabilities.delete_users) && !isMe;
  const names = displayNameOptions({ ...values, username: user.username, name: values.name });

  return (
    <>
      <PageHeader
        title={title}
        description={self ? 'How you appear on the site, and how you log in.' : undefined}
        actions={!self && back}
      />
      <div className={styles.layout}>
        <form id={formId} ref={formRef} className={styles.layout} onSubmit={submit} noValidate>
          <div className={styles.identity}>
            <Avatar id={user.id} name={user.name} large />
            <div>
              <p className={styles.identityName}>{user.name}</p>
              <p className={styles.identityMeta}>
                @{user.username} · {roleLabel(user.roles[0])} · Joined{' '}
                {formatGmt(user.registered_date)}
              </p>
            </div>
          </div>

          {problem && <Notice tone="danger" title={problem} />}

          {canPromote && (
            <Card title="Role" description="What this person can do on the site.">
              <fieldset
                className={styles.roleGrid}
                aria-describedby={errors.role ? 'role-error' : undefined}
              >
                <legend className="visually-hidden">Role</legend>
                {ROLES.map((role) => (
                  <label key={role.id} className={styles.roleOption}>
                    <input
                      type="radio"
                      name="role"
                      value={role.id}
                      checked={values.role === role.id}
                      onChange={() => set('role', role.id)}
                    />
                    <span className={styles.roleText}>
                      <span>{role.label}</span>
                      <span className={styles.roleSummary}>{role.summary}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {errors.role && (
                <p id="role-error" role="alert" className={styles.muted}>
                  {errors.role}
                </p>
              )}
            </Card>
          )}

          <Card title="Name">
            <div className={styles.fields}>
              <div className={styles.two}>
                <TextField
                  label="First name"
                  optional
                  value={values.first_name}
                  onChange={(e) => set('first_name', e.target.value)}
                  error={errors.first_name}
                  autoComplete={isMe ? 'given-name' : 'off'}
                />
                <TextField
                  label="Last name"
                  optional
                  value={values.last_name}
                  onChange={(e) => set('last_name', e.target.value)}
                  error={errors.last_name}
                  autoComplete={isMe ? 'family-name' : 'off'}
                />
              </div>
              <div className={styles.two}>
                <TextField
                  label="Nickname"
                  value={values.nickname}
                  onChange={(e) => set('nickname', e.target.value)}
                  error={errors.nickname}
                  autoComplete="off"
                />
                <SelectField
                  label="Display name"
                  hint="Shown on posts and comments."
                  value={values.name}
                  onChange={(e) => set('name', e.target.value)}
                  error={errors.name}
                >
                  {names.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </SelectField>
              </div>
              <TextField
                label="Username"
                value={user.username}
                readOnly
                hint="Usernames can’t be changed."
              />
            </div>
          </Card>

          <Card title="Contact">
            <div className={styles.fields}>
              <TextField
                label="Email"
                type="email"
                value={values.email}
                onChange={(e) => set('email', e.target.value)}
                error={errors.email}
                hint={
                  isMe
                    ? 'Used for password resets and notifications. Never shown publicly.'
                    : 'Never shown publicly. The old address is told when it changes.'
                }
                autoComplete={isMe ? 'email' : 'off'}
              />
              <TextField
                label="Website"
                type="url"
                optional
                value={values.url}
                onChange={(e) => set('url', e.target.value)}
                error={errors.url}
                placeholder="https://"
                autoComplete={isMe ? 'url' : 'off'}
              />
            </div>
          </Card>

          <Card title="About">
            <TextAreaField
              label="Biographical info"
              optional
              rows={4}
              value={values.description}
              onChange={(e) => set('description', e.target.value)}
              error={errors.description}
              hint={
                isMe
                  ? 'A few words about yourself. Themes may show it next to posts.'
                  : 'A few words about this person. Themes may show it next to posts.'
              }
            />
          </Card>

          <Card
            title="Account"
            description={
              isMe
                ? 'Changing your password logs you out everywhere else.'
                : 'Changing the password logs this person out everywhere.'
            }
          >
            <div className={styles.fields}>
              {password === null ? (
                <div className={styles.actions}>
                  <Button
                    onClick={() => setPassword('')}
                    icon={<KeyRound size={16} aria-hidden="true" />}
                  >
                    Set a new password
                  </Button>
                  {!isMe && (
                    <Button variant="ghost" onClick={sendResetLink} loading={sendingLink}>
                      {sendingLink ? 'Sending…' : 'Send a password reset link'}
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  <PasswordField
                    label="New password"
                    isNew
                    value={password}
                    onChange={(v) => {
                      setPassword(v);
                      setErrors(({ password: _, ...rest }) => rest);
                    }}
                    error={errors.password}
                    context={[user.username, values.email, values.first_name, values.last_name]}
                  />
                  <div>
                    <Button variant="ghost" size="sm" onClick={() => setPassword(null)}>
                      Keep the current password
                    </Button>
                  </div>
                </>
              )}
            </div>
          </Card>
        </form>

        <ApplicationPasswords userId={user.id} username={user.username} isSelf={isMe} />

        {canDelete && (
          <Card title="Delete user" className={styles.danger}>
            <div className={styles.fields}>
              <p className={styles.muted}>
                Deleting {user.name} can’t be undone. You’ll choose what happens to their content.
              </p>
              <div>
                <Button variant="danger" onClick={() => setDeleting(true)}>
                  Delete user
                </Button>
              </div>
            </div>
          </Card>
        )}

        {dirty && (
          <section className={settings.savebar} aria-label="Unsaved changes">
            <span>You have unsaved changes</span>
            <div className={settings.savebarActions}>
              <Button
                variant="ghost"
                onClick={() => {
                  setValues(saved);
                  setPassword(null);
                  setErrors({});
                }}
                disabled={busy}
              >
                Discard
              </Button>
              <Button type="submit" form={formId} variant="primary" loading={busy}>
                {busy ? 'Saving…' : self ? 'Update profile' : 'Update user'}
              </Button>
            </div>
          </section>
        )}
      </div>

      <DeleteUsersDialog
        users={deleting ? [{ id: user.id, name: user.name }] : null}
        busy={busy}
        onCancel={() => setDeleting(false)}
        onConfirm={destroy}
      />
    </>
  );
}
