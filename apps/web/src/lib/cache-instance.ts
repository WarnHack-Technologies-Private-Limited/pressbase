import { PageCache } from './page-cache';
import { cacheSecret } from './revalidate';

/**
 * The process's page cache, shared by the page route and the revalidation
 * route. Next.js may load a route's modules more than once (separate bundles,
 * dev reloads), so the instance lives on globalThis. Undefined when caching
 * is off (no PRESSBASE_REVALIDATE_SECRET).
 */

const globalCache = globalThis as typeof globalThis & { __pressbasePageCache?: PageCache };

export function pageCache(): PageCache | undefined {
  if (!cacheSecret()) return undefined;
  const mb = Number(process.env.PRESSBASE_PAGE_CACHE_MB);
  globalCache.__pressbasePageCache ??= new PageCache({
    maxBytes: (Number.isFinite(mb) && mb > 0 ? mb : 64) * 1024 * 1024,
  });
  return globalCache.__pressbasePageCache;
}
