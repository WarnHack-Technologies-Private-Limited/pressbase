import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, DatabaseLockedError, migrationStatus } from './index';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pressbase-lock-'));
  dirs.push(dir);
  return dir;
}

function holder(pid: number, host = hostname()) {
  return JSON.stringify({ pid, hostname: host, process: 'server', since: new Date().toISOString() });
}

describe('the built-in database lock', () => {
  it('is held while a connection is open and released on close', async () => {
    const db = path.join(await tempDir(), 'db');
    const connection = await connect(`pglite:${db}`);
    expect(existsSync(`${db}.lock`)).toBe(true);
    // A second connection in the same process is refused too.
    await expect(connect(`pglite:${db}`)).rejects.toBeInstanceOf(DatabaseLockedError);
    await connection.close();
    expect(existsSync(`${db}.lock`)).toBe(false);
    const again = await connect(`pglite:${db}`);
    await again.close();
  });

  it('refuses a directory another live process holds, and says what to do', async () => {
    const db = path.join(await tempDir(), 'db');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
    try {
      await writeFile(`${db}.lock`, holder(child.pid as number));
      const error = await connect(`pglite:${db}`).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DatabaseLockedError);
      expect((error as Error).message).toMatch(/Stop the Pressbase server first, or use PostgreSQL/);
      // The holder's lock is untouched.
      expect(JSON.parse(await readFile(`${db}.lock`, 'utf8')).pid).toBe(child.pid);
    } finally {
      child.kill();
    }
  });

  it('takes over a lock whose process is gone', async () => {
    const db = path.join(await tempDir(), 'db');
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => child.on('exit', resolve));
    await writeFile(`${db}.lock`, holder(child.pid as number));
    const connection = await connect(`pglite:${db}`);
    expect(JSON.parse(await readFile(`${db}.lock`, 'utf8')).pid).toBe(process.pid);
    await connection.close();
  });

  it('trusts a lock from another host only while it is kept fresh', async () => {
    const db = path.join(await tempDir(), 'db');
    await writeFile(`${db}.lock`, holder(1, 'another-container'));
    await expect(connect(`pglite:${db}`)).rejects.toBeInstanceOf(DatabaseLockedError);
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(`${db}.lock`, old, old);
    const connection = await connect(`pglite:${db}`);
    await connection.close();
  });
});

describe('migrationStatus', () => {
  it('lists pending migrations without applying them', async () => {
    const connection = await connect('pglite:memory');
    try {
      const before = await migrationStatus(connection);
      expect(before.pending.length).toBeGreaterThan(0);
      expect(before.pending[0]).toBe('0000_initial_schema');
      await connection.migrate();
      const after = await migrationStatus(connection);
      expect(after.pending).toEqual([]);
      expect(after.migrations.every((m) => m.applied)).toBe(true);
    } finally {
      await connection.close();
    }
  });
});
