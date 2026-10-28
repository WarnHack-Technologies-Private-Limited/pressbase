import { describe, expect, it } from 'vitest';
import { api, publish, render, site } from './helpers';

/** REST meta auth, the posts-list filter, imports, the CLI audit and Site Health. */

async function author(ctx: Awaited<ReturnType<typeof site>>, login: string, role: string) {
  const res = await ctx.request('POST', '/wp/v2/users', {
    username: login,
    email: `${login}@example.com`,
    password: 'a long enough password 123',
    roles: [role],
  });
  expect(res.status).toBe(201);
  const client = ctx.client();
  const login2 = await client.request('POST', '/pressbase/v1/auth/login', {
    login,
    password: 'a long enough password 123',
  });
  expect(login2.status).toBe(200);
  return { id: res.body.id as number, client };
}

describe('Yoast meta in REST', () => {
  it('is readable by anyone, writable by those who can edit the post, sanitised', async () => {
    const ctx = await site();
    const post = await publish(ctx, {
      title: 'Meta',
      meta: {
        '_yoast_wpseo_meta-robots-noindex': '7',
        _yoast_wpseo_canonical: 'not a url',
        _yoast_wpseo_metadesc: '  A   description  ',
      },
    });
    expect(post.meta).toMatchObject({
      '_yoast_wpseo_meta-robots-noindex': '0',
      _yoast_wpseo_canonical: '',
      _yoast_wpseo_metadesc: 'A description',
      _yoast_wpseo_focuskw: '',
    });
    const anon = await ctx.client().request('GET', `/wp/v2/posts/${post.id}`);
    expect(anon.body.meta._yoast_wpseo_metadesc).toBe('A description');

    const writer = await author(ctx, 'writer', 'author');
    const denied = await writer.client.request('POST', `/wp/v2/posts/${post.id}`, {
      meta: { _yoast_wpseo_metadesc: 'Hijacked' },
    });
    expect(denied.status).toBe(403);
    const own = await writer.client.request('POST', '/wp/v2/posts', {
      title: 'Mine',
      meta: { _yoast_wpseo_metadesc: 'My own description' },
    });
    expect(own.status).toBe(201);
    expect(own.body.meta._yoast_wpseo_metadesc).toBe('My own description');
    const logged = await ctx.client().request('POST', `/wp/v2/posts/${post.id}`, {
      meta: { _yoast_wpseo_metadesc: 'x' },
    });
    expect(logged.status).toBe(401);
  });

  it('has the same fields on categories and tags', async () => {
    const ctx = await site();
    const tag = await ctx.request('POST', '/wp/v2/tags', {
      name: 'Oolong',
      meta: { wpseo_title: '%%term_title%% guide %%sep%% %%sitename%%' },
    });
    expect(tag.body.meta.wpseo_title).toBe('%%term_title%% guide %%sep%% %%sitename%%');
    await publish(ctx, { title: 'Tagged', tags: [tag.body.id] });
    expect((await render(ctx, '/tag/oolong/')).html).toContain('<title>Oolong guide - Test Site</title>');
  });

  it('filters the posts list to posts missing a description', async () => {
    const ctx = await site();
    const without = await publish(ctx, { title: 'Without' });
    const withDesc = await publish(ctx, {
      title: 'With',
      meta: { _yoast_wpseo_metadesc: 'Described.' },
    });
    const res = await ctx.request(
      'GET',
      '/wp/v2/posts?context=edit&pressbase-seo-description=missing&per_page=100',
    );
    const ids = res.body.map((p: { id: number }) => p.id);
    expect(ids).toContain(without.id);
    expect(ids).not.toContain(withDesc.id);
  });
});

describe('imports from other SEO plugins', () => {
  it('converts Rank Math and AIOSEO meta and variables without overwriting Yoast values', async () => {
    const ctx = await site();
    const seo = api(ctx);
    const a = await publish(ctx, { title: 'From Rank Math' });
    await seo.meta.update('post', a.id, 'rank_math_title', '%title% %sep% %sitename%');
    await seo.meta.update('post', a.id, 'rank_math_description', 'About %title%.');
    await seo.meta.update('post', a.id, 'rank_math_focus_keyword', 'rank math,second');
    await seo.meta.update('post', a.id, 'rank_math_robots', ['noindex', 'nofollow']);
    const b = await publish(ctx, { title: 'From AIOSEO', meta: { _yoast_wpseo_title: 'Keep me' } });
    await seo.meta.update('post', b.id, '_aioseo_title', '#post_title #separator_sa #site_title');
    await seo.meta.update('post', b.id, '_aioseo_description', 'All in one: #post_title');

    const rm = await ctx.request('POST', '/pressbase-seo/v1/import/rankmath');
    expect(rm.body).toMatchObject({ posts: 1, fields: 5 });
    expect(await seo.meta.get('post', a.id, '_yoast_wpseo_title', true)).toBe('%%title%% %%sep%% %%sitename%%');
    expect(await seo.meta.get('post', a.id, '_yoast_wpseo_focuskw', true)).toBe('rank math');
    expect(String(await seo.meta.get('post', a.id, '_yoast_wpseo_meta-robots-noindex', true))).toBe('1');

    const aio = await ctx.request('POST', '/pressbase-seo/v1/import/aioseo');
    expect(aio.body).toMatchObject({ posts: 1, fields: 1 });
    expect(await seo.meta.get('post', b.id, '_yoast_wpseo_title', true)).toBe('Keep me');
    expect(await seo.meta.get('post', b.id, '_yoast_wpseo_metadesc', true)).toBe('All in one: %%title%%');
  });
});

describe('CLI and Site Health', () => {
  it('audits posts with `pressbase pressbase-seo audit`', async () => {
    const ctx = await site();
    const post = await publish(ctx, {
      title: 'Audit me',
      content: '<!-- wp:heading {"level":1} --><h1>Extra</h1><!-- /wp:heading -->',
      meta: { _yoast_wpseo_focuskw: 'audit' },
    });
    const command = ctx.kernel.cli.all().find((c) => c.name === 'pressbase-seo audit');
    expect(command).toBeDefined();
    const rows: Record<string, unknown>[] = [];
    await command!.handler([String(post.id)], {}, {
      log: () => {},
      success: () => {},
      warning: () => {},
      error: (m: string) => {
        throw new Error(m);
      },
      formatItems: (items: Record<string, unknown>[]) => rows.push(...items),
      confirm: async () => {},
    } as never);
    const byCheck = Object.fromEntries(rows.map((r) => [r.check, r.status]));
    expect(byCheck['keyphrase-title']).toBe('good');
    expect(byCheck['single-h1']).toBe('improve');
    expect(byCheck['description-length']).toBe('improve');
    expect(rows.every((r) => r.post === post.id)).toBe(true);
  });

  it('adds the three Site Health checks', async () => {
    const ctx = await site();
    const tests = (await ctx.kernel.hooks.applyFilters('site_status_tests', {
      direct: {},
      async: {},
    })) as { direct: Record<string, { test: () => Promise<{ status: string }> }> };
    expect(Object.keys(tests.direct)).toEqual(
      expect.arrayContaining([
        'pressbase_seo_search_engines',
        'pressbase_seo_representation',
        'pressbase_seo_sitemap',
      ]),
    );
    expect((await tests.direct.pressbase_seo_search_engines!.test()).status).toBe('good');
    expect((await tests.direct.pressbase_seo_representation!.test()).status).toBe('recommended');
    await ctx.request('POST', '/wp/v2/settings', { blog_public: false });
    expect((await tests.direct.pressbase_seo_search_engines!.test()).status).toBe('critical');
    expect((await tests.direct.pressbase_seo_sitemap!.test()).status).toBe('recommended');
  });
});
