import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAILY_EVENTS, PUBLISH_FUTURE_POST } from './jobs/core-events';
import { CronError } from './jobs/cron';
import { backoffSeconds } from './jobs/queue';
import { setup } from './test-utils';

async function installed() {
  const ctx = await setup();
  await ctx.install();
  // Run the daily events scheduled at install, so each test starts with a quiet queue.
  await ctx.kernel.jobs.runDue();
  return ctx;
}

const at = (iso: string) => new Date(iso);
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

afterEach(() => {
  vi.useRealTimers();
});

describe('kernel.jobs', () => {
  it('runs due jobs with their data, and leaves later ones pending', async () => {
    const { kernel } = await installed();
    const seen: unknown[] = [];
    kernel.jobs.register('test/echo', (data) => {
      seen.push(data);
    });
    const now = new Date();
    const due = await kernel.jobs.enqueue('test/echo', { n: 1 });
    const later = await kernel.jobs.enqueue(
      'test/echo',
      { n: 2 },
      {
        runAt: new Date(now.getTime() + 60_000),
      },
    );

    expect(await kernel.jobs.runDue({ now })).toEqual({ completed: 1, retried: 0, failed: 0 });
    expect(seen).toEqual([{ n: 1 }]);
    expect((await kernel.jobs.get(due?.id ?? 0))?.status).toBe('completed');
    expect((await kernel.jobs.get(later?.id ?? 0))?.status).toBe('pending');

    await kernel.jobs.runDue({ now: new Date(now.getTime() + 61_000) });
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('runs higher priority first and leaves jobs without a handler alone', async () => {
    const { kernel } = await installed();
    const order: string[] = [];
    kernel.jobs.register<{ name: string }>('test/order', ({ name }) => {
      order.push(name);
    });
    await kernel.jobs.enqueue('test/order', { name: 'low' });
    await kernel.jobs.enqueue('test/order', { name: 'high' }, { priority: 10 });
    const orphan = await kernel.jobs.enqueue('test/nobody', {});
    await kernel.jobs.runDue();
    expect(order).toEqual(['high', 'low']);
    expect((await kernel.jobs.get(orphan?.id ?? 0))?.status).toBe('pending');
  });

  it('retries with exponential backoff, then records the failure', async () => {
    const { kernel } = await installed();
    let calls = 0;
    kernel.jobs.register('test/flaky', () => {
      calls += 1;
      throw new Error('Remote server said no.');
    });
    const failures: boolean[] = [];
    kernel.hooks.addAction('pressbase_job_failed', (_job, _error, retrying) => {
      failures.push(retrying);
    });
    const job = await kernel.jobs.enqueue('test/flaky', {}, { maxAttempts: 3, backoffSeconds: 10 });
    const id = job?.id ?? 0;
    const t0 = new Date();

    expect(await kernel.jobs.runDue({ now: t0 })).toMatchObject({ retried: 1 });
    let row = await kernel.jobs.get(id);
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row?.runAt.getTime()).toBe(t0.getTime() + 10_000);
    expect(row?.lastError).toContain('Remote server said no.');

    // Not before the backoff has passed.
    await kernel.jobs.runDue({ now: new Date(t0.getTime() + 9_000) });
    expect(calls).toBe(1);

    const t1 = new Date(t0.getTime() + 10_000);
    await kernel.jobs.runDue({ now: t1 });
    row = await kernel.jobs.get(id);
    expect(row?.runAt.getTime()).toBe(t1.getTime() + 20_000);

    expect(await kernel.jobs.runDue({ now: new Date(t1.getTime() + 20_000) })).toMatchObject({
      failed: 1,
    });
    row = await kernel.jobs.get(id);
    expect(row).toMatchObject({ status: 'failed', attempts: 3 });
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(calls).toBe(3);
    expect(failures).toEqual([true, true, false]);
    expect((await kernel.jobs.list({ status: 'failed' })).map((j) => j.id)).toEqual([id]);
  });

  it('caps the backoff at a day', () => {
    expect(backoffSeconds(30, 1)).toBe(30);
    expect(backoffSeconds(30, 3)).toBe(120);
    expect(backoffSeconds(30, 30)).toBe(24 * 60 * 60);
  });

  it('times out a job that runs too long and aborts its signal', async () => {
    const { kernel } = await installed();
    let aborted = false;
    kernel.jobs.register('test/slow', (_data, { signal }) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise(() => undefined);
    });
    const job = await kernel.jobs.enqueue('test/slow', {}, { timeoutSeconds: 1, maxAttempts: 1 });
    expect(await kernel.jobs.runDue()).toMatchObject({ failed: 1 });
    expect(aborted).toBe(true);
    expect((await kernel.jobs.get(job?.id ?? 0))?.lastError).toContain('did not finish within 1');
  });

  it('deduplicates by singleton key, or replaces the pending job', async () => {
    const { kernel } = await installed();
    const first = await kernel.jobs.enqueue('test/sync', { v: 1 }, { singletonKey: 'sync' });
    expect(first).not.toBeNull();
    expect(await kernel.jobs.enqueue('test/sync', { v: 2 }, { singletonKey: 'sync' })).toBeNull();
    const replaced = await kernel.jobs.enqueue(
      'test/sync',
      { v: 3 },
      { singletonKey: 'sync', replace: true },
    );
    expect(replaced?.id).toBe(first?.id);
    expect(replaced?.data).toEqual({ v: 3 });

    // Once it has run, the key is free again.
    kernel.jobs.register('test/sync', () => undefined);
    await kernel.jobs.runDue();
    expect(
      await kernel.jobs.enqueue('test/sync', { v: 4 }, { singletonKey: 'sync' }),
    ).not.toBeNull();
  });

  it('requeues jobs abandoned by a dead worker and prunes old finished jobs', async () => {
    const { kernel } = await installed();
    kernel.jobs.register('test/ok', () => undefined);
    const job = await kernel.jobs.enqueue('test/ok', {}, { timeoutSeconds: 10 });
    const id = job?.id ?? 0;
    // Another process claimed it and died.
    const { schema } = await import('@pressbase/db');
    const { eq } = await import('drizzle-orm');
    const t0 = new Date();
    await kernel.db
      .update(schema.jobs)
      .set({ status: 'running', attempts: 1, startedAt: t0, lockedBy: 'gone:1:abc' })
      .where(eq(schema.jobs.id, id));
    await kernel.jobs.runDue({ now: new Date(t0.getTime() + 30_000) });
    expect((await kernel.jobs.get(id))?.status).toBe('running');
    await kernel.jobs.runDue({ now: new Date(t0.getTime() + 80_000) });
    expect(await kernel.jobs.get(id)).toMatchObject({ status: 'completed', attempts: 2 });

    const later = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect(await kernel.jobs.prune(later)).toBeGreaterThan(0);
    expect(await kernel.jobs.get(id)).toBeUndefined();
  });

  it('runs jobs from the polling worker and stops cleanly', async () => {
    const { kernel } = await installed();
    let resolve: () => void = () => undefined;
    const ran = new Promise<void>((r) => {
      resolve = r;
    });
    kernel.jobs.register('test/worker', () => resolve());
    kernel.jobs.start({ pollMs: 50 });
    expect(kernel.jobs.workerRunning).toBe(true);
    await kernel.jobs.enqueue('test/worker', {});
    await ran;
    await kernel.jobs.stop();
    expect(kernel.jobs.workerRunning).toBe(false);
  });
});

describe('kernel.cron', () => {
  it('schedules, finds and unschedules single events, refusing near duplicates', async () => {
    const { kernel } = await installed();
    const ts = Math.floor(Date.now() / 1000) + 3600;
    expect(await kernel.cron.scheduleSingleEvent(ts, 'test_single', [1, 'a'])).toBe(true);
    expect(await kernel.cron.nextScheduled('test_single', [1, 'a'])).toBe(ts);
    expect(await kernel.cron.nextScheduled('test_single', [2])).toBe(false);

    // Within ten minutes of an identical event: a duplicate.
    expect(await kernel.cron.scheduleSingleEvent(ts + 300, 'test_single', [1, 'a'])).toBe(false);
    const error = await kernel.cron.scheduleSingleEvent(ts + 300, 'test_single', [1, 'a'], true);
    expect(error).toBeInstanceOf(CronError);
    expect((error as CronError).code).toBe('duplicate_event');
    // Different arguments are a different event.
    expect(await kernel.cron.scheduleSingleEvent(ts + 300, 'test_single', [2])).toBe(true);

    expect(await kernel.cron.unscheduleEvent(ts, 'test_single', [1, 'a'])).toBe(true);
    expect(await kernel.cron.nextScheduled('test_single', [1, 'a'])).toBe(false);
    expect(await kernel.cron.clearScheduledHook('test_single', [2])).toBe(1);
    expect(await kernel.cron.scheduleSingleEvent(-5, 'test_single')).toBe(false);
  });

  it('fires the hook with its arguments when the event is due', async () => {
    const { kernel } = await installed();
    const calls: unknown[][] = [];
    kernel.hooks.addAction('test_fire', (...args: unknown[]) => {
      calls.push(args);
    });
    const ts = unix('2030-05-01T10:00:00Z');
    await kernel.cron.scheduleSingleEvent(ts, 'test_fire', [42, { x: 1 }]);
    await kernel.jobs.runDue({ now: at('2030-05-01T09:59:59Z') });
    expect(calls).toEqual([]);
    await kernel.jobs.runDue({ now: at('2030-05-01T10:00:00Z') });
    expect(calls).toEqual([[42, { x: 1 }]]);
    expect(await kernel.cron.nextScheduled('test_fire', [42, { x: 1 }])).toBe(false);
  });

  it('reschedules recurring events keeping their phase, with cron_schedules additions', async () => {
    const { kernel } = await installed();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('2030-01-01T00:00:00Z'));
    kernel.hooks.addFilter('cron_schedules', (schedules) => ({
      ...schedules,
      every_five_minutes: { interval: 300, display: 'Every Five Minutes' },
    }));
    expect(Object.keys(await kernel.cron.getSchedules())).toEqual(
      expect.arrayContaining(['hourly', 'twicedaily', 'daily', 'weekly', 'every_five_minutes']),
    );
    expect(await kernel.cron.scheduleEvent(unix('2030-01-01T00:00:00Z'), 'nope', 'test_bad')).toBe(
      false,
    );

    let runs = 0;
    kernel.hooks.addAction('test_hourly', () => {
      runs += 1;
    });
    await kernel.cron.scheduleEvent(unix('2030-01-01T01:00:00Z'), 'hourly', 'test_hourly');
    expect(await kernel.cron.getSchedule('test_hourly')).toBe('hourly');

    // The worker was late by 25 minutes: the next run stays on the hour.
    vi.setSystemTime(at('2030-01-01T01:25:00Z'));
    await kernel.jobs.runDue({ now: new Date() });
    expect(runs).toBe(1);
    expect(await kernel.cron.nextScheduled('test_hourly')).toBe(unix('2030-01-01T02:00:00Z'));

    await kernel.cron.scheduleEvent(
      unix('2030-01-01T01:25:00Z'),
      'every_five_minutes',
      'test_five',
    );
    expect((await kernel.cron.events()).map((e) => e.hook)).toEqual(
      expect.arrayContaining(['test_hourly', 'test_five']),
    );
    expect(await kernel.cron.clearScheduledHook('test_hourly')).toBe(1);
    expect(await kernel.cron.unscheduleHook('test_five')).toBe(1);
  });

  it('lets pre_schedule_event short-circuit scheduling', async () => {
    const { kernel } = await installed();
    kernel.hooks.addFilter('pre_schedule_event', (pre, event) =>
      (event as { hook: string }).hook === 'test_blocked' ? false : pre,
    );
    const ts = Math.floor(Date.now() / 1000) + 60;
    expect(await kernel.cron.scheduleSingleEvent(ts, 'test_blocked')).toBe(false);
    expect(await kernel.cron.nextScheduled('test_blocked')).toBe(false);
  });

  it('schedules the daily core events at install', async () => {
    const { kernel } = await installed();
    for (const hook of DAILY_EVENTS) {
      expect(await kernel.cron.getSchedule(hook)).toBe('daily');
    }
  });
});

describe('publish_future_post', () => {
  it('publishes a scheduled post at its date, follows date changes and trashing', async () => {
    const { kernel, request } = await installed();
    const res = await request('POST', '/wp/v2/posts', {
      title: 'Launch',
      status: 'future',
      date_gmt: '2099-01-01T03:30:00',
    });
    expect(res.body.status).toBe('future');
    const id = res.body.id as number;
    expect(await kernel.cron.nextScheduled(PUBLISH_FUTURE_POST, [id])).toBe(
      unix('2099-01-01T03:30:00Z'),
    );

    // A new date moves the event.
    await request('POST', `/wp/v2/posts/${id}`, { date_gmt: '2099-01-02T03:30:00' });
    expect(await kernel.cron.nextScheduled(PUBLISH_FUTURE_POST, [id])).toBe(
      unix('2099-01-02T03:30:00Z'),
    );
    expect((await kernel.cron.events()).filter((e) => e.hook === PUBLISH_FUTURE_POST)).toHaveLength(
      1,
    );

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('2099-01-02T03:29:59Z'));
    await kernel.jobs.runDue({ now: new Date() });
    expect((await kernel.posts.get(id))?.status).toBe('future');

    const transitions: string[] = [];
    kernel.hooks.addAction('transition_post_status', (newStatus, oldStatus) => {
      transitions.push(`${oldStatus}->${newStatus}`);
    });
    vi.setSystemTime(at('2099-01-02T03:30:00Z'));
    await kernel.jobs.runDue({ now: new Date() });
    expect((await kernel.posts.get(id))?.status).toBe('publish');
    expect(transitions).toEqual(['future->publish']);
    expect(await kernel.cron.nextScheduled(PUBLISH_FUTURE_POST, [id])).toBe(false);
  });

  it('clears the event when a scheduled post is trashed or deleted', async () => {
    const { kernel, request } = await installed();
    const a = await request('POST', '/wp/v2/posts', {
      title: 'A',
      status: 'future',
      date_gmt: '2099-01-01T00:00:00',
    });
    const b = await request('POST', '/wp/v2/posts', {
      title: 'B',
      status: 'future',
      date_gmt: '2099-01-01T00:00:00',
    });
    await request('DELETE', `/wp/v2/posts/${a.body.id}`);
    expect(await kernel.cron.nextScheduled(PUBLISH_FUTURE_POST, [a.body.id])).toBe(false);
    await request('DELETE', `/wp/v2/posts/${b.body.id}?force=true`);
    expect(await kernel.cron.nextScheduled(PUBLISH_FUTURE_POST, [b.body.id])).toBe(false);
  });

  it('keeps publishDue() as a safety net when the event is missing', async () => {
    const { kernel, request } = await installed();
    const res = await request('POST', '/wp/v2/posts', {
      title: 'Lost event',
      status: 'future',
      date_gmt: '2099-01-01T00:00:00',
    });
    await kernel.cron.clearScheduledHook(PUBLISH_FUTURE_POST, [res.body.id]);
    await kernel.posts.publishDue(at('2099-01-01T00:00:01Z'));
    expect((await kernel.posts.get(res.body.id))?.status).toBe('publish');
  });
});

describe('GET /pressbase/v1/cron', () => {
  it('lists scheduled events and failed jobs for administrators only', async () => {
    const { kernel, request, loginAs } = await installed();
    kernel.jobs.register('test/broken', () => {
      throw new Error('Broken on purpose.');
    });
    await kernel.jobs.enqueue('test/broken', {}, { maxAttempts: 1 });
    await kernel.jobs.runDue();

    const res = await request('GET', '/pressbase/v1/cron');
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { hook: string }) => e.hook)).toEqual(
      expect.arrayContaining([...DAILY_EVENTS]),
    );
    expect(res.body.schedules.daily.interval).toBe(86400);
    expect(res.body.failed[0]).toMatchObject({
      name: 'test/broken',
      attempts: 1,
      error: 'Error: Broken on purpose.',
    });

    const editor = await loginAs('ed', 'editor');
    expect((await editor.request('GET', '/pressbase/v1/cron')).status).toBe(403);
  });
});
