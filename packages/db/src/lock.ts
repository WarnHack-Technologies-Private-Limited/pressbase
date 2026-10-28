import { readFileSync, unlinkSync } from 'node:fs';
import { open, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { hostname } from 'node:os';

/**
 * The built-in database (PGlite) is one process's private PostgreSQL: two
 * processes opening the same directory each believe they own it, and their
 * writes destroy each other (PGlite doesn't lock the directory itself). So
 * whoever opens a PGlite directory first — the server, or the `pressbase`
 * CLI — holds a lock file beside it (`<dir>.lock`), and everyone else is
 * refused with DatabaseLockedError until it closes.
 *
 * The lock records who holds it and is touched every few seconds. It is
 * stale, and taken over, when its process is gone: on the same host we ask
 * the operating system (the pid is checked); from another host (a second
 * container on a shared volume) we can only see whether it is still being
 * touched. A crash therefore never leaves the site locked for long.
 */

export interface LockHolder {
  pid: number;
  hostname: string;
  /** What opened the database: "server", "cli"… (PRESSBASE_PROCESS, else the script). */
  process: string;
  since: string;
}

/** Thrown when another live process holds the built-in database. */
export class DatabaseLockedError extends Error {
  readonly code = 'PRESSBASE_DB_LOCKED';
  constructor(
    readonly lockFile: string,
    readonly holder: LockHolder,
  ) {
    super(
      `The built-in database is in use by another Pressbase process (${describeHolder(holder)}). ` +
        'Stop the Pressbase server first, or use PostgreSQL.',
    );
    this.name = 'DatabaseLockedError';
  }
}

function describeHolder(holder: LockHolder): string {
  const where = holder.hostname === hostname() ? '' : ` on ${holder.hostname}`;
  return `${holder.process}, process ${holder.pid}${where}`;
}

/** How often the holder touches the lock file, and when an untouched one counts as stale. */
const HEARTBEAT_MS = 15_000;
const STALE_MS = 60_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function processName(): string {
  if (process.env.PRESSBASE_PROCESS) return process.env.PRESSBASE_PROCESS;
  const script = process.argv[1] ?? '';
  return script.split(/[\\/]/).pop() || 'node';
}

async function readHolder(file: string): Promise<LockHolder | undefined> {
  try {
    const holder = JSON.parse(await readFile(file, 'utf8')) as LockHolder;
    return typeof holder.pid === 'number' ? holder : undefined;
  } catch {
    return undefined;
  }
}

/** Lock files this process holds right now. */
const held = new Set<string>();

async function isStale(file: string, holder: LockHolder | undefined): Promise<boolean> {
  // Unreadable or half-written: written by a process that died mid-write.
  if (!holder) return true;
  if (holder.hostname === hostname()) {
    // Our own pid on a lock we don't hold: left by an earlier life of this
    // process (a container restarted with the same pid).
    if (holder.pid === process.pid) return !held.has(file);
    return !isAlive(holder.pid);
  }
  try {
    const { mtimeMs } = await stat(file);
    return Date.now() - mtimeMs > STALE_MS;
  } catch {
    return true;
  }
}

export interface DirectoryLock {
  file: string;
  release(): Promise<void>;
}

/**
 * Takes the lock for a PGlite directory, or throws DatabaseLockedError.
 * `release()` removes it (only if it is still ours).
 */
export async function lockDirectory(dir: string): Promise<DirectoryLock> {
  const file = `${dir.replace(/[\\/]+$/, '')}.lock`;
  const me: LockHolder = {
    pid: process.pid,
    hostname: hostname(),
    process: processName(),
    since: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(me)}\n`);
      } finally {
        await handle.close();
      }
      return holdLock(file, me);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = await readHolder(file);
    if (!(await isStale(file, holder))) {
      throw new DatabaseLockedError(file, holder as LockHolder);
    }
    // Stale: remove it and try again (another process may win the race; then we read its lock).
    await unlink(file).catch(() => {});
  }
  const holder = await readHolder(file);
  throw new DatabaseLockedError(file, holder ?? me);
}

function holdLock(file: string, me: LockHolder): DirectoryLock {
  held.add(file);
  const timer = setInterval(() => {
    const now = new Date();
    utimes(file, now, now).catch(() => {});
  }, HEARTBEAT_MS);
  timer.unref();
  // A process that exits without closing the database still lets go.
  const onExit = () => {
    try {
      const holder = JSON.parse(readFileSync(file, 'utf8')) as LockHolder;
      if (holder.pid === me.pid && holder.since === me.since) {
        // Synchronous: 'exit' handlers can't wait.
        unlinkSync(file);
      }
    } catch {
      // Already gone.
    }
  };
  process.once('exit', onExit);
  let released = false;
  return {
    file,
    release: async () => {
      if (released) return;
      released = true;
      held.delete(file);
      clearInterval(timer);
      process.off('exit', onExit);
      const holder = await readHolder(file);
      if (holder?.pid === me.pid && holder.since === me.since) await unlink(file).catch(() => {});
    },
  };
}
