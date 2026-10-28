/**
 * Which public requests apps/web may answer from its page cache, under which
 * key, and how long a response may be kept. Pure functions, unit-tested in
 * cache-policy.test.ts. See docs/adr/0008-public-page-caching.md.
 */

/**
 * Cookies that change what a page shows: a session (logged-in visitors see
 * previews, private posts and their own toolbar), an unlocked post password,
 * a commenter's details. WordPress caching plugins skip the same ones.
 */
const PERSONAL_COOKIE =
  /^(pressbase_|wp-postpass|comment_author_|wordpress_logged_in_|wordpress_sec_)/;

/** Query variables that make a page personal or a one-off. */
const PERSONAL_QUERY = ['preview', 'unapproved', 'moderation-hash', 'replytocom'];

export type Bypass = 'method' | 'cookie' | 'query' | 'authorization' | 'disabled';

/** Why a request must go to core uncached, or undefined when the cache may answer it. */
export function bypassReason(request: {
  method: string;
  url: string;
  headers: Headers;
}): Bypass | undefined {
  if (request.method !== 'GET' && request.method !== 'HEAD') return 'method';
  if (request.headers.get('authorization')) return 'authorization';
  const cookie = request.headers.get('cookie');
  if (cookie) {
    for (const part of cookie.split(';')) {
      const name = part.split('=')[0]?.trim() ?? '';
      if (PERSONAL_COOKIE.test(name)) return 'cookie';
    }
  }
  const url = new URL(request.url);
  if (PERSONAL_QUERY.some((name) => url.searchParams.has(name))) return 'query';
  return undefined;
}

/** The cache key: path and query string, exactly as requested. */
export function cacheKey(requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.pathname}${url.search}`;
}

export interface CacheTtl {
  /** Seconds a stored response is fresh. */
  fresh: number;
  /** Seconds it may then still be served while a refresh runs. */
  stale: number;
}

export interface TtlSettings {
  /** Pages, feeds, sitemaps (200). Invalidation is the main mechanism; this is a backstop. */
  ok: CacheTtl;
  /** Redirects (301) and not-found pages (404): brief. */
  brief: CacheTtl;
}

export const DEFAULT_TTLS: TtlSettings = {
  ok: { fresh: 3600, stale: 86_400 },
  brief: { fresh: 60, stale: 0 },
};

/** How long core's answer may be kept, or undefined when it mustn't be stored. */
export function ttlFor(
  status: number,
  headers: Record<string, string>,
  ttls: TtlSettings = DEFAULT_TTLS,
): CacheTtl | undefined {
  const cacheControl = (
    Object.entries(headers).find(([k]) => k.toLowerCase() === 'cache-control')?.[1] ?? ''
  ).toLowerCase();
  if (/\b(private|no-store)\b/.test(cacheControl)) return undefined;
  if (status === 200) return ttls.ok;
  if (status === 301 || status === 404) return ttls.brief;
  return undefined;
}

/** Whether the visitor's validators match the cached response (a 304 is enough). */
export function notModified(
  requestHeaders: Headers,
  responseHeaders: Record<string, string>,
): boolean {
  const etag = responseHeaders.etag;
  const ifNoneMatch = requestHeaders.get('if-none-match');
  if (ifNoneMatch && etag) {
    const bare = (t: string) => t.trim().replace(/^W\//, '');
    return ifNoneMatch === '*' || ifNoneMatch.split(',').some((t) => bare(t) === bare(etag));
  }
  const since = requestHeaders.get('if-modified-since');
  const lastModified = responseHeaders['last-modified'];
  if (since && lastModified) {
    const a = Date.parse(since);
    const b = Date.parse(lastModified);
    return Number.isFinite(a) && Number.isFinite(b) && b <= a;
  }
  return false;
}

/** Valid cache tags from core: short printable strings, a bounded number of them. */
export function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 200)
    .filter((t) => /^[\x21-\x7e]+$/.test(t))
    .slice(0, 50_000);
}
