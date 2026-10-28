'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
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
  const { __, sprintf } = useI18n();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!login.trim() || !password) {
      setError(__('Enter your username or email and your password.', 'pressbase-admin'));
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
      setError(
        err instanceof ApiError
          ? err.message
          : __('Something went wrong. Please try again.', 'pressbase-admin'),
      );
      setPassword('');
      setBusy(false);
      requestAnimationFrame(() => errorRef.current?.focus());
    }
  }

  return (
    <form className={styles.form} noValidate onSubmit={submit}>
      <div className={styles.header}>
        <h1 className={styles.title}>{__('Log in', 'pressbase-admin')}</h1>
        {siteName && (
          <p className={styles.lead}>
            {/* translators: %s: the site's title. */}
            {sprintf(__('to %s', 'pressbase-admin'), siteName)}
          </p>
        )}
      </div>

      {error && (
        <div ref={errorRef} tabIndex={-1}>
          <Notice tone="danger" title={error} />
        </div>
      )}

      <TextField
        label={__('Username or email', 'pressbase-admin')}
        name="username"
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        autoComplete="username"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus
      />
      <PasswordField
        label={__('Password', 'pressbase-admin')}
        name="password"
        value={password}
        onChange={setPassword}
      />
      <Checkbox
        label={__('Keep me logged in for 14 days', 'pressbase-admin')}
        checked={remember}
        onChange={(e) => setRemember(e.target.checked)}
      />
      <Button type="submit" variant="primary" fullWidth loading={busy}>
        {busy ? __('Logging in…', 'pressbase-admin') : __('Log in', 'pressbase-admin')}
      </Button>
      <p className={auth.alt}>
        <Link href="/lost-password">{__('Forgot your password?', 'pressbase-admin')}</Link>
      </p>
    </form>
  );
}
