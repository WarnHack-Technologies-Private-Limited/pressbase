# Jobs and cron

Pressbase runs background work from a job queue stored in PostgreSQL, and puts WordPress's cron API on top of it. Why not pg-boss: [ADR 0010](../adr/0010-job-queue.md).

| Piece | Where | WordPress |
| ----- | ----- | --------- |
| `kernel.jobs` (queue, worker) | `apps/core/src/jobs/queue.ts` | — |
| `kernel.cron` | `apps/core/src/jobs/cron.ts` | `wp-includes/cron.php`, `wp-cron.php` |
| Core events | `apps/core/src/jobs/core-events.ts` | `_future_post_hook()`, `check_and_publish_future_post()` |
| `GET /pressbase/v1/cron` | `apps/core/src/routes/cron.ts` | — (WP Crontrol, as a plugin) |
| Settings → Scheduled tasks | `apps/admin/src/components/settings/scheduled-tasks.tsx` | — |

## The queue: `kernel.jobs`

```ts
kernel.jobs.register('my-plugin/sync', async (data, { attempt, signal }) => {
  await fetch(data.url, { signal });
}, { maxAttempts: 5, backoffSeconds: 60, timeoutSeconds: 120 });

await kernel.jobs.enqueue('my-plugin/sync', { url: 'https://example.com' }, {
  runAt: new Date(Date.now() + 60_000), // default: now
  singletonKey: 'sync:example.com',     // at most one pending or running job per key
  priority: 10,                         // higher first among due jobs
});
```

- **Storage.** One row per job in the `jobs` table: `pending` → `running` → `completed` or `failed`.
- **Handlers** are registered by name, in code, in every process that should run them. A job whose handler isn't registered stays `pending`.
- **Retries.** A handler that throws (or times out) is retried after `backoffSeconds × 2^(attempt − 1)`, capped at a day, until `maxAttempts` (default 3). The last error is kept in `last_error`; each failure fires `pressbase_job_failed` (`job, error, retrying`).
- **Timeouts.** After `timeoutSeconds` (default 300) the attempt fails and the handler's `signal` is aborted. A job left `running` by a process that died is retried (or failed) once its timeout plus a minute has passed.
- **Deduplication.** With a `singletonKey`, `enqueue()` returns `null` while a job with that key is pending or running. `replace: true` updates the pending job's data and time instead.
- **Several processes.** Workers claim jobs with `FOR UPDATE SKIP LOCKED`, so any number of core processes can share one PostgreSQL database. On PGlite, jobs run one at a time.
- **Retention.** Completed jobs are kept a day and failed jobs a week (`kernel.jobs.retention`); the daily `pressbase_prune_jobs` event deletes older ones.
- **Other methods:** `get(id)`, `cancel(id)` (pending only), `list({ status, name })`, `counts()`, `prune(now)`.

### The worker

`apps/core/src/server.ts` calls `kernel.jobs.start()` at boot. The worker sleeps until the next job is due (at most 15 seconds), wakes early when this process enqueues an earlier one, and does nothing until the site is installed. `kernel.shutdown()` (on `SIGINT`/`SIGTERM`) stops it: running handlers' signals are aborted and awaited.

Set `PRESSBASE_WORKER=off` to run a core process without a worker, for example when another process sharing the database runs it. Without any worker, events don't run; scheduled posts still go live lazily (see below).

Tests don't start the worker. They call `kernel.jobs.runDue({ now })`, which runs every due job and returns `{ completed, retried, failed }`. Its timers never keep a process alive.

## Cron: `kernel.cron`

A port of `wp-includes/cron.php`. Timestamps are Unix seconds (a `Date` works too); results are WordPress's: `true`, `false`, or a `CronError` (WordPress's `WP_Error`) when the last argument is `true`.

```ts
await kernel.cron.scheduleEvent(Date.now() / 1000, 'daily', 'my_plugin_cleanup', [42]);
await kernel.cron.scheduleSingleEvent(timestamp, 'my_plugin_reminder', [userId]);
await kernel.cron.nextScheduled('my_plugin_cleanup', [42]);       // timestamp or false
await kernel.cron.unscheduleEvent(timestamp, 'my_plugin_reminder', [userId]);
await kernel.cron.clearScheduledHook('my_plugin_cleanup', [42]);  // how many were removed
kernel.hooks.addAction('my_plugin_cleanup', async (id) => { /* … */ });
```

Also `rescheduleEvent`, `unscheduleHook`, `getScheduledEvent`, `getSchedule`, `getSchedules` and `events()`.

- **Running an event** fires its hook as an action with its arguments (`do_action_ref_array( $hook, $args )`). A recurring event first schedules its next run, keeping its phase: an hourly event due at 01:00 that ran at 01:25 next runs at 02:00.
- **Schedules:** `hourly`, `twicedaily`, `daily`, `weekly`, plus whatever the `cron_schedules` filter adds (`{ name: { interval, display } }`).
- **Identity.** An event is its hook, time and arguments. Scheduling the same three again replaces it. A single event within ten minutes of an identical one is refused (`duplicate_event`), as in WordPress.
- **Filters:** `pre_schedule_event`, `schedule_event`, `pre_reschedule_event`, `pre_unschedule_event`, `pre_clear_scheduled_hook`, `pre_unschedule_hook`, `pre_get_scheduled_event`, `wp_next_scheduled`, `get_schedule`, `cron_schedules`; the `cron_reschedule_event_error` action.
- **Differences from WordPress.** Events are rows in `jobs` (name `cron`), not the `cron` option. They run on time from the worker, not on the next page view. They aren't retried: a failure is recorded (Settings → Scheduled tasks shows it) and a recurring event still runs next time.

## Core events

| Hook | When | Does |
| ---- | ---- | ---- |
| `publish_future_post` | once per scheduled post, at its date | Publishes it (`check_and_publish_future_post()`). Scheduled when a `future` post is saved, moved when its date changes, cleared when it leaves `future` or is deleted. |
| `pressbase_delete_expired_sessions` | daily | Deletes expired login sessions. |
| `pressbase_prune_jobs` | daily | Deletes finished jobs older than the retention. |

The daily events are scheduled on `init` when missing, at midnight UTC. `init` also schedules events for `future` posts that lack one (posts scheduled before the queue existed). `kernel.posts.publishDue()` still runs before content queries as a safety net, so a scheduled post is never late when no worker is running. See [Content](content.md#scheduling).

## REST and admin

`GET /pressbase/v1/cron` (`manage_options`) returns `events` (hook, timestamp, schedule, interval, args; soonest first), `schedules`, the 20 most recent `failed` jobs (name, hook, attempts, first line of the error, finish time), `counts` per status and whether this process runs a `worker`. Settings → Scheduled tasks shows it, read-only.
