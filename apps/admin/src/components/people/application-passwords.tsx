'use client';

import { Check, Copy, KeyRound, TriangleAlert } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { type AppPassword, formatGmt } from '@/lib/people';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { TextField } from '../ui/field';
import { Card, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './people.module.css';

/**
 * Application passwords (the section on WordPress's profile screen): create
 * one with a name, see the password exactly once, list and revoke them.
 */
export function ApplicationPasswords({
  userId,
  username,
  isSelf,
}: {
  userId: number;
  username: string;
  isSelf: boolean;
}) {
  const toast = useToast();
  const base = `/wp/v2/users/${isSelf ? 'me' : userId}/application-passwords`;
  const [items, setItems] = useState<AppPassword[] | null>(null);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<AppPassword | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<AppPassword | 'all' | null>(null);
  const createdRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api<AppPassword[]>(base));
    } catch (error) {
      setProblem(
        error instanceof ApiError ? error.message : 'Could not load application passwords.',
      );
      setItems([]);
    }
  }, [base]);

  useEffect(() => {
    load();
  }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setNameError('Give it a name, like the app or site that will use it.');
      formRef.current?.querySelector('input')?.focus();
      return;
    }
    setBusy(true);
    setNameError(undefined);
    setProblem(undefined);
    try {
      const item = await api<AppPassword>(base, { method: 'POST', body: { name: name.trim() } });
      setCreated(item);
      setCopied(false);
      setName('');
      await load();
      requestAnimationFrame(() => {
        // Bring the whole box into view, then announce it by moving focus to its heading.
        createdRef.current?.parentElement?.scrollIntoView({ block: 'center' });
        createdRef.current?.focus({ preventScroll: true });
      });
    } catch (error) {
      if (error instanceof ApiError && error.data.params?.name)
        setNameError(error.data.params.name);
      else setProblem(error instanceof ApiError ? error.message : 'Could not create it.');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!created?.password) return;
    try {
      await navigator.clipboard.writeText(created.password);
      setCopied(true);
    } catch {
      toast('Couldn’t copy. Select the password and copy it yourself.', { tone: 'danger' });
    }
  }

  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      if (revoking === 'all') {
        await api(base, { method: 'DELETE' });
        toast('All application passwords revoked.');
      } else {
        await api(`${base}/${revoking.uuid}`, { method: 'DELETE' });
        toast(`“${revoking.name}” revoked.`);
        if (created?.uuid === revoking.uuid) setCreated(null);
      }
      if (revoking === 'all') setCreated(null);
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Couldn’t revoke it.', { tone: 'danger' });
    } finally {
      setBusy(false);
      setRevoking(null);
    }
  }

  return (
    <Card
      title="Application passwords"
      description={
        isSelf
          ? 'Let apps and scripts use the REST API as you, without your main password. You can revoke each one on its own.'
          : 'Let apps and scripts use the REST API as this user. You can revoke each one on its own.'
      }
    >
      <div className={styles.fields}>
        {problem && <Notice tone="danger" title={problem} />}

        {created?.password && (
          <section className={styles.newPassword} aria-labelledby="new-app-password">
            <h3
              id="new-app-password"
              className={styles.newPasswordTitle}
              ref={createdRef}
              tabIndex={-1}
            >
              <TriangleAlert size={18} aria-hidden="true" />
              Copy the password for “{created.name}” now. You won’t see it again.
            </h3>
            <div className={styles.secretRow}>
              <code className={styles.secret}>{created.password}</code>
              <Button
                onClick={copy}
                icon={
                  copied ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    <Copy size={16} aria-hidden="true" />
                  )
                }
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className={styles.muted}>
              Use it with the username <strong>{username}</strong>. Spaces are optional. Apps send
              it with HTTP Basic authentication.
            </p>
            <div>
              <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
                I’ve saved it
              </Button>
            </div>
          </section>
        )}

        <form ref={formRef} className={styles.createRow} onSubmit={create} noValidate>
          <TextField
            label="New application password name"
            placeholder="For example, Deploy script"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(undefined);
            }}
            error={nameError}
            maxLength={200}
            autoComplete="off"
          />
          <Button
            type="submit"
            loading={busy && !revoking}
            icon={<KeyRound size={16} aria-hidden="true" />}
          >
            {busy && !revoking ? 'Adding…' : 'Add application password'}
          </Button>
        </form>

        {items === null ? null : items.length === 0 ? (
          <p className={styles.muted}>No application passwords yet.</p>
        ) : (
          <>
            <ul className={styles.appList} aria-label="Application passwords">
              {items.map((item) => (
                <li key={item.uuid} className={styles.appItem}>
                  <div style={{ minWidth: 0 }}>
                    <p className={styles.appName}>{item.name}</p>
                    <dl className={styles.appMeta}>
                      <div>
                        <dt>Created</dt>
                        <dd>{formatGmt(item.created)}</dd>
                      </div>
                      <div>
                        <dt>Last used</dt>
                        <dd>{formatGmt(item.last_used, true)}</dd>
                      </div>
                      <div>
                        <dt>Last IP</dt>
                        <dd>{item.last_ip || '—'}</dd>
                      </div>
                    </dl>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(item)}>
                    Revoke<span className="visually-hidden"> “{item.name}”</span>
                  </Button>
                </li>
              ))}
            </ul>
            {items.length > 1 && (
              <div>
                <Button size="sm" variant="danger" onClick={() => setRevoking('all')}>
                  Revoke all
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={revoking !== null}
        title={
          revoking === 'all'
            ? 'Revoke all application passwords?'
            : `Revoke “${revoking?.name ?? ''}”?`
        }
        confirmLabel={revoking === 'all' ? 'Revoke all' : 'Revoke'}
        busy={busy}
        onCancel={() => setRevoking(null)}
        onConfirm={revoke}
      >
        {revoking === 'all'
          ? 'Every app using one of them stops working straight away. This can’t be undone.'
          : 'Apps using it stop working straight away. This can’t be undone.'}
      </ConfirmDialog>
    </Card>
  );
}
