'use client';

import { CheckCircle2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { formatPhpDate } from '@/lib/php-date';
import { Button } from '../ui/button';
import { SelectField, TextField } from '../ui/field';
import { Card, Notice } from '../ui/surface';
import styles from './settings.module.css';
import { SiteIconField, SiteLogoField } from './site-identity-fields';

export interface GeneralSettings {
  title: string;
  description: string;
  url: string;
  email: string;
  timezone: string;
  date_format: string;
  time_format: string;
  start_of_week: number;
  /** Attachment IDs (0 for none), as WordPress registers them. */
  site_logo: number;
  site_icon: number;
}

const DATE_FORMATS = ['F j, Y', 'Y-m-d', 'm/d/Y', 'd/m/Y'];
const TIME_FORMATS = ['g:i a', 'g:i A', 'H:i'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function FormatChoice({
  legend,
  name,
  presets,
  value,
  onChange,
  timezone,
  now,
}: {
  legend: string;
  name: string;
  presets: string[];
  value: string;
  onChange: (value: string) => void;
  timezone: string;
  now: Date | null;
}) {
  const isCustom = !presets.includes(value);
  const [custom, setCustom] = useState(isCustom ? value : '');
  const sample = (format: string) => (now ? formatPhpDate(format, now, timezone) : ' ');

  return (
    <fieldset className={styles.formats}>
      <legend>{legend}</legend>
      {presets.map((format) => (
        <label key={format} className={styles.format}>
          <input
            type="radio"
            name={name}
            checked={value === format}
            onChange={() => onChange(format)}
          />
          <span>{sample(format)}</span>
          <code>{format}</code>
        </label>
      ))}
      <label className={styles.format}>
        <input
          type="radio"
          name={name}
          checked={isCustom}
          onChange={() => onChange(custom || presets[0] || '')}
        />
        <span>Custom{isCustom && value ? `: ${sample(value)}` : ''}</span>
        <input
          className={styles.customInput}
          aria-label={`Custom ${legend.toLowerCase()}`}
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            if (e.target.value) onChange(e.target.value);
          }}
          onFocus={() => custom && onChange(custom)}
          spellCheck={false}
        />
      </label>
    </fieldset>
  );
}

export function GeneralSettingsForm({
  initial,
  timezones,
}: {
  initial: GeneralSettings;
  timezones: string[];
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(false);
  const [now, setNow] = useState<Date | null>(null);

  // Clock for live previews, started on the client only to keep hydration stable.
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(false), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(saved), [values, saved]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const set = <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors(({ [key]: _, ...rest }) => rest);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await api<GeneralSettings>('/wp/v2/settings', {
        method: 'POST',
        body: values,
      });
      const next = { ...values, ...pick(result) };
      setSaved(next);
      setValues(next);
      setErrors({});
      setToast(true);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.data.params) setErrors(error.data.params);
      else setProblem(error instanceof ApiError ? error.message : 'Could not save your changes.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {problem && <Notice tone="danger" title={problem} />}

      <Card
        title="Site identity"
        description="How your site introduces itself to visitors, search engines and browsers."
      >
        <div className={styles.fields}>
          <TextField
            label="Site title"
            value={values.title}
            onChange={(e) => set('title', e.target.value)}
            error={errors.title}
          />
          <TextField
            label="Tagline"
            optional
            value={values.description}
            onChange={(e) => set('description', e.target.value)}
            error={errors.description}
            hint="In a few words, explain what this site is about."
            placeholder="e.g. Notes on design, code and coffee"
          />
          <SiteLogoField
            value={values.site_logo}
            onChange={(id) => set('site_logo', id)}
            siteName={values.title}
          />
          <SiteIconField
            value={values.site_icon}
            onChange={(id) => set('site_icon', id)}
            siteName={values.title}
          />
        </div>
      </Card>

      <Card title="Address and contact">
        <div className={styles.fields}>
          <TextField
            label="Site address (URL)"
            type="url"
            value={values.url}
            onChange={(e) => set('url', e.target.value)}
            error={errors.url}
            hint="Change this only if you have moved the site to a new address."
            spellCheck={false}
          />
          <TextField
            label="Administration email"
            type="email"
            value={values.email}
            onChange={(e) => set('email', e.target.value)}
            error={errors.email}
            hint="Used for admin notices, such as a new user registering."
          />
        </div>
      </Card>

      <Card
        title="Date and time"
        description="Used wherever your site shows dates, such as on posts."
      >
        <div className={styles.fields}>
          <div className={styles.two}>
            <SelectField
              label="Time zone"
              value={values.timezone}
              onChange={(e) => set('timezone', e.target.value)}
              error={errors.timezone}
              hint={now ? `Local time: ${formatPhpDate('g:i a', now, values.timezone)}` : ' '}
            >
              {timezones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replaceAll('_', ' ')}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Week starts on"
              value={values.start_of_week}
              onChange={(e) => set('start_of_week', Number(e.target.value))}
            >
              {WEEKDAYS.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </SelectField>
          </div>
          <div className={styles.two}>
            <FormatChoice
              legend="Date format"
              name="date_format"
              presets={DATE_FORMATS}
              value={values.date_format}
              onChange={(v) => set('date_format', v)}
              timezone={values.timezone}
              now={now}
            />
            <FormatChoice
              legend="Time format"
              name="time_format"
              presets={TIME_FORMATS}
              value={values.time_format}
              onChange={(v) => set('time_format', v)}
              timezone={values.timezone}
              now={now}
            />
          </div>
        </div>
      </Card>

      {dirty && (
        <section className={styles.savebar} aria-label="Unsaved changes">
          <span>You have unsaved changes</span>
          <div className={styles.savebarActions}>
            <Button variant="ghost" onClick={() => setValues(saved)} disabled={busy}>
              Discard
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </section>
      )}

      <div aria-live="polite">
        {toast && (
          <div className={styles.toast}>
            <CheckCircle2 size={16} aria-hidden="true" />
            Settings saved
          </div>
        )}
      </div>
    </form>
  );
}

function pick(result: GeneralSettings): GeneralSettings {
  const {
    title,
    description,
    url,
    email,
    timezone,
    date_format,
    time_format,
    start_of_week,
    site_logo,
    site_icon,
  } = result;
  return {
    title,
    description,
    url,
    email,
    timezone,
    date_format,
    time_format,
    start_of_week,
    site_logo: site_logo ?? 0,
    site_icon: site_icon ?? 0,
  };
}
