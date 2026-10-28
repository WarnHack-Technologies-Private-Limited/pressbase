import { bypassReason, cacheKey, cleanTags, notModified, ttlFor } from './cache-policy';
import type { CachedPage, PageCache } from './page-cache';
import {
  errorPage,
  FORWARDED_REQUEST_HEADERS,
  isRenderResult,
  renderEndpoint,
  responseFromCore,
  toResponse,
} from './render';

/**
 * Answers a public request: from the page cache when it may, otherwise by
 * asking core to render it. The route handler is a thin wrapper around this,
 * so the whole flow is unit-tested with a fake core (serve.test.ts).
 *
 * The `x-pressbase-cache` header says what happened: HIT, STALE (served while
 * a refresh runs), MISS (rendered and stored), BYPASS (personal or uncacheable
 * request) or OFF (no PRESSBASE_REVALIDATE_SECRET, so no cache).
 */

export interface ServeOptions {
  coreUrl: string;
  adminUrl: string;
  /** Undefined when caching is off. */
  cache: PageCache | undefined;
  fetch?: typeof fetch;
}

type CacheState = 'HIT' | 'STALE' | 'MISS' | 'BYPASS' | 'OFF';

function withCacheHeaders(res: Response, state: CacheState, age?: number): Response {
  res.headers.set('x-pressbase-cache', state);
  if (age !== undefined) res.headers.set('age', String(age));
  return res;
}

const unreachable = (coreUrl: string) =>
  errorPage(
    502,
    'The site can’t be reached right now',
    `Pressbase’s core server isn’t answering at ${coreUrl}. Start it (pnpm dev), then reload this page.`,
  );

/** The visitor's response for a stored page, honouring If-None-Match / If-Modified-Since. */
function fromCache(page: CachedPage, request: Request): Response {
  if (page.status === 200 && notModified(request.headers, page.headers)) {
    return toResponse({ status: 304, headers: page.headers, html: '' }, request.method);
  }
  return toResponse(
    { status: page.status, headers: page.headers, html: page.body },
    request.method,
  );
}

export async function servePublicRequest(
  request: Request,
  options: ServeOptions,
): Promise<Response> {
  const { coreUrl, adminUrl, cache } = options;
  const send = options.fetch ?? fetch;
  const bypass = cache ? bypassReason(request) : 'disabled';

  if (!cache || bypass) {
    // As before caching: forward the visitor's cookie and validator.
    const headers: Record<string, string> = { accept: 'application/json' };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    let res: Response;
    try {
      res = await send(renderEndpoint(coreUrl, request.url), {
        headers,
        cache: 'no-store',
        redirect: 'manual',
      });
    } catch {
      return unreachable(coreUrl);
    }
    const response = await responseFromCore(res, { method: request.method, adminUrl });
    return withCacheHeaders(response, cache ? 'BYPASS' : 'OFF');
  }

  const key = cacheKey(request.url);
  const hit = cache.lookup(key);
  if (hit) {
    if (hit.state === 'stale') void fill(cache, key, request.url, options).catch(() => undefined);
    return withCacheHeaders(
      fromCache(hit.page, request),
      hit.state === 'fresh' ? 'HIT' : 'STALE',
      hit.age,
    );
  }

  let filled: Filled;
  try {
    filled = await fill(cache, key, request.url, options);
  } catch {
    return unreachable(coreUrl);
  }
  if (filled.page) return withCacheHeaders(fromCache(filled.page, request), 'MISS');
  return withCacheHeaders(
    await responseFromCore(filled.response(), { method: request.method, adminUrl }),
    'MISS',
  );
}

/**
 * A render's outcome: the page when core rendered one, and core's raw reply
 * (buffered, so every request waiting on a shared render gets its own copy).
 */
interface Filled {
  page?: CachedPage;
  response: () => Response;
}

/**
 * Renders a URL anonymously and stores it when allowed. Concurrent calls for
 * the same key share one request to core.
 */
function fill(
  cache: PageCache,
  key: string,
  requestUrl: string,
  { coreUrl, fetch: send = fetch }: ServeOptions,
): Promise<Filled> {
  const running = cache.inflight.get(key) as Promise<Filled> | undefined;
  if (running) return running;

  const work = (async (): Promise<Filled> => {
    const generation = cache.generation();
    // Anonymous render: no cookie, no validator; the cache answers conditionals itself.
    const reply = await send(renderEndpoint(coreUrl, requestUrl), {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      redirect: 'manual',
    });
    const text = await reply.text();
    const status = reply.status;
    const headers = new Headers(reply.headers);
    const response = () => new Response(text, { status, headers });
    if (!reply.ok) return { response };
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { response };
    }
    if (!isRenderResult(payload) || payload.status === 304) return { response };
    const page: CachedPage = {
      status: payload.status,
      headers: payload.headers ?? {},
      body: payload.html,
      tags: cleanTags(payload.tags),
    };
    const ttl = ttlFor(page.status, page.headers);
    // Without tags core can't purge it, so it isn't kept.
    if (ttl && page.tags.length) {
      cache.store(key, page, { ttl: ttl.fresh, stale: ttl.stale, generation });
    }
    return { page, response };
  })();
  cache.inflight.set(key, work);
  void work.finally(() => cache.inflight.delete(key)).catch(() => undefined);
  return work;
}
