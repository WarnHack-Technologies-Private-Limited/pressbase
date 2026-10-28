import { describe, expect, it } from 'vitest';
import { cleanRule, normalizePath, rulesFromCsv, toCsv } from '../src/redirects';
import { publish, render, site } from './helpers';

/** Redirects (301/302/307/410, regex), the 404 log and its cap, slug-change redirects. */

describe('redirect rules', () => {
  it('normalises and validates rules', () => {
    expect(normalizePath('/old-post/?utm=1#x')).toBe('/old-post');
    expect(normalizePath('https://example.org/a/b/')).toBe('/a/b');
    expect(cleanRule({ source: 'old/', target: '/new/' })).toEqual({
      source: '/old',
      target: '/new/',
      status: 301,
      regex: false,
    });
    expect(cleanRule({ source: '/gone', status: 410, target: '/x' }).target).toBe('');
    expect(() => cleanRule({ source: '/a', target: 'javascript:alert(1)' })).toThrow(/path/);
    expect(() => cleanRule({ source: '/a', target: '/a/' })).toThrow(/itself/);
    expect(() => cleanRule({ source: '(', target: '/b', regex: true })).toThrow(/regular/);
    expect(() => cleanRule({ source: '/a', target: '/b', status: 308 })).toThrow(/301/);
  });

  it('round-trips CSV', () => {
    const csv = toCsv([
      { id: 1, source: '/a,b', target: '/c', status: 301, regex: false, hits: 0, last_hit: null },
      { id: 2, source: '^/blog/(.*)$', target: '/$1', status: 302, regex: true, hits: 0, last_hit: null },
    ]);
    expect(csv).toBe('source,target,status,regex\n"/a,b",/c,301,0\n^/blog/(.*)$,/$1,302,1\n');
    expect(rulesFromCsv(csv)).toEqual([
      { source: '/a,b', target: '/c', status: 301, regex: false },
      { source: '^/blog/(.*)$', target: '/$1', status: 302, regex: true },
    ]);
  });
});

describe('redirects on the public site', () => {
  it('answers 301, 302, 307, regex and 410 rules and counts hits', async () => {
    const ctx = await site();
    const post = await publish(ctx, { title: 'Destination' });
    const target = new URL(post.link).pathname;
    const add = (body: Record<string, unknown>) =>
      ctx.request('POST', '/pressbase-seo/v1/redirects', body);
    expect((await add({ source: '/old-post/', target, status: 301 })).status).toBe(201);
    expect((await add({ source: '/temp', target: 'https://example.org/', status: 302 })).status).toBe(201);
    expect((await add({ source: '/keep-method', target, status: 307 })).status).toBe(201);
    expect((await add({ source: '^/archive/(\\d+)/?$', target: '/?p=$1', regex: true })).status).toBe(201);
    expect((await add({ source: '/retired/', status: 410 })).status).toBe(201);
    const dup = await add({ source: '/old-post', target: '/x/' });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('duplicate_source');

    const old = await render(ctx, '/old-post/?ref=mail');
    expect(old.status).toBe(301);
    expect(old.headers.location).toBe(target);
    expect((await render(ctx, '/temp/')).status).toBe(302);
    expect((await render(ctx, '/keep-method')).status).toBe(307);
    const regex = await render(ctx, '/archive/42/');
    expect(regex.status).toBe(301);
    expect(regex.headers.location).toBe('/?p=42');
    expect((await render(ctx, '/retired/')).status).toBe(410);

    const list = await ctx.request('GET', '/pressbase-seo/v1/redirects');
    expect(list.body.total).toBe(5);
    expect(list.body.items.find((r: { source: string }) => r.source === '/old-post').hits).toBe(1);
  });

  it('purges the source path when a rule changes, the site for regex rules', async () => {
    const ctx = await site();
    const purges: string[][] = [];
    ctx.kernel.hooks.addAction('pressbase_cache_purge', async (tags: string[]) => {
      purges.push(tags);
    });
    const res = await ctx.request('POST', '/pressbase-seo/v1/redirects', {
      source: '/hello/',
      target: '/world/',
    });
    expect(purges).toContainEqual(['path:/hello']);
    await ctx.request('PUT', `/pressbase-seo/v1/redirects/${res.body.id}`, { source: '/hi/' });
    expect(purges.at(-1)).toEqual(expect.arrayContaining(['path:/hello', 'path:/hi']));
    await ctx.request('POST', '/pressbase-seo/v1/redirects', {
      source: '^/x/',
      target: '/y/',
      regex: true,
    });
    expect(purges.at(-1)).toEqual(['site']);
    const del = await ctx.request('DELETE', `/pressbase-seo/v1/redirects/${res.body.id}`);
    expect(del.body.deleted).toBe(true);
    expect((await render(ctx, '/hi/')).status).toBe(404);
  });

  it('imports and exports CSV, and only administrators manage redirects', async () => {
    const ctx = await site();
    const imported = await ctx.request('POST', '/pressbase-seo/v1/redirects/import', {
      csv: 'source,target,status,regex\n/a,/b,301,0\n/c,,410,0\nbad,javascript:x,301,0\n',
    });
    expect(imported.body.saved).toBe(2);
    expect(imported.body.errors).toHaveLength(1);
    const res = await ctx.app.request('/wp-json/pressbase-seo/v1/redirects/export');
    expect(res.status).toBe(401);
    const exported = await ctx.client();
    expect((await exported.request('GET', '/pressbase-seo/v1/redirects')).status).toBe(401);
  });
});

describe('the 404 log', () => {
  it('logs path, referrer and count (never the IP) and is capped by the prune', async () => {
    const ctx = await site();
    await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent('/missing-page/')}`, {
      headers: { referer: 'https://elsewhere.example/links', 'x-forwarded-for': '203.0.113.9' },
    });
    await render(ctx, '/missing-page/?utm=1');
    await render(ctx, '/wp-login.php');
    const log = await ctx.request('GET', '/pressbase-seo/v1/404s');
    expect(log.body.items).toHaveLength(1);
    expect(log.body.items[0]).toMatchObject({
      path: '/missing-page/',
      referrer: 'https://elsewhere.example/links',
      hits: 2,
    });
    expect(JSON.stringify(log.body)).not.toContain('203.0.113.9');

    const { Redirects } = await import('../src/redirects');
    const runtime = ctx.kernel.plugins.runtime('pressbase-seo');
    const redirects = new Redirects(runtime!.api);
    for (let i = 0; i < 12; i++) await redirects.log404(`/gone-${i}`, '');
    await redirects.prune404(5);
    expect(await redirects.list404({ limit: 100 })).toHaveLength(5);
    // Pruning is a daily cron event of the plugin.
    expect(await runtime!.api.cron.nextScheduled('prune_404s')).toBeTruthy();
  });
});

describe('slug changes', () => {
  it('adds a 301 from the old address when a published post’s slug changes', async () => {
    const ctx = await site();
    const post = await publish(ctx, { title: 'First name' });
    const before = new URL(post.link).pathname;
    const res = await ctx.request('POST', `/wp/v2/posts/${post.id}`, { slug: 'second-name' });
    const after = new URL(res.body.link).pathname;
    const old = await render(ctx, before);
    expect(old.status).toBe(301);
    expect(old.headers.location).toBe(after);
    // Renaming back removes the rule that would loop.
    await ctx.request('POST', `/wp/v2/posts/${post.id}`, { slug: 'first-name' });
    const back = await render(ctx, before);
    expect(back.status).toBe(200);
  });
});
