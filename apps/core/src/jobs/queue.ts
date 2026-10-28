import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { schema } from '@pressbase/db';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Kernel } from '../kernel';

/**
 * The job queue: durable background jobs in the `jobs` table, the same SQL on
 * PostgreSQL and PGlite (docs/architecture/jobs.md, ADR 0010).
 *
 * - Handlers are registered by name (`kernel.jobs.register('my-plugin/sync', fn)`);
 *   jobs whose handler isn't registered stay pending until one is.
 * - Workers claim due jobs with `FOR UPDATE SKIP LOCKED`, so several core
 *   processes on one PostgreSQL database never run a job twice.
 * - A failed attempt is retried after `backoffSeconds × 2^(attempt − 1)` until
 *   `maxAttempts`; then the job is `failed` and keeps its error for the admin.
 * - `singletonKey` deduplicates: one pending or running job per key.
 * - A job running longer than `timeoutSeconds` counts as a failed attempt;
 *   its handler's `signal` is aborted.
 * - Finished jobs are pruned after `retention` (the daily `pressbase_prune_jobs` event).
 *
 * Cron (kernel.cron, cron.ts) is built on top: each scheduled event is a job.
 */

export type Job = typeof schema.jobs.$inferSelect;
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface JobContext {
  job: Job;
  /** The attempt this is, from 1. */
  attempt: number;
  /** The time the worker considers "now" for this run (explicit in tests). */
  now: Date;
  /** Aborted when the job times out or the worker stops. */
  signal: AbortSignal;
}

// biome-ignore lint/suspicious/noExplicitAny: job data is whatever the enqueuer stored.
export type JobHandler<T = any> = (data: T, context: JobContext) => unknown;

/** Defaults a handler gives the jobs enqueued for it. */
export interface HandlerOptions {
  maxAttempts?: number;
  backoffSeconds?: number;
  timeoutSeconds?: number;
}

export interface EnqueueOptions extends HandlerOptions {
  /** Not before this time. Default: now. */
  runAt?: Date;
  /** Higher runs first among due jobs. Default 0. */
  priority?: number;
  /** At most one pending or running job with this key; later enqueues return null. */
  singletonKey?: string;
  /** With a singletonKey: update the pending job's data and time instead of skipping. */
  replace?: boolean;
}

export interface RunOptions {
  /** Treat this as the current time (tests). Default: the real clock. */
  now?: Date;
  /** Stop after this many jobs. Default 100. */
  limit?: number;
}

export interface RunResult {
  completed: number;
  /** Failed attempts that will be retried. */
  retried: number;
  /** Jobs that used their last attempt. */
  failed: number;
}

export interface WorkerOptions {
  /** Longest sleep between checks, in milliseconds. Default 15 seconds. */
  pollMs?: number;
}

export interface Retention {
  /** Seconds to keep completed jobs. Default one day. */
  completed: number;
  /** Seconds to keep failed jobs (the admin lists them). Default seven days. */
  failed: number;
}

declare module '@pressbase/hooks' {
  interface ActionRegistry {
    /** A job attempt threw or timed out; `retrying` is false on its last attempt. */
    pressbase_job_failed: [job: Job, error: unknown, retrying: boolean];
  }
}

export class JobTimeoutError extends Error {
  constructor(seconds: number) {
    super(`The job did not finish within ${seconds} seconds.`);
    this.name = 'JobTimeoutError';
  }
}

const MAX_BACKOFF_SECONDS = 24 * 60 * 60;
/** Extra time a running job gets before another worker treats it as abandoned. */
const STALE_GRACE_SECONDS = 60;

/** The delay before retry number `attempt` (1 = after the first failure). */
export function backoffSeconds(base: number, attempt: number): number {
  return Math.min(MAX_BACKOFF_SECONDS, base * 2 ** Math.max(0, attempt - 1));
}

function describeError(error: unknown): string {
  const text =
    error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  return text.slice(0, 4000);
}

interface Registered {
  handler: JobHandler;
  options: HandlerOptions;
}

interface WorkerState {
  stopped: boolean;
  pollMs: number;
  timer?: ReturnType<typeof setTimeout>;
  wakeAt: number;
  current?: Promise<unknown>;
}

export class JobQueue {
  /** How long finished jobs are kept. */
  retention: Retention = { completed: 24 * 60 * 60, failed: 7 * 24 * 60 * 60 };
  /** Identifies this process's claims (jobs.locked_by). */
  readonly workerId = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  #handlers = new Map<string, Registered>();
  #inFlight = new Map<number, AbortController>();
  #chain: Promise<unknown> = Promise.resolve();
  #worker: WorkerState | undefined;

  constructor(private readonly kernel: Kernel) {}

  get #db() {
    return this.kernel.db;
  }

  /* ------------------------------------------------------------- handlers */

  /** Registers the handler for jobs named `name`. Returns a function that unregisters it. */
  register<T>(name: string, handler: JobHandler<T>, options: HandlerOptions = {}): () => void {
    const entry: Registered = { handler, options };
    this.#handlers.set(name, entry);
    return () => {
      if (this.#handlers.get(name) === entry) this.#handlers.delete(name);
    };
  }

  hasHandler(name: string): boolean {
    return this.#handlers.has(name);
  }

  /** Names with a registered handler. */
  handlers(): string[] {
    return [...this.#handlers.keys()];
  }

  /* ------------------------------------------------------------- enqueuing */

  /**
   * Adds a job. Returns it, or null when a job with the same singletonKey is
   * already pending or running (with `replace`, a pending one is updated and returned).
   */
  async enqueue(
    name: string,
    data: unknown = {},
    options: EnqueueOptions = {},
  ): Promise<Job | null> {
    const defaults = this.#handlers.get(name)?.options ?? {};
    const runAt = options.runAt ?? new Date();
    const values: typeof schema.jobs.$inferInsert = {
      name,
      data: data ?? {},
      runAt,
      priority: options.priority ?? 0,
      maxAttempts: Math.max(1, options.maxAttempts ?? defaults.maxAttempts ?? 3),
      backoffSeconds: Math.max(0, options.backoffSeconds ?? defaults.backoffSeconds ?? 30),
      timeoutSeconds: Math.max(1, options.timeoutSeconds ?? defaults.timeoutSeconds ?? 300),
      singletonKey: options.singletonKey ?? null,
    };
    const jobs = schema.jobs;
    const insert = this.#db.insert(jobs).values(values);
    const target = { target: jobs.singletonKey, where: sql`status in ('pending', 'running')` };
    const [job] = !options.singletonKey
      ? await insert.returning()
      : options.replace
        ? await insert
            .onConflictDoUpdate({
              target: jobs.singletonKey,
              targetWhere: target.where,
              set: {
                data: values.data,
                runAt,
                priority: values.priority,
                maxAttempts: values.maxAttempts,
                backoffSeconds: values.backoffSeconds,
                timeoutSeconds: values.timeoutSeconds,
              },
              // A running job keeps its data; the new values are not queued.
              setWhere: sql`${jobs.status} = 'pending'`,
            })
            .returning()
        : await insert.onConflictDoNothing(target).returning();
    if (job) this.#nudge(job.runAt);
    return job ?? null;
  }

  async get(id: number): Promise<Job | undefined> {
    const [job] = await this.#db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    return job;
  }

  /** Deletes a pending job. Running jobs can't be cancelled. */
  async cancel(id: number): Promise<boolean> {
    const deleted = await this.#db
      .delete(schema.jobs)
      .where(and(eq(schema.jobs.id, id), eq(schema.jobs.status, 'pending')))
      .returning({ id: schema.jobs.id });
    return deleted.length > 0;
  }

  /** Jobs by status, newest first (failed and completed by finish time). */
  async list(filter: { status?: JobStatus; name?: string; limit?: number } = {}): Promise<Job[]> {
    const jobs = schema.jobs;
    const finished = filter.status === 'failed' || filter.status === 'completed';
    return this.#db
      .select()
      .from(jobs)
      .where(
        and(
          filter.status ? eq(jobs.status, filter.status) : undefined,
          filter.name ? eq(jobs.name, filter.name) : undefined,
        ),
      )
      .orderBy(finished ? desc(jobs.finishedAt) : asc(jobs.runAt), desc(jobs.id))
      .limit(filter.limit ?? 50);
  }

  /** How many jobs are in each status. */
  async counts(): Promise<Record<JobStatus, number>> {
    const rows = await this.#db
      .select({ status: schema.jobs.status, n: count() })
      .from(schema.jobs)
      .groupBy(schema.jobs.status);
    const result: Record<JobStatus, number> = { pending: 0, running: 0, completed: 0, failed: 0 };
    for (const row of rows) result[row.status as JobStatus] = row.n;
    return result;
  }

  /** The earliest run time among pending jobs this process can run. */
  async nextRunAt(): Promise<Date | undefined> {
    const names = this.handlers();
    if (!names.length) return undefined;
    const [row] = await this.#db
      .select({ runAt: schema.jobs.runAt })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, 'pending'), inArray(schema.jobs.name, names)))
      .orderBy(asc(schema.jobs.runAt))
      .limit(1);
    return row?.runAt;
  }

  /* ---------------------------------------------------------------- running */

  /**
   * Runs every due job this process has a handler for, then returns. The
   * worker calls it on a timer; tests call it directly with an explicit `now`.
   * Calls in one process run one after another.
   */
  runDue(options: RunOptions = {}): Promise<RunResult> {
    const run = this.#chain.then(() => this.#runDue(options));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #runDue(options: RunOptions): Promise<RunResult> {
    const result: RunResult = { completed: 0, retried: 0, failed: 0 };
    const names = this.handlers();
    if (!names.length) return result;
    const clock = () => options.now ?? new Date();
    await this.#recoverStale(clock());
    // PGlite is one connection in this process: run one job at a time there.
    const concurrency = this.kernel.connection.driver === 'pglite' ? 1 : 4;
    const limit = options.limit ?? 100;
    let ran = 0;
    while (ran < limit) {
      const batch = await this.#claim(names, clock(), Math.min(concurrency, limit - ran));
      if (!batch.length) break;
      ran += batch.length;
      const outcomes = await Promise.all(batch.map((job) => this.#run(job, clock)));
      for (const outcome of outcomes) result[outcome] += 1;
    }
    return result;
  }

  /** Marks due jobs as running and returns them; locked rows are skipped, never waited for. */
  async #claim(names: string[], now: Date, n: number): Promise<Job[]> {
    const jobs = schema.jobs;
    const due = this.#db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, now), inArray(jobs.name, names)))
      .orderBy(desc(jobs.priority), asc(jobs.runAt), asc(jobs.id))
      .limit(n)
      .for('update', { skipLocked: true });
    const claimed = await this.#db
      .update(jobs)
      .set({
        status: 'running',
        attempts: sql`${jobs.attempts} + 1`,
        startedAt: now,
        lockedBy: this.workerId,
      })
      .where(and(inArray(jobs.id, due), eq(jobs.status, 'pending')))
      .returning();
    return claimed.sort(
      (a, b) => b.priority - a.priority || a.runAt.getTime() - b.runAt.getTime() || a.id - b.id,
    );
  }

  async #run(job: Job, clock: () => Date): Promise<keyof RunResult> {
    const registered = this.#handlers.get(job.name);
    const controller = new AbortController();
    this.#inFlight.set(job.id, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new JobTimeoutError(job.timeoutSeconds);
        controller.abort(error);
        reject(error);
      }, job.timeoutSeconds * 1000);
      timer.unref?.();
    });
    try {
      if (!registered) throw new Error(`No handler is registered for "${job.name}" jobs.`);
      const context: JobContext = {
        job,
        attempt: job.attempts,
        now: clock(),
        signal: controller.signal,
      };
      await Promise.race([
        Promise.resolve().then(() => registered.handler(job.data, context)),
        timeout,
      ]);
      await this.#db
        .update(schema.jobs)
        .set({ status: 'completed', finishedAt: clock(), lastError: null, lockedBy: null })
        .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, 'running')));
      return 'completed';
    } catch (error) {
      return await this.#fail(job, error, clock());
    } finally {
      clearTimeout(timer);
      this.#inFlight.delete(job.id);
    }
  }

  async #fail(job: Job, error: unknown, now: Date): Promise<'retried' | 'failed'> {
    const retrying = job.attempts < job.maxAttempts;
    const lastError = describeError(error);
    const [updated] = await this.#db
      .update(schema.jobs)
      .set(
        retrying
          ? {
              status: 'pending',
              runAt: new Date(
                now.getTime() + backoffSeconds(job.backoffSeconds, job.attempts) * 1000,
              ),
              lastError,
              lockedBy: null,
            }
          : { status: 'failed', finishedAt: now, lastError, lockedBy: null },
      )
      .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, 'running')))
      .returning();
    if (this.#worker) {
      console.error(
        `Pressbase job ${job.id} (${job.name}) failed on attempt ${job.attempts} of ${job.maxAttempts}${retrying ? ', will retry' : ''}:`,
        error,
      );
    }
    try {
      await this.kernel.hooks.doAction('pressbase_job_failed', updated ?? job, error, retrying);
    } catch (hookError) {
      console.error('pressbase_job_failed callback threw:', hookError);
    }
    return retrying ? 'retried' : 'failed';
  }

  /**
   * Jobs left `running` by a process that died (or a handler that ignored its
   * timeout in another process) count as a failed attempt once their timeout
   * and a grace period have passed.
   */
  async #recoverStale(now: Date): Promise<void> {
    const jobs = schema.jobs;
    const stamp = sql`${now.toISOString()}::timestamptz`;
    const exhausted = sql`${jobs.attempts} >= ${jobs.maxAttempts}`;
    const mine = [...this.#inFlight.keys()];
    await this.#db
      .update(jobs)
      .set({
        status: sql`case when ${exhausted} then 'failed' else 'pending' end`,
        finishedAt: sql`case when ${exhausted} then ${stamp} else null end`,
        runAt: stamp,
        lastError: 'The worker stopped before the job finished.',
        lockedBy: null,
      })
      .where(
        and(
          eq(jobs.status, 'running'),
          sql`${jobs.startedAt} + (${jobs.timeoutSeconds} + ${STALE_GRACE_SECONDS}) * interval '1 second' < ${stamp}`,
          mine.length ? notInArray(jobs.id, mine) : undefined,
        ),
      );
  }

  /** Deletes completed and failed jobs older than `retention`. Returns how many. */
  async prune(now = new Date()): Promise<number> {
    const jobs = schema.jobs;
    const before = (seconds: number): SQL =>
      sql`${jobs.finishedAt} < ${new Date(now.getTime() - seconds * 1000).toISOString()}::timestamptz`;
    const deleted = await this.#db
      .delete(jobs)
      .where(
        or(
          and(eq(jobs.status, 'completed'), before(this.retention.completed)),
          and(eq(jobs.status, 'failed'), before(this.retention.failed)),
        ),
      )
      .returning({ id: jobs.id });
    return deleted.length;
  }

  /* ----------------------------------------------------------------- worker */

  /** True while this process's worker loop is started. */
  get workerRunning(): boolean {
    return Boolean(this.#worker && !this.#worker.stopped);
  }

  /**
   * Starts the polling worker. It sleeps until the next pending job is due
   * (at most `pollMs`), wakes early when this process enqueues an earlier job,
   * and only works while the site is installed. Its timers never keep the
   * process alive on their own.
   */
  start(options: WorkerOptions = {}): void {
    if (this.#worker) return;
    this.#worker = { stopped: false, pollMs: options.pollMs ?? 15_000, wakeAt: Infinity };
    this.#arm(0);
  }

  /**
   * Stops the worker: aborts running jobs' signals and waits for their
   * handlers to return (at most their timeout).
   */
  async stop(): Promise<void> {
    const worker = this.#worker;
    if (!worker) return;
    worker.stopped = true;
    clearTimeout(worker.timer);
    for (const controller of this.#inFlight.values()) {
      controller.abort(new Error('The worker is stopping.'));
    }
    await worker.current?.catch(() => undefined);
    await this.#chain;
    if (this.#worker === worker) this.#worker = undefined;
  }

  #arm(delayMs: number): void {
    const worker = this.#worker;
    if (!worker || worker.stopped) return;
    clearTimeout(worker.timer);
    worker.wakeAt = Date.now() + delayMs;
    worker.timer = setTimeout(() => void this.#tick(worker), delayMs);
    worker.timer.unref?.();
  }

  /** Wakes the worker early when a job is due before its next check. */
  #nudge(runAt: Date): void {
    const worker = this.#worker;
    if (!worker || worker.stopped || worker.current) return;
    const delay = Math.max(0, runAt.getTime() - Date.now());
    if (Date.now() + delay < worker.wakeAt) this.#arm(delay);
  }

  async #tick(worker: WorkerState): Promise<void> {
    if (worker.stopped) return;
    worker.timer = undefined;
    worker.wakeAt = Infinity;
    let delay = worker.pollMs;
    const work = async () => {
      if (this.kernel.state !== 'ready') return;
      await this.runDue();
      const next = await this.nextRunAt();
      if (next) delay = Math.min(delay, Math.max(10, next.getTime() - Date.now()));
    };
    worker.current = work();
    try {
      await worker.current;
    } catch (error) {
      console.error('Pressbase worker:', error);
    } finally {
      worker.current = undefined;
    }
    if (!worker.stopped && this.#worker === worker) this.#arm(delay);
  }
}
