'use client';

import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import styles from '../install/installer.module.css';
import { Button, ButtonLink } from '../ui/button';
import { TextField } from '../ui/field';
import { Notice } from '../ui/surface';
import auth from './auth-pages.module.css';

/**
 * "Forgot your password?" (wp-login.php?action=lostpassword). The answer is
 * the same whether or not the account exists, so the screen can't be used to
 * find out who has an account.
 */
export function LostPasswordForm({ siteName }: { siteName: string }) {
  const [login, setLogin] = useState('');
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!login.trim()) {
      setFieldError('Enter your username or email address.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ message: string }>('/pressbase/v1/auth/lost-password', {
        method: 'POST',
        body: { login: login.trim() },
      });
      setSent(res.message);
      requestAnimationFrame(() => headingRef.current?.focus());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className={auth.stack}>
        <span className={auth.icon} aria-hidden="true">
          <MailCheck size={22} />
        </span>
        <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
          Check your email
        </h1>
        <p className={auth.body}>{sent}</p>
        <p className={auth.body}>The link works once and expires in 24 hours.</p>
        <ButtonLink href="/login" variant="primary" fullWidth>
          Back to log in
        </ButtonLink>
        <p className={auth.alt}>
          Nothing arrived?{' '}
          <button type="button" className={auth.linkButton} onClick={() => setSent(null)}>
            Try again
          </button>
        </p>
      </div>
    );
  }

  return (
    <form className={styles.form} noValidate onSubmit={submit}>
      <div className={styles.header}>
        <h1 className={styles.title}>Forgot your password?</h1>
        <p className={styles.lead}>
          Enter your username or email address{siteName ? ` for ${siteName}` : ''}. We’ll email you
          a link to choose a new password.
        </p>
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
        onChange={(e) => {
          setLogin(e.target.value);
          setFieldError(undefined);
        }}
        error={fieldError}
        autoComplete="username"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus
      />
      <Button type="submit" variant="primary" fullWidth loading={busy}>
        {busy ? 'Sending…' : 'Email me a reset link'}
      </Button>
      <p className={auth.alt}>
        Remembered it? <Link href="/login">Log in</Link>
      </p>
    </form>
  );
}
