'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { Checkbox, SelectField, TextField } from '../ui/field';
import { Card, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './settings.module.css';

/** GET /pressbase/v1/ai/settings (apps/core/src/routes/ai.ts). Keys are never included. */
export interface AiSettingsData {
  enabled: boolean;
  provider: string;
  model: string;
  daily_limit: number;
  requests_today: number;
  supports_ai: boolean;
  providers: {
    id: string;
    name: string;
    default_model: string;
    models: { id: string; name: string }[];
    key_url: string | null;
    env_var: string;
    key: { source: 'env' | 'database' | 'none'; last4: string | null };
  }[];
}

/**
 * Settings → AI: turn AI on, pick the provider and model, save the provider's
 * API key, set the daily limit, and test the connection. The key goes to core
 * once and only its last four characters ever come back. Every AI request is
 * sent by core, never by the browser.
 */
export function AiSettingsForm({ initial }: { initial: AiSettingsData }) {
  const { __, sprintf } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [provider, setProvider] = useState(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [limit, setLimit] = useState(String(initial.daily_limit));
  const [apiKey, setApiKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const current = data.providers.find((p) => p.id === provider) ?? data.providers[0];
  const key = current?.key ?? { source: 'none', last4: null };
  const models = current?.models ?? [];
  const knownModel = model === '' || models.some((m) => m.id === model);

  async function send(body: Record<string, unknown>) {
    const next = await api<AiSettingsData>('/pressbase/v1/ai/settings', { method: 'POST', body });
    setData(next);
    router.refresh();
    return next;
  }

  function fail(error: unknown, fallback: string) {
    if (error instanceof ApiError && error.data.params) setErrors(error.data.params);
    else setProblem(error instanceof ApiError ? error.message : fallback);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy('save');
    setProblem(undefined);
    setErrors({});
    try {
      const body: Record<string, unknown> = {
        enabled,
        provider,
        model,
        daily_limit: Number(limit),
      };
      // An empty field keeps the saved key.
      if (apiKey.trim()) body.api_key = apiKey.trim();
      await send(body);
      setApiKey('');
      toast(__('AI settings saved.', 'pressbase-admin'));
    } catch (error) {
      fail(error, __('Could not save your changes.', 'pressbase-admin'));
    } finally {
      setBusy(null);
    }
  }

  async function removeKey() {
    setBusy('remove');
    setProblem(undefined);
    try {
      await send({ provider, api_key: '' });
      toast(__('API key removed.', 'pressbase-admin'));
    } catch (error) {
      fail(error, __('Could not remove the key.', 'pressbase-admin'));
    } finally {
      setBusy(null);
      setConfirmRemove(false);
    }
  }

  async function test() {
    setBusy('test');
    setProblem(undefined);
    try {
      const result = await api<{ provider: string; model: string }>('/pressbase/v1/ai/test', {
        method: 'POST',
      });
      toast(
        sprintf(
          __('Connected. %1$s answered with %2$s.', 'pressbase-admin'),
          current?.name ?? result.provider,
          result.model,
        ),
      );
      router.refresh();
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? error.message
          : __('Could not reach the AI provider.', 'pressbase-admin'),
      );
    } finally {
      setBusy(null);
    }
  }

  const keyStatus =
    key.source === 'env'
      ? sprintf(
          __('Set by the %1$s environment variable, ends in …%2$s', 'pressbase-admin'),
          current?.env_var ?? '',
          key.last4 ?? '',
        )
      : key.source === 'database'
        ? sprintf(__('Saved, ends in …%s', 'pressbase-admin'), key.last4 ?? '')
        : __('No key saved.', 'pressbase-admin');

  return (
    <form className={styles.form} onSubmit={save} noValidate>
      {problem && <Notice tone="danger" title={problem} />}
      <Card
        title={__('AI features', 'pressbase-admin')}
        description={__(
          'Plugins such as Pressbase SEO can suggest titles, descriptions and alt text. Nothing is sent to a provider until someone asks for a suggestion, and suggestions are never applied without a person choosing them.',
          'pressbase-admin',
        )}
      >
        <Checkbox
          label={__('Turn on AI features', 'pressbase-admin')}
          description={__(
            'Requests are sent from this server, never from visitors’ browsers.',
            'pressbase-admin',
          )}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </Card>

      <Card
        title={__('Provider', 'pressbase-admin')}
        description={__(
          'The service that answers AI requests, and the model it uses.',
          'pressbase-admin',
        )}
      >
        <div className={styles.fields}>
          <SelectField
            label={__('Provider', 'pressbase-admin')}
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel('');
            }}
            error={errors.provider}
          >
            {data.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={__('Model', 'pressbase-admin')}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            error={errors.model}
          >
            <option value="">
              {sprintf(__('Default (%s)', 'pressbase-admin'), current?.default_model ?? '')}
            </option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            {!knownModel && <option value={model}>{model}</option>}
          </SelectField>
        </div>
      </Card>

      <Card
        title={__('API key', 'pressbase-admin')}
        description={keyStatus}
        actions={
          key.source === 'database' ? (
            <Button variant="ghost" onClick={() => setConfirmRemove(true)} disabled={busy !== null}>
              {__('Remove key', 'pressbase-admin')}
            </Button>
          ) : undefined
        }
      >
        <div className={styles.fields}>
          <TextField
            label={
              key.source === 'none'
                ? __('API key', 'pressbase-admin')
                : __('Replace the key', 'pressbase-admin')
            }
            type="password"
            autoComplete="off"
            spellCheck={false}
            optional={key.source !== 'none'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            error={errors.api_key}
            hint={
              key.source === 'env'
                ? __('The environment variable wins over a saved key.', 'pressbase-admin')
                : __('Stored on this server and never shown again.', 'pressbase-admin')
            }
          />
        </div>
      </Card>

      <Card
        title={__('Daily limit', 'pressbase-admin')}
        description={sprintf(
          __('%d requests sent today. The count resets at midnight UTC.', 'pressbase-admin'),
          data.requests_today,
        )}
      >
        <div className={`${styles.fields} ${styles.short}`}>
          <TextField
            label={__('Requests per day', 'pressbase-admin')}
            type="number"
            min={0}
            inputMode="numeric"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            error={errors.daily_limit}
            hint={__('For the whole site, all plugins together.', 'pressbase-admin')}
          />
        </div>
      </Card>

      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={busy === 'save'} disabled={busy !== null}>
          {busy === 'save'
            ? __('Saving…', 'pressbase-admin')
            : __('Save changes', 'pressbase-admin')}
        </Button>
        <Button
          onClick={test}
          loading={busy === 'test'}
          disabled={busy !== null || !data.supports_ai}
        >
          {busy === 'test'
            ? __('Testing…', 'pressbase-admin')
            : __('Test connection', 'pressbase-admin')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title={__('Remove the API key?', 'pressbase-admin')}
        confirmLabel={__('Remove key', 'pressbase-admin')}
        tone="danger"
        busy={busy === 'remove'}
        onConfirm={removeKey}
        onCancel={() => setConfirmRemove(false)}
      >
        {__('AI features stop working until a new key is saved.', 'pressbase-admin')}
      </ConfirmDialog>
    </form>
  );
}
