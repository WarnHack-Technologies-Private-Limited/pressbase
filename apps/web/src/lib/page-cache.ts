/**
 * An in-process cache of rendered public pages, indexed by cache tag.
 *
 * - **LRU by size.** Entries are evicted least recently used first once the
 *   bodies held pass `maxBytes`; one entry may use at most an eighth of it.
 * - **Tags.** Each entry carries the tags core rendered it with (`site`,
 *   `post:12`, `posts:post`…). `purge(tags)` drops every entry that carries
 *   one of them; `site` drops everything.
 * - **Freshness.** An entry is fresh for its TTL, then stale for a grace
 *   period during which it may still be served while a refresh runs
 *   (stale-while-revalidate), then gone. Purged entries are never served.
 * - **Race safety.** A render that started before a purge must not store its
 *   (now outdated) result: `store()` takes the generation read when the
 *   render began and refuses if any purge happened since.
 *
 * See docs/adr/0008-public-page-caching.md for why this isn't Next.js's cache.
 */

export interface CachedPage {
  status: number;
  headers: Record<string, string>;
  body: string;
  tags: string[];
}

interface Entry extends CachedPage {
  key: string;
  size: number;
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
}

export interface Lookup {
  page: CachedPage;
  state: 'fresh' | 'stale';
  /** Seconds since the entry was stored (the Age header). */
  age: number;
}

export interface PageCacheOptions {
  maxBytes?: number;
  now?: () => number;
}

export class PageCache {
  readonly maxBytes: number;
  #now: () => number;
  /** Map iteration order is insertion order: the first key is the least recently used. */
  #entries = new Map<string, Entry>();
  #byTag = new Map<string, Set<string>>();
  #bytes = 0;
  #generation = 0;
  /** In-flight renders per key, so concurrent misses share one request to core. */
  readonly inflight = new Map<string, Promise<unknown>>();

  constructor({ maxBytes = 64 * 1024 * 1024, now = Date.now }: PageCacheOptions = {}) {
    this.maxBytes = maxBytes;
    this.#now = now;
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** Read before rendering; pass to store(). */
  generation(): number {
    return this.#generation;
  }

  lookup(key: string): Lookup | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    const now = this.#now();
    if (now >= entry.staleUntil) {
      this.#delete(key);
      return undefined;
    }
    // Most recently used goes to the end.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return {
      page: entry,
      state: now < entry.freshUntil ? 'fresh' : 'stale',
      age: Math.max(0, Math.floor((now - entry.storedAt) / 1000)),
    };
  }

  /**
   * Stores a page for `ttl` seconds, servable stale for `stale` more. Returns
   * false when it wasn't stored (too big, or purged since `generation`).
   */
  store(
    key: string,
    page: CachedPage,
    { ttl, stale = 0, generation }: { ttl: number; stale?: number; generation: number },
  ): boolean {
    if (generation !== this.#generation || ttl <= 0) return false;
    const size =
      page.body.length +
      Object.entries(page.headers).reduce((n, [k, v]) => n + k.length + v.length, 0) +
      page.tags.reduce((n, t) => n + t.length, 0) +
      key.length;
    if (size > this.maxBytes / 8) return false;
    this.#delete(key);
    const now = this.#now();
    const entry: Entry = {
      ...page,
      tags: [...new Set(page.tags)],
      key,
      size,
      storedAt: now,
      freshUntil: now + ttl * 1000,
      staleUntil: now + (ttl + stale) * 1000,
    };
    this.#entries.set(key, entry);
    this.#bytes += size;
    for (const tag of entry.tags) {
      const keys = this.#byTag.get(tag) ?? new Set<string>();
      keys.add(key);
      this.#byTag.set(tag, keys);
    }
    while (this.#bytes > this.maxBytes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#delete(oldest);
    }
    return true;
  }

  /** Drops every entry carrying one of `tags` (`site`: everything). Returns how many. */
  purge(tags: Iterable<string>): number {
    this.#generation++;
    const list = [...tags];
    if (list.includes('site')) {
      const n = this.#entries.size;
      this.clear();
      return n;
    }
    let purged = 0;
    for (const tag of list) {
      for (const key of [...(this.#byTag.get(tag) ?? [])]) {
        if (this.#delete(key)) purged++;
      }
    }
    return purged;
  }

  clear(): void {
    this.#generation++;
    this.#entries.clear();
    this.#byTag.clear();
    this.#bytes = 0;
  }

  #delete(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    this.#entries.delete(key);
    this.#bytes -= entry.size;
    for (const tag of entry.tags) {
      const keys = this.#byTag.get(tag);
      keys?.delete(key);
      if (keys?.size === 0) this.#byTag.delete(tag);
    }
    return true;
  }
}
