'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { Button } from '../ui/button';
import { Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './settings.module.css';

export interface FieldApi<T> {
  values: T;
  set: <K extends keyof T>(key: K, value: T[K]) => void;
  errors: Record<string, string>;
}

/**
 * A settings screen backed by /wp/v2/settings: tracks unsaved changes, shows
 * the save bar, warns before leaving, and maps server errors onto fields.
 * `endpoint` replaces /wp/v2/settings for screens with their own route
 * (Permalinks: /pressbase/v1/permalinks).
 */
export function SettingsForm<T extends Record<string, unknown>>({
  initial,
  children,
  endpoint = '/wp/v2/settings',
  savedValues = (result) => result,
}: {
  initial: T;
  children: (api: FieldApi<T>) => ReactNode;
  endpoint?: string;
  /** Where the saved values are in the response (plugin pages nest them in `values`). */
  savedValues?: (result: Record<string, unknown>) => Record<string, unknown>;
}) {
  const router = useRouter();
  const toast = useToast();
  const { __ } = useI18n();
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(saved), [values, saved]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const set: FieldApi<T>['set'] = (key, value) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors(({ [key as string]: _, ...rest }) => rest);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    try {
      const result = savedValues(
        await api<Record<string, unknown>>(endpoint, { method: 'POST', body: values }),
      );
      const next = Object.fromEntries(
        Object.keys(values).map((k) => [k, result[k] ?? values[k]]),
      ) as T;
      setSaved(next);
      setValues(next);
      toast(__('Settings saved.', 'pressbase-admin'));
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.data.params) setErrors(error.data.params);
      else
        setProblem(
          error instanceof ApiError
            ? error.message
            : __('Could not save your changes.', 'pressbase-admin'),
        );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {problem && <Notice tone="danger" title={problem} />}
      {children({ values, set, errors })}
      {dirty && (
        <section className={styles.savebar} aria-label={__('Unsaved changes', 'pressbase-admin')}>
          <span>{__('You have unsaved changes', 'pressbase-admin')}</span>
          <div className={styles.savebarActions}>
            <Button variant="ghost" onClick={() => setValues(saved)} disabled={busy}>
              {__('Discard', 'pressbase-admin')}
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              {busy ? __('Saving…', 'pressbase-admin') : __('Save changes', 'pressbase-admin')}
            </Button>
          </div>
        </section>
      )}
    </form>
  );
}
