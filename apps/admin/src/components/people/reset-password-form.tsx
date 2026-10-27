'use client';

import { CircleCheck, LinkIcon } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import styles from '../install/installer.module.css';
import { Button, ButtonLink } from '../ui/button';
import { PasswordField } from '../ui/field';
import { Notice } from '../ui/surface';
import auth from './auth-pages.module.css';

type State =
  | { step: 'checking' }
  | { step: 'invalid'; message: string; expired: boolean }
  | { step: 'form' }
  | { step: 'done' };

/**
 * Choose a new password from an emailed link (wp-login.php?action=rp). The
 * link is checked first, so an old or broken one says so straight away
 * instead of after the person has typed a new password.
 */
export function ResetPasswordForm({ login, resetKey }: { login: string; resetKey: string }) {
  const [state, setState] = useState<State>({ step: 'checking' });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!login || !resetKey) {
      setState({ step: 'invalid', message: 'This link is incomplete.', expired: false });
      return;
    }
    api('/pressbase/v1/auth/check-reset-key', {
      method: 'POST',
      body: { login, key: resetKey },
    })
      .then(() => setState({ step: 'form' }))
      .catch((err) =>
        setState({
          step: 'invalid',
          message: err instanceof ApiError ? err.message : 'This link couldn’t be checked.',
          expired: err instanceof ApiError && err.code === 'expired_key',
        }),
      );
  }, [login, resetKey]);

  useEffect(() => {
    if (state.step === 'invalid' || state.step === 'done') {
      requestAnimationFrame(() => headingRef.current?.focus());
    }
  }, [state.step]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password) {
      setError('Choose a password, or generate one.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api('/pressbase/v1/auth/reset-password', {
        method: 'POST',
        body: { login, key: resetKey, password },
      });
      setState({ step: 'done' });
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'invalid_key' || err.code === 'expired_key')) {
        setState({ step: 'invalid', message: err.message, expired: err.code === 'expired_key' });
      } else {
        setError(
          err instanceof ApiError
            ? (err.data.params?.password ?? err.message)
            : 'Something went wrong. Please try again.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  if (state.step === 'checking') {
    return (
      <p className={auth.body} aria-live="polite">
        Checking your link…
      </p>
    );
  }

  if (state.step === 'invalid') {
    return (
      <div className={auth.stack}>
        <span className={auth.icon} data-tone="warning" aria-hidden="true">
          <LinkIcon size={22} />
        </span>
        <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
          {state.expired ? 'This link has expired' : 'This link doesn’t work'}
        </h1>
        <p className={auth.body}>
          {state.expired
            ? 'Reset links last 24 hours. Ask for a new one and use it soon.'
            : 'It may have been used already, or a newer link replaced it. Ask for a new one.'}
        </p>
        <ButtonLink href="/lost-password" variant="primary" fullWidth>
          Get a new link
        </ButtonLink>
        <p className={auth.alt}>
          <Link href="/login">Back to log in</Link>
        </p>
      </div>
    );
  }

  if (state.step === 'done') {
    return (
      <div className={auth.stack}>
        <span className={auth.icon} data-tone="success" aria-hidden="true">
          <CircleCheck size={22} />
        </span>
        <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
          Your password has been reset
        </h1>
        <p className={auth.body}>
          For your security, you’ve been logged out everywhere. Log in with your new password.
        </p>
        <ButtonLink href="/login" variant="primary" fullWidth>
          Log in
        </ButtonLink>
      </div>
    );
  }

  return (
    <form className={styles.form} noValidate onSubmit={submit}>
      <div className={styles.header}>
        <h1 className={styles.title}>Choose a new password</h1>
        <p className={styles.lead}>
          for <strong>{login}</strong>
        </p>
      </div>
      {error && <Notice tone="danger" title={error} />}
      {/* Lets password managers save the new password against the right account. */}
      <input type="text" name="username" autoComplete="username" value={login} readOnly hidden />
      <PasswordField
        label="New password"
        name="new-password"
        isNew
        value={password}
        onChange={(v) => {
          setPassword(v);
          setError(undefined);
        }}
        context={[login]}
      />
      <Button type="submit" variant="primary" fullWidth loading={busy}>
        {busy ? 'Saving…' : 'Save password'}
      </Button>
    </form>
  );
}
