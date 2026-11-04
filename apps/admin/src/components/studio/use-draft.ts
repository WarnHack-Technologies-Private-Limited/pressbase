'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  type Changeset,
  type EntryValue,
  entriesPatch,
  mergeFields,
  pendingKeys,
  type StoredEntry,
} from './changes-model';

/**
 * Studio's draft (#31): the user's open changeset, kept in step with the
 * canvas. The editor says which entries it wants (`want()`); after a short
 * pause the difference is written with `POST /pressbase/v1/changesets`
 * (which starts the changeset, or returns the user's open one). One request
 * at a time; edits made meanwhile go in the next. Nothing here touches the
 * live site until `publish()`.
 */

/** How long typing pauses before the draft is written. */
export const SAVE_DELAY = 800;

export type DraftStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface Draft {
  /** The open changeset, once there is one. */
  changeset: Changeset | null;
  /** Its entries with unsent edits laid over: what Publish would list. */
  keys: string[];
  entries: Readonly<Record<string, StoredEntry>>;
  status: DraftStatus;
  error: string | null;
  /** Edits not written to the draft yet: leaving now would lose them. */
  unsaved: boolean;
  /** The canvas wants these entries (null: no entry). Saved after SAVE_DELAY. */
  want(entries: ReadonlyMap<string, EntryValue | null>): void;
  /**
   * Merges fields into object entries (page entries, which the canvas and the
   * Pages panel share; see mergeFields()). `undefined` takes a field out.
   */
  wantFields(changes: ReadonlyMap<string, Readonly<Record<string, unknown>>>): void;
  /** Writes what's pending now; resolves with the changeset (null if there's nothing in it). */
  flush(): Promise<Changeset | null>;
  /** Removes one entry from the draft. */
  revert(key: string): Promise<void>;
  publish(): Promise<Changeset>;
  discard(): Promise<void>;
  /** Uses this changeset from now on (Studio opening the user's open one). */
  resume(changeset: Changeset | null): void;
}

export function useDraft({ onError }: { onError: (message: string) => void }): Draft {
  const [changeset, setChangeset] = useState<Changeset | null>(null);
  const [status, setStatus] = useState<DraftStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [desiredVersion, setDesiredVersion] = useState(0);
  const server = useRef<Changeset | null>(null);
  const desired = useRef(new Map<string, EntryValue | null>());
  const sent = useRef(new Map<string, string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<Changeset | null> | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const accept = useCallback((next: Changeset | null) => {
    server.current = next;
    setChangeset(next);
  }, []);

  const patch = useCallback(
    () => entriesPatch(desired.current, server.current?.entries ?? {}, sent.current),
    [],
  );

  /** Sends what's pending, repeating until nothing is; one request at a time. */
  const run = useCallback(async (): Promise<Changeset | null> => {
    while (inflight.current) await inflight.current.catch(() => null);
    const body = patch();
    if (!Object.keys(body).length) {
      setStatus((s) => (s === 'saving' || s === 'pending' ? 'saved' : s));
      return server.current;
    }
    setStatus('saving');
    const request = (async () => {
      const next = await api<Changeset>('/pressbase/v1/changesets', {
        method: 'POST',
        body: { entries: body },
      });
      for (const [key, value] of Object.entries(body)) {
        if (value === null) sent.current.delete(key);
        else sent.current.set(key, JSON.stringify(value));
      }
      accept(next);
      return next;
    })();
    inflight.current = request;
    try {
      await request;
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setStatus('error');
      throw e;
    } finally {
      inflight.current = null;
    }
    return run();
  }, [accept, patch]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setStatus((s) => (s === 'saving' ? s : 'pending'));
    timer.current = setTimeout(() => {
      timer.current = null;
      run().catch((e) => onErrorRef.current(e instanceof Error ? e.message : String(e)));
    }, SAVE_DELAY);
  }, [run]);

  const want = useCallback(
    (entries: ReadonlyMap<string, EntryValue | null>) => {
      let changed = false;
      for (const [key, value] of entries) {
        const before = desired.current.get(key);
        if (desired.current.has(key) && JSON.stringify(before) === JSON.stringify(value)) continue;
        desired.current.set(key, value);
        changed = true;
      }
      if (!changed) return;
      setDesiredVersion((v) => v + 1);
      if (Object.keys(patch()).length) schedule();
    },
    [patch, schedule],
  );

  const wantFields = useCallback(
    (changes: ReadonlyMap<string, Readonly<Record<string, unknown>>>) => {
      const next = new Map<string, EntryValue | null>();
      for (const [key, fields] of changes) {
        const base = desired.current.has(key)
          ? desired.current.get(key)
          : server.current?.entries[key]?.value;
        next.set(key, mergeFields(base, fields));
      }
      want(next);
    },
    [want],
  );

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    return run();
  }, [run]);

  /** After publishing or discarding: the canvas starts again from what's live. */
  const reset = useCallback(() => {
    desired.current.clear();
    sent.current.clear();
    accept(null);
    setDesiredVersion((v) => v + 1);
    setStatus('idle');
    setError(null);
  }, [accept]);

  const revert = useCallback(
    async (key: string) => {
      await flush();
      desired.current.set(key, null);
      sent.current.delete(key);
      setDesiredVersion((v) => v + 1);
      await run();
    },
    [flush, run],
  );

  const publish = useCallback(async () => {
    const current = await flush();
    if (!current) throw new Error('There’s nothing to publish yet.');
    const published = await api<Changeset>(
      `/pressbase/v1/changesets/${encodeURIComponent(current.uuid)}/publish`,
      { method: 'POST' },
    );
    reset();
    return published;
  }, [flush, reset]);

  const discard = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    while (inflight.current) await inflight.current.catch(() => null);
    const current = server.current;
    if (current) {
      await api(`/pressbase/v1/changesets/${encodeURIComponent(current.uuid)}`, {
        method: 'DELETE',
      });
    }
    reset();
  }, [reset]);

  const resume = useCallback(
    (next: Changeset | null) => {
      accept(next);
      if (next) setStatus('saved');
    },
    [accept],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const view = useMemo(() => {
    const pending = patch();
    const keys = pendingKeys(changeset?.entries ?? {}, pending);
    const entries: Record<string, StoredEntry> = { ...(changeset?.entries ?? {}) };
    for (const [key, value] of Object.entries(pending)) {
      if (value === null) delete entries[key];
      else
        entries[key] = { value, type: key.split(':')[0] ?? '', user_id: 0, date_modified_gmt: '' };
    }
    return { keys, entries, unsaved: Object.keys(pending).length > 0 };
  }, [changeset, desiredVersion, patch]);

  return {
    changeset,
    keys: view.keys,
    entries: view.entries,
    status,
    error,
    unsaved: view.unsaved || status === 'saving' || status === 'error',
    want,
    wantFields,
    flush,
    revert,
    publish,
    discard,
    resume,
  };
}
