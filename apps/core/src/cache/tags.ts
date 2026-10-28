import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

/**
 * Cache tags: what a rendered public page depends on.
 *
 * While core renders a page (or a feed, a sitemap, robots.txt), every post,
 * listing, term, author and comment list it reads is recorded here. The
 * render endpoint returns the tags with the page; apps/web indexes its cached
 * copy by them, and `cache/invalidation.ts` purges exactly the tags a content
 * change touches. See docs/adr/0008-public-page-caching.md.
 *
 * Recording is a no-op outside a collection scope (REST requests, the admin),
 * so the content services can call `addCacheTags()` unconditionally.
 */

export const CacheTag = {
  /** Every page: purged by theme switches, settings and anything site-wide. */
  site: 'site',
  /** The front page. */
  home: 'home',
  /** A page that shows this post (singular view, list item, adjacent link, menu). */
  post: (id: number) => `post:${id}`,
  /** A page that lists posts of this type: which posts appear can change. */
  posts: (type: string) => `posts:${type}`,
  /** A page that shows this term (archive, post terms). */
  term: (id: number) => `term:${id}`,
  /** A page that lists the terms of a taxonomy (category lists, tag clouds, sitemaps). */
  terms: (taxonomy: string) => `terms:${taxonomy}`,
  /** A page that shows this author (archive, bylines). */
  author: (id: number) => `author:${id}`,
  /** A page that lists comments across posts (latest comments, the comments feed). */
  comments: 'comments',
  /** Search results: any published change can change what matches. */
  search: 'search',
  /** A "not found" answer, which new content can turn into a page. */
  notFound: '404',
  /**
   * Every answer for one path, whatever its query string (ADR 0017): purging
   * it makes the next request reach core, so a new redirect or plugin file
   * wins over a cached page. See pathTag().
   */
  path: (path: string) => pathTag(path),
} as const;

/**
 * `path:{path}`, normalised so `/a/b/` and `/a/b` (and `%7E` and `~`) are the
 * same tag: percent-encoding as `new URL()` gives it, without trailing
 * slashes, query or fragment. Tags are printable ASCII of at most 200
 * characters (apps/web's cleanTags()), so long paths are hashed.
 */
export function pathTag(path: string): string {
  let pathname: string;
  try {
    pathname = new URL(path, 'http://pressbase.invalid').pathname;
  } catch {
    pathname = '/';
  }
  try {
    pathname = encodeURI(decodeURIComponent(pathname));
  } catch {
    // Malformed escapes stay as they are.
  }
  pathname = pathname.replace(/\/+$/, '') || '/';
  const tag = `path:${pathname}`;
  return tag.length <= 200 && /^[\x21-\x7e]+$/.test(tag)
    ? tag
    : `path:#${createHash('sha1').update(pathname).digest('hex')}`;
}

const storage = new AsyncLocalStorage<Set<string>>();

/** Runs `fn`, collecting the tags of everything it reads. */
export async function collectCacheTags<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; tags: string[] }> {
  const tags = new Set<string>();
  const result = await storage.run(tags, fn);
  return { result, tags: [...tags] };
}

/** Records tags for the render in progress, if any. */
export function addCacheTags(...tags: (string | undefined | null | false)[]): void {
  const store = storage.getStore();
  if (!store) return;
  for (const tag of tags) if (tag) store.add(tag);
}

/** Whether a render is collecting tags (lets callers skip work that only feeds tags). */
export function collectingCacheTags(): boolean {
  return storage.getStore() !== undefined;
}
