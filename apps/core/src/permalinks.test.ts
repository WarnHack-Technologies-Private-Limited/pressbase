import { describe, expect, it } from 'vitest';
import { PURGE_ACTION } from './cache/invalidation';
import { sanitizePermalinkBase, sanitizePermalinkStructure } from './content/permalinks';
import { parseRequest } from './frontend/query';
import { setup } from './test-utils';

/**
 * Settings → Permalinks: validation (options-permalink.php, sanitize_option()),
 * /pressbase/v1/permalinks, routing with category and tag bases, redirects
 * from old addresses and the cache purge.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  const purges: string[][] = [];
  ctx.kernel.hooks.addAction(PURGE_ACTION, async (tags) => {
    purges.push(tags);
  });
  return { ...ctx, purges };
}

async function render(ctx: Ctx, url: string) {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { status: number; headers: Record<string, string>; html: string };
}

const path = (link: string) => new URL(link).pathname + new URL(link).search;

describe('permalink validation', () => {
  it('normalises structures like options-permalink.php', () => {
    expect(sanitizePermalinkStructure('')).toEqual({ ok: true, value: '' });
    expect(sanitizePermalinkStructure('  %postname%/ ')).toEqual({
      ok: true,
      value: '/%postname%/',
    });
    expect(sanitizePermalinkStructure('//blog//#%year%/%postname%')).toEqual({
      ok: true,
      value: '/blog/%year%/%postname%',
    });
  });

  it('requires a structure tag, known tags and a tag naming the post', () => {
    expect(sanitizePermalinkStructure('/posts/')).toMatchObject({
      ok: false,
      error: expect.stringContaining('structure tag is required'),
    });
    expect(sanitizePermalinkStructure('/%foo%/%postname%/')).toMatchObject({
      ok: false,
      error: expect.stringContaining('%foo%'),
    });
    expect(sanitizePermalinkStructure('/%year%/%monthnum%/')).toMatchObject({ ok: false });
    expect(sanitizePermalinkStructure('/a b/%postname%/')).toMatchObject({ ok: false });
    expect(sanitizePermalinkStructure('/../%postname%/')).toMatchObject({ ok: false });
    for (const ok of [
      '/%year%/%monthnum%/%day%/%hour%/%minute%/%second%/%postname%/',
      '/%category%/%author%/%post_id%',
    ]) {
      expect(sanitizePermalinkStructure(ok)).toEqual({ ok: true, value: ok });
    }
  });

  it('normalises bases and refuses reserved or unsafe ones', () => {
    expect(sanitizePermalinkBase('')).toEqual({ ok: true, value: '' });
    expect(sanitizePermalinkBase('topics/')).toEqual({ ok: true, value: '/topics' });
    expect(sanitizePermalinkBase('//a//b')).toEqual({ ok: true, value: '/a/b' });
    expect(sanitizePermalinkBase('author')).toMatchObject({ ok: false });
    expect(sanitizePermalinkBase('a?b')).toMatchObject({ ok: false });
    expect(sanitizePermalinkBase('%postname%')).toMatchObject({ ok: false });
  });
});

describe('parseRequest with bases', () => {
  const structure = '/%year%/%monthnum%/%day%/%postname%/';
  const parse = (p: string) =>
    parseRequest(new URL(p, 'http://x'), structure, { category: 'topics/all', tag: 'labels' });
  it('routes the configured bases only', () => {
    expect(parse('/topics/all/news/')).toMatchObject({ category_name: 'news' });
    expect(parse('/topics/all/parent/child/')).toMatchObject({ category_name: 'child' });
    expect(parse('/labels/tea/page/2/')).toMatchObject({ tag: 'tea', paged: 2 });
    expect(parse('/category/news/').category_name).toBeUndefined();
    expect(parse('/tag/tea/').tag).toBeUndefined();
  });
});

describe('/pressbase/v1/permalinks', () => {
  it('needs manage_options', async () => {
    const ctx = await site();
    const anonymous = ctx.client();
    expect((await anonymous.request('GET', '/pressbase/v1/permalinks')).status).toBe(401);
  });

  it('reads, validates and saves the settings', async () => {
    const ctx = await site();
    expect((await ctx.request('GET', '/pressbase/v1/permalinks')).body).toEqual({
      permalink_structure: '/%year%/%monthnum%/%day%/%postname%/',
      category_base: '',
      tag_base: '',
    });

    const bad = await ctx.request('POST', '/pressbase/v1/permalinks', {
      permalink_structure: '/static/',
      category_base: 'search',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('rest_invalid_param');
    expect(Object.keys(bad.body.data.params)).toEqual(['permalink_structure', 'category_base']);

    const same = await ctx.request('POST', '/pressbase/v1/permalinks', {
      category_base: 'things',
      tag_base: '/things/',
    });
    expect(same.status).toBe(400);
    expect(same.body.data.params.tag_base).toContain('different');

    const ok = await ctx.request('POST', '/pressbase/v1/permalinks', {
      permalink_structure: '%postname%',
      category_base: 'topics',
      tag_base: '',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      permalink_structure: '/%postname%',
      category_base: '/topics',
      tag_base: '',
    });
    // Nothing leaks into /wp/v2/settings: that stays WordPress's.
    const settings = await ctx.request('GET', '/wp/v2/settings');
    expect(settings.body.permalink_structure).toBeUndefined();
  });

  it('purges every cached page when the structure changes', async () => {
    const ctx = await site();
    ctx.purges.length = 0;
    await ctx.request('POST', '/pressbase/v1/permalinks', { permalink_structure: '/%postname%/' });
    expect(ctx.purges.flat()).toContain('site');
  });
});

describe('routing after a permalink change', () => {
  it('serves posts and archives at the new addresses and redirects the old ones', async () => {
    const ctx = await site();
    const news = await ctx.request('POST', '/wp/v2/categories', { name: 'News' });
    const tea = await ctx.request('POST', '/wp/v2/tags', { name: 'Tea' });
    const post = await ctx.request('POST', '/wp/v2/posts', {
      title: 'Brewing',
      status: 'publish',
      categories: [news.body.id],
      tags: [tea.body.id],
    });
    const oldPost = path(post.body.link);
    expect(oldPost).toMatch(/^\/\d{4}\/\d{2}\/\d{2}\/brewing\/$/);

    await ctx.request('POST', '/pressbase/v1/permalinks', {
      permalink_structure: '/%post_id%/%postname%/',
      category_base: 'topics',
      tag_base: 'labels',
    });
    const fresh = await ctx.request('GET', `/wp/v2/posts/${post.body.id}`);
    expect(path(fresh.body.link)).toBe(`/${post.body.id}/brewing/`);
    expect((await render(ctx, `/${post.body.id}/brewing/`)).status).toBe(200);

    // The term links follow the bases, in REST and on the page.
    const category = await ctx.request('GET', `/wp/v2/categories/${news.body.id}`);
    expect(path(category.body.link)).toBe('/topics/news/');
    const single = await render(ctx, `/${post.body.id}/brewing/`);
    expect(single.html).toContain('href="http://localhost:3000/topics/news/"');
    expect(single.html).toContain('href="http://localhost:3000/labels/tea/"');
    expect((await render(ctx, '/topics/news/')).status).toBe(200);
    expect((await render(ctx, '/labels/tea/')).status).toBe(200);
    expect((await render(ctx, '/topics/news/feed/')).status).toBe(200);

    // Old addresses redirect.
    const moved = await render(ctx, oldPost);
    expect(moved.status).toBe(301);
    expect(moved.headers.location).toBe(`http://localhost:3000/${post.body.id}/brewing/`);
    expect((await render(ctx, '/category/news/')).headers.location).toBe(
      'http://localhost:3000/topics/news/',
    );
    expect((await render(ctx, '/tag/tea/')).headers.location).toBe(
      'http://localhost:3000/labels/tea/',
    );
    // Unknown addresses are still 404s.
    expect((await render(ctx, '/2020/01/01/missing/')).status).toBe(404);
    expect((await render(ctx, '/category/missing/')).status).toBe(404);

    // Back to plain: pretty addresses redirect to ?p=.
    await ctx.request('POST', '/pressbase/v1/permalinks', { permalink_structure: '' });
    const plain = await render(ctx, `/${post.body.id}/brewing/`);
    expect(plain.status).toBe(301);
    expect(plain.headers.location).toBe(`http://localhost:3000/?p=${post.body.id}`);
    expect((await render(ctx, oldPost)).headers.location).toBe(
      `http://localhost:3000/?p=${post.body.id}`,
    );
  });
});
