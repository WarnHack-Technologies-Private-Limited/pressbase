import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from '@pressbase/db';

/**
 * Request-scoped database transactions (v0.8, ADR 0022).
 *
 * `kernel.transaction(fn)` runs `fn` in one transaction; while it runs,
 * `kernel.db` *is* that transaction, so every service (posts, terms, meta,
 * options, the job queue) joins it without a new parameter. That is what
 * lets a changeset publish many entities through the ordinary services and
 * still commit or roll back as one (WordPress has no equivalent: its
 * Customizer saves settings one by one).
 *
 * A nested call opens a savepoint. Continuations that outlive the
 * transaction (a timer armed inside it) see no transaction once it has
 * finished, rather than a closed one.
 */

interface Scope {
  tx: Database;
  open: boolean;
}

const storage = new AsyncLocalStorage<Scope>();

/** The transaction the current code runs in, if any. */
export function activeTransaction(): Database | undefined {
  const scope = storage.getStore();
  return scope?.open ? scope.tx : undefined;
}

/** Runs `fn` in a transaction of `db` (a savepoint inside an open one). */
export async function runInTransaction<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  const outer = activeTransaction() ?? db;
  return outer.transaction(async (tx) => {
    const scope: Scope = { tx: tx as unknown as Database, open: true };
    try {
      return await storage.run(scope, fn);
    } finally {
      scope.open = false;
    }
  });
}
