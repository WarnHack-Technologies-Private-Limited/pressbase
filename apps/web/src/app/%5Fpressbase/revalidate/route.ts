import { pageCache } from '@/lib/cache-instance';
import { cacheSecret, handleRevalidate } from '@/lib/revalidate';

/**
 * POST /_pressbase/revalidate — core's cache purges (see lib/revalidate.ts and
 * docs/adr/0008-public-page-caching.md). The folder is `%5Fpressbase` because
 * Next.js treats folders starting with `_` as private.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleRevalidate(request, { cache: pageCache(), secret: cacheSecret() });
}
