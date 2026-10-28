import { createHash } from 'node:crypto';
import { schema } from '@pressbase/db';
import { and, asc, between, eq, or, type SQL, sql } from 'drizzle-orm';
import type { Kernel } from '../kernel';
import type { Job, JobContext } from './queue';

/**
 * WP-Cron on the job queue — a port of wordpress/wp-includes/cron.php
 * (wp_schedule_event, wp_schedule_single_event, wp_reschedule_event,
 * wp_unschedule_event, wp_clear_scheduled_hook, wp_unschedule_hook,
 * wp_get_scheduled_event, wp_next_scheduled, wp_get_schedules, wp_get_schedule)
 * and of wp-cron.php's runner.
 *
 * Each scheduled event is one `cron` job whose run time is the event's
 * timestamp. When it runs, a recurring event first schedules its next
 * occurrence (wp_reschedule_event), then the event's action fires with its
 * arguments: `do_action_ref_array( $hook, $args )`.
 *
 * Same semantics as WordPress: timestamps are Unix seconds (a Date works too);
 * events are identified by hook + timestamp + arguments (compared as JSON, where
 * WordPress compares md5(serialize($args))); a single event within ten minutes
 * of an identical one is a duplicate; the `pre_*` filters short-circuit. Unlike
 * wp-cron, events run on time from the worker, not on the next page view, and
 * cron jobs aren't retried: a failure is recorded and the next occurrence of a
 * recurring event still runs.
 */

export const CRON_JOB = 'cron';

/**
 * The job name of a plugin's cron events (`cron:{slug}`). They are stored
 * and listed like core's, but run only while the plugin's runner is
 * registered: a deactivated plugin's events wait, pending, until it is
 * activated again (see docs/architecture/jobs.md#plugins).
 */
export function pluginCronJob(slug: string): string {
  return `${CRON_JOB}:${slug}`;
}

export interface CronOptions {
  /** A plugin's slug: its events are `cron:{slug}` jobs and its queries see only them. */
  owner?: string;
}

/** wp_schedule_*()'s event object. */
export interface CronEvent {
  hook: string;
  /** Unix timestamp, in seconds. */
  timestamp: number;
  /** The recurrence (`hourly`, `daily`…), or false for a single event. */
  schedule: string | false;
  args: unknown[];
  /** Seconds between runs, for recurring events. */
  interval?: number;
}

/** One entry of wp_get_schedules(). */
export interface CronSchedule {
  interval: number;
  display: string;
}

/** The data of a `cron` job. */
export interface CronJobData extends CronEvent {
  /** md5 of the JSON-encoded arguments (WordPress's md5(serialize($args))). */
  key: string;
}

/** WP_Error for the cron functions, returned when `wpError` is true. */
export class CronError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CronError';
  }
}

/** What the scheduling functions return: WordPress's `bool|WP_Error`. */
type Outcome<E extends boolean, T> = E extends true ? T | CronError : T | false;

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    cron_schedules: [schedules: Record<string, CronSchedule>];
    /** Return non-null to short-circuit scheduling: true, false or a CronError. */
    pre_schedule_event: [pre: unknown, event: CronEvent, wpError: boolean];
    /** Change the event, or return false to refuse it. */
    schedule_event: [event: CronEvent | false];
    pre_reschedule_event: [pre: unknown, event: CronEvent, wpError: boolean];
    pre_unschedule_event: [
      pre: unknown,
      timestamp: number,
      hook: string,
      args: unknown[],
      wpError: boolean,
    ];
    pre_clear_scheduled_hook: [pre: unknown, hook: string, args: unknown[], wpError: boolean];
    pre_unschedule_hook: [pre: unknown, hook: string, wpError: boolean];
    pre_get_scheduled_event: [
      pre: unknown,
      hook: string,
      args: unknown[],
      timestamp: number | undefined,
    ];
    wp_next_scheduled: [timestamp: number, event: CronEvent, hook: string, args: unknown[]];
    get_schedule: [schedule: string | false, hook: string, args: unknown[]];
  }
  interface ActionRegistry {
    cron_reschedule_event_error: [error: CronError, hook: string, event: CronJobData];
  }
}

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/** wp_get_schedules()'s built-in recurrences. */
export const CORE_SCHEDULES: Record<string, CronSchedule> = {
  hourly: { interval: HOUR, display: 'Once Hourly' },
  twicedaily: { interval: 12 * HOUR, display: 'Twice Daily' },
  daily: { interval: DAY, display: 'Once Daily' },
  weekly: { interval: 7 * DAY, display: 'Once Weekly' },
};

/** Ten minutes: identical single events closer than this are duplicates. */
const DUPLICATE_WINDOW = 10 * 60;

export function cronArgsKey(args: unknown[]): string {
  return createHash('md5')
    .update(JSON.stringify(args ?? []))
    .digest('hex');
}

const seconds = (timestamp: number | Date): number =>
  timestamp instanceof Date ? Math.floor(timestamp.getTime() / 1000) : timestamp;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const validTimestamp = (t: number) => Number.isFinite(t) && t > 0;
const singletonKey = (hook: string, key: string, timestamp: number) =>
  `cron:${hook}:${key}:${timestamp}`;

export class Cron {
  /** The job name events are stored under: `cron`, or `cron:{slug}` for a plugin. */
  readonly jobName: string;
  readonly #owner: string | undefined;

  constructor(
    private readonly kernel: Kernel,
    options: CronOptions = {},
  ) {
    this.#owner = options.owner;
    this.jobName = options.owner ? pluginCronJob(options.owner) : CRON_JOB;
    // Core's runner is always there; a plugin's is registered while it is loaded.
    if (!options.owner) this.registerRunner();
  }

  /** Registers the handler that runs this instance's events. Returns a function that removes it. */
  registerRunner(): () => void {
    return this.kernel.jobs.register<CronJobData>(
      this.jobName,
      (data, context) => this.#run(data, context),
      { maxAttempts: 1 },
    );
  }

  /** Core's cron sees every event, plugins' included; a plugin's sees only its own. */
  #names(): SQL {
    const name = schema.jobs.name;
    if (this.#owner) return eq(name, this.jobName);
    return or(eq(name, CRON_JOB), sql`left(${name}, 5) = 'cron:'`) as SQL;
  }

  /** wp_get_schedules(): the `cron_schedules` filter's additions, then the built-in ones. */
  async getSchedules(): Promise<Record<string, CronSchedule>> {
    const extra = await this.kernel.hooks.applyFilters('cron_schedules', {});
    return { ...extra, ...CORE_SCHEDULES };
  }

  /** wp_schedule_single_event(): run `hook` once at `timestamp`. */
  async scheduleSingleEvent<E extends boolean = false>(
    timestamp: number | Date,
    hook: string,
    args: unknown[] = [],
    wpError?: E,
  ): Promise<Outcome<E, true>> {
    const ts = seconds(timestamp);
    if (!validTimestamp(ts)) {
      return this.#error<E, true>(
        wpError,
        'invalid_timestamp',
        'Event timestamp must be a valid Unix timestamp.',
      );
    }
    const event: CronEvent = { hook, timestamp: ts, schedule: false, args };
    const pre = await this.kernel.hooks.applyFilters(
      'pre_schedule_event',
      null,
      event,
      Boolean(wpError),
    );
    if (pre !== null && pre !== undefined) {
      return this.#pre<E, true>(
        pre,
        wpError,
        'pre_schedule_event_false',
        'A plugin prevented the event from being scheduled.',
      );
    }

    // Don't schedule an event identical to one within ten minutes of it.
    const now = nowSeconds();
    const min = ts < now + DUPLICATE_WINDOW ? 0 : ts - DUPLICATE_WINDOW;
    const max = ts < now ? now + DUPLICATE_WINDOW : ts + DUPLICATE_WINDOW;
    const [duplicate] = await this.#select(
      this.#match(hook, cronArgsKey(args)),
      between(schema.jobs.runAt, new Date(min * 1000), new Date(max * 1000)),
    ).limit(1);
    if (duplicate)
      return this.#error<E, true>(wpError, 'duplicate_event', 'A duplicate event already exists.');

    return this.#store(await this.kernel.hooks.applyFilters('schedule_event', event), wpError);
  }

  /** wp_schedule_event(): run `hook` at `timestamp`, then every `recurrence`. */
  async scheduleEvent<E extends boolean = false>(
    timestamp: number | Date,
    recurrence: string,
    hook: string,
    args: unknown[] = [],
    wpError?: E,
  ): Promise<Outcome<E, true>> {
    const ts = seconds(timestamp);
    if (!validTimestamp(ts)) {
      return this.#error<E, true>(
        wpError,
        'invalid_timestamp',
        'Event timestamp must be a valid Unix timestamp.',
      );
    }
    const schedule = (await this.getSchedules())[recurrence];
    if (!schedule)
      return this.#error<E, true>(wpError, 'invalid_schedule', 'Event schedule does not exist.');
    const event: CronEvent = {
      hook,
      timestamp: ts,
      schedule: recurrence,
      args,
      interval: schedule.interval,
    };
    const pre = await this.kernel.hooks.applyFilters(
      'pre_schedule_event',
      null,
      event,
      Boolean(wpError),
    );
    if (pre !== null && pre !== undefined) {
      return this.#pre<E, true>(
        pre,
        wpError,
        'pre_schedule_event_false',
        'A plugin prevented the event from being scheduled.',
      );
    }
    return this.#store(await this.kernel.hooks.applyFilters('schedule_event', event), wpError);
  }

  /**
   * wp_reschedule_event(): schedules the next occurrence of a recurring event
   * that was due at `timestamp`, keeping its phase (now + what's left of the interval).
   */
  async rescheduleEvent<E extends boolean = false>(
    timestamp: number | Date,
    recurrence: string,
    hook: string,
    args: unknown[] = [],
    wpError?: E,
  ): Promise<Outcome<E, true>> {
    return this.#reschedule(seconds(timestamp), recurrence, hook, args, undefined, wpError);
  }

  async #reschedule<E extends boolean>(
    ts: number,
    recurrence: string,
    hook: string,
    args: unknown[],
    savedInterval: number | undefined,
    wpError?: E,
  ): Promise<Outcome<E, true>> {
    if (!validTimestamp(ts)) {
      return this.#error<E, true>(
        wpError,
        'invalid_timestamp',
        'Event timestamp must be a valid Unix timestamp.',
      );
    }
    // The schedule's interval, or the one saved with the event if the schedule is gone.
    let interval = (await this.getSchedules())[recurrence]?.interval ?? 0;
    if (!interval) {
      interval =
        savedInterval ??
        ((await this.getScheduledEvent(hook, args, ts)) || undefined)?.interval ??
        0;
    }
    const event: CronEvent = { hook, timestamp: ts, schedule: recurrence, args, interval };
    const pre = await this.kernel.hooks.applyFilters(
      'pre_reschedule_event',
      null,
      event,
      Boolean(wpError),
    );
    if (pre !== null && pre !== undefined) {
      return this.#pre<E, true>(
        pre,
        wpError,
        'pre_reschedule_event_false',
        'A plugin prevented the event from being rescheduled.',
      );
    }
    if (!interval)
      return this.#error<E, true>(wpError, 'invalid_schedule', 'Event schedule does not exist.');
    const now = nowSeconds();
    const next = ts >= now ? now + interval : now + (interval - ((now - ts) % interval));
    return this.scheduleEvent(next, recurrence, hook, args, wpError);
  }

  /** wp_unschedule_event(): removes one occurrence, identified by time, hook and arguments. */
  async unscheduleEvent<E extends boolean = false>(
    timestamp: number | Date,
    hook: string,
    args: unknown[] = [],
    wpError?: E,
  ): Promise<Outcome<E, true>> {
    const ts = seconds(timestamp);
    if (!validTimestamp(ts)) {
      return this.#error<E, true>(
        wpError,
        'invalid_timestamp',
        'Event timestamp must be a valid Unix timestamp.',
      );
    }
    const pre = await this.kernel.hooks.applyFilters(
      'pre_unschedule_event',
      null,
      ts,
      hook,
      args,
      Boolean(wpError),
    );
    if (pre !== null && pre !== undefined) {
      return this.#pre<E, true>(
        pre,
        wpError,
        'pre_unschedule_event_false',
        'A plugin prevented the event from being unscheduled.',
      );
    }
    await this.kernel.db
      .delete(schema.jobs)
      .where(
        and(
          this.#names(),
          eq(schema.jobs.status, 'pending'),
          eq(schema.jobs.singletonKey, singletonKey(hook, cronArgsKey(args), ts)),
        ),
      );
    return true as Outcome<E, true>;
  }

  /**
   * wp_clear_scheduled_hook(): removes every occurrence of `hook` with exactly
   * these arguments. Returns how many were removed.
   */
  async clearScheduledHook<E extends boolean = false>(
    hook: string,
    args: unknown[] = [],
    wpError?: E,
  ): Promise<Outcome<E, number>> {
    const pre = await this.kernel.hooks.applyFilters(
      'pre_clear_scheduled_hook',
      null,
      hook,
      args,
      Boolean(wpError),
    );
    if (pre !== null && pre !== undefined) {
      return this.#pre<E, number>(
        pre,
        wpError,
        'pre_clear_scheduled_hook_false',
        'A plugin prevented the hook from being cleared.',
      );
    }
    return (await this.#delete(this.#match(hook, cronArgsKey(args)))) as Outcome<E, number>;
  }

  /** wp_unschedule_hook(): removes every occurrence of `hook`, whatever its arguments. */
  async unscheduleHook<E extends boolean = false>(
    hook: string,
    wpError?: E,
  ): Promise<Outcome<E, number>> {
    const pre = await this.kernel.hooks.applyFilters(
      'pre_unschedule_hook',
      null,
      hook,
      Boolean(wpError),
    );
    if (pre !== null && pre !== undefined) {
      return this.#pre<E, number>(
        pre,
        wpError,
        'pre_unschedule_hook_false',
        'A plugin prevented the hook from being cleared.',
      );
    }
    return (await this.#delete(this.#match(hook))) as Outcome<E, number>;
  }

  /**
   * wp_get_scheduled_event(): the event at `timestamp`, or the next one when
   * no timestamp is given. False when there is none.
   */
  async getScheduledEvent(
    hook: string,
    args: unknown[] = [],
    timestamp?: number | Date,
  ): Promise<CronEvent | false> {
    const ts = timestamp === undefined ? undefined : seconds(timestamp);
    const pre = await this.kernel.hooks.applyFilters(
      'pre_get_scheduled_event',
      null,
      hook,
      args,
      ts,
    );
    if (pre !== null && pre !== undefined) return pre as CronEvent | false;
    if (ts !== undefined && !validTimestamp(ts)) return false;
    const key = cronArgsKey(args);
    const [job] = await this.#select(
      this.#match(hook, key),
      ts !== undefined ? eq(schema.jobs.singletonKey, singletonKey(hook, key, ts)) : undefined,
    ).limit(1);
    return job ? toEvent(job) : false;
  }

  /** wp_next_scheduled(): the Unix timestamp of the next occurrence, or false. */
  async nextScheduled(hook: string, args: unknown[] = []): Promise<number | false> {
    const event = await this.getScheduledEvent(hook, args);
    if (!event) return false;
    return this.kernel.hooks.applyFilters('wp_next_scheduled', event.timestamp, event, hook, args);
  }

  /** wp_get_schedule(): the recurrence of the next occurrence, or false. */
  async getSchedule(hook: string, args: unknown[] = []): Promise<string | false> {
    const event = await this.getScheduledEvent(hook, args);
    return this.kernel.hooks.applyFilters(
      'get_schedule',
      event ? event.schedule : false,
      hook,
      args,
    );
  }

  /** Every scheduled event, soonest first (WordPress's _get_cron_array(), flattened). */
  async events(limit = 500): Promise<CronEvent[]> {
    return (await this.#select().limit(limit)).map(toEvent);
  }

  /* ------------------------------------------------------------- internals */

  /** wp-cron.php for one event: reschedule a recurring event, then fire its action. */
  async #run(data: CronJobData, _context: JobContext): Promise<void> {
    const args = Array.isArray(data.args) ? data.args : [];
    if (data.schedule) {
      const result = await this.#reschedule(
        data.timestamp,
        data.schedule,
        data.hook,
        args,
        data.interval,
        true,
      );
      if (result instanceof CronError) {
        console.error(
          `Cron reschedule event error for hook: ${data.hook}, Error code: ${result.code}, Error message: ${result.message}`,
        );
        await this.kernel.hooks.doAction('cron_reschedule_event_error', result, data.hook, data);
      }
    }
    await this.kernel.hooks.doAction(data.hook, ...args);
  }

  async #store<E extends boolean>(
    event: CronEvent | false,
    wpError: E | undefined,
  ): Promise<Outcome<E, true>> {
    if (!event)
      return this.#error<E, true>(
        wpError,
        'schedule_event_false',
        'A plugin disallowed this event.',
      );
    const key = cronArgsKey(event.args);
    const data: CronJobData = {
      hook: event.hook,
      timestamp: event.timestamp,
      schedule: event.schedule,
      args: event.args,
      key,
      ...(event.interval ? { interval: event.interval } : {}),
    };
    // Same hook, arguments and time replace the stored event, as in WordPress's cron array.
    await this.kernel.jobs.enqueue(this.jobName, data, {
      runAt: new Date(event.timestamp * 1000),
      singletonKey: singletonKey(event.hook, key, event.timestamp),
      replace: true,
      maxAttempts: 1,
    });
    return true as Outcome<E, true>;
  }

  /** Pending cron jobs for a hook (and arguments). */
  #match(hook: string, key?: string): SQL {
    const data = schema.jobs.data;
    return and(
      sql`(${data} ->> 'hook') = ${hook}`,
      key === undefined ? undefined : sql`(${data} ->> 'key') = ${key}`,
    ) as SQL;
  }

  #select(...conditions: (SQL | undefined)[]) {
    return this.kernel.db
      .select()
      .from(schema.jobs)
      .where(and(this.#names(), eq(schema.jobs.status, 'pending'), ...conditions))
      .orderBy(asc(schema.jobs.runAt), asc(schema.jobs.id))
      .$dynamic();
  }

  async #delete(condition: SQL): Promise<number> {
    const deleted = await this.kernel.db
      .delete(schema.jobs)
      .where(and(this.#names(), eq(schema.jobs.status, 'pending'), condition))
      .returning({ id: schema.jobs.id });
    return deleted.length;
  }

  #error<E extends boolean, T>(
    wpError: E | undefined,
    code: string,
    message: string,
  ): Outcome<E, T> {
    return (wpError ? new CronError(code, message) : false) as Outcome<E, T>;
  }

  /** The pre_* filters' short-circuit rules. */
  #pre<E extends boolean, T>(
    pre: unknown,
    wpError: E | undefined,
    code: string,
    message: string,
  ): Outcome<E, T> {
    if (wpError && pre === false) return new CronError(code, message) as Outcome<E, T>;
    if (!wpError && pre instanceof Error) return false as Outcome<E, T>;
    return pre as Outcome<E, T>;
  }
}

function toEvent(job: Job): CronEvent {
  const data = job.data as CronJobData;
  return {
    hook: data.hook,
    timestamp: data.timestamp,
    schedule: data.schedule ?? false,
    args: Array.isArray(data.args) ? data.args : [],
    ...(data.interval ? { interval: data.interval } : {}),
  };
}
