# 0010: A table-backed job queue instead of pg-boss

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

v0.5 needs durable background work: WP-Cron events (scheduled posts, daily clean-up), and jobs that plugins enqueue. The roadmap named [pg-boss](https://github.com/timgit/pg-boss), the established PostgreSQL queue for Node.js.

Pressbase runs on PostgreSQL _and_ on PGlite ([ADR 0002](0002-postgres-drizzle-pglite.md)): trials and every core test use an embedded, single-connection PGlite. Whatever we pick must behave the same on both, and must be testable without a database server.

pg-boss doesn't fit that:

- It opens its own `pg` connection pool from a connection string; PGlite is an in-process object with one connection, so pg-boss can't use it at all.
- It manages its own `pgboss` schema with its own migrations, outside Drizzle's, and polls on its own timers. Trials and tests would need a second code path (or no queue), which is exactly what we want to avoid.
- Its features beyond the basics (pub/sub, throttling, partitioned tables) aren't needed for WP-Cron and simple plugin jobs.

## Decision

Pressbase keeps its jobs in its own `jobs` table (migration `0001_job_queue`), managed by Drizzle like every other table, with a small queue in `apps/core/src/jobs/queue.ts` (`kernel.jobs`):

- One row per job: `name` (the handler), `data` (JSON), `status` (`pending` → `running` → `completed` | `failed`), `run_at`, `priority`, attempts, `max_attempts`, a base backoff, a timeout, an optional `singleton_key` and the last error.
- Workers claim due rows with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, so several core processes on one PostgreSQL database never run a job twice. On PGlite there is one connection and one process, so the same SQL simply runs one job at a time.
- Failed attempts are retried after `backoff × 2^(attempt − 1)` (capped at a day) until `max_attempts`; then the job stays `failed`, with its error, for a week. Completed jobs are kept a day. A daily event prunes them.
- A partial unique index on `singleton_key` (where `status` is `pending` or `running`) gives deduplication.
- Jobs left `running` past their timeout by a process that died are put back (or failed) by the next worker.
- Handlers are registered by name in code (`kernel.jobs.register()`); plugins will register theirs the same way.
- WP-Cron (`kernel.cron`) is built on top: each scheduled event is one `cron` job whose data holds the hook, arguments and recurrence.

## Consequences

- One code path for PostgreSQL and PGlite; tests run the real queue on `pglite:memory`, with an explicit `now`.
- No new dependency and no second schema. The queue is ~500 lines we own and must maintain.
- Polling (every 15 seconds at most, sooner when a job is due) instead of `LISTEN/NOTIFY`. Fine for cron-grade work; a job enqueued by another process may wait up to one poll.
- Throughput is modest by design: a few jobs at a time per process. Heavy workloads (thousands of jobs a minute) would need a dedicated queue; the `kernel.jobs` API can be backed by one later without changing callers.

## Alternatives considered

- **pg-boss:** see Context. It can't run on PGlite and brings its own schema and migrations.
- **Graphile Worker:** same problem: it needs a real `pg` pool and its own schema, and relies on `LISTEN/NOTIFY`.
- **WordPress's model (the `cron` option, run on page views):** a single serialised array rewritten on every change, racy across processes, and events only run when someone visits. We keep WordPress's _API_ (`wp_schedule_event()` and friends) and drop its storage.
- **An in-memory scheduler (`setInterval`):** not durable across restarts and not shared between processes.
