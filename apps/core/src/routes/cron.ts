import { Hono } from 'hono';
import { type AppEnv, requireCapability } from '../http';
import type { Job } from '../jobs/queue';

/**
 * GET /pressbase/v1/cron: what the "Scheduled tasks" screen shows. Scheduled
 * cron events (WordPress's _get_cron_array(), as a list), recent failed jobs
 * and the queue's counts. Read-only; administrators only.
 */
export function cronRoutes() {
  const app = new Hono<AppEnv>();

  app.use(requireCapability('manage_options'));

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const [events, schedules, failed, counts] = await Promise.all([
      kernel.cron.events(200),
      kernel.cron.getSchedules(),
      kernel.jobs.list({ status: 'failed', limit: 20 }),
      kernel.jobs.counts(),
    ]);
    return c.json({
      events: events.map((event) => ({
        hook: event.hook,
        timestamp: event.timestamp,
        schedule: event.schedule,
        interval: event.interval ?? null,
        args: event.args,
      })),
      schedules,
      failed: failed.map(formatFailedJob),
      counts,
      worker: kernel.jobs.workerRunning,
    });
  });

  return app;
}

function formatFailedJob(job: Job) {
  const data = job.data as { hook?: unknown } | null;
  return {
    id: job.id,
    name: job.name,
    hook: job.name === 'cron' && typeof data?.hook === 'string' ? data.hook : null,
    attempts: job.attempts,
    max_attempts: job.maxAttempts,
    // The first line only: stacks stay in the database.
    error: (job.lastError ?? '').split('\n')[0] ?? '',
    finished: job.finishedAt?.toISOString() ?? null,
  };
}
