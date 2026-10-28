import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export { schema };

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type Driver = 'postgres' | 'pglite';

export interface DatabaseConnection {
  db: Database;
  driver: Driver;
  /** Applies any migrations that have not run yet. Safe to call on every boot. */
  migrate(): Promise<void>;
  /**
   * Runs a script of one or more SQL statements with the simple query
   * protocol, so the statements run together in one implicit transaction
   * (unless the script manages its own). Used for plugin migrations.
   */
  exec(script: string): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Pool size for PostgreSQL. Ignored by PGlite. */
  maxConnections?: number;
  /** Seconds to wait for a PostgreSQL connection before failing. */
  connectTimeout?: number;
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Which driver a connection URL selects.
 *
 * - `postgres://…` / `postgresql://…` — a PostgreSQL server.
 * - `pglite:memory` — embedded, in memory (tests).
 * - `pglite:<directory>` — embedded, persisted to a directory (trying Pressbase out).
 */
export function driverFor(url: string): Driver {
  if (/^postgres(ql)?:\/\//i.test(url)) return 'postgres';
  if (url.startsWith('pglite:')) return 'pglite';
  throw new Error('Database URL must start with postgres://, postgresql:// or pglite:');
}

export async function connect(
  url: string,
  options: ConnectOptions = {},
): Promise<DatabaseConnection> {
  if (driverFor(url) === 'pglite') {
    const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
      import('@electric-sql/pglite'),
      import('drizzle-orm/pglite'),
      import('drizzle-orm/pglite/migrator'),
    ]);
    const target = url.slice('pglite:'.length);
    // PGlite creates its own directory but not missing parents (a fresh data dir).
    if (target !== 'memory') await mkdir(path.dirname(path.resolve(target)), { recursive: true });
    const client = target === 'memory' ? new PGlite() : new PGlite(target);
    const db = drizzle(client, { schema });
    return {
      db: db as unknown as Database,
      driver: 'pglite',
      migrate: () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }),
      exec: async (script) => {
        await client.exec(script);
      },
      close: () => client.close(),
    };
  }

  const [{ default: postgres }, { drizzle }, { migrate }] = await Promise.all([
    import('postgres'),
    import('drizzle-orm/postgres-js'),
    import('drizzle-orm/postgres-js/migrator'),
  ]);
  const client = postgres(url, {
    max: options.maxConnections ?? 10,
    connect_timeout: options.connectTimeout ?? 10,
    onnotice: () => {},
  });
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as Database,
    driver: 'postgres',
    migrate: () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    exec: async (script) => {
      await client.unsafe(script).simple();
    },
    close: () => client.end({ timeout: 5 }),
  };
}

/** Opens a connection, runs `select 1` and closes it. Throws the driver's error on failure. */
export async function testConnection(url: string): Promise<void> {
  const connection = await connect(url, { maxConnections: 1, connectTimeout: 5 });
  try {
    await connection.db.execute(sql`select 1`);
  } finally {
    await connection.close();
  }
}

/** Rows of a raw `execute()` result: PGlite returns `{ rows }`, postgres-js the array itself. */
export function resultRows<T>(result: unknown): T[] {
  return ((result as { rows?: unknown }).rows ?? result) as T[];
}

/**
 * Schema migrations that this database hasn't applied yet, by tag. It uses
 * the migrator's own rule: a journal entry is pending when it is newer than
 * the last row of `drizzle.__drizzle_migrations`. `connection.migrate()` runs
 * on every boot, so anything listed here means a migration failed or the code
 * changed under a running process. Used by Site Health.
 */
export async function pendingMigrations(db: Database): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string; when: number }[] };
  let last = 0;
  try {
    const [row] = resultRows<{ created_at: string | number }>(
      await db.execute(
        sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
      ),
    );
    last = Number(row?.created_at ?? 0);
  } catch {
    // No migrations table: nothing has been applied.
  }
  return journal.entries.filter((entry) => last < entry.when).map((entry) => entry.tag);
}
