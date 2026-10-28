import { describe, expect, it } from 'vitest';
import { PURGE_ACTION } from './cache/invalidation';
import { startRevalidationNotifier } from './cache/notifier';
import { addCacheTags, collectCacheTags } from './cache/tags';
import { setup } from './test-utils';

/**
 * Public page caching, core's half (docs/adr/0008-public-page-caching.md):
 * the cache tags a render reports, the purges content changes announce, the
 * notifier that sends them to apps/web, and the Cache-Control of pages that
 * must never be shared.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  const purges: { tags: string[]; reason: string }[] = [];
  ctx.kernel.hooks.addAction(PURGE_ACTION, async (tags, reason) => {
    purges.push({ tags, reason });
  });
  /** Tags purged since the last call. */
  const purged = () => {
    const tags = new Set(purges.flatMap((p) => p.tags));
    purges.length = 0;
    return tags;
  };
  return { ...ctx, purged };
}

async function render(ctx: Ctx, url: string, headers: Record<string, string> = {}) {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`, {
    headers,
  });
  return (await res.json()) as {
    status: number;
    headers: Record<string, string>;
    html: string;
    tags: string[];
  };
}

async function post(ctx: Ctx, body: Record<string, unknown>, type = 'posts') {
  const res = await ctx.request('POST', `/wp/v2/${type}`, { status: 'publish', ...body });
  expect(res.status).toBe(201);
  return res.body as { id: number; link: string };
}

describe('cache tags', () => {
  it('collects tags only inside a collection scope', async () => {
    addCacheTags('ignored');
    const { result, tags } = await collectCacheTags(async () => {
      addCacheTags('a', undefined, false, 'b', 'a');
      return 42;
    });
    expect(result).toBe(42);
    expect(tags).toEqual(['a', 'b']);
  });

  it('tags a single post with what it shows', async () => {
    const ctx = await site();
    const news = await ctx.request('POST', '/wp/v2/categories', { name: 'News' });
    const older = await post(ctx, { title: 'Older' });
    const hello = await post(ctx, { title: 'Tagged post', categories: [news.body.id] });
    const page = await render(ctx, new URL(hello.link).pathname);
    expect(page.status).toBe(200);
    expect(page.tags[0]).toBe('site');
    expect(page.tags).toEqual(
      expect.arrayContaining([
        `post:${hello.id}`,
        `term:${news.body.id}`,
        'author:1',
        // The post navigation links to the previous post.
        `post:${older.id}`,
        'posts:post',
      ]),
    );
  });

  it('tags the home page with its posts, and 404s as such', async () => {
    const ctx = await site();
    const a = await post(ctx, { title: 'On the home page' });
    const home = await render(ctx, '/');
    expect(home.tags).toEqual(
      expect.arrayContaining(['site', 'home', 'posts:post', `post:${a.id}`]),
    );
    const missing = await render(ctx, '/no-such-thing/');
    expect(missing.status).toBe(404);
    expect(missing.tags).toContain('404');
  });
});

describe('invalidation', () => {
  it('purges listings when a post is published, and nothing for drafts', async () => {
    const ctx = await site();
    ctx.purged();
    const draft = await post(ctx, { title: 'Draft', status: 'draft' });
    await ctx.request('POST', `/wp/v2/posts/${draft.id}`, { title: 'Still a draft' });
    expect(ctx.purged().size).toBe(0);
    await ctx.request('POST', `/wp/v2/posts/${draft.id}`, { status: 'publish' });
    expect([...ctx.purged()]).toEqual(
      expect.arrayContaining([
        `post:${draft.id}`,
        'posts:post',
        'posts:any',
        'home',
        '404',
        'search',
        'author:1',
      ]),
    );
  });

  it('purges only the post when a published post is edited in place', async () => {
    const ctx = await site();
    const created = await post(ctx, { title: 'Original' });
    ctx.purged();
    await ctx.request('POST', `/wp/v2/posts/${created.id}`, {
      title: 'Edited',
      content: 'New body',
    });
    expect([...ctx.purged()]).toEqual([`post:${created.id}`]);
    // A new date moves it in listings.
    await ctx.request('POST', `/wp/v2/posts/${created.id}`, { date: '2025-05-05T10:00:00' });
    expect(ctx.purged()).toContain('posts:post');
  });

  it('purges term archives when a post changes category', async () => {
    const ctx = await site();
    const news = await ctx.request('POST', '/wp/v2/categories', { name: 'News' });
    const created = await post(ctx, { title: 'Moving' });
    ctx.purged();
    await ctx.request('POST', `/wp/v2/posts/${created.id}`, { categories: [news.body.id] });
    const tags = ctx.purged();
    expect(tags).toContain(`term:${news.body.id}`);
    expect(tags).toContain('term:1'); // Uncategorized, which it left
    expect(tags).toContain('posts:post');
    // Sending the same terms again changes nothing.
    await ctx.request('POST', `/wp/v2/posts/${created.id}`, { categories: [news.body.id] });
    expect(ctx.purged()).toEqual(new Set([`post:${created.id}`]));
  });

  it('purges on trash and permanent deletion', async () => {
    const ctx = await site();
    const created = await post(ctx, { title: 'Doomed' });
    ctx.purged();
    await ctx.request('DELETE', `/wp/v2/posts/${created.id}`);
    expect(ctx.purged()).toContain('posts:post');
    const other = await post(ctx, { title: 'Gone' });
    ctx.purged();
    await ctx.request('DELETE', `/wp/v2/posts/${other.id}?force=true`);
    expect(ctx.purged()).toContain(`post:${other.id}`);
  });

  it('purges a post when an approved comment arrives, not for a held one', async () => {
    const ctx = await site();
    const created = await post(ctx, { title: 'Discuss' });
    ctx.purged();
    const ok = await ctx.request('POST', '/wp/v2/comments', { post: created.id, content: 'Hi' });
    expect(ok.body.status).toBe('approved');
    expect(ctx.purged()).toEqual(new Set([`post:${created.id}`, 'comments']));
    await ctx.request('POST', `/wp/v2/comments/${ok.body.id}`, { status: 'hold' });
    expect(ctx.purged()).toContain(`post:${created.id}`);
    // Editing a held comment is invisible to visitors.
    await ctx.request('POST', `/wp/v2/comments/${ok.body.id}`, { content: 'Hi again' });
    expect(ctx.purged().size).toBe(0);
  });

  it('purges terms, authors, settings, sticky posts and the theme', async () => {
    const ctx = await site();
    ctx.purged();
    await ctx.request('POST', '/wp/v2/categories/1', { name: 'General' });
    expect(ctx.purged()).toEqual(new Set(['term:1', 'terms:category', '404']));
    await ctx.request('POST', '/wp/v2/users/1', { name: 'Ada' });
    expect(ctx.purged()).toContain('author:1');
    await ctx.request('POST', '/wp/v2/settings', { title: 'Renamed' });
    expect(ctx.purged()).toEqual(new Set(['site']));
    // The header menu's fallback (navigation menus) and any other public option.
    await ctx.kernel.options.set('pressbase_navigation_fallback', 12);
    expect(ctx.purged()).toEqual(new Set(['site']));
    // Internal bookkeeping options never purge.
    await ctx.kernel.options.set('_transient_x', 1);
    expect(ctx.purged().size).toBe(0);
    const created = await post(ctx, { title: 'Pin me' });
    ctx.purged();
    await ctx.request('POST', `/wp/v2/posts/${created.id}`, { sticky: true });
    expect(ctx.purged()).toContain('posts:post');
    await ctx.request('POST', '/pressbase/v1/themes/twentytwentyfive/activate');
    expect(ctx.purged()).toContain('site');
  });
});

describe('revalidation notifier', () => {
  it('batches purges into one authenticated request per public app', async () => {
    const ctx = await site();
    const sent: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const stop = startRevalidationNotifier(ctx.kernel, {
      urls: ['http://web-1.test/', 'http://web-2.test'],
      secret: 'shared-secret-123456',
      fetch: fakeFetch,
      delayMs: 5,
    });
    await post(ctx, { title: 'Announce me' });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.map((s) => s.url)).toEqual([
      'http://web-1.test/_pressbase/revalidate',
      'http://web-2.test/_pressbase/revalidate',
    ]);
    const headers = sent[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer shared-secret-123456');
    const body = JSON.parse(String(sent[0]?.init.body)) as { tags: string[] };
    expect(body.tags).toContain('posts:post');

    sent.length = 0;
    await ctx.request('POST', '/wp/v2/settings', { title: 'Renamed' });
    await post(ctx, { title: 'And another' });
    await new Promise((r) => setTimeout(r, 30));
    // `site` covers everything else in the batch.
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ tags: ['site'] });
    stop();
  });
});

describe('Cache-Control', () => {
  it('marks personal pages private', async () => {
    const ctx = await site();
    const created = await post(ctx, { title: 'Hello there' });
    const path = new URL(created.link).pathname;
    expect((await render(ctx, path)).headers['cache-control']).toBe(
      'public, max-age=0, must-revalidate',
    );
    expect((await render(ctx, path, { cookie: 'wp-postpass=abc' })).headers['cache-control']).toBe(
      'private, no-cache',
    );
    expect(
      (await render(ctx, `${path}?unapproved=1&moderation-hash=x`)).headers['cache-control'],
    ).toBe('private, no-store');
    // Logged in (the main client holds the administrator's session).
    const res = await ctx.request('GET', `/pressbase/v1/render?url=${encodeURIComponent(path)}`);
    expect(res.body.headers['cache-control']).toBe('private, no-cache');
  });
});
