/**
 * The guided "build my site" flow (#60): its steps, what it sends to core,
 * the sitemap's arithmetic, a run's progress from its events, and the design
 * previews' styles. Pure functions, no I/O, so they're tested on their own
 * (site-builder.test.ts). The screen is components/site-builder/.
 * See docs/architecture/site-builder.md#the-guided-flow.
 */

import {
  createDesign,
  DENSITIES,
  type DesignChoice,
  FONT_PAIRS,
  fontPair,
  MOODS,
  RADII,
  radiusPresets,
  spacingPresets,
} from '@pressbase/design';
import { msgid } from './i18n/locale';

export type { DesignChoice };

/* ------------------------------------------------------------------ steps */

export type StepId =
  | 'describe'
  | 'clarify'
  | 'brief'
  | 'design'
  | 'sitemap'
  | 'generate'
  | 'review';

export const STEPS: readonly { id: StepId; label: string }[] = [
  { id: 'describe', label: msgid('Describe') },
  { id: 'clarify', label: msgid('Questions') },
  { id: 'brief', label: msgid('Details') },
  { id: 'design', label: msgid('Look') },
  { id: 'sitemap', label: msgid('Pages') },
  { id: 'generate', label: msgid('Build') },
  { id: 'review', label: msgid('Review') },
];

export const stepIndex = (id: StepId) => STEPS.findIndex((s) => s.id === id);

/** The step Back goes to. Describe has none: Back leaves the flow. */
export function previousStep(id: StepId, finished: boolean): StepId | null {
  if (id === 'review') return 'sitemap';
  if (id === 'generate') return finished ? 'review' : 'sitemap';
  const i = stepIndex(id);
  return i > 0 ? (STEPS[i - 1]?.id ?? null) : null;
}

/* ------------------------------------------------------------------- form */

export interface DescribeForm {
  description: string;
  name: string;
  location: string;
  phone: string;
  email: string;
  address: string;
  /** Anything else to state as fact, one per line. */
  facts: string;
}

export const EMPTY_FORM: DescribeForm = {
  description: '',
  name: '',
  location: '',
  phone: '',
  email: '',
  address: '',
  facts: '',
};

export const MAX_DESCRIPTION = 4000;

/** The Describe step's form as core takes it: trimmed, empty fields left out. */
export function formPayload(form: DescribeForm): Record<string, unknown> {
  const out: Record<string, unknown> = { description: form.description.trim() };
  for (const key of ['name', 'location', 'phone', 'email', 'address'] as const) {
    const value = form[key].trim();
    if (value) out[key] = value;
  }
  const facts = form.facts
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (facts.length) out.facts = facts;
  return out;
}

export interface Question {
  question: string;
}

export interface Answer {
  question: string;
  answer: string;
}

/** The answers worth sending: the questions the person answered. */
export function answersPayload(questions: Question[], answers: string[]): Answer[] {
  return questions
    .map((q, i) => ({ question: q.question, answer: (answers[i] ?? '').trim() }))
    .filter((a) => a.answer);
}

/* ------------------------------------------------------------------ brief */

export interface Brief {
  name: string;
  kind: string;
  audience: string;
  tone: string;
  facts: string[];
  pages: string[];
  language: string;
}

/** A brief edited in the card: list fields one per line, cleaned. */
export function cleanBrief(brief: Brief): Brief {
  const lines = (list: string[], max: number) =>
    list
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, max);
  return {
    ...brief,
    name: brief.name.trim(),
    kind: brief.kind.trim(),
    audience: brief.audience.trim(),
    tone: brief.tone.trim(),
    facts: lines(brief.facts, 50),
    pages: lines(brief.pages, 20),
  };
}

/* ---------------------------------------------------------------- designs */

export interface DesignOption {
  label: string;
  choice: DesignChoice;
}

export const DESIGN_MOODS = MOODS;
export const DESIGN_RADII = RADII;
export const DESIGN_DENSITIES = DENSITIES;
export const DESIGN_FONT_PAIRS: { id: string; label: string }[] = FONT_PAIRS.map((p) => ({
  id: p.id,
  label: p.label,
}));

/** The words for each choice, for people (the values are the model's). */
export const MOOD_LABELS: Record<string, string> = {
  calm: msgid('Calm'),
  warm: msgid('Warm'),
  vibrant: msgid('Vibrant'),
  elegant: msgid('Elegant'),
  earthy: msgid('Earthy'),
  minimal: msgid('Minimal'),
  playful: msgid('Playful'),
};
export const RADIUS_LABELS: Record<string, string> = {
  square: msgid('Square'),
  subtle: msgid('Slightly rounded'),
  rounded: msgid('Rounded'),
  soft: msgid('Very rounded'),
};
export const DENSITY_LABELS: Record<string, string> = {
  compact: msgid('Compact'),
  comfortable: msgid('Comfortable'),
  spacious: msgid('Spacious'),
};

/** CSS custom properties for a design's mini preview: its palette, fonts, corners and spacing. */
export function previewStyle(choice: DesignChoice): Record<string, string> {
  const design = createDesign(choice);
  const color = (slug: string) => design.palette.find((p) => p.slug === slug)?.color ?? '';
  const pair = fontPair(choice.fontPair);
  const radius = (slug: string) => radiusPresets(choice.radius).find((r) => r.slug === slug)?.size;
  const space = (slug: string) => spacingPresets(choice.density).find((s) => s.slug === slug)?.size;
  return {
    '--pv-base': color('base'),
    '--pv-surface': color('surface'),
    '--pv-contrast': color('contrast'),
    '--pv-muted': color('muted'),
    '--pv-border': color('border'),
    '--pv-accent': color('accent'),
    '--pv-accent-text': color('accent-text'),
    '--pv-accent-soft': color('accent-soft'),
    '--pv-on-accent': color('on-accent'),
    '--pv-second': color('violet'),
    '--pv-heading-font': pair?.heading.fontFamily ?? 'inherit',
    '--pv-body-font': pair?.body.fontFamily ?? 'inherit',
    '--pv-radius': radius('md') ?? '0',
    '--pv-button-radius': radius('full') ?? '0',
    '--pv-space': space('40') ?? '1rem',
  };
}

export const sameChoice = (a: DesignChoice, b: DesignChoice) =>
  JSON.stringify(a) === JSON.stringify(b);

/* ---------------------------------------------------------------- sitemap */

export interface SitemapSection {
  category: string;
  intent: string;
}

export interface SitemapPage {
  title: string;
  slug: string;
  sections: SitemapSection[];
}

export interface Sitemap {
  pages: SitemapPage[];
}

export interface SectionKind {
  category: string;
  label: string;
}

export const MAX_PAGES = 8;
export const MAX_SECTIONS = 8;

/** Moves a page (or a section) from one place to another; out-of-range moves change nothing. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
    return [...list];
  }
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item as T);
  return out;
}

/** A page added at the end, with one section to start from; none past the limit. */
export function addPage(
  pages: readonly SitemapPage[],
  title: string,
  first: string,
): SitemapPage[] {
  const clean = title.trim();
  if (!clean || pages.length >= MAX_PAGES) return [...pages];
  return [...pages, { title: clean, slug: '', sections: [{ category: first, intent: '' }] }];
}

/** Removes a page; the last one stays (a site needs a home page). */
export function removePage(pages: readonly SitemapPage[], index: number): SitemapPage[] {
  if (pages.length <= 1) return [...pages];
  return pages.filter((_, i) => i !== index);
}

export function updatePage(
  pages: readonly SitemapPage[],
  index: number,
  change: (page: SitemapPage) => SitemapPage,
): SitemapPage[] {
  return pages.map((page, i) => (i === index ? change(page) : page));
}

export function addSection(page: SitemapPage, category: string): SitemapPage {
  if (page.sections.length >= MAX_SECTIONS) return page;
  return { ...page, sections: [...page.sections, { category, intent: '' }] };
}

/** Removes a section; a page keeps at least one. */
export function removeSection(page: SitemapPage, index: number): SitemapPage {
  if (page.sections.length <= 1) return page;
  return { ...page, sections: page.sections.filter((_, i) => i !== index) };
}

/** The sitemap as core takes it: titles trimmed, pages without a title left out. */
export function sitemapPayload(sitemap: Sitemap): Sitemap {
  return {
    pages: sitemap.pages
      .map((p) => ({ ...p, title: p.title.trim() }))
      .filter((p) => p.title && p.sections.length)
      .slice(0, MAX_PAGES),
  };
}

/* -------------------------------------------------------------------- run */

export type RunStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed' | 'cancelled';
export type PageStatus = 'pending' | 'generating' | 'done' | 'failed' | 'skipped';

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface Usage {
  tokens: TokenUsage;
  requests: number;
}

export const NO_USAGE: Usage = { tokens: { prompt: 0, completion: 0, total: 0 }, requests: 0 };

export function addUsage(a: Usage, b: Partial<Usage> | undefined): Usage {
  return {
    tokens: {
      prompt: a.tokens.prompt + (b?.tokens?.prompt ?? 0),
      completion: a.tokens.completion + (b?.tokens?.completion ?? 0),
      total: a.tokens.total + (b?.tokens?.total ?? 0),
    },
    requests: a.requests + (b?.requests ?? 0),
  };
}

export interface RunPage {
  slug: string;
  title: string;
  status: PageStatus;
  home: boolean;
  placeholders: string[];
  preview_link: string | null;
  error: { code: string; message: string } | null;
  checks?: { errors: number; warnings: number; passed: number } | null;
}

export interface Run {
  id: number;
  status: RunStatus;
  stage: string | null;
  pages: RunPage[];
  changeset_uuid: string | null;
  preview_link: string | null;
  tokens: TokenUsage;
  requests: number;
  warnings: { code: string; message: string }[];
  error: { code: string; message: string } | null;
  last_event_id?: number;
}

export const FINISHED: readonly RunStatus[] = ['completed', 'stopped', 'failed', 'cancelled'];
export const isFinished = (run: Pick<Run, 'status'> | null | undefined) =>
  Boolean(run && FINISHED.includes(run.status));

/** One progress event (`event:` and `data:` of the stream) applied to the run. */
export function applyEvent(run: Run, type: string, data: Record<string, unknown>): Run {
  switch (type) {
    case 'snapshot':
      return data as unknown as Run;
    case 'run':
      return {
        ...run,
        status: (data.status as RunStatus) ?? run.status,
        changeset_uuid: (data.changeset_uuid as string) ?? run.changeset_uuid,
        preview_link: (data.preview_link as string) ?? run.preview_link,
      };
    case 'stage':
      return {
        ...run,
        status: 'running',
        stage: data.status === 'started' ? String(data.stage) : run.stage,
      };
    case 'sitemap': {
      const sitemap = data.sitemap as Sitemap | undefined;
      if (!sitemap || run.pages.length) return run;
      return {
        ...run,
        pages: sitemap.pages.map((p, i) => ({
          slug: p.slug,
          title: p.title,
          status: 'pending',
          home: i === 0,
          placeholders: [],
          preview_link: null,
          error: null,
        })),
      };
    }
    case 'page': {
      const index = run.pages.findIndex((p) => p.title === data.title || p.slug === data.slug);
      const page: RunPage = {
        ...(run.pages[index] ?? {
          slug: String(data.slug ?? ''),
          title: String(data.title ?? ''),
          home: run.pages.length === 0,
          placeholders: [],
          preview_link: null,
          error: null,
          status: 'pending',
        }),
        slug: String(data.slug ?? run.pages[index]?.slug ?? ''),
        status: data.status as PageStatus,
        ...(data.preview_link ? { preview_link: String(data.preview_link) } : {}),
        ...(Array.isArray(data.placeholders)
          ? { placeholders: data.placeholders as string[] }
          : {}),
        ...(data.error ? { error: data.error as RunPage['error'] } : {}),
      };
      const pages = [...run.pages];
      if (index === -1) pages.push(page);
      else pages[index] = page;
      return { ...run, pages };
    }
    case 'checks':
      return {
        ...run,
        pages: run.pages.map((p) =>
          p.slug === data.slug
            ? {
                ...p,
                checks: {
                  errors: Number(data.errors ?? 0),
                  warnings: Number(data.warnings ?? 0),
                  passed: Number(data.passed ?? 0),
                },
              }
            : p,
        ),
      };
    case 'warning':
      return { ...run, warnings: [...run.warnings, data as Run['warnings'][number]] };
    case 'done':
      return {
        ...run,
        status: data.status as RunStatus,
        stage: null,
        tokens: (data.tokens as TokenUsage) ?? run.tokens,
        requests: Number(data.requests ?? run.requests),
        changeset_uuid: (data.changeset_uuid as string) ?? run.changeset_uuid,
        preview_link: (data.preview_link as string) ?? run.preview_link,
        error: (data.error as Run['error']) ?? null,
      };
    default:
      return run;
  }
}

/** Placeholders left on the built pages: the things to fill in before publishing. */
export function placeholderCount(run: Pick<Run, 'pages'>): number {
  return run.pages
    .filter((p) => p.status === 'done')
    .reduce((sum, p) => sum + p.placeholders.length, 0);
}

export function pagesDone(run: Pick<Run, 'pages'>): number {
  return run.pages.filter((p) => p.status === 'done').length;
}

/** A rough number of words for a number of tokens (about ¾ of a word each in English). */
export const roughWords = (tokens: number) => Math.round((tokens * 0.75) / 100) * 100;

/** What Studio opens for the result: the draft, and the run for its summary. */
export function studioLink(run: Pick<Run, 'id' | 'changeset_uuid'>): string {
  const params = new URLSearchParams();
  if (run.changeset_uuid) params.set('changeset_uuid', run.changeset_uuid);
  params.set('run', String(run.id));
  return `/admin/studio?${params}`;
}

/* ------------------------------------------------------------ saved state */

/** Where the flow keeps the person's answers between visits (this browser only). */
export const SAVED_KEY = 'pressbase-site-builder';
