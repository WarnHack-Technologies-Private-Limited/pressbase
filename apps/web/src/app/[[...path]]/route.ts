import { pageCache } from '@/lib/cache-instance';
import { servePublicRequest } from '@/lib/serve';

/**
 * Every public URL (except /wp-json, /wp-content and /wp-includes, which
 * next.config.ts proxies to core) is rendered by core: pages of the theme,
 * feeds, sitemaps and robots.txt.
 *
 * Dynamic for Next.js: this app keeps its own page cache, purged by core
 * through /_pressbase/revalidate (lib/serve.ts, docs/adr/0008-public-page-caching.md).
 */
export const dynamic = 'force-dynamic';

const CORE_URL = process.env.CORE_URL ?? 'http://localhost:4000';
const ADMIN_URL = process.env.ADMIN_URL ?? 'http://localhost:3000';

async function handle(request: Request): Promise<Response> {
  return servePublicRequest(request, {
    coreUrl: CORE_URL,
    adminUrl: ADMIN_URL,
    cache: pageCache(),
  });
}

export const GET = handle;
export const HEAD = handle;
