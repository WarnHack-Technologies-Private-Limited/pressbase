'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { MEDIA_FILTERS, type MediaFilter, type RestMedia, uploadMedia } from '@/lib/media';

const PER_PAGE = 40;

/**
 * One page-at-a-time view of /wp/v2/media for a filter and search, with
 * "load more" and local updates after uploads, edits and deletions.
 */
export function useMediaList({
  filter,
  search,
  allowed,
}: {
  filter: MediaFilter;
  search: string;
  /** When set, "all" means all of these filters (used by the picker's allowedTypes). */
  allowed?: Exclude<MediaFilter, 'all'>[];
}) {
  const [items, setItems] = useState<RestMedia[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const allowedKey = allowed?.join(',') ?? '';

  const fetchPage = useCallback(
    async (n: number) => {
      const q = new URLSearchParams({
        context: 'edit',
        per_page: String(PER_PAGE),
        page: String(n),
      });
      const filters = filter === 'all' ? (allowedKey ? allowedKey.split(',') : []) : [filter];
      const mediaTypes = MEDIA_FILTERS.filter((f) => filters.includes(f.id)).flatMap(
        (f) => f.mediaTypes,
      );
      if (mediaTypes.length) q.set('media_type', mediaTypes.join(','));
      if (search) q.set('search', search);
      const res = await fetch(`/wp-json/wp/v2/media?${q}`, { credentials: 'same-origin' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new ApiError(
          res.status,
          data?.code ?? 'pressbase_unknown_error',
          data?.message ?? 'Could not load the media library.',
        );
      }
      return {
        items: data as RestMedia[],
        total: Number(res.headers.get('X-WP-Total') ?? 0),
        totalPages: Number(res.headers.get('X-WP-TotalPages') ?? 1),
      };
    },
    [filter, search, allowedKey],
  );

  const reload = useCallback(async () => {
    const id = ++request.current;
    setError(undefined);
    setItems(null);
    try {
      const result = await fetchPage(1);
      if (id !== request.current) return;
      setItems(result.items);
      setTotal(result.total);
      setTotalPages(result.totalPages);
      setPage(1);
    } catch (err) {
      if (id !== request.current) return;
      setError(err instanceof ApiError ? err.message : 'Could not load the media library.');
      setItems([]);
    }
  }, [fetchPage]);

  useEffect(() => {
    reload();
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (page >= totalPages) return;
    const id = request.current;
    setLoadingMore(true);
    try {
      const result = await fetchPage(page + 1);
      if (id !== request.current) return;
      // Uploads made since the first page shift pages; skip anything already shown.
      setItems((current) => {
        const seen = new Set(current?.map((m) => m.id));
        return [...(current ?? []), ...result.items.filter((m) => !seen.has(m.id))];
      });
      setTotal(result.total);
      setTotalPages(result.totalPages);
      setPage(page + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load more media.');
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, page, totalPages]);

  const prepend = useCallback((media: RestMedia) => {
    setItems((current) => [media, ...(current ?? []).filter((m) => m.id !== media.id)]);
    setTotal((n) => n + 1);
  }, []);
  const replace = useCallback((media: RestMedia) => {
    setItems((current) => current?.map((m) => (m.id === media.id ? media : m)) ?? null);
  }, []);
  const remove = useCallback((id: number) => {
    setItems((current) => current?.filter((m) => m.id !== id) ?? null);
    setTotal((n) => Math.max(0, n - 1));
  }, []);

  return {
    items,
    total,
    error,
    hasMore: page < totalPages,
    loadingMore,
    loadMore,
    reload,
    prepend,
    replace,
    remove,
  };
}

export interface UploadItem {
  key: number;
  name: string;
  size: number;
  progress: number;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
  media?: RestMedia;
}

const CONCURRENCY = 3;

/**
 * A queue of uploads, three at a time, each with its own progress. Calls
 * `onUploaded` as each file finishes so it can appear in the grid right away.
 */
export function useUploads(onUploaded: (media: RestMedia) => void) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const files = useRef(new Map<number, File>());
  const controllers = useRef(new Map<number, AbortController>());
  const started = useRef(new Set<number>());
  const nextKey = useRef(1);
  const callback = useRef(onUploaded);
  callback.current = onUploaded;

  const update = (key: number, change: Partial<UploadItem>) =>
    setUploads((all) => all.map((u) => (u.key === key ? { ...u, ...change } : u)));

  // Start queued uploads while fewer than CONCURRENCY are running.
  useEffect(() => {
    const running = uploads.filter((u) => u.status === 'uploading').length;
    const queued = uploads.filter((u) => u.status === 'queued').slice(0, CONCURRENCY - running);
    for (const item of queued) {
      const file = files.current.get(item.key);
      if (!file || started.current.has(item.key)) continue;
      started.current.add(item.key);
      const controller = new AbortController();
      controllers.current.set(item.key, controller);
      update(item.key, { status: 'uploading' });
      uploadMedia(file, {
        signal: controller.signal,
        onProgress: (progress) => update(item.key, { progress }),
      })
        .then((media) => {
          update(item.key, { status: 'done', progress: 1, media });
          callback.current(media);
        })
        .catch((error: Error) => update(item.key, { status: 'error', error: error.message }))
        .finally(() => {
          files.current.delete(item.key);
          controllers.current.delete(item.key);
        });
    }
  }, [uploads]);

  const add = useCallback((list: FileList | File[]) => {
    const added: UploadItem[] = [];
    for (const file of Array.from(list)) {
      const key = nextKey.current++;
      files.current.set(key, file);
      added.push({ key, name: file.name, size: file.size, progress: 0, status: 'queued' });
    }
    setUploads((all) => [...all, ...added]);
  }, []);

  const dismiss = useCallback((key: number) => {
    controllers.current.get(key)?.abort();
    setUploads((all) => all.filter((u) => u.key !== key));
  }, []);

  const clearFinished = useCallback(
    () => setUploads((all) => all.filter((u) => u.status === 'queued' || u.status === 'uploading')),
    [],
  );

  return { uploads, add, dismiss, clearFinished };
}
