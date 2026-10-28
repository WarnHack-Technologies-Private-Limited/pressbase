import { createHash, timingSafeEqual } from 'node:crypto';
import { cleanTags } from './cache-policy';
import type { PageCache } from './page-cache';

/**
 * POST /_pressbase/revalidate: core tells this app which cache tags a content
 * change made stale. Authenticated with the shared secret
 * (PRESSBASE_REVALIDATE_SECRET) as `Authorization: Bearer <secret>`.
 */

/** Shortest secret accepted; a shorter one disables caching (see cacheSecret()). */
export const MIN_SECRET_LENGTH = 16;

/** The configured secret, or undefined when caching is off. */
export function cacheSecret(env: Record<string, string | undefined> = process.env) {
  const secret = env.PRESSBASE_REVALIDATE_SECRET?.trim();
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : undefined;
}

/**
 * Constant-time comparison: both sides are hashed first, so neither the
 * secret's content nor its length leaks through timing.
 */
export function secretMatches(provided: string | null | undefined, expected: string): boolean {
  const a = createHash('sha256')
    .update(provided ?? '')
    .digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b) && provided !== null && provided !== undefined;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** The largest purge request read (64 KiB holds thousands of tags). */
const MAX_BODY = 64 * 1024;

export async function handleRevalidate(
  request: Request,
  { cache, secret }: { cache: PageCache | undefined; secret: string | undefined },
): Promise<Response> {
  if (!cache || !secret) {
    return json(404, { code: 'pressbase_cache_disabled', message: 'Page caching is off.' });
  }
  const header = request.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  if (!secretMatches(token, secret)) {
    return json(401, { code: 'pressbase_invalid_secret', message: 'Invalid revalidation secret.' });
  }
  const text = await request.text();
  if (text.length > MAX_BODY) {
    return json(413, { code: 'pressbase_too_large', message: 'Too many tags in one request.' });
  }
  let tags: string[];
  try {
    tags = cleanTags((JSON.parse(text) as { tags?: unknown }).tags);
  } catch {
    tags = [];
  }
  if (!tags.length) {
    return json(400, {
      code: 'rest_invalid_param',
      message: 'Give the tags to purge: { "tags": [...] }.',
    });
  }
  return json(200, { purged: cache.purge(tags), tags: tags.length });
}
