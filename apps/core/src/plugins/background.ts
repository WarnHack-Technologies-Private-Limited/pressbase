import { schema } from '@pressbase/db';
import { and, asc, desc, eq, ne, or, type SQL, sql } from 'drizzle-orm';
import { Cron, pluginCronJob } from '../jobs/cron';
import type { EnqueueOptions, HandlerOptions, Job, JobContext } from '../jobs/queue';
import type { Kernel } from '../kernel';

/**
 * `api.cron` and `api.jobs`: WP-Cron and the job queue, scoped to one plugin
 * (docs/architecture/plugins.md#background-work, docs/architecture/jobs.md#plugins).
 *
 * - Cron hook names get the plugin's prefix, as options do (`rotate` →
 *   `daily_tips_rotate`), so a plugin can't fire core's events. Its events
 *   are `cron:{slug}` jobs.
 * - Job names get the slug as a namespace (`sync` → `daily-tips/sync`).
 * - While the plugin is loaded its cron runner and job handlers are
 *   registered; deactivating removes them, so its due work waits, pending and
 *   untouched, until it is activated again (nothing fails, nothing is lost).
 * - Deleting the plugin removes every job and event it left
 *   (`clearPluginJobs()`).
 */

/** Hook names and job names a plugin uses: lowercase letters, numbers, `_` and `-`. */
const LOCAL_NAME = /^[a-z0-9_-]+$/;
const JOB_NAME = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/;

// biome-ignore lint/suspicious/noExplicitAny: action callbacks take whatever the event was scheduled with.
type CronCallback = (...args: any[]) => unknown;

export interface PluginCron {
  /** The prefix added to hook names: the plugin's option prefix (`daily_tips_`). */
  readonly prefix: string;
  /** The full hook name for a cron hook (`rotate` → `daily_tips_rotate`). */
  hookName(hook: string): string;
  /** wp_schedule_event(): run `hook` at `timestamp` (Unix seconds or a Date), then every `recurrence`. */
  scheduleEvent(
    timestamp: number | Date,
    recurrence: 'hourly' | 'twicedaily' | 'daily' | 'weekly' | (string & {}),
    hook: string,
    args?: unknown[],
  ): Promise<boolean>;
  /** wp_schedule_single_event(): run `hook` once. False for a duplicate within ten minutes. */
  scheduleSingleEvent(timestamp: number | Date, hook: string, args?: unknown[]): Promise<boolean>;
  /** wp_next_scheduled(): the Unix timestamp of the next run, or false. */
  nextScheduled(hook: string, args?: unknown[]): Promise<number | false>;
  /** wp_unschedule_event(): removes one occurrence. */
  unscheduleEvent(timestamp: number | Date, hook: string, args?: unknown[]): Promise<boolean>;
  /** wp_clear_scheduled_hook(): removes every occurrence with these arguments; returns how many. */
  clearScheduledHook(hook: string, args?: unknown[]): Promise<number | false>;
  /** wp_unschedule_hook(): removes every occurrence, whatever the arguments; returns how many. */
  unscheduleHook(hook: string): Promise<number | false>;
  /**
   * add_action() for a cron hook, with the prefix added. Same as
   * `api.hooks.addAction(api.cron.hookName(hook), callback)`. Removed on deactivation.
   */
  addAction(hook: string, callback: CronCallback, priority?: number): () => void;
}

/** What a plugin's job handler receives besides the job's data. */
export type PluginJobContext = JobContext;

// biome-ignore lint/suspicious/noExplicitAny: job data is whatever the plugin enqueued.
export type PluginJobHandler<T = any> = (data: T, context: PluginJobContext) => unknown;

export interface PluginJobs {
  /** The queue name of a job (`sync` → `daily-tips/sync`). */
  name(name: string): string;
  /**
   * Registers the handler for the plugin's `name` jobs. Unregistered on
   * deactivation; jobs enqueued meanwhile wait until the plugin is active again.
   */
  register<T = unknown>(
    name: string,
    handler: PluginJobHandler<T>,
    options?: HandlerOptions,
  ): () => void;
  /** Adds a job. Null when a job with the same `singletonKey` is already pending or running. */
  enqueue(name: string, data?: unknown, options?: EnqueueOptions): Promise<Job | null>;
  /** Deletes one of the plugin's pending jobs. */
  cancel(id: number): Promise<boolean>;
  /** The plugin's jobs, soonest first (or most recently finished, for `completed` and `failed`). */
  list(filter?: {
    name?: string;
    status?: 'pending' | 'running' | 'completed' | 'failed';
    limit?: number;
  }): Promise<Job[]>;
}

export interface BackgroundHost {
  kernel: Kernel;
  slug: string;
  prefix: string;
  /** Records a disposer, run on deactivation. */
  track(dispose: () => void): void;
  /** Adds a tracked, error-isolated action (the runtime's addAction). */
  addAction(name: string, callback: CronCallback, priority?: number): () => void;
  reportError(during: string, error: unknown): void;
}

export interface Background {
  cron: PluginCron;
  jobs: PluginJobs;
  /** Registers the cron runner. Called once the plugin has registered its callbacks. */
  start(): void;
}

export function createBackground(host: BackgroundHost): Background {
  const { kernel, slug, prefix } = host;
  const cron = new Cron(kernel, { owner: slug });

  const hookName = (hook: string) => {
    if (typeof hook !== 'string' || !LOCAL_NAME.test(hook)) {
      throw new Error(
        `Cron hook names use lowercase letters, numbers, "_" and "-": "${String(hook)}".`,
      );
    }
    return hook.startsWith(prefix) ? hook : `${prefix}${hook}`;
  };
  const jobName = (name: string) => {
    if (typeof name !== 'string') throw new Error('Job names are strings.');
    const local = name.startsWith(`${slug}/`) ? name.slice(slug.length + 1) : name;
    if (!JOB_NAME.test(local)) {
      throw new Error(`Job names use lowercase letters, numbers, "_", "-" and "/": "${name}".`);
    }
    return `${slug}/${local}`;
  };
  const ownJob = ownedBy(slug);

  const pluginCron: PluginCron = Object.freeze<PluginCron>({
    prefix,
    hookName,
    scheduleEvent: (timestamp, recurrence, hook, args = []) =>
      cron.scheduleEvent(timestamp, recurrence, hookName(hook), args),
    scheduleSingleEvent: (timestamp, hook, args = []) =>
      cron.scheduleSingleEvent(timestamp, hookName(hook), args),
    nextScheduled: (hook, args = []) => cron.nextScheduled(hookName(hook), args),
    unscheduleEvent: (timestamp, hook, args = []) =>
      cron.unscheduleEvent(timestamp, hookName(hook), args),
    clearScheduledHook: (hook, args = []) => cron.clearScheduledHook(hookName(hook), args),
    unscheduleHook: (hook) => cron.unscheduleHook(hookName(hook)),
    addAction: (hook, callback, priority) => host.addAction(hookName(hook), callback, priority),
  });

  const jobs: PluginJobs = Object.freeze<PluginJobs>({
    name: jobName,
    register: <T>(name: string, handler: PluginJobHandler<T>, options?: HandlerOptions) => {
      if (typeof handler !== 'function') throw new TypeError('The job handler is not a function.');
      const full = jobName(name);
      // A throw is recorded against the plugin, then rethrown so the queue retries.
      const off = kernel.jobs.register<T>(
        full,
        async (data, context) => {
          try {
            return await handler(data, context);
          } catch (error) {
            host.reportError(`job ${full}`, error);
            throw error;
          }
        },
        options,
      );
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        off();
      };
      host.track(remove);
      return remove;
    },
    enqueue: (name: string, data?: unknown, options?: EnqueueOptions) =>
      kernel.jobs.enqueue(jobName(name), data ?? {}, options),
    cancel: async (id: number) => {
      const deleted = await kernel.db
        .delete(schema.jobs)
        .where(and(eq(schema.jobs.id, id), eq(schema.jobs.status, 'pending'), ownJob))
        .returning({ id: schema.jobs.id });
      return deleted.length > 0;
    },
    list: async (filter = {}) => {
      const jobs = schema.jobs;
      const finished = filter.status === 'failed' || filter.status === 'completed';
      return kernel.db
        .select()
        .from(jobs)
        .where(
          and(
            filter.name ? eq(jobs.name, jobName(filter.name)) : ownJob,
            filter.status ? eq(jobs.status, filter.status) : undefined,
          ),
        )
        .orderBy(finished ? desc(jobs.finishedAt) : asc(jobs.runAt), desc(jobs.id))
        .limit(filter.limit ?? 50);
    },
  });

  let started = false;
  return {
    cron: pluginCron,
    jobs,
    start: () => {
      if (started) return;
      started = true;
      host.track(cron.registerRunner());
    },
  };
}

/**
 * Removes every job a deleted plugin left behind: its cron events
 * (`cron:{slug}`) and its `{slug}/…` jobs, whatever their status. Jobs running
 * in another process finish and are pruned later.
 */
export async function clearPluginJobs(kernel: Kernel, slug: string): Promise<number> {
  const name = schema.jobs.name;
  const deleted = await kernel.db
    .delete(schema.jobs)
    .where(and(ne(schema.jobs.status, 'running'), or(eq(name, pluginCronJob(slug)), ownedBy(slug))))
    .returning({ id: schema.jobs.id });
  return deleted.length;
}

/** Jobs named `{slug}/…`. */
function ownedBy(slug: string): SQL {
  const prefix = `${slug}/`;
  return sql`left(${schema.jobs.name}, ${prefix.length}) = ${prefix}`;
}
