/**
 * Tools → SEO: redirects (list, add and edit, CSV import and export), the
 * 404 log ("Create redirect" from a row) and imports from other SEO plugins.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotFoundEntry, Redirect } from '../redirects';
import { host } from './host';
import { __, useL10n } from './l10n';
import { muted, Segmented, stack } from './ui';

const { components } = host;
const NS = '/pressbase-seo/v1';

const table = { width: '100%', borderCollapse: 'collapse' as const, fontSize: 'var(--text-sm)' };
const cell = {
  textAlign: 'left' as const,
  padding: 'var(--space-2)',
  borderBottom: '1px solid var(--color-border)',
  verticalAlign: 'top' as const,
  overflowWrap: 'anywhere' as const,
};

interface Form {
  id?: number;
  source: string;
  target: string;
  status: string;
  regex: boolean;
}
const EMPTY: Form = { source: '', target: '', status: '301', regex: false };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function RedirectForm({
  form,
  setForm,
  onSaved,
}: {
  form: Form;
  setForm: (f: Form) => void;
  onSaved: () => void;
}) {
  const { TextField, SelectField, Checkbox, Button } = components;
  const toast = host.useToast();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sourceRef = useRef<HTMLDivElement>(null);
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = {
        source: form.source,
        target: form.target,
        status: Number(form.status),
        regex: form.regex,
      };
      if (form.id) await host.api(`${NS}/redirects/${form.id}`, { method: 'PUT', body });
      else await host.api(`${NS}/redirects`, { method: 'POST', body });
      toast(form.id ? __('Redirect updated.') : __('Redirect added.'));
      setForm(EMPTY);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      sourceRef.current?.querySelector('input')?.focus();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} style={stack('var(--space-3)')} data-seo-redirect-form="">
      <div ref={sourceRef}>
        <TextField
          label={__('From')}
          value={form.source}
          placeholder="/old-page/"
          hint={
            form.regex
              ? __('A regular expression matched against the path, e.g. ^/blog/(.*)$')
              : __('A path on this site.')
          }
          error={error || undefined}
          onChange={(e: { target: { value: string } }) =>
            setForm({ ...form, source: e.target.value })
          }
        />
      </div>
      <SelectField
        label={__('Type')}
        value={form.status}
        onChange={(e: { target: { value: string } }) =>
          setForm({ ...form, status: e.target.value })
        }
      >
        <option value="301">{__('301 Moved permanently')}</option>
        <option value="302">{__('302 Found (temporary)')}</option>
        <option value="307">{__('307 Temporary redirect')}</option>
        <option value="410">{__('410 Gone (removed for good)')}</option>
      </SelectField>
      {form.status !== '410' && (
        <TextField
          label={__('To')}
          value={form.target}
          placeholder="/new-page/"
          hint={form.regex ? __('Use $1, $2… for the groups matched.') : undefined}
          onChange={(e: { target: { value: string } }) =>
            setForm({ ...form, target: e.target.value })
          }
        />
      )}
      <Checkbox
        label={__('Regular expression')}
        checked={form.regex}
        onChange={(e: { target: { checked: boolean } }) =>
          setForm({ ...form, regex: e.target.checked })
        }
      />
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Button variant="primary" type="submit" loading={busy}>
          {form.id ? __('Update redirect') : __('Add redirect')}
        </Button>
        {(form.id || form.source) && (
          <Button variant="ghost" type="button" onClick={() => setForm(EMPTY)}>
            {__('Cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

function Redirects({ form, setForm }: { form: Form; setForm: (f: Form) => void }) {
  const { Card, Button, EmptyState, TextField } = components;
  const toast = host.useToast();
  const [items, setItems] = useState<Redirect[] | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(() => {
    host
      .api<{ items: Redirect[]; total: number }>(
        `${NS}/redirects?per_page=200${search ? `&search=${encodeURIComponent(search)}` : ''}`,
      )
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
      });
  }, [search]);
  useEffect(load, [load]);

  const remove = async (rule: Redirect) => {
    await host.api(`${NS}/redirects/${rule.id}`, { method: 'DELETE' });
    toast(__('Redirect deleted.'), {});
    load();
  };
  const exportCsv = async () => {
    const res = await fetch(`/wp-json${NS}/redirects/export`, { credentials: 'same-origin' });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'redirects.csv';
    a.click();
    URL.revokeObjectURL(url);
  };
  const importCsv = async (f: File | undefined) => {
    if (!f) return;
    try {
      const res = await host.api<{ saved: number; errors: string[] }>(`${NS}/redirects/import`, {
        method: 'POST',
        body: { csv: await f.text() },
      });
      toast(
        `${res.saved} ${__('redirects imported.')}${res.errors.length ? ` ${res.errors.length} ${__('rows were skipped.')}` : ''}`,
      );
      load();
    } catch (err) {
      toast(errorMessage(err), { tone: 'danger' });
    }
    if (file.current) file.current.value = '';
  };

  return (
    <div style={stack('var(--space-5)')}>
      <Card title={form.id ? __('Edit redirect') : __('Add a redirect')}>
        <RedirectForm form={form} setForm={setForm} onSaved={load} />
      </Card>
      <Card
        title={`${__('Redirects')} (${total})`}
        actions={
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button size="sm" type="button" onClick={exportCsv}>
              {__('Export CSV')}
            </Button>
            <Button size="sm" type="button" onClick={() => file.current?.click()}>
              {__('Import CSV')}
            </Button>
            <input
              ref={file}
              type="file"
              accept=".csv,text/csv"
              hidden
              aria-label={__('Import CSV')}
              onChange={(e) => importCsv(e.target.files?.[0])}
            />
          </div>
        }
      >
        <div style={stack('var(--space-3)')}>
          <TextField
            label={__('Search redirects')}
            optional
            value={search}
            onChange={(e: { target: { value: string } }) => setSearch(e.target.value)}
          />
          {items === null ? null : items.length === 0 ? (
            <EmptyState title={__('No redirects yet')}>
              {__('Add one above, or import a CSV with source, target, status and regex columns.')}
            </EmptyState>
          ) : (
            <table style={table} data-seo-redirects="">
              <thead>
                <tr>
                  <th style={cell}>{__('From')}</th>
                  <th style={cell}>{__('To')}</th>
                  <th style={cell}>{__('Type')}</th>
                  <th style={cell}>{__('Hits')}</th>
                  <th style={cell}>
                    <span
                      style={{
                        position: 'absolute',
                        width: 1,
                        height: 1,
                        overflow: 'hidden',
                        clip: 'rect(0,0,0,0)',
                      }}
                    >
                      {__('Actions')}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((rule) => (
                  <tr key={rule.id}>
                    <td style={cell}>
                      <code>{rule.source}</code>
                      {rule.regex && <span style={muted}> · {__('regex')}</span>}
                    </td>
                    <td style={cell}>{rule.status === 410 ? '—' : <code>{rule.target}</code>}</td>
                    <td style={cell}>{rule.status}</td>
                    <td style={cell}>{rule.hits.toLocaleString()}</td>
                    <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        onClick={() =>
                          setForm({
                            id: rule.id,
                            source: rule.source,
                            target: rule.target,
                            status: String(rule.status),
                            regex: rule.regex,
                          })
                        }
                        aria-label={`${__('Edit')} ${rule.source}`}
                      >
                        {__('Edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        type="button"
                        onClick={() => remove(rule)}
                        aria-label={`${__('Delete')} ${rule.source}`}
                      >
                        {__('Delete')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

function NotFoundLog({ onCreate }: { onCreate: (path: string) => void }) {
  const { Card, Button, EmptyState } = components;
  const toast = host.useToast();
  const [items, setItems] = useState<NotFoundEntry[] | null>(null);
  const load = useCallback(() => {
    host.api<{ items: NotFoundEntry[] }>(`${NS}/404s?per_page=200`).then((r) => setItems(r.items));
  }, []);
  useEffect(load, [load]);
  return (
    <Card
      title={__('404 log')}
      description={__(
        'Addresses visitors asked for that don’t exist: the path, the last referrer and how often. No IP addresses are kept; entries are pruned after 90 days.',
      )}
      actions={
        items?.length ? (
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={async () => {
              await host.api(`${NS}/404s`, { method: 'DELETE' });
              toast(__('404 log cleared.'));
              load();
            }}
          >
            {__('Clear log')}
          </Button>
        ) : null
      }
    >
      {items === null ? null : items.length === 0 ? (
        <EmptyState title={__('No 404s logged')}>
          {__('When a visitor reaches an address that doesn’t exist, it shows up here.')}
        </EmptyState>
      ) : (
        <table style={table} data-seo-404s="">
          <thead>
            <tr>
              <th style={cell}>{__('Path')}</th>
              <th style={cell}>{__('Last referrer')}</th>
              <th style={cell}>{__('Hits')}</th>
              <th style={cell}>{__('Last seen')}</th>
              <th style={cell}>
                <span
                  style={{
                    position: 'absolute',
                    width: 1,
                    height: 1,
                    overflow: 'hidden',
                    clip: 'rect(0,0,0,0)',
                  }}
                >
                  {__('Actions')}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id}>
                <td style={cell}>
                  <code>{row.path}</code>
                </td>
                <td style={cell}>{row.referrer || '—'}</td>
                <td style={cell}>{row.hits.toLocaleString()}</td>
                <td style={cell}>{new Date(row.last_seen).toLocaleString()}</td>
                <td style={cell}>
                  <Button
                    size="sm"
                    type="button"
                    onClick={() => onCreate(row.path)}
                    aria-label={`${__('Create redirect')} ${row.path}`}
                  >
                    {__('Create redirect')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Import() {
  const { Card, Button } = components;
  const toast = host.useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (source: 'rankmath' | 'aioseo') => {
    setBusy(source);
    try {
      const r = await host.api<{ posts: number; terms: number; fields: number }>(
        `${NS}/import/${source}`,
        { method: 'POST' },
      );
      toast(
        `${__('Import finished:')} ${r.posts} ${__('posts and')} ${r.terms} ${__('terms updated.')}`,
      );
    } catch (err) {
      toast(errorMessage(err), { tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card
      title={__('Import from another SEO plugin')}
      description={__(
        'Copies titles, descriptions, keyphrases, canonicals, robots settings and social texts into the fields Pressbase SEO uses. Values already set are kept. Yoast SEO’s data needs no import.',
      )}
    >
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Button type="button" loading={busy === 'rankmath'} onClick={() => run('rankmath')}>
          {__('Import from Rank Math')}
        </Button>
        <Button type="button" loading={busy === 'aioseo'} onClick={() => run('aioseo')}>
          {__('Import from All in One SEO')}
        </Button>
      </div>
    </Card>
  );
}

export default function SeoTools() {
  useL10n();
  const [tab, setTab] = useState<'redirects' | '404s' | 'import'>('redirects');
  const [form, setForm] = useState<Form>(EMPTY);
  return (
    <div style={stack('var(--space-5)')} data-seo-tools="">
      <Segmented
        label={__('SEO tools')}
        value={tab}
        onChange={setTab}
        options={[
          { value: 'redirects', label: __('Redirects') },
          { value: '404s', label: __('404 log') },
          { value: 'import', label: __('Import') },
        ]}
      />
      {tab === 'redirects' && <Redirects form={form} setForm={setForm} />}
      {tab === '404s' && (
        <NotFoundLog
          onCreate={(path) => {
            setForm({ ...EMPTY, source: path });
            setTab('redirects');
          }}
        />
      )}
      {tab === 'import' && <Import />}
    </div>
  );
}
