import { CRON_JOB } from '@pressbase/core/src/jobs/cron';
import { schema } from '@pressbase/db';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { CommandSpec } from '../command';
import { gmtDate, plural } from './shared';

/**
 * `pressbase cron`: wp-cli's cron-command, on kernel.cron (WP-Cron on
 * Pressbase's job queue). Events normally run on time in the server's job
 * worker; `cron event run` runs them now, in this process.
 */

const CAP = 'manage_options';

function relative(seconds: number): string {
  const abs = Math.abs(seconds);
  const parts: string[] = [];
  const units: [number, string][] = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ];
  let rest = abs;
  for (const [size, name] of units) {
    const n = Math.floor(rest / size);
    if (n) parts.push(plural(n, name));
    rest -= n * size;
    if (parts.length === 2) break;
  }
  const text = parts.join(' ') || 'now';
  return seconds < 0 ? `${text} ago` : text;
}

export const cronCommands: CommandSpec[] = [
  {
    name: 'cron event list',
    shortdesc: 'Lists scheduled cron events.',
    synopsis: '[--hook=<hook>] [--fields=<fields>] [--field=<field>] [--format=<format>]',
    options: { hook: 'Only events of this hook.' },
    examples: [['pressbase cron event list --fields=hook,next_run_relative', 'When each event runs next']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(CAP, undefined, `${ctx.user?.login} isn’t allowed to manage scheduled tasks.`);
      const hook = ctx.string('hook');
      const now = Math.floor(Date.now() / 1000);
      const events = (await ctx.kernel.cron.events(10_000)).filter((e) => !hook || e.hook === hook);
      ctx.formatItems(
        events.map((e) => ({
          hook: e.hook,
          next_run_gmt: gmtDate(new Date(e.timestamp * 1000)),
          next_run_relative: relative(e.timestamp - now),
          recurrence: e.schedule ? relative(e.interval ?? 0) : 'Non-repeating',
          schedule: e.schedule || '',
          interval: e.interval ?? '',
          timestamp: e.timestamp,
          args: e.args,
        })),
        ['hook', 'next_run_gmt', 'next_run_relative', 'recurrence'],
        {
          all: ['hook', 'next_run_gmt', 'next_run_relative', 'recurrence', 'schedule', 'interval', 'timestamp', 'args'],
          idField: 'hook',
        },
      );
    },
  },
  {
    name: 'cron event run',
    shortdesc: 'Runs scheduled events now.',
    synopsis: '[<hook>...] [--due-now] [--all]',
    options: {
      hook: 'Run the next event of each of these hooks.',
      'due-now': 'Run every event that is due.',
      all: 'Run every scheduled event.',
    },
    longdesc:
      'A recurring event is rescheduled first, keeping its schedule; a single event leaves the queue. The hooks’ callbacks run in this process, with this site’s active plugins loaded.',
    examples: [
      ['pressbase cron event run pressbase_prune_jobs', 'Run one event now'],
      ['pressbase cron event run --due-now', 'Catch up on overdue events'],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(CAP, undefined, `${ctx.user?.login} isn’t allowed to run scheduled tasks.`);
      const now = Math.floor(Date.now() / 1000);
      let targets: { hook: string; args?: unknown[] }[];
      if (ctx.flag('due-now') || ctx.flag('all')) {
        const events = await ctx.kernel.cron.events(10_000);
        targets = events
          .filter((e) => ctx.flag('all') || e.timestamp <= now)
          .map((e) => ({ hook: e.hook, args: e.args }));
      } else {
        if (!ctx.args.length) ctx.error('Give the hooks to run, or --due-now or --all.');
        targets = ctx.args.map((hook) => ({ hook }));
      }
      let ran = 0;
      let missing = 0;
      for (const target of targets) {
        const started = performance.now();
        const event = await ctx.kernel.cron.runNow(target.hook, target.args);
        if (!event) {
          ctx.warning(`No event of '${target.hook}' is scheduled.`);
          missing += 1;
          continue;
        }
        ran += 1;
        ctx.log(`Executed the cron event '${event.hook}' in ${((performance.now() - started) / 1000).toFixed(3)}s.`);
      }
      if (missing && !ran) ctx.error(`No events ran.`);
      ctx.success(`Executed a total of ${plural(ran, 'cron event')}.`);
    },
  },
  {
    name: 'cron event delete',
    shortdesc: 'Unschedules every event of these hooks.',
    synopsis: '<hook>...',
    options: { hook: 'The hooks.' },
    examples: [['pressbase cron event delete reading_time_cleanup', 'Unschedule a plugin’s event']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(CAP, undefined, `${ctx.user?.login} isn’t allowed to manage scheduled tasks.`);
      let total = 0;
      for (const hook of ctx.args) {
        const n = await ctx.kernel.cron.unscheduleHook(hook);
        if (!n) ctx.warning(`No event of '${hook}' is scheduled.`);
        total += Number(n) || 0;
      }
      if (!total) ctx.error('No events were deleted.');
      ctx.success(`Deleted a total of ${plural(total, 'cron event')}.`);
    },
  },
  {
    name: 'cron schedule list',
    shortdesc: 'Lists the recurrences events can use (hourly, daily…).',
    synopsis: '[--fields=<fields>] [--field=<field>] [--format=<format>]',
    examples: [['pressbase cron schedule list', 'List the schedules']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(CAP, undefined, `${ctx.user?.login} isn’t allowed to manage scheduled tasks.`);
      const schedules = await ctx.kernel.cron.getSchedules();
      ctx.formatItems(
        Object.entries(schedules)
          .map(([name, s]) => ({ name, display: s.display, interval: s.interval }))
          .sort((a, b) => a.interval - b.interval),
        ['name', 'display', 'interval'],
        { idField: 'name' },
      );
    },
  },
  {
    name: 'cron test',
    shortdesc: 'Checks that scheduled events are running on time.',
    longdesc:
      'wp-cli tests that WordPress can spawn wp-cron.php. Pressbase runs events from the job worker in the server instead, so this checks for events that are overdue by more than ten minutes, which means no worker is running, and for recent failures.',
    examples: [['pressbase cron test', 'Check the worker']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(CAP, undefined, `${ctx.user?.login} isn’t allowed to manage scheduled tasks.`);
      const { jobs } = schema;
      const cronJobs = or(eq(jobs.name, CRON_JOB), sql`left(${jobs.name}, 5) = 'cron:'`);
      const [overdue] = await ctx.kernel.db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(jobs)
        .where(
          and(cronJobs, eq(jobs.status, 'pending'), lt(jobs.runAt, new Date(Date.now() - 10 * 60_000))),
        );
      const failed = await ctx.kernel.jobs.list({ status: 'failed', limit: 5 });
      for (const job of failed) {
        ctx.warning(`Job ${job.id} (${job.name}) failed: ${(job.lastError ?? '').split('\n')[0]}`);
      }
      if (overdue?.n) {
        ctx.error(
          `${plural(overdue.n, 'scheduled event')} ${overdue.n === 1 ? 'is' : 'are'} more than ten minutes late. Check that a Pressbase server is running with its job worker on (PRESSBASE_WORKER isn’t off), or run “pressbase cron event run --due-now”.`,
        );
      }
      ctx.success('Scheduled events are running on time.');
    },
  },
];
