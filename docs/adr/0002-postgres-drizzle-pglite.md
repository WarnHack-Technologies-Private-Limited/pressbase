# 0002: PostgreSQL only, Drizzle ORM, PGlite for trials and tests

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

WordPress is tied to MySQL and stores PHP-serialized blobs. We want a modern, queryable database that's also easy to try, and tests that need no database server.

## Decision

- **PostgreSQL 14+ is the only supported database.** We use its features freely: `jsonb`, `timestamptz`, expression indexes, and full-text search later.
- **Drizzle ORM** for typed queries and SQL migrations generated from `schema.ts`.
- **PGlite** (PostgreSQL compiled to WASM) through the same `connect()`:
  - `pglite:<dir>` for "try it" installs;
  - `pglite:memory` for tests.
- Keep WordPress's table model, with the changes in [database.md](../architecture/database.md).

## Consequences

- Tests run real PostgreSQL SQL with no Docker.
- Anyone can install Pressbase with zero services.
- PGlite is single-process and slower to boot (a few seconds), so it's labelled "not for live sites" in the UI.
- Supporting MySQL later would be a large change. That's deliberate.

## Alternatives considered

- **Prisma:** heavier runtime and less control over SQL; no PGlite driver at the time.
- **Kysely:** a good query builder, but no schema-to-migration generation.
- **SQLite for trials:** a second SQL dialect to support and test.
