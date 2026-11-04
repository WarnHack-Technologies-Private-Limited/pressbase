import { EventEmitter } from 'node:events';
import { schema } from '@pressbase/db';
import type { DesignChoice } from '@pressbase/design';
import { and, desc, eq } from 'drizzle-orm';
import type { Post } from '../content/posts';
import type { Kernel } from '../kernel';
import type { SiteBrief } from '../site-building/brief';

/**
 * Site-builder runs (v0.8, #59): the record of one "build my site" run, so
 * it survives a closed tab, a reload or another device. Stored as a
 * `pressbase_site_run` post (private, like a changeset) whose content is the
 * run as JSON; the pipeline rewrites it as it goes, and the progress route
 * replays its events over Server-Sent Events. See docs/architecture/site-builder.md.
 */

export const SITE_RUN_POST_TYPE = 'pressbase_site_run';
/** Post meta set when a person stops a run; the pipeline checks it between steps. */
export const SITE_RUN_CANCEL_META = '_pressbase_site_run_cancel';

export type RunStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed' | 'cancelled';
export const FINISHED_STATUSES: readonly RunStatus[] = [
  'completed',
  'stopped',
  'failed',
  'cancelled',
];

export type StageName = 'brief' | 'design' | 'sitemap' | 'pages' | 'assemble' | 'check';
export const STAGES: readonly StageName[] = [
  'brief',
  'design',
  'sitemap',
  'pages',
  'assemble',
  'check',
];

/** What the person gave: the Describe step's form. Every field is data, never instructions. */
export interface RunInput {
  description: string;
  name?: string;
  location?: string;
  phone?: string;
  email?: string;
  address?: string;
  /** Anything else they want stated: opening hours, prices, a customer quote… */
  facts?: string[];
  /** Pages they asked for, by title. */
  pages?: string[];
  language?: string;
}

export interface SitemapSection {
  /** A pattern category (banner, about, testimonials…). */
  category: string;
  /** What the section is for, in a sentence: guidance for the Page stage. */
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

export type PageStatus = 'pending' | 'generating' | 'done' | 'failed' | 'skipped';

export interface RunPage {
  slug: string;
  title: string;
  status: PageStatus;
  /** Whether this is the home page (`show_on_front` = page). */
  home: boolean;
  /** Patterns used, in order. */
  sections: string[];
  /** Slots holding a placeholder: `{section}.{slot path}`. */
  placeholders: string[];
  /** Slots the honest-content rules emptied: `{section}.{slot path}`. */
  replaced: string[];
  checks: { errors: number; warnings: number; passed: boolean } | null;
  preview_link: string | null;
  error: { code: string; message: string } | null;
}

export interface RunEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface SiteRun {
  id: number;
  author: number;
  status: RunStatus;
  stage: StageName | null;
  input: RunInput;
  brief: SiteBrief | null;
  design: DesignChoice | null;
  sitemap: Sitemap | null;
  pages: RunPage[];
  changeset_uuid: string | null;
  preview_link: string | null;
  tokens: TokenUsage;
  /** Provider requests made, retries included. */
  requests: number;
  warnings: { code: string; message: string }[];
  error: { code: string; message: string } | null;
  job_id: number | null;
  created: string;
  modified: string;
  events: RunEvent[];
}

/** The stored part of a run: everything but the post's own fields. */
type Stored = Omit<SiteRun, 'id' | 'author' | 'created' | 'modified'>;

/** Wakes the progress streams of this process when a run changes. */
export const runChanges = new EventEmitter();
runChanges.setMaxListeners(0);

export function registerSiteRunPostType(kernel: Kernel): void {
  // Private and only reachable through /pressbase/v1/site-builder; the
  // capabilities are the theme's, as a changeset's are.
  kernel.postTypes.register(
    SITE_RUN_POST_TYPE,
    {
      label: 'Site builder runs',
      singularLabel: 'Site builder run',
      public: false,
      supports: ['title', 'author'],
      capabilityType: SITE_RUN_POST_TYPE,
      capabilities: {
        create_posts: 'edit_theme_options',
        edit_post: 'edit_theme_options',
        edit_posts: 'edit_theme_options',
        edit_others_posts: 'edit_theme_options',
        delete_post: 'edit_theme_options',
        read_post: 'edit_theme_options',
      },
    },
    true,
  );
}

function fromPost(post: Post): SiteRun {
  let stored: Partial<Stored> = {};
  try {
    stored = JSON.parse(post.content || '{}') as Partial<Stored>;
  } catch {}
  return {
    id: post.id,
    author: post.authorId ?? 0,
    status: stored.status ?? 'failed',
    stage: stored.stage ?? null,
    input: stored.input ?? { description: '' },
    brief: stored.brief ?? null,
    design: stored.design ?? null,
    sitemap: stored.sitemap ?? null,
    pages: stored.pages ?? [],
    changeset_uuid: stored.changeset_uuid ?? null,
    preview_link: stored.preview_link ?? null,
    tokens: stored.tokens ?? { prompt: 0, completion: 0, total: 0 },
    requests: stored.requests ?? 0,
    warnings: stored.warnings ?? [],
    error: stored.error ?? null,
    job_id: stored.job_id ?? null,
    created: post.date.toISOString(),
    modified: post.modified.toISOString(),
    events: stored.events ?? [],
  };
}

function toStored(run: SiteRun): Stored {
  const { id: _id, author: _author, created: _created, modified: _modified, ...stored } = run;
  return stored;
}

export async function createRun(
  kernel: Kernel,
  authorId: number,
  input: RunInput,
  preset: Pick<SiteRun, 'brief' | 'design' | 'sitemap' | 'changeset_uuid'>,
): Promise<SiteRun> {
  const stored: Stored = {
    status: 'queued',
    stage: null,
    input,
    brief: preset.brief,
    design: preset.design,
    sitemap: preset.sitemap,
    pages: [],
    changeset_uuid: preset.changeset_uuid,
    preview_link: null,
    tokens: { prompt: 0, completion: 0, total: 0 },
    requests: 0,
    warnings: [],
    error: null,
    job_id: null,
    events: [],
  };
  const post = await kernel.posts.insert(SITE_RUN_POST_TYPE, {
    title: (input.name || input.description).slice(0, 100),
    content: JSON.stringify(stored),
    status: 'private',
    authorId,
    saveRevision: false,
  });
  return fromPost(post);
}

export async function getRun(kernel: Kernel, id: number): Promise<SiteRun | undefined> {
  const [post] = await kernel.db
    .select()
    .from(schema.posts)
    .where(and(eq(schema.posts.id, id), eq(schema.posts.type, SITE_RUN_POST_TYPE)));
  return post ? fromPost(post) : undefined;
}

export async function listRuns(kernel: Kernel, authorId: number, limit = 20): Promise<SiteRun[]> {
  const posts = await kernel.db
    .select()
    .from(schema.posts)
    .where(and(eq(schema.posts.type, SITE_RUN_POST_TYPE), eq(schema.posts.authorId, authorId)))
    .orderBy(desc(schema.posts.date), desc(schema.posts.id))
    .limit(limit);
  return posts.map(fromPost);
}

/**
 * Writes the run (straight to its row: progress isn't a content change, so
 * no hooks, revisions or cache purges) and wakes the progress streams.
 */
export async function saveRun(kernel: Kernel, run: SiteRun): Promise<void> {
  const modified = new Date();
  run.modified = modified.toISOString();
  await kernel.db
    .update(schema.posts)
    .set({ content: JSON.stringify(toStored(run)), modified })
    .where(eq(schema.posts.id, run.id));
  runChanges.emit(String(run.id));
}

export async function requestCancel(kernel: Kernel, id: number): Promise<void> {
  await kernel.meta.update('post', id, SITE_RUN_CANCEL_META, '1');
  runChanges.emit(String(id));
}

export async function cancelRequested(kernel: Kernel, id: number): Promise<boolean> {
  return Boolean(await kernel.meta.get('post', id, SITE_RUN_CANCEL_META, true));
}

/** Waits until the run changes in this process, or `ms` pass (another process may change it). */
export function waitForChange(id: number, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      runChanges.off(String(id), done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    runChanges.on(String(id), done);
    signal?.addEventListener('abort', done);
  });
}

/** A run as the REST API gives it: without its events (the progress stream has those). */
export function presentRun(run: SiteRun): Omit<SiteRun, 'events'> & { last_event_id: number } {
  const { events, ...rest } = run;
  return { ...rest, last_event_id: events[events.length - 1]?.id ?? 0 };
}
