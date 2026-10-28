import { describe, expect, it } from 'vitest';
import { PageCache } from './page-cache';
import { cacheSecret, handleRevalidate, secretMatches } from './revalidate';
import { servePublicRequest } from './serve';

const SECRET = 'a-long-shared-secret-for-tests';

/** A fake core: answers render requests from a table and records what it was asked. */
function fakeCore(
  pages: Record<
    string,
    { status: number; headers?: Record<string, string>; html: string; tags?: string[] }
  >,
) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const target = url.searchParams.get('url') ?? '/';
    calls.push({ url: target, headers: (init?.headers ?? {}) as Record<string, string> });
    const page = pages[target];
    if (!page) return new Response(JSON.stringify({ code: 'rest_no_route' }), { status: 404 });
    return new Response(JSON.stringify({ headers: {}, ...page }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls, pages };
}

const options = (cache: PageCache | undefined, fetch: typeof globalThis.fetch) => ({
  coreUrl: 'http://core.test',
  adminUrl: 'http://admin.test',
  cache,
  fetch,
});

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`http://site.test${path}`, { method, headers });

describe('servePublicRequest', () => {
  it('renders once, then answers from the cache until core purges a tag', async () => {
    const core = fakeCore({
      '/hello/': {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          etag: 'W/"v1"',
          'cache-control': 'public, max-age=0, must-revalidate',
        },
        html: '<p>v1</p>',
        tags: ['site', 'post:1'],
      },
    });
    const cache = new PageCache();
    const first = await servePublicRequest(get('/hello/'), options(cache, core.fetch));
    expect(first.headers.get('x-pressbase-cache')).toBe('MISS');
    expect(await first.text()).toBe('<p>v1</p>');
    const second = await servePublicRequest(get('/hello/'), options(cache, core.fetch));
    expect(second.headers.get('x-pressbase-cache')).toBe('HIT');
    expect(await second.text()).toBe('<p>v1</p>');
    expect(core.calls).toHaveLength(1);
    // The fill is anonymous: no cookie or validator reaches core.
    expect(core.calls[0]?.headers).toEqual({ accept: 'application/json' });

    core.pages['/hello/'] = {
      ...core.pages['/hello/'],
      html: '<p>v2</p>',
      headers: { etag: 'W/"v2"' },
    } as never;
    const purge = await handleRevalidate(
      new Request('http://site.test/_pressbase/revalidate', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ tags: ['post:1'] }),
      }),
      { cache, secret: SECRET },
    );
    expect(await purge.json()).toEqual({ purged: 1, tags: 1 });
    const third = await servePublicRequest(get('/hello/'), options(cache, core.fetch));
    expect(third.headers.get('x-pressbase-cache')).toBe('MISS');
    expect(await third.text()).toBe('<p>v2</p>');
  });

  it('answers conditional requests from the cache with 304', async () => {
    const core = fakeCore({
      '/': { status: 200, headers: { etag: 'W/"home"' }, html: 'home', tags: ['site'] },
    });
    const cache = new PageCache();
    await servePublicRequest(get('/'), options(cache, core.fetch));
    const res = await servePublicRequest(
      get('/', { 'if-none-match': 'W/"home"' }),
      options(cache, core.fetch),
    );
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe('W/"home"');
    expect(await res.text()).toBe('');
  });

  it('forwards logged-in visitors to core with their cookie, uncached', async () => {
    const core = fakeCore({ '/': { status: 200, html: 'fresh for you', tags: ['site'] } });
    const cache = new PageCache();
    for (let i = 0; i < 2; i++) {
      const res = await servePublicRequest(
        get('/', { cookie: 'pressbase_session=s' }),
        options(cache, core.fetch),
      );
      expect(res.headers.get('x-pressbase-cache')).toBe('BYPASS');
    }
    expect(core.calls).toHaveLength(2);
    expect(core.calls[0]?.headers.cookie).toBe('pressbase_session=s');
    expect(cache.size).toBe(0);
  });

  it('keeps 404s briefly and never stores private answers', async () => {
    const core = fakeCore({
      '/missing/': { status: 404, html: 'nope', tags: ['site', '404'] },
      '/locked/': {
        status: 200,
        headers: { 'cache-control': 'private, no-cache' },
        html: 'x',
        tags: ['site'],
      },
    });
    const cache = new PageCache();
    const missing = await servePublicRequest(get('/missing/'), options(cache, core.fetch));
    expect(missing.status).toBe(404);
    expect(
      (await servePublicRequest(get('/missing/'), options(cache, core.fetch))).headers.get(
        'x-pressbase-cache',
      ),
    ).toBe('HIT');
    await servePublicRequest(get('/locked/'), options(cache, core.fetch));
    expect(
      (await servePublicRequest(get('/locked/'), options(cache, core.fetch))).headers.get(
        'x-pressbase-cache',
      ),
    ).toBe('MISS');
  });

  it('keeps XML and text content types', async () => {
    const core = fakeCore({
      '/feed/': {
        status: 200,
        headers: { 'content-type': 'application/rss+xml; charset=UTF-8' },
        html: '<rss/>',
        tags: ['site'],
      },
      '/robots.txt': {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        html: 'User-agent: *',
        tags: ['site'],
      },
    });
    const cache = new PageCache();
    for (let i = 0; i < 2; i++) {
      expect(
        (await servePublicRequest(get('/feed/'), options(cache, core.fetch))).headers.get(
          'content-type',
        ),
      ).toBe('application/rss+xml; charset=UTF-8');
      expect(
        (await servePublicRequest(get('/robots.txt'), options(cache, core.fetch))).headers.get(
          'content-type',
        ),
      ).toBe('text/plain; charset=utf-8');
    }
    expect(core.calls).toHaveLength(2);
  });

  it('shares one render between concurrent misses', async () => {
    const core = fakeCore({ '/': { status: 200, html: 'home', tags: ['site'] } });
    const cache = new PageCache();
    const all = await Promise.all(
      [1, 2, 3].map(() =>
        servePublicRequest(get('/'), options(cache, core.fetch)).then((r) => r.text()),
      ),
    );
    expect(all).toEqual(['home', 'home', 'home']);
    expect(core.calls).toHaveLength(1);
  });

  it('gives every waiter its own copy of a shared answer that is not a page', async () => {
    // Core not installed: a 503 that each visitor turns into a redirect.
    const notInstalled = (async () =>
      new Response(JSON.stringify({ code: 'pressbase_not_installed' }), {
        status: 503,
      })) as typeof fetch;
    const cache = new PageCache();
    const all = await Promise.all(
      [1, 2, 3].map(() => servePublicRequest(get('/'), options(cache, notInstalled))),
    );
    expect(all.map((r) => r.status)).toEqual([302, 302, 302]);
    expect(all[2]?.headers.get('location')).toBe('http://admin.test/install');
    expect(cache.size).toBe(0);
  });

  it('works as before without a cache', async () => {
    const core = fakeCore({ '/': { status: 200, html: 'home', tags: ['site'] } });
    const res = await servePublicRequest(
      get('/', { 'if-none-match': 'W/"x"' }),
      options(undefined, core.fetch),
    );
    expect(res.headers.get('x-pressbase-cache')).toBe('OFF');
    expect(core.calls[0]?.headers['if-none-match']).toBe('W/"x"');
  });

  it('shows the error page when core is down', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const res = await servePublicRequest(get('/'), options(new PageCache(), down));
    expect(res.status).toBe(502);
  });
});

describe('revalidation endpoint', () => {
  const post = (body: unknown, authorization?: string) =>
    new Request('http://site.test/_pressbase/revalidate', {
      method: 'POST',
      headers: authorization ? { authorization } : {},
      body: JSON.stringify(body),
    });

  it('refuses a wrong or missing secret', async () => {
    const cache = new PageCache();
    expect(
      (await handleRevalidate(post({ tags: ['site'] }), { cache, secret: SECRET })).status,
    ).toBe(401);
    expect(
      (await handleRevalidate(post({ tags: ['site'] }, 'Bearer nope'), { cache, secret: SECRET }))
        .status,
    ).toBe(401);
  });

  it('needs tags, and is off without a cache', async () => {
    const cache = new PageCache();
    expect(
      (await handleRevalidate(post({}, `Bearer ${SECRET}`), { cache, secret: SECRET })).status,
    ).toBe(400);
    expect(
      (
        await handleRevalidate(post({ tags: ['site'] }, `Bearer ${SECRET}`), {
          cache: undefined,
          secret: undefined,
        })
      ).status,
    ).toBe(404);
  });

  it('compares secrets in constant time and requires a long enough one', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretMatches(undefined, SECRET)).toBe(false);
    expect(cacheSecret({ PRESSBASE_REVALIDATE_SECRET: 'short' })).toBeUndefined();
    expect(cacheSecret({ PRESSBASE_REVALIDATE_SECRET: SECRET })).toBe(SECRET);
    expect(cacheSecret({})).toBeUndefined();
  });
});
