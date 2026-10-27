'use client';

import { CheckCircle2, ChevronDown, Database, KeyRound, Mail, PartyPopper } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import type { InstallStatus } from '@/lib/core';
import { generatePassword, passwordStrength } from '@/lib/password';
import { Button, ButtonLink } from '../ui/button';
import { Checkbox, PasswordField, TextField } from '../ui/field';
import { Badge, Notice } from '../ui/surface';
import styles from './installer.module.css';

type StepId = 'welcome' | 'database' | 'site' | 'done';

interface DatabaseForm {
  kind: 'postgres' | 'embedded';
  mode: 'fields' | 'url';
  host: string;
  port: string;
  name: string;
  user: string;
  password: string;
  ssl: boolean;
  url: string;
}

interface SiteForm {
  title: string;
  username: string;
  password: string;
  email: string;
  discourageSearchEngines: boolean;
  allowWeak: boolean;
}

type Errors = Record<string, string>;

interface Problem {
  title: string;
  hint?: string;
}

function databasePayload(form: DatabaseForm) {
  if (form.kind === 'embedded') return { kind: 'embedded' as const };
  if (form.mode === 'url') return { kind: 'url' as const, url: form.url.trim() };
  return {
    kind: 'postgres' as const,
    host: form.host.trim(),
    port: Number(form.port) || 5432,
    name: form.name.trim(),
    user: form.user.trim(),
    password: form.password,
    ssl: form.ssl,
  };
}

function validateDatabase(form: DatabaseForm): Errors {
  const errors: Errors = {};
  if (form.kind === 'embedded') return errors;
  if (form.mode === 'url') {
    if (!/^postgres(ql)?:\/\//i.test(form.url.trim()))
      errors.url = 'The URL must start with postgres://';
    return errors;
  }
  if (!form.host.trim()) errors.host = 'Enter the database host.';
  if (!form.name.trim()) errors.name = 'Enter the database name.';
  if (!form.user.trim()) errors.user = 'Enter the database username.';
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    errors.port = 'Use a port from 1 to 65535.';
  return errors;
}

function validateSite(form: SiteForm): Errors {
  const errors: Errors = {};
  if (!form.title.trim()) errors.title = 'Give your site a name. You can change it later.';
  if (!form.username.trim()) errors.username = 'Choose a username.';
  else if (!/^[A-Za-z0-9 _.\-@]+$/.test(form.username.trim()))
    errors.username =
      'Usernames can contain letters, numbers, spaces and these characters: _ . - @';
  if (form.password.length < 8) errors.password = 'Use at least 8 characters.';
  else if (passwordStrength(form.password, [form.username, form.email]) < 2 && !form.allowWeak)
    errors.allowWeak = 'Confirm that you want to use a weak password, or choose a stronger one.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
    errors.email = 'Enter a valid email address.';
  return errors;
}

/** Moves focus to the first invalid field so keyboard and screen reader users land on it. */
function focusFirstError(form: HTMLFormElement | null) {
  requestAnimationFrame(() => form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}

export function Installer({ status }: { status: InstallStatus }) {
  const needsDatabase = status.state === 'needs-database';
  const steps: { id: StepId; label: string }[] = [
    { id: 'welcome', label: 'Welcome' },
    ...(needsDatabase ? [{ id: 'database' as const, label: 'Database' }] : []),
    { id: 'site', label: 'Your site' },
  ];

  const [step, setStep] = useState<StepId>('welcome');
  const [setupToken, setSetupToken] = useState('');
  const [tokenError, setTokenError] = useState<string>();
  const [database, setDatabase] = useState<DatabaseForm>({
    kind: 'postgres',
    mode: 'fields',
    host: 'localhost',
    port: '5432',
    name: 'pressbase',
    user: '',
    password: '',
    ssl: false,
    url: '',
  });
  const [site, setSite] = useState<SiteForm>({
    title: '',
    username: '',
    password: '',
    email: '',
    discourageSearchEngines: false,
    allowWeak: false,
  });
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<Problem>();
  const [busy, setBusy] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const firstRender = useRef(true);

  // Each step change moves focus to the new heading, so assistive tech announces it.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  // Suggest a strong password when the account step first opens (client only, to avoid
  // a server/client mismatch).
  useEffect(() => {
    if (step === 'site' && !site.password) setSite((s) => ({ ...s, password: generatePassword() }));
  }, [step, site.password]);

  const go = (next: StepId) => {
    setErrors({});
    setProblem(undefined);
    setStep(next);
  };

  const stepIndex = steps.findIndex((s) => s.id === step);
  const failingChecks = status.checks.filter((c) => !c.ok);

  async function submitDatabase(event: FormEvent) {
    event.preventDefault();
    const found = validateDatabase(database);
    setErrors(found);
    setProblem(undefined);
    if (Object.keys(found).length) return focusFirstError(formRef.current);

    setBusy(true);
    try {
      await api('/pressbase/v1/install/database-check', {
        method: 'POST',
        body: { database: databasePayload(database), setupToken: setupToken || undefined },
      });
      go('site');
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  async function submitSite(event: FormEvent) {
    event.preventDefault();
    const found = validateSite(site);
    setErrors(found);
    setProblem(undefined);
    if (Object.keys(found).length) return focusFirstError(formRef.current);

    setBusy(true);
    try {
      await api('/pressbase/v1/install', {
        method: 'POST',
        body: {
          database: needsDatabase ? databasePayload(database) : undefined,
          setupToken: setupToken || undefined,
          site: {
            title: site.title.trim(),
            username: site.username.trim(),
            password: site.password,
            email: site.email.trim(),
            url: window.location.origin,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            discourageSearchEngines: site.discourageSearchEngines,
          },
        },
      });
      go('done');
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  function handleError(error: unknown) {
    if (!(error instanceof ApiError)) {
      setProblem({ title: 'Something unexpected happened. Please try again.' });
      return;
    }
    if (error.code === 'pressbase_setup_token_invalid') {
      setTokenError(error.message);
      go('welcome');
      return;
    }
    if (error.code === 'rest_invalid_param' && error.data.params) {
      const mapped: Errors = {};
      for (const [key, message] of Object.entries(error.data.params)) {
        mapped[key.replace(/^(site|database)\./, '')] = message;
      }
      setErrors(mapped);
      focusFirstError(formRef.current);
      return;
    }
    if (error.code.startsWith('pressbase_db_') && step === 'site') {
      // The database stopped answering between steps: send the user back to fix it.
      setStep('database');
    }
    setProblem({ title: error.message, hint: error.data.hint });
  }

  const header = (title: string, lead?: string) => (
    <div className={styles.header}>
      <h1 ref={headingRef} tabIndex={-1} className={styles.title}>
        {title}
      </h1>
      {lead && <p className={styles.lead}>{lead}</p>}
    </div>
  );

  const problemNotice = problem && (
    <Notice tone="danger" title={problem.title}>
      {problem.hint}
    </Notice>
  );

  return (
    <>
      {step !== 'done' && (
        <ol className={styles.stepper} aria-label="Installation progress">
          {steps.map((s, i) => (
            <li
              key={s.id}
              className={styles.step}
              data-state={i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'upcoming'}
              aria-current={i === stepIndex ? 'step' : undefined}
            >
              <span>
                <span className="visually-hidden">
                  Step {i + 1} of {steps.length}:{' '}
                </span>
                {s.label}
              </span>
            </li>
          ))}
        </ol>
      )}

      {step === 'welcome' && (
        <form
          className={styles.form}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (status.setupTokenRequired && !setupToken.trim()) {
              setTokenError('Enter the setup code to continue.');
              return;
            }
            go(needsDatabase ? 'database' : 'site');
          }}
        >
          {header(
            'Welcome to Pressbase',
            'Let’s get your site running. It takes about two minutes.',
          )}

          <ul className={styles.needs} aria-label="What you’ll need">
            {needsDatabase && (
              <li>
                <Database size={18} aria-hidden="true" />
                <span>
                  Your PostgreSQL connection details — or use the built-in database to try Pressbase
                  out.
                </span>
              </li>
            )}
            <li>
              <KeyRound size={18} aria-hidden="true" />
              <span>A username and password for your account.</span>
            </li>
            <li>
              <Mail size={18} aria-hidden="true" />
              <span>An email address for password resets.</span>
            </li>
          </ul>

          {failingChecks.length > 0 ? (
            <Notice
              tone="warning"
              title="Your server needs attention before Pressbase can be installed"
            >
              <ul>
                {failingChecks.map((check) => (
                  <li key={check.id}>
                    {check.label}: {check.detail}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : (
            <details className={styles.checks}>
              <summary>
                <CheckCircle2 size={18} aria-hidden="true" />
                Your server is ready
                <ChevronDown size={16} className={styles.chevron} aria-hidden="true" />
              </summary>
              <ul className={styles.checkList}>
                {status.checks.map((check) => (
                  <li key={check.id}>
                    <CheckCircle2 size={14} aria-hidden="true" color="var(--color-success)" />
                    <span>{check.label}</span>
                    <span className={styles.checkDetail}>{check.detail}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {status.setupTokenRequired && (
            <TextField
              label="Setup code"
              value={setupToken}
              onChange={(e) => {
                setSetupToken(e.target.value);
                setTokenError(undefined);
              }}
              error={tokenError}
              hint="Your server administrator set this in PRESSBASE_SETUP_TOKEN. It stops anyone else from claiming your site first."
              autoComplete="off"
              spellCheck={false}
            />
          )}

          <div className={styles.actions}>
            <Button type="submit" variant="primary" disabled={failingChecks.length > 0}>
              Let’s go
            </Button>
          </div>
        </form>
      )}

      {step === 'database' && (
        <form ref={formRef} className={styles.form} noValidate onSubmit={submitDatabase}>
          {header('Connect a database', 'Pressbase keeps your content in PostgreSQL.')}

          <fieldset className={styles.choices}>
            <legend className="visually-hidden">Database type</legend>
            <label className={styles.choice}>
              <input
                type="radio"
                name="kind"
                checked={database.kind === 'postgres'}
                onChange={() => setDatabase({ ...database, kind: 'postgres' })}
              />
              <span className={styles.choiceText}>
                <span className={styles.choiceTitle}>
                  PostgreSQL server <Badge tone="accent">Recommended</Badge>
                </span>
                <span className={styles.choiceDescription}>
                  For live sites. Use a database from your host, Docker or a managed service.
                </span>
              </span>
            </label>
            <label className={styles.choice}>
              <input
                type="radio"
                name="kind"
                checked={database.kind === 'embedded'}
                onChange={() => setDatabase({ ...database, kind: 'embedded' })}
              />
              <span className={styles.choiceText}>
                <span className={styles.choiceTitle}>Built-in database</span>
                <span className={styles.choiceDescription}>
                  Nothing to set up — ideal for trying Pressbase on your computer. Not meant for
                  live sites.
                </span>
              </span>
            </label>
          </fieldset>

          {database.kind === 'postgres' && (
            <>
              <fieldset className={styles.tabs}>
                <legend className="visually-hidden">How to enter connection details</legend>
                <button
                  type="button"
                  className={styles.tab}
                  aria-pressed={database.mode === 'fields'}
                  onClick={() => setDatabase({ ...database, mode: 'fields' })}
                >
                  Connection details
                </button>
                <button
                  type="button"
                  className={styles.tab}
                  aria-pressed={database.mode === 'url'}
                  onClick={() => setDatabase({ ...database, mode: 'url' })}
                >
                  Connection URL
                </button>
              </fieldset>

              {database.mode === 'fields' ? (
                <>
                  <div className={styles.row}>
                    <TextField
                      label="Host"
                      value={database.host}
                      onChange={(e) => setDatabase({ ...database, host: e.target.value })}
                      error={errors.host}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <TextField
                      label="Port"
                      inputMode="numeric"
                      value={database.port}
                      onChange={(e) => setDatabase({ ...database, port: e.target.value })}
                      error={errors.port}
                    />
                  </div>
                  <TextField
                    label="Database name"
                    value={database.name}
                    onChange={(e) => setDatabase({ ...database, name: e.target.value })}
                    error={errors.name}
                    hint="The database must already exist. Pressbase creates the tables."
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <TextField
                    label="Username"
                    value={database.user}
                    onChange={(e) => setDatabase({ ...database, user: e.target.value })}
                    error={errors.user}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <PasswordField
                    label="Password"
                    optional
                    value={database.password}
                    onChange={(password) => setDatabase({ ...database, password })}
                    autoComplete="off"
                  />
                  <Checkbox
                    label="Require SSL"
                    description="Turn this on for hosted databases such as Neon, Supabase or Amazon RDS."
                    checked={database.ssl}
                    onChange={(e) => setDatabase({ ...database, ssl: e.target.checked })}
                  />
                </>
              ) : (
                <div className={styles.mono}>
                  <TextField
                    label="Connection URL"
                    value={database.url}
                    onChange={(e) => setDatabase({ ...database, url: e.target.value })}
                    error={errors.url}
                    placeholder="postgres://user:password@host:5432/database"
                    hint="Your host may call this a connection string or DATABASE_URL."
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              )}
            </>
          )}

          {problemNotice}

          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => go('welcome')} disabled={busy}>
              Back
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              {busy
                ? 'Connecting…'
                : database.kind === 'embedded'
                  ? 'Continue'
                  : 'Connect and continue'}
            </Button>
          </div>
        </form>
      )}

      {step === 'site' && (
        <form ref={formRef} className={styles.form} noValidate onSubmit={submitSite}>
          {header('About your site', 'You can change all of this later, except your username.')}

          {status.databaseFromEnv && (
            <Notice tone="success" title="Database connected">
              Your server setup already provides the database, so there is nothing to configure.
            </Notice>
          )}

          <TextField
            label="Site title"
            value={site.title}
            onChange={(e) => setSite({ ...site, title: e.target.value })}
            error={errors.title}
            placeholder="e.g. The Morning Paper"
          />
          <TextField
            label="Username"
            value={site.username}
            onChange={(e) => setSite({ ...site, username: e.target.value })}
            error={errors.username}
            hint="You’ll log in with this. It can’t be changed later."
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
          />
          <PasswordField
            label="Password"
            isNew
            value={site.password}
            onChange={(password) => setSite({ ...site, password, allowWeak: false })}
            context={[site.username, site.email, site.title]}
            error={errors.password}
            hint="We’ve suggested a strong one. Save it in your password manager."
          />
          {site.password.length >= 8 &&
            passwordStrength(site.password, [site.username, site.email]) < 2 && (
              <Checkbox
                label="Use this weak password anyway"
                checked={site.allowWeak}
                onChange={(e) => setSite({ ...site, allowWeak: e.target.checked })}
                aria-invalid={Boolean(errors.allowWeak) || undefined}
                description={errors.allowWeak ?? 'Weak passwords are easy to guess.'}
              />
            )}
          <TextField
            label="Email"
            type="email"
            value={site.email}
            onChange={(e) => setSite({ ...site, email: e.target.value })}
            error={errors.email}
            hint="For password resets and important notices. Never shown publicly."
            autoComplete="email"
          />
          <Checkbox
            label="Ask search engines not to index this site"
            description="Handy while you’re still building. Search engines decide whether to honour it."
            checked={site.discourageSearchEngines}
            onChange={(e) => setSite({ ...site, discourageSearchEngines: e.target.checked })}
          />

          {problemNotice}

          <div className={styles.actions}>
            <Button
              variant="ghost"
              onClick={() => go(needsDatabase ? 'database' : 'welcome')}
              disabled={busy}
            >
              Back
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              {busy ? 'Installing…' : 'Install Pressbase'}
            </Button>
          </div>
        </form>
      )}

      {step === 'done' && (
        <div className={styles.done}>
          <div className={styles.doneIcon} aria-hidden="true">
            <PartyPopper size={28} />
          </div>
          {header(
            'Your site is ready',
            `Pressbase is installed and you’re signed in as ${site.username.trim()}.`,
          )}
          <dl className={styles.summary}>
            <div>
              <dt>Site title</dt>
              <dd>{site.title.trim()}</dd>
            </div>
            <div>
              <dt>Address</dt>
              <dd>{typeof window === 'undefined' ? '' : window.location.origin}</dd>
            </div>
            <div>
              <dt>Username</dt>
              <dd>{site.username.trim()}</dd>
            </div>
            {needsDatabase && (
              <div>
                <dt>Database</dt>
                <dd>{database.kind === 'embedded' ? 'Built-in' : 'PostgreSQL'}</dd>
              </div>
            )}
          </dl>
          {database.kind === 'embedded' && needsDatabase && (
            <Notice tone="warning" title="You’re using the built-in database">
              It’s great for trying things out. Switch to PostgreSQL before you go live.
            </Notice>
          )}
          <ButtonLink href="/admin" variant="primary" fullWidth>
            Go to your dashboard
          </ButtonLink>
        </div>
      )}
    </>
  );
}
