'use client';

import { CheckCircle2, Download } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { dateWords } from '@/lib/i18n/date-words';
import {
  type AvailableLanguage,
  type InstalledLanguage,
  type InstallResult,
  installable,
  type Languages,
  languageLabel,
} from '@/lib/languages';
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
  /** The site's language (WordPress's WPLANG), e.g. en_US or de_DE. */
  language: string;
}

const DATE_FORMATS = ['F j, Y', 'Y-m-d', 'm/d/Y', 'd/m/Y'];
const TIME_FORMATS = ['g:i a', 'g:i A', 'H:i'];

function FormatChoice({
  legend,
  customLabel,
  name,
  presets,
  value,
  onChange,
  sample,
}: {
  legend: string;
  /** The custom field's accessible name, e.g. "Custom date format". */
  customLabel: string;
  name: string;
  presets: string[];
  value: string;
  onChange: (value: string) => void;
  sample: (format: string) => string;
}) {
  const { __, sprintf } = useI18n();
  const isCustom = !presets.includes(value);
  const [custom, setCustom] = useState(isCustom ? value : '');

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
        <span>
          {isCustom && value
            ? // translators: %s: a date or time in the custom format.
              sprintf(__('Custom: %s', 'pressbase-admin'), sample(value))
            : __('Custom', 'pressbase-admin')}
        </span>
        <input
          className={styles.customInput}
          aria-label={customLabel}
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

/**
 * Settings → General's language: the site language select
 * (wp_dropdown_languages()) and, for people with `install_languages`,
 * installing a language pack from WordPress.org (wp_download_language_pack()).
 */
function LanguageFields({
  value,
  onChange,
  error,
  languages,
}: {
  value: string;
  onChange: (language: string) => void;
  error?: string;
  languages: Languages;
}) {
  const { __, sprintf } = useI18n();
  const [installed, setInstalled] = useState<InstalledLanguage[]>(languages.installed);
  const [available, setAvailable] = useState<AvailableLanguage[] | null>(null);
  const [choice, setChoice] = useState('');
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string }>();
  const offer = available ? installable(available, installed) : [];

  async function loadAvailable() {
    setLoading(true);
    setMessage(undefined);
    try {
      setAvailable(await api<AvailableLanguage[]>('/pressbase/v1/languages/available'));
    } catch (error) {
      setMessage({
        tone: 'danger',
        text:
          error instanceof ApiError
            ? error.message
            : __('Could not reach WordPress.org.', 'pressbase-admin'),
      });
    } finally {
      setLoading(false);
    }
  }

  async function install() {
    if (!choice) return;
    setInstalling(true);
    setMessage(undefined);
    try {
      const result = await api<InstallResult>('/pressbase/v1/languages', {
        method: 'POST',
        body: { language: choice },
      });
      setInstalled(result.installed);
      const added = result.installed.find((l) => l.language === result.language);
      setMessage({
        tone: 'success',
        text: sprintf(
          // translators: %s: a language's name.
          __('%s is installed. Choose it as the site language and save.', 'pressbase-admin'),
          added ? languageLabel(added) : result.language,
        ),
      });
      onChange(result.language);
      setChoice('');
    } catch (error) {
      setMessage({
        tone: 'danger',
        text:
          error instanceof ApiError
            ? error.message
            : __('Could not install the language.', 'pressbase-admin'),
      });
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className={styles.fields}>
      <SelectField
        label={__('Site language', 'pressbase-admin')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        error={error}
        hint={__(
          'The language of the public site, and of the admin for people who haven’t chosen their own.',
          'pressbase-admin',
        )}
      >
        {installed.map((language) => (
          <option
            key={language.language}
            value={language.language}
            lang={language.language.replace('_', '-')}
          >
            {languageLabel(language)}
          </option>
        ))}
      </SelectField>
      {languages.can_install &&
        (available === null ? (
          <div>
            <Button
              variant="secondary"
              onClick={loadAvailable}
              loading={loading}
              icon={<Download size={16} aria-hidden="true" />}
            >
              {__('Add a language…', 'pressbase-admin')}
            </Button>
          </div>
        ) : (
          <div className={styles.two}>
            <SelectField
              label={__('Language to install', 'pressbase-admin')}
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              hint={__(
                'Downloads WordPress’s translation from WordPress.org: the block editor and themes speak the language too.',
                'pressbase-admin',
              )}
            >
              <option value="">{__('Choose a language', 'pressbase-admin')}</option>
              {offer.map((language) => (
                <option key={language.language} value={language.language}>
                  {languageLabel(language)}
                </option>
              ))}
            </SelectField>
            <div style={{ alignSelf: 'center' }}>
              <Button variant="secondary" onClick={install} loading={installing} disabled={!choice}>
                {installing
                  ? __('Installing…', 'pressbase-admin')
                  : __('Install', 'pressbase-admin')}
              </Button>
            </div>
          </div>
        ))}
      <div aria-live="polite">{message && <Notice tone={message.tone} title={message.text} />}</div>
    </div>
  );
}

export function GeneralSettingsForm({
  initial,
  timezones,
  languages,
}: {
  initial: GeneralSettings;
  timezones: string[];
  languages: Languages;
}) {
  const router = useRouter();
  const { __, _x, sprintf } = useI18n();
  const words = useMemo(() => dateWords(__, _x), [__, _x]);
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const sample = (timezone: string) => (format: string) =>
    now ? formatPhpDate(format, now, timezone, words) : ' ';

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
      // A new site language re-renders the admin in it (for people without their own).
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

      <Card
        title={__('Site identity', 'pressbase-admin')}
        description={__(
          'How your site introduces itself to visitors, search engines and browsers.',
          'pressbase-admin',
        )}
      >
        <div className={styles.fields}>
          <TextField
            label={__('Site title', 'pressbase-admin')}
            value={values.title}
            onChange={(e) => set('title', e.target.value)}
            error={errors.title}
          />
          <TextField
            label={__('Tagline', 'pressbase-admin')}
            optional
            value={values.description}
            onChange={(e) => set('description', e.target.value)}
            error={errors.description}
            hint={__('In a few words, explain what this site is about.', 'pressbase-admin')}
            placeholder={__('e.g. Notes on design, code and coffee', 'pressbase-admin')}
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

      <Card title={__('Address and contact', 'pressbase-admin')}>
        <div className={styles.fields}>
          <TextField
            label={__('Site address (URL)', 'pressbase-admin')}
            type="url"
            value={values.url}
            onChange={(e) => set('url', e.target.value)}
            error={errors.url}
            hint={__(
              'Change this only if you have moved the site to a new address.',
              'pressbase-admin',
            )}
            spellCheck={false}
          />
          <TextField
            label={__('Administration email', 'pressbase-admin')}
            type="email"
            value={values.email}
            onChange={(e) => set('email', e.target.value)}
            error={errors.email}
            hint={__('Used for admin notices, such as a new user registering.', 'pressbase-admin')}
          />
        </div>
      </Card>

      <Card
        title={__('Language', 'pressbase-admin')}
        description={__(
          'Pressbase uses WordPress’s translations, so the editor and themes are translated too.',
          'pressbase-admin',
        )}
      >
        <LanguageFields
          value={values.language}
          onChange={(language) => set('language', language)}
          error={errors.language}
          languages={languages}
        />
      </Card>

      <Card
        title={__('Date and time', 'pressbase-admin')}
        description={__(
          'Used wherever your site shows dates, such as on posts.',
          'pressbase-admin',
        )}
      >
        <div className={styles.fields}>
          <div className={styles.two}>
            <SelectField
              label={__('Time zone', 'pressbase-admin')}
              value={values.timezone}
              onChange={(e) => set('timezone', e.target.value)}
              error={errors.timezone}
              hint={
                now
                  ? // translators: %s: the time now in the chosen time zone.
                    sprintf(
                      __('Local time: %s', 'pressbase-admin'),
                      formatPhpDate('g:i a', now, values.timezone, words),
                    )
                  : ' '
              }
            >
              {timezones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replaceAll('_', ' ')}
                </option>
              ))}
            </SelectField>
            <SelectField
              label={__('Week starts on', 'pressbase-admin')}
              value={values.start_of_week}
              onChange={(e) => set('start_of_week', Number(e.target.value))}
            >
              {words.weekday.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </SelectField>
          </div>
          <div className={styles.two}>
            <FormatChoice
              legend={__('Date format', 'pressbase-admin')}
              customLabel={__('Custom date format', 'pressbase-admin')}
              name="date_format"
              presets={DATE_FORMATS}
              value={values.date_format}
              onChange={(v) => set('date_format', v)}
              sample={sample(values.timezone)}
            />
            <FormatChoice
              legend={__('Time format', 'pressbase-admin')}
              customLabel={__('Custom time format', 'pressbase-admin')}
              name="time_format"
              presets={TIME_FORMATS}
              value={values.time_format}
              onChange={(v) => set('time_format', v)}
              sample={sample(values.timezone)}
            />
          </div>
        </div>
      </Card>

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

      <div aria-live="polite">
        {toast && (
          <div className={styles.toast}>
            <CheckCircle2 size={16} aria-hidden="true" />
            {__('Settings saved', 'pressbase-admin')}
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
    language,
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
    language: language || 'en_US',
  };
}
