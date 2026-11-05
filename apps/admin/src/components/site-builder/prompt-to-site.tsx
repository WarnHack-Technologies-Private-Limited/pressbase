'use client';

import {
  ArrowLeft,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  ExternalLink,
  ImagePlus,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { formatNumber, msgid } from '@/lib/i18n/locale';
import { type RestMedia, uploadMedia } from '@/lib/media';
import {
  type Answer,
  addUsage,
  answersPayload,
  applyEvent,
  type Brief,
  cleanBrief,
  DENSITY_LABELS,
  DESIGN_DENSITIES,
  DESIGN_FONT_PAIRS,
  DESIGN_MOODS,
  DESIGN_RADII,
  type DescribeForm,
  type DesignChoice,
  type DesignOption,
  EMPTY_FORM,
  formPayload,
  isFinished,
  MAX_DESCRIPTION,
  MOOD_LABELS,
  NO_USAGE,
  pagesDone,
  placeholderCount,
  previousStep,
  type Question,
  RADIUS_LABELS,
  type Run,
  roughWords,
  SAVED_KEY,
  type SectionKind,
  type Sitemap,
  STEPS,
  type StepId,
  sameChoice,
  sitemapPayload,
  stepIndex,
  studioLink,
  type Usage,
} from '@/lib/site-builder';
import { Button, ButtonLink, Spinner } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { SelectField, TextAreaField, TextField } from '../ui/field';
import { Badge, Logo, Notice } from '../ui/surface';
import type { SiteBuilderStatus } from './build-offer';
import { DesignPreview } from './design-preview';
import styles from './site-builder.module.css';
import { SitemapEditor } from './sitemap-editor';

/**
 * Prompt to site (#60): the guided flow from a description to a draft site,
 * in seven steps: Describe, Questions (at most three, skippable), Details
 * (the brief, editable), Look (three live previews, more on request, then
 * adjust), Pages (arrange up to eight), Build (pages arrive as they're
 * written) and Review (open the draft in Studio). Back always works.
 *
 * Every step is a REST call (/pressbase/v1/site-builder); the build is a
 * run in core, so closing the tab loses nothing: the flow finds the run
 * again (`?run=`, or the status's `active_run`) and follows its events.
 * What the person typed is kept in this browser until the build starts.
 * See docs/architecture/site-builder.md#the-guided-flow.
 */

export interface PromptToSiteProps {
  status: SiteBuilderStatus;
  siteName: string;
  /** A run to show (`?run=`), else the one in progress. */
  requestedRun?: number;
  canUpload: boolean;
  /** Whether the logo can go in the draft as the site logo (`manage_options`). */
  canSetLogo: boolean;
}

interface Saved {
  step: StepId;
  form: DescribeForm;
  logo: Upload | null;
  photos: Upload[];
  questions: Question[] | null;
  answers: string[];
  asked: string;
  brief: Brief | null;
  briefFor: string;
  designs: DesignOption[];
  designsFor: string;
  chosen: number | null;
  choice: DesignChoice | null;
  sitemap: Sitemap | null;
  sections: SectionKind[];
  sitemapFor: string;
  usage: Usage;
  runId: number | null;
}

interface Upload {
  id: number;
  name: string;
  url?: string;
}

const INITIAL: Saved = {
  step: 'describe',
  form: EMPTY_FORM,
  logo: null,
  photos: [],
  questions: null,
  answers: [],
  asked: '',
  brief: null,
  briefFor: '',
  designs: [],
  designsFor: '',
  chosen: null,
  choice: null,
  sitemap: null,
  sections: [],
  sitemapFor: '',
  usage: NO_USAGE,
  runId: null,
};

const key = (value: unknown) => JSON.stringify(value);
const BASE = '/pressbase/v1/site-builder';

function loadSaved(): Saved | null {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    return raw ? { ...INITIAL, ...(JSON.parse(raw) as Partial<Saved>) } : null;
  } catch {
    return null;
  }
}

function save(state: Saved | null) {
  try {
    if (state) window.localStorage.setItem(SAVED_KEY, JSON.stringify(state));
    else window.localStorage.removeItem(SAVED_KEY);
  } catch {
    // Private windows and blocked storage: the flow works without it.
  }
}

export function PromptToSite(props: PromptToSiteProps) {
  const { __, _n, sprintf, lang } = useI18n();
  const [state, setState] = useState<Saved>(INITIAL);
  const [restored, setRestored] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ title: string; code?: string } | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | undefined>();
  const [uploading, setUploading] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<'stop' | 'back' | null>(null);
  const [fontPairs, setFontPairs] = useState(DESIGN_FONT_PAIRS);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Set when the person (not the restore on opening) changes the step. */
  const moved = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const update = useCallback((change: Partial<Saved>) => {
    if (change.step && change.step !== stateRef.current.step) moved.current = true;
    setState((s) => ({ ...s, ...change }));
  }, []);

  /* ------------------------------------------------- opening and resuming */

  useEffect(() => {
    const runId = props.requestedRun ?? props.status.active_run ?? null;
    const saved = loadSaved();
    if (runId) {
      setState({ ...(saved ?? INITIAL), runId, step: 'generate' });
    } else if (saved) {
      // A finished build isn't reopened from here (that's what ?run= is for): back to Pages.
      const building = saved.runId || saved.step === 'generate' || saved.step === 'review';
      setState(
        building ? { ...saved, runId: null, step: saved.sitemap ? 'sitemap' : 'describe' } : saved,
      );
    }
    setRestored(true);
  }, [props.requestedRun, props.status.active_run]);

  useEffect(() => {
    if (restored) save(state);
  }, [state, restored]);

  // Each step the person moves to puts focus on its heading, so a screen reader
  // announces it. Opening the flow where it was left doesn't.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    headingRef.current?.focus();
    setProblem(null);
  }, [state.step]);

  // The font pairs this site's theme can show.
  useEffect(() => {
    api<{ design_options: { font_pairs: { id: string; label: string }[] } }>(
      '/wp-abilities/v1/abilities/core/get-design-system/run',
    )
      .then((system) => {
        const pairs = system.design_options.font_pairs;
        if (pairs.length) setFontPairs(pairs.map(({ id, label }) => ({ id, label })));
      })
      .catch(() => undefined);
  }, []);

  /* ----------------------------------------------------------- following */

  // The run: its events as they happen (replayed after a reconnect), and a
  // slower poll in case the stream can't get through.
  useEffect(() => {
    const id = state.runId;
    if (!id) return;
    let live = true;
    let source: EventSource | null = null;
    let finished = false;
    const finish = () => {
      finished = true;
      source?.close();
    };
    const load = () =>
      api<Run>(`${BASE}/runs/${id}`)
        .then((next) => {
          if (!live) return;
          setRun((current) =>
            current && (current.last_event_id ?? 0) > (next.last_event_id ?? 0) ? current : next,
          );
          if (isFinished(next)) finish();
        })
        .catch((error) => {
          if (live && error instanceof ApiError && error.status === 404) {
            finish();
            setProblem({ title: __('That build can’t be found any more.', 'pressbase-admin') });
            update({ runId: null, step: stateRef.current.sitemap ? 'sitemap' : 'describe' });
          }
        });
    load();
    if (typeof EventSource !== 'undefined') {
      source = new EventSource(`/wp-json${BASE}/runs/${id}`);
      const on = (type: string) =>
        source?.addEventListener(type, (event) => {
          if (!live) return;
          const data = JSON.parse((event as MessageEvent).data) as Record<string, unknown>;
          setRun((current) => {
            if (type === 'snapshot') return data as unknown as Run;
            if (!current) return current;
            const next = applyEvent(current, type, data);
            const eventId = Number((event as MessageEvent).lastEventId) || 0;
            return { ...next, last_event_id: Math.max(next.last_event_id ?? 0, eventId) };
          });
          if (type === 'done') finish();
        });
      for (const type of [
        'snapshot',
        'run',
        'stage',
        'sitemap',
        'page',
        'checks',
        'warning',
        'done',
      ]) {
        on(type);
      }
    }
    const poll = window.setInterval(() => {
      if (!finished) load();
    }, 5000);
    return () => {
      live = false;
      source?.close();
      window.clearInterval(poll);
    };
  }, [state.runId, update, __]);

  // A finished build goes on to Review by itself.
  useEffect(() => {
    if (run && isFinished(run) && state.step === 'generate' && run.id === state.runId) {
      update({ step: 'review' });
    }
  }, [run, state.step, state.runId, update]);

  /* --------------------------------------------------------------- calls */

  const fail = (error: unknown) => {
    if (error instanceof ApiError) setProblem({ title: error.message, code: error.code });
    else setProblem({ title: __('Something went wrong. Please try again.', 'pressbase-admin') });
  };

  const call = async <T,>(label: string, path: string, body: unknown): Promise<T | null> => {
    setBusy(label);
    setProblem(null);
    try {
      return await api<T>(`${BASE}/${path}`, { method: 'POST', body });
    } catch (error) {
      fail(error);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const fetchBrief = async (answers: Answer[]) => {
    const s = stateRef.current;
    const forKey = key([formPayload(s.form), answers]);
    if (s.brief && s.briefFor === forKey) return update({ step: 'brief' });
    const result = await call<{ brief: Brief; usage: Usage }>(
      __('Writing a short description of your site…', 'pressbase-admin'),
      'brief',
      { ...formPayload(s.form), answers },
    );
    if (!result) return;
    update({
      brief: result.brief,
      briefFor: forKey,
      usage: addUsage(stateRef.current.usage, result.usage),
      step: 'brief',
    });
  };

  const onDescribe = async (event: FormEvent) => {
    event.preventDefault();
    const s = stateRef.current;
    if (!s.form.description.trim()) {
      setDescriptionError(
        __(
          'Tell us a little about the site first: a sentence or two is enough.',
          'pressbase-admin',
        ),
      );
      document.getElementById('site-description')?.focus();
      return;
    }
    setDescriptionError(undefined);
    const askedFor = key(formPayload(s.form));
    if (s.questions && s.asked === askedFor) {
      return update({ step: s.questions.length ? 'clarify' : 'brief' });
    }
    const result = await call<{ questions: Question[]; usage: Usage }>(
      __('Reading your description…', 'pressbase-admin'),
      'clarify',
      formPayload(s.form),
    );
    if (!result) return;
    update({
      questions: result.questions,
      answers: result.questions.map(() => ''),
      asked: askedFor,
      usage: addUsage(stateRef.current.usage, result.usage),
    });
    if (result.questions.length) update({ step: 'clarify' });
    else await fetchBrief([]);
  };

  const onClarify = async (skip: boolean) => {
    const s = stateRef.current;
    await fetchBrief(skip ? [] : answersPayload(s.questions ?? [], s.answers));
  };

  const fetchDesigns = async (more: boolean) => {
    const s = stateRef.current;
    const brief = cleanBrief(s.brief as Brief);
    const forKey = key(brief);
    if (!more && s.designs.length && s.designsFor === forKey)
      return update({ brief, step: 'design' });
    const shown = more ? s.designs.map((d) => d.choice) : [];
    const result = await call<{ designs: DesignOption[]; usage: Usage }>(
      more
        ? __('Finding three more looks…', 'pressbase-admin')
        : __('Choosing looks that suit your site…', 'pressbase-admin'),
      'designs',
      { brief, shown },
    );
    if (!result) return;
    const designs = more ? [...s.designs, ...result.designs] : result.designs;
    update({
      brief,
      designs,
      designsFor: forKey,
      chosen: more ? s.chosen : null,
      choice: more ? s.choice : null,
      usage: addUsage(stateRef.current.usage, result.usage),
      step: 'design',
    });
    if (more) {
      // Focus the first new look, so keyboard users land on what arrived.
      requestAnimationFrame(() =>
        document
          .querySelectorAll<HTMLInputElement>('input[name="design"]')
          [s.designs.length]?.focus(),
      );
    }
  };

  const fetchSitemap = async () => {
    const s = stateRef.current;
    const brief = cleanBrief(s.brief as Brief);
    const forKey = key(brief);
    if (s.sitemap && s.sitemapFor === forKey) return update({ step: 'sitemap' });
    const result = await call<{ sitemap: Sitemap; sections: SectionKind[]; usage: Usage }>(
      __('Planning your pages…', 'pressbase-admin'),
      'sitemap',
      { brief },
    );
    if (!result) return;
    update({
      sitemap: result.sitemap,
      sections: result.sections,
      sitemapFor: forKey,
      usage: addUsage(stateRef.current.usage, result.usage),
      step: 'sitemap',
    });
  };

  const startBuild = async () => {
    const s = stateRef.current;
    if (!s.brief || !s.choice || !s.sitemap) return;
    setBusy(__('Starting the build…', 'pressbase-admin'));
    setProblem(null);
    try {
      let changeset_uuid: string | undefined;
      if (s.logo && props.canSetLogo) {
        // The logo goes in the same draft as the site, as the site logo.
        const draft = await api<{ uuid: string }>('/pressbase/v1/changesets', {
          method: 'POST',
          body: { entries: { 'option:site_logo': s.logo.id } },
        }).catch(() => null);
        changeset_uuid = draft?.uuid;
      }
      const started = await api<Run>(`${BASE}/runs`, {
        method: 'POST',
        body: {
          ...formPayload(s.form),
          brief: cleanBrief(s.brief),
          design: s.choice,
          sitemap: sitemapPayload(s.sitemap),
          ...(changeset_uuid ? { changeset_uuid } : {}),
        },
      });
      setRun(started);
      update({ runId: started.id, step: 'generate' });
      window.history.replaceState(window.history.state, '', `?run=${started.id}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'site_builder_run_active') {
        const id = Number((error.data as { run?: number }).run);
        if (id) {
          update({ runId: id, step: 'generate' });
          return;
        }
      }
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const stopBuild = async (thenBack: boolean) => {
    const id = stateRef.current.runId;
    setConfirmStop(null);
    if (!id) return;
    try {
      await api(`${BASE}/runs/${id}`, { method: 'DELETE' });
    } catch (error) {
      fail(error);
      return;
    }
    if (thenBack) {
      setRun(null);
      update({ runId: null, step: stateRef.current.sitemap ? 'sitemap' : 'describe' });
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  };

  const startOver = () => {
    save(null);
    setRun(null);
    moved.current = stateRef.current.step !== INITIAL.step;
    setState(INITIAL);
    setProblem(null);
    window.history.replaceState(window.history.state, '', window.location.pathname);
  };

  const onUpload = async (files: FileList | null, kind: 'logo' | 'photos') => {
    if (!files?.length) return;
    setUploading(
      kind === 'logo'
        ? __('Uploading your logo…', 'pressbase-admin')
        : __('Uploading your photos…', 'pressbase-admin'),
    );
    try {
      const done: Upload[] = [];
      for (const file of Array.from(files).slice(0, kind === 'logo' ? 1 : 10)) {
        const media: RestMedia = await uploadMedia(file);
        done.push({ id: media.id, name: file.name, url: media.source_url });
      }
      if (kind === 'logo') update({ logo: done[0] ?? null });
      else update({ photos: [...stateRef.current.photos, ...done].slice(0, 10) });
    } catch (error) {
      setProblem({
        title:
          error instanceof Error
            ? error.message
            : __('The file couldn’t be uploaded.', 'pressbase-admin'),
      });
    } finally {
      setUploading(null);
    }
  };

  /* ---------------------------------------------------------------- view */

  const { step } = state;
  const finished = isFinished(run);
  const back = () => {
    const previous = previousStep(step, finished);
    if (step === 'generate' && !finished && run) return setConfirmStop('back');
    if (step === 'review' || (step === 'generate' && finished)) {
      // Building again starts a new build, into the same draft. (A build opened from
      // its link in another browser has no pages here to go back to: start from the top.)
      setRun(null);
      update({ runId: null, step: stateRef.current.sitemap ? 'sitemap' : 'describe' });
      window.history.replaceState(window.history.state, '', window.location.pathname);
      return;
    }
    if (previous) update({ step: previous });
  };
  const setForm = (change: Partial<DescribeForm>) =>
    update({ form: { ...stateRef.current.form, ...change } });
  const setBrief = (change: Partial<Brief>) =>
    update({ brief: { ...(stateRef.current.brief as Brief), ...change } });

  const index = stepIndex(step);
  const heading = (title: string, lead?: ReactNode) => (
    <header className={styles.stepHeader}>
      <p className={styles.stepCount}>
        {sprintf(__('Step %1$d of %2$d', 'pressbase-admin'), index + 1, STEPS.length)}
      </p>
      <h1 ref={headingRef} tabIndex={-1} className={styles.stepTitle}>
        {title}
      </h1>
      {lead && <p className={styles.stepLead}>{lead}</p>}
    </header>
  );

  const backButton = (
    <Button
      variant="ghost"
      icon={<ArrowLeft size={16} aria-hidden="true" />}
      onClick={back}
      disabled={busy !== null}
    >
      {__('Back', 'pressbase-admin')}
    </Button>
  );

  const problemNotice = problem && (
    <Notice tone="danger" title={problem.title}>
      {problem.code === 'prompt_prevented' && props.status.can_manage_ai ? (
        <Link href="/admin/settings/ai">{__('Open Settings → AI', 'pressbase-admin')}</Link>
      ) : problem.code === 'ai_daily_limit_reached' ? (
        __('Your answers so far are kept. Come back tomorrow to carry on.', 'pressbase-admin')
      ) : (
        __('Your answers so far are kept. Try again in a moment.', 'pressbase-admin')
      )}
    </Notice>
  );

  const busyNotice = busy && (
    <p className={styles.busy} role="status">
      <Spinner />
      {busy}
    </p>
  );

  const usageWords = (usage: Usage) =>
    sprintf(
      _n(
        '%1$s AI request, about %2$s tokens (roughly %3$s words read and written)',
        '%1$s AI requests, about %2$s tokens (roughly %3$s words read and written)',
        usage.requests,
        'pressbase-admin',
      ),
      formatNumber(usage.requests, lang),
      formatNumber(usage.tokens.total, lang),
      formatNumber(roughWords(usage.tokens.total), lang),
    );

  const brief = state.brief;

  return (
    <div className={styles.screen}>
      <header className={styles.topBar}>
        <Link href="/admin" className={styles.topBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          <span>{__('Dashboard', 'pressbase-admin')}</span>
        </Link>
        <span className={styles.topTitle}>
          <Logo name={props.siteName || 'Pressbase'} />
        </span>
        {(step !== 'describe' || state.form.description) && !state.runId ? (
          <Button size="sm" variant="ghost" onClick={startOver} disabled={busy !== null}>
            {__('Start over', 'pressbase-admin')}
          </Button>
        ) : (
          <span />
        )}
      </header>

      <nav className={styles.progress} aria-label={__('Steps', 'pressbase-admin')}>
        <ol>
          {STEPS.map((s, i) => (
            <li
              key={s.id}
              data-state={i < index ? 'done' : i === index ? 'current' : 'upcoming'}
              aria-current={i === index ? 'step' : undefined}
            >
              <span className={styles.progressDot} aria-hidden="true">
                {i < index ? <Check size={12} /> : i + 1}
              </span>
              <span className={styles.progressLabel}>
                <span className={styles.srOnly}>
                  {i < index
                    ? __('Done:', 'pressbase-admin')
                    : i === index
                      ? __('Current:', 'pressbase-admin')
                      : ''}{' '}
                </span>
                {__(s.label, 'pressbase-admin')}
              </span>
            </li>
          ))}
        </ol>
      </nav>

      <main className={styles.main} data-step={step} aria-busy={busy !== null || undefined}>
        {!restored ? null : step === 'describe' ? (
          <form className={styles.step} onSubmit={onDescribe} noValidate>
            {heading(
              __('What’s your site for?', 'pressbase-admin'),
              __(
                'Describe it in your own words. Pressbase plans the pages, suggests a look and writes a first draft for you to check. Nothing goes live until you publish it.',
                'pressbase-admin',
              ),
            )}
            {problemNotice}
            <div className={styles.describe}>
              <label htmlFor="site-description" className={styles.bigLabel}>
                {__('Describe your site', 'pressbase-admin')}
              </label>
              <textarea
                id="site-description"
                className={styles.bigText}
                rows={5}
                maxLength={MAX_DESCRIPTION}
                value={state.form.description}
                aria-invalid={Boolean(descriptionError) || undefined}
                aria-describedby="site-description-hint site-description-error"
                placeholder={__(
                  'For example: A small bakery in Leeds selling sourdough, pastries and coffee. We want people to find us, see what we bake and visit.',
                  'pressbase-admin',
                )}
                onChange={(event) => setForm({ description: event.target.value })}
              />
              <p id="site-description-hint" className={styles.hint}>
                {__(
                  'What you do, who it’s for, and what visitors should be able to do. Pressbase only states facts you give it; anything else becomes a gap for you to fill.',
                  'pressbase-admin',
                )}
              </p>
              {descriptionError && (
                <p id="site-description-error" className={styles.error}>
                  <CircleAlert size={14} aria-hidden="true" />
                  {descriptionError}
                </p>
              )}
            </div>

            <details className={styles.more} open={Boolean(state.form.name || state.form.phone)}>
              <summary>{__('Add your details (optional)', 'pressbase-admin')}</summary>
              <p className={styles.hint}>
                {__(
                  'These go on the site exactly as you write them. Leave out anything you’re not sure about.',
                  'pressbase-admin',
                )}
              </p>
              <div className={styles.fieldGrid}>
                <TextField
                  label={__('Business or site name', 'pressbase-admin')}
                  optional
                  maxLength={200}
                  value={state.form.name}
                  onChange={(event) => setForm({ name: event.target.value })}
                />
                <TextField
                  label={__('Town or area', 'pressbase-admin')}
                  optional
                  maxLength={200}
                  value={state.form.location}
                  onChange={(event) => setForm({ location: event.target.value })}
                />
                <TextField
                  label={__('Phone', 'pressbase-admin')}
                  optional
                  type="tel"
                  maxLength={50}
                  value={state.form.phone}
                  onChange={(event) => setForm({ phone: event.target.value })}
                />
                <TextField
                  label={__('Email', 'pressbase-admin')}
                  optional
                  type="email"
                  maxLength={200}
                  value={state.form.email}
                  onChange={(event) => setForm({ email: event.target.value })}
                />
              </div>
              <TextField
                label={__('Address', 'pressbase-admin')}
                optional
                maxLength={400}
                value={state.form.address}
                onChange={(event) => setForm({ address: event.target.value })}
              />
              <TextAreaField
                label={__('Other facts to include', 'pressbase-admin')}
                hint={__(
                  'One per line: opening hours, prices, a customer’s words (with their permission).',
                  'pressbase-admin',
                )}
                optional
                rows={3}
                value={state.form.facts}
                onChange={(event) => setForm({ facts: event.target.value })}
              />
              {props.canUpload && (
                <div className={styles.uploads}>
                  <UploadField
                    label={__('Logo', 'pressbase-admin')}
                    hint={
                      props.canSetLogo
                        ? __('Shown in your site’s header.', 'pressbase-admin')
                        : __('Saved to your media library.', 'pressbase-admin')
                    }
                    files={state.logo ? [state.logo] : []}
                    disabled={uploading !== null}
                    onPick={(files) => onUpload(files, 'logo')}
                    onRemove={() => update({ logo: null })}
                  />
                  <UploadField
                    label={__('Photos', 'pressbase-admin')}
                    hint={__(
                      'Saved to your media library, ready to put on your pages in Studio.',
                      'pressbase-admin',
                    )}
                    multiple
                    files={state.photos}
                    disabled={uploading !== null}
                    onPick={(files) => onUpload(files, 'photos')}
                    onRemove={(id) =>
                      update({ photos: stateRef.current.photos.filter((p) => p.id !== id) })
                    }
                  />
                  {uploading && (
                    <p className={styles.busy} role="status">
                      <Spinner />
                      {uploading}
                    </p>
                  )}
                </div>
              )}
            </details>

            {busyNotice}
            <div className={styles.actions}>
              <ButtonLink
                href="/admin"
                variant="ghost"
                icon={<ArrowLeft size={16} aria-hidden="true" />}
              >
                {__('Back', 'pressbase-admin')}
              </ButtonLink>
              <Button type="submit" variant="primary" loading={busy !== null}>
                {__('Continue', 'pressbase-admin')}
              </Button>
            </div>
          </form>
        ) : step === 'clarify' ? (
          <form
            className={styles.step}
            onSubmit={(event) => {
              event.preventDefault();
              onClarify(false);
            }}
          >
            {heading(
              __('A few quick questions', 'pressbase-admin'),
              __(
                'Answer any you like, or skip them. Your answers help Pressbase write about what you really do.',
                'pressbase-admin',
              ),
            )}
            {problemNotice}
            <div className={styles.questions}>
              {(state.questions ?? []).map((q, i) => (
                <TextAreaField
                  key={q.question}
                  label={q.question}
                  optional
                  rows={2}
                  maxLength={1000}
                  value={state.answers[i] ?? ''}
                  onChange={(event) => {
                    const answers = [...stateRef.current.answers];
                    answers[i] = event.target.value;
                    update({ answers });
                  }}
                />
              ))}
            </div>
            {busyNotice}
            <div className={styles.actions}>
              {backButton}
              <span className={styles.actionsEnd}>
                <Button
                  variant="secondary"
                  onClick={() => onClarify(true)}
                  disabled={busy !== null}
                >
                  {__('Skip questions', 'pressbase-admin')}
                </Button>
                <Button type="submit" variant="primary" loading={busy !== null}>
                  {__('Continue', 'pressbase-admin')}
                </Button>
              </span>
            </div>
          </form>
        ) : step === 'brief' && brief ? (
          <form
            className={styles.step}
            onSubmit={(event) => {
              event.preventDefault();
              fetchDesigns(false);
            }}
          >
            {heading(
              __('Is this right?', 'pressbase-admin'),
              __(
                'This is what Pressbase will build from. Change anything that’s off.',
                'pressbase-admin',
              ),
            )}
            {problemNotice}
            <div className={styles.briefCard}>
              <div className={styles.fieldGrid}>
                <TextField
                  label={__('Name', 'pressbase-admin')}
                  maxLength={200}
                  optional
                  value={brief.name}
                  onChange={(event) => setBrief({ name: event.target.value })}
                />
                <TextField
                  label={__('What kind of site', 'pressbase-admin')}
                  maxLength={200}
                  optional
                  value={brief.kind}
                  onChange={(event) => setBrief({ kind: event.target.value })}
                />
              </div>
              <TextField
                label={__('Who it’s for', 'pressbase-admin')}
                maxLength={500}
                optional
                value={brief.audience}
                onChange={(event) => setBrief({ audience: event.target.value })}
              />
              <TextField
                label={__('How it should sound', 'pressbase-admin')}
                maxLength={200}
                optional
                value={brief.tone}
                onChange={(event) => setBrief({ tone: event.target.value })}
              />
              <TextAreaField
                label={__('Facts the site can state', 'pressbase-admin')}
                hint={__(
                  'One per line. Only these appear as facts; anything else (prices, reviews, opening hours) is left as a gap for you to fill.',
                  'pressbase-admin',
                )}
                optional
                rows={Math.min(8, Math.max(3, brief.facts.length + 1))}
                value={brief.facts.join('\n')}
                onChange={(event) => setBrief({ facts: event.target.value.split('\n') })}
              />
            </div>
            {busyNotice}
            <div className={styles.actions}>
              {backButton}
              <Button type="submit" variant="primary" loading={busy !== null}>
                {__('Continue', 'pressbase-admin')}
              </Button>
            </div>
          </form>
        ) : step === 'design' && brief ? (
          <form
            className={styles.step}
            data-wide
            onSubmit={(event) => {
              event.preventDefault();
              if (state.choice) fetchSitemap();
              else
                setProblem({
                  title: __('Choose a look first. You can change it later.', 'pressbase-admin'),
                });
            }}
          >
            {heading(
              __('Choose a look', 'pressbase-admin'),
              __(
                'Pick the one that feels most like you, then adjust the colour and fonts if you like. You can change all of it later.',
                'pressbase-admin',
              ),
            )}
            {problemNotice}
            <fieldset className={styles.designs}>
              <legend className={styles.srOnly}>{__('Looks', 'pressbase-admin')}</legend>
              {state.designs.map((option, i) => {
                const selected = state.chosen === i;
                const choice = selected && state.choice ? state.choice : option.choice;
                return (
                  <label
                    key={i}
                    className={styles.designCard}
                    data-selected={selected || undefined}
                  >
                    <input
                      type="radio"
                      name="design"
                      className={styles.srOnly}
                      checked={selected}
                      onChange={() => update({ chosen: i, choice: option.choice })}
                    />
                    <DesignPreview
                      choice={choice}
                      name={brief.name || props.siteName}
                      kind={brief.kind}
                      pages={brief.pages}
                    />
                    <span className={styles.designLabel}>
                      {selected && <CircleCheck size={16} aria-hidden="true" />}
                      {option.label}
                      {selected && state.choice && !sameChoice(state.choice, option.choice) && (
                        <Badge>{__('Adjusted', 'pressbase-admin')}</Badge>
                      )}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <div className={styles.moreDesigns}>
              <Button
                icon={<RefreshCw size={16} aria-hidden="true" />}
                onClick={() => fetchDesigns(true)}
                disabled={busy !== null || state.designs.length >= 12}
              >
                {__('Show three more', 'pressbase-admin')}
              </Button>
            </div>
            {state.choice && (
              <fieldset className={styles.adjust}>
                <legend>{__('Adjust the look you picked', 'pressbase-admin')}</legend>
                <div className={styles.hueField}>
                  <label htmlFor="design-hue">{__('Main colour', 'pressbase-admin')}</label>
                  <input
                    id="design-hue"
                    type="range"
                    min={0}
                    max={359}
                    value={state.choice.hue}
                    aria-valuetext={sprintf(__('Hue %d°', 'pressbase-admin'), state.choice.hue)}
                    style={{ ['--hue' as string]: String(state.choice.hue) }}
                    onChange={(event) =>
                      update({
                        choice: {
                          ...(state.choice as DesignChoice),
                          hue: Number(event.target.value),
                        },
                      })
                    }
                  />
                </div>
                <SelectField
                  label={__('Colour feel', 'pressbase-admin')}
                  value={state.choice.mood}
                  onChange={(event) =>
                    update({
                      choice: {
                        ...(state.choice as DesignChoice),
                        mood: event.target.value as DesignChoice['mood'],
                      },
                    })
                  }
                >
                  {DESIGN_MOODS.map((m) => (
                    <option key={m} value={m}>
                      {__(MOOD_LABELS[m] ?? m, 'pressbase-admin')}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label={__('Fonts', 'pressbase-admin')}
                  value={state.choice.fontPair}
                  onChange={(event) =>
                    update({
                      choice: {
                        ...(state.choice as DesignChoice),
                        fontPair: event.target.value as DesignChoice['fontPair'],
                      },
                    })
                  }
                >
                  {fontPairs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label={__('Corners', 'pressbase-admin')}
                  value={state.choice.radius}
                  onChange={(event) =>
                    update({
                      choice: {
                        ...(state.choice as DesignChoice),
                        radius: event.target.value as DesignChoice['radius'],
                      },
                    })
                  }
                >
                  {DESIGN_RADII.map((r) => (
                    <option key={r} value={r}>
                      {__(RADIUS_LABELS[r] ?? r, 'pressbase-admin')}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label={__('Spacing', 'pressbase-admin')}
                  value={state.choice.density}
                  onChange={(event) =>
                    update({
                      choice: {
                        ...(state.choice as DesignChoice),
                        density: event.target.value as DesignChoice['density'],
                      },
                    })
                  }
                >
                  {DESIGN_DENSITIES.map((d) => (
                    <option key={d} value={d}>
                      {__(DENSITY_LABELS[d] ?? d, 'pressbase-admin')}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label={__('Pages', 'pressbase-admin')}
                  value={state.choice.scheme}
                  onChange={(event) =>
                    update({
                      choice: {
                        ...(state.choice as DesignChoice),
                        scheme: event.target.value as DesignChoice['scheme'],
                      },
                    })
                  }
                >
                  <option value="light">{__('Light', 'pressbase-admin')}</option>
                  <option value="dark">{__('Dark', 'pressbase-admin')}</option>
                </SelectField>
              </fieldset>
            )}
            {busyNotice}
            <div className={styles.actions}>
              {backButton}
              <Button type="submit" variant="primary" loading={busy !== null}>
                {__('Continue', 'pressbase-admin')}
              </Button>
            </div>
          </form>
        ) : step === 'sitemap' && state.sitemap ? (
          <form
            className={styles.step}
            onSubmit={(event) => {
              event.preventDefault();
              startBuild();
            }}
          >
            {heading(
              __('Choose your pages', 'pressbase-admin'),
              __(
                'Drag pages into the order of your menu; the first is your home page. Add or remove pages and the sections on each.',
                'pressbase-admin',
              ),
            )}
            {problemNotice}
            <SitemapEditor
              sitemap={state.sitemap}
              sections={state.sections}
              onChange={(sitemap) => update({ sitemap })}
            />
            {busyNotice}
            <div className={styles.actions}>
              {backButton}
              <Button
                type="submit"
                variant="primary"
                loading={busy !== null}
                icon={<Sparkles size={16} aria-hidden="true" />}
                disabled={!sitemapPayload(state.sitemap).pages.length}
              >
                {__('Build my site', 'pressbase-admin')}
              </Button>
            </div>
          </form>
        ) : step === 'generate' ? (
          <section className={styles.step} data-wide aria-labelledby="build-heading">
            <header className={styles.stepHeader}>
              <p className={styles.stepCount}>
                {sprintf(__('Step %1$d of %2$d', 'pressbase-admin'), index + 1, STEPS.length)}
              </p>
              <h1 id="build-heading" ref={headingRef} tabIndex={-1} className={styles.stepTitle}>
                {__('Building your site', 'pressbase-admin')}
              </h1>
              <p className={styles.stepLead}>
                {__(
                  'Pages appear here as they’re written. You can close this tab: the build carries on, and you’ll find it here again.',
                  'pressbase-admin',
                )}
              </p>
            </header>
            {problemNotice}
            <BuildProgress run={run} />
            <div className={styles.actions}>
              {backButton}
              <Button
                variant="secondary"
                icon={<X size={16} aria-hidden="true" />}
                onClick={() => setConfirmStop('stop')}
                disabled={!run || finished}
              >
                {__('Stop building', 'pressbase-admin')}
              </Button>
            </div>
          </section>
        ) : step === 'review' && run ? (
          <section className={styles.step} data-wide aria-labelledby="review-heading">
            <header className={styles.stepHeader}>
              <p className={styles.stepCount}>
                {sprintf(__('Step %1$d of %2$d', 'pressbase-admin'), index + 1, STEPS.length)}
              </p>
              <h1 id="review-heading" ref={headingRef} tabIndex={-1} className={styles.stepTitle}>
                {run.status === 'completed'
                  ? __('Your site is ready to review', 'pressbase-admin')
                  : run.status === 'stopped'
                    ? __('Your site is partly built', 'pressbase-admin')
                    : run.status === 'cancelled'
                      ? __('You stopped the build', 'pressbase-admin')
                      : __('The build didn’t finish', 'pressbase-admin')}
              </h1>
              <p className={styles.stepLead}>
                {__(
                  'It’s a draft: nobody sees it until you publish. Open it in Studio to check each page, fill in the gaps and publish when you’re happy.',
                  'pressbase-admin',
                )}
              </p>
            </header>
            {run.error && run.status !== 'cancelled' && (
              <Notice
                tone={run.status === 'stopped' ? 'warning' : 'danger'}
                title={run.error.message}
              >
                {run.status === 'stopped'
                  ? __(
                      'The pages already written are in your draft. Build the rest tomorrow, or add them in Studio.',
                      'pressbase-admin',
                    )
                  : __(
                      'Whatever was built is in your draft. Go back to try again.',
                      'pressbase-admin',
                    )}
              </Notice>
            )}
            <ReviewSummary run={run} usage={addUsage(state.usage, run)} usageWords={usageWords} />
            <BuildProgress run={run} />
            <div className={styles.actions}>
              {backButton}
              <span className={styles.actionsEnd}>
                {run.preview_link && pagesDone(run) > 0 && (
                  <ButtonLink
                    href={run.preview_link}
                    target="_blank"
                    rel="noopener"
                    icon={<ExternalLink size={16} aria-hidden="true" />}
                  >
                    {__('Preview', 'pressbase-admin')}
                  </ButtonLink>
                )}
                {pagesDone(run) > 0 && (
                  <ButtonLink
                    href={studioLink(run, { checklist: placeholderCount(run) > 0 })}
                    variant="primary"
                    onClick={() => save(null)}
                  >
                    {__('Review in Studio', 'pressbase-admin')}
                  </ButtonLink>
                )}
              </span>
            </div>
          </section>
        ) : (
          <div className={styles.step}>
            <p className={styles.busy} role="status">
              <Spinner />
              {__('Opening…', 'pressbase-admin')}
            </p>
          </div>
        )}
      </main>

      <ConfirmDialog
        open={confirmStop !== null}
        title={
          confirmStop === 'back'
            ? __('Stop building and go back?', 'pressbase-admin')
            : __('Stop building?', 'pressbase-admin')
        }
        confirmLabel={__('Stop building', 'pressbase-admin')}
        onConfirm={() => stopBuild(confirmStop === 'back')}
        onCancel={() => setConfirmStop(null)}
      >
        <p>
          {__(
            'Pages already written stay in your draft. The rest aren’t built.',
            'pressbase-admin',
          )}
        </p>
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ parts */

function UploadField({
  label,
  hint,
  files,
  multiple,
  disabled,
  onPick,
  onRemove,
}: {
  label: string;
  hint: string;
  files: Upload[];
  multiple?: boolean;
  disabled?: boolean;
  onPick: (files: FileList | null) => void;
  onRemove: (id: number) => void;
}) {
  const { __, sprintf } = useI18n();
  const id = `upload-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div className={styles.upload}>
      <span className={styles.uploadLabel}>{label}</span>
      <p className={styles.hint} id={`${id}-hint`}>
        {hint}
      </p>
      {files.length > 0 && (
        <ul className={styles.uploadList}>
          {files.map((file) => (
            <li key={file.id}>
              {file.url && <img src={file.url} alt="" width={32} height={32} />}
              <span>{file.name}</span>
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={sprintf(__('Remove %s', 'pressbase-admin'), file.name)}
                onClick={() => onRemove(file.id)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {(multiple || files.length === 0) && (
        <label className={styles.uploadButton} data-disabled={disabled || undefined}>
          <ImagePlus size={16} aria-hidden="true" />
          {multiple
            ? __('Choose photos', 'pressbase-admin')
            : __('Choose a logo', 'pressbase-admin')}
          <input
            id={id}
            type="file"
            accept="image/*"
            multiple={multiple}
            disabled={disabled}
            aria-describedby={`${id}-hint`}
            className={styles.srOnly}
            onChange={(event) => {
              onPick(event.target.files);
              event.target.value = '';
            }}
          />
        </label>
      )}
    </div>
  );
}

/** What the person sees of the run's stages: brief and design are quick when the flow passed them. */
const STAGE_LABELS: { stage: string; label: string; from: number; to: number }[] = [
  { stage: 'brief', label: msgid('Getting ready'), from: 0, to: 1 },
  { stage: 'sitemap', label: msgid('Header and footer'), from: 2, to: 2 },
  { stage: 'pages', label: msgid('Pages'), from: 3, to: 3 },
  { stage: 'assemble', label: msgid('Menu and home page'), from: 4, to: 4 },
  { stage: 'check', label: msgid('Checking the pages'), from: 5, to: 5 },
];
const STAGE_ORDER = ['brief', 'design', 'sitemap', 'pages', 'assemble', 'check'];

function BuildProgress({ run }: { run: Run | null }) {
  const { __, sprintf } = useI18n();
  if (!run) {
    return (
      <p className={styles.busy} role="status">
        <Spinner />
        {__('Finding your build…', 'pressbase-admin')}
      </p>
    );
  }
  const finished = isFinished(run);
  const position = finished ? STAGE_ORDER.length : run.stage ? STAGE_ORDER.indexOf(run.stage) : -1;
  const done = pagesDone(run);
  const writing = run.pages.find((p) => p.status === 'generating');
  const status = finished
    ? sprintf(__('Finished: %1$d of %2$d pages built.', 'pressbase-admin'), done, run.pages.length)
    : writing
      ? sprintf(__('Writing the %s page…', 'pressbase-admin'), writing.title)
      : run.status === 'queued'
        ? __('Waiting to start…', 'pressbase-admin')
        : __('Working…', 'pressbase-admin');
  return (
    <div className={styles.build}>
      <p className={styles.buildStatus} role="status" aria-live="polite">
        {!finished && <LoaderCircle size={16} className={styles.spin} aria-hidden="true" />}
        {status}
      </p>
      <ol className={styles.stages}>
        {STAGE_LABELS.map(({ stage, label, from, to }) => {
          const state = position > to ? 'done' : position >= from ? 'current' : 'upcoming';
          return (
            <li key={stage} data-state={state}>
              {state === 'done' ? (
                <CircleCheck size={16} aria-hidden="true" />
              ) : state === 'current' ? (
                <LoaderCircle size={16} className={styles.spin} aria-hidden="true" />
              ) : (
                <CircleDashed size={16} aria-hidden="true" />
              )}
              <span>
                {__(label, 'pressbase-admin')}
                {stage === 'pages' && run.pages.length > 0 && (
                  <> {sprintf(__('(%1$d of %2$d)', 'pressbase-admin'), done, run.pages.length)}</>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {run.pages.length > 0 && (
        <ul className={styles.pageCards}>
          {run.pages.map((page) => (
            <li key={page.title} className={styles.pageCard} data-status={page.status}>
              <div className={styles.thumb}>
                {page.status === 'done' && page.preview_link ? (
                  <iframe
                    src={page.preview_link}
                    title={sprintf(__('Preview of %s', 'pressbase-admin'), page.title)}
                    tabIndex={-1}
                    aria-hidden="true"
                    loading="lazy"
                  />
                ) : (
                  <span className={styles.thumbEmpty}>
                    {page.status === 'generating' ? (
                      <LoaderCircle size={20} className={styles.spin} aria-hidden="true" />
                    ) : null}
                  </span>
                )}
              </div>
              <div className={styles.pageCardText}>
                <span className={styles.pageCardTitle}>
                  {page.title}
                  {page.home && (
                    <span className={styles.pageCardHome}>{__('Home', 'pressbase-admin')}</span>
                  )}
                </span>
                <span className={styles.pageCardStatus}>
                  {page.status === 'done'
                    ? page.placeholders.length
                      ? sprintf(
                          __('Ready · %d to fill in', 'pressbase-admin'),
                          page.placeholders.length,
                        )
                      : __('Ready', 'pressbase-admin')
                    : page.status === 'generating'
                      ? __('Writing…', 'pressbase-admin')
                      : page.status === 'failed'
                        ? (page.error?.message ?? __('Couldn’t be built', 'pressbase-admin'))
                        : page.status === 'skipped'
                          ? __('Not built', 'pressbase-admin')
                          : __('Waiting', 'pressbase-admin')}
                </span>
              </div>
              {page.status === 'done' && page.preview_link && (
                <a
                  href={page.preview_link}
                  target="_blank"
                  rel="noopener"
                  className={styles.pageCardLink}
                >
                  {sprintf(__('Preview %s', 'pressbase-admin'), page.title)}
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReviewSummary({
  run,
  usage,
  usageWords,
}: {
  run: Run;
  usage: Usage;
  usageWords: (usage: Usage) => string;
}) {
  const { __, _n, sprintf, lang } = useI18n();
  const done = pagesDone(run);
  const gaps = placeholderCount(run);
  return (
    <ul className={styles.summary}>
      <li>
        <CircleCheck size={18} aria-hidden="true" className={styles.summaryOk} />
        <span>
          {sprintf(
            _n('%s page built', '%s pages built', done, 'pressbase-admin'),
            formatNumber(done, lang),
          )}
          {done < run.pages.length &&
            ` ${sprintf(__('(%d not built)', 'pressbase-admin'), run.pages.length - done)}`}
        </span>
      </li>
      <li>
        {gaps ? (
          <CircleAlert size={18} aria-hidden="true" className={styles.summaryTodo} />
        ) : (
          <CircleCheck size={18} aria-hidden="true" className={styles.summaryOk} />
        )}
        <span>
          {gaps ? (
            <>
              <strong>
                {sprintf(
                  _n(
                    '%s thing to fill in before you publish',
                    '%s things to fill in before you publish',
                    gaps,
                    'pressbase-admin',
                  ),
                  formatNumber(gaps, lang),
                )}
              </strong>
              {': '}
              {__(
                'where Pressbase didn’t know a fact (a customer quote, opening hours, prices), it left a gap in square brackets instead of making one up.',
                'pressbase-admin',
              )}{' '}
              <Link href={studioLink(run, { checklist: true })}>
                {__('See them on the checklist in Studio', 'pressbase-admin')}
              </Link>
            </>
          ) : (
            __('Nothing left to fill in.', 'pressbase-admin')
          )}
        </span>
      </li>
      <li>
        <Sparkles size={18} aria-hidden="true" className={styles.summaryInfo} />
        <span>{sprintf(__('Building it used %s.', 'pressbase-admin'), usageWords(usage))}</span>
      </li>
    </ul>
  );
}
