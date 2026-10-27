'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import auth from '../people/auth-pages.module.css';
import { Button } from '../ui/button';
import { Checkbox, PasswordField, TextField } from '../ui/field';
import { Notice } from '../ui/surface';
import styles from './installer.module.css';

/** Only same-site admin paths are allowed as redirect targets. */
function safeRedirect(target: string | undefined): string {
  return target?.startsWith('/admin') && !target.startsWith('//') ? target : '/admin';
}

export function LoginForm({ siteName, redirectTo }: { siteName: string; redirectTo?: string }) {
  const router = useRouter();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!login.trim() || !password) {
      setError('Enter your username or email and your password.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api('/pressbase/v1/auth/login', {
        method: 'POST',
        body: { login, password, remember },
      });
      router.replace(safeRedirect(redirectTo));
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setPassword('');
      setBusy(false);
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }

  return (
    <form className={styles.form} noValidate onSubmit={submit}>
      <div className={styles.header}>
        <h1 className={styles.title}>Log in</h1>
        {siteName && <p className={styles.lead}>to {siteName}</p>}
      </div>

      {error && (
        <div ref={errorRef} tabIndex={-1}>
          <Notice tone="danger" title={error} />
        </div>
      )}

      <TextField
        label="Username or email"
        name="username"
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        autoComplete="username"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus
      />
      <PasswordField label="Password" name="password" value={password} onChange={setPassword} />
      <Checkbox
        label="Keep me logged in for 14 days"
        checked={remember}
        onChange={(e) => setRemember(e.target.checked)}
      />
      <Button type="submit" variant="primary" fullWidth loading={busy}>
        {busy ? 'Logging in…' : 'Log in'}
      </Button>
      <p className={auth.alt}>
        <Link href="/lost-password">Forgot your password?</Link>
      </p>
    </form>
  );
}
