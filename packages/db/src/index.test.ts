import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { connect, driverFor } from './index';

describe('driverFor', () => {
  it('recognises PostgreSQL and PGlite URLs', () => {
    expect(driverFor('postgres://u:p@localhost/db')).toBe('postgres');
    expect(driverFor('postgresql://localhost/db')).toBe('postgres');
    expect(driverFor('pglite:memory')).toBe('pglite');
  });

  it('rejects anything else', () => {
    expect(() => driverFor('mysql://localhost/wp')).toThrow(/must start with/);
  });
});

describe('migrations', () => {
  it('create every table on an empty database and can be re-run', async () => {
    const connection = await connect('pglite:memory');
    try {
      await connection.migrate();
      await connection.migrate();
      const result: unknown = await connection.db.execute(
        sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
      );
      // PGlite returns { rows }, postgres-js returns the rows array itself.
      const rows = ((result as { rows?: unknown }).rows ?? result) as { table_name: string }[];
      expect(rows.map((r) => r.table_name)).toEqual([
        'ai_requests',
        'commentmeta',
        'comments',
        'jobs',
        'options',
        'postmeta',
        'posts',
        'sessions',
        'term_relationships',
        'term_taxonomy',
        'termmeta',
        'terms',
        'usermeta',
        'users',
      ]);
    } finally {
      await connection.close();
    }
  });
});

describe('embedded database on disk', () => {
  it('creates missing parent folders (a fresh data directory)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pressbase-db-'));
    try {
      const connection = await connect(`pglite:${path.join(root, 'not', 'yet', 'there', 'db')}`);
      await connection.migrate();
      await connection.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
