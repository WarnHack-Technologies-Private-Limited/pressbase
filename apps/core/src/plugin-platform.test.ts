import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PURGE_ACTION } from './cache/invalidation';
import { setup } from './test-utils';

/**
 * The v0.7 plugin API gaps on the server (docs/plans/first-party-plugins.md):
 * registered meta in REST (1), early request hooks and the page cache (5,
 * ADR 0017), canonical and head output (6), cache purges (7), plugin tables
 * (8) and plugin files at the site root (9). See docs/architecture/plugins.md.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  const purges: { tags: string[]; reason: string }[] = [];
  ctx.kernel.hooks.addAction(PURGE_ACTION, async (tags, reason) => {
    purges.push({ tags, reason });
  });
  return { ...ctx, purges };
}

async function plugin(
  ctx: Ctx,
  slug: string,
  files: Record<string, string>,
  manifest: Record<string, unknown> = {},
) {
  const dir = path.join(ctx.dataDir, 'plugins', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ name: slug, title: slug, version: '1.0.0', main: 'index.js', ...manifest }),
  );
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
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

async function publish(ctx: Ctx, title: string) {
  const res = await ctx.request('POST', '/wp/v2/posts', { title, status: 'publish' });
  expect(res.status).toBe(201);
  return res.body as { id: number; link: string; slug: string };
}

/* ------------------------------------------------------------------- meta */

const SEO_META = `
export default function register(api) {
  // Yoast's keys: protected (leading _), so editing them needs an auth callback.
  api.meta.registerPostMeta('', '_yoast_wpseo_title', {
    type: 'string',
    single: true,
    showInRest: true,
    sanitizeCallback: (value) => String(value).trim(),
    authCallback: () => true,
  });
  // Protected and no auth callback: shown, but nobody can change it through REST.
  api.meta.registerPostMeta('post', '_yoast_wpseo_metadesc', { single: true, showInRest: true });
  api.meta.registerPostMeta('post', 'reading_level', {
    type: 'integer',
    single: true,
    default: 3,
    showInRest: { schema: { minimum: 1, maximum: 5 } },
  });
  // A multi key: one row per value, a list in REST (type is the type of each value).
  api.meta.registerPostMeta('post', 'pb_keywords', { type: 'string', showInRest: true });
  api.meta.registerPostMeta('post', 'not_in_rest', { single: true });
  api.meta.registerTermMeta('category', '_yoast_wpseo_bctitle', {
    single: true,
    showInRest: true,
    authCallback: () => true,
  });
}
`;

describe('registered meta (register_post_meta, register_term_meta)', () => {
  it('shows registered keys under meta, with defaults, and hides the rest', async () => {
    const ctx = await site();
    await plugin(ctx, 'seo', { 'index.js': SEO_META });
    await ctx.kernel.plugins.activate('seo');
    const post = await publish(ctx, 'Meta');

    const res = await ctx.client().request('GET', `/wp/v2/posts/${post.id}`);
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({
      _yoast_wpseo_title: '',
      _yoast_wpseo_metadesc: '',
      reading_level: 3,
      pb_keywords: [],
    });
    // A key registered for posts only isn't on pages; one for every type is.
    const page = await ctx.request('POST', '/wp/v2/pages', { title: 'P', status: 'publish' });
    expect(page.body.meta).toEqual({ _yoast_wpseo_title: '' });
    expect(await ctx.kernel.meta.get('post', post.id, 'reading_level', true)).toBe(3);
  });

  it('writes protected keys only with an auth callback, and checks the user can edit the post', async () => {
    const ctx = await site();
    await plugin(ctx, 'seo', { 'index.js': SEO_META });
    await ctx.kernel.plugins.activate('seo');
    const post = await publish(ctx, 'Protected');

    // The administrator: the auth callback allows _yoast_wpseo_title, sanitised on the way in.
    const ok = await ctx.request('POST', `/wp/v2/posts/${post.id}`, {
      meta: { _yoast_wpseo_title: '  %%title%% %%sep%% %%sitename%%  ' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.meta._yoast_wpseo_title).toBe('%%title%% %%sep%% %%sitename%%');
    expect(await ctx.kernel.meta.get('post', post.id, '_yoast_wpseo_title', true)).toBe(
      '%%title%% %%sep%% %%sitename%%',
    );

    // No auth callback on a protected key: refused, even for an administrator, and nothing saved.
    const refused = await ctx.request('POST', `/wp/v2/posts/${post.id}`, {
      title: 'Changed',
      meta: { _yoast_wpseo_metadesc: 'A description' },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('rest_cannot_update');
    expect(refused.body.message).toBe(
      'Sorry, you are not allowed to edit the _yoast_wpseo_metadesc custom field.',
    );
    expect((await ctx.kernel.posts.get(post.id))?.title).toBe('Protected');
    expect(await ctx.kernel.meta.get('post', post.id, '_yoast_wpseo_metadesc')).toEqual([]);

    // Logged out: 401. A contributor on someone else's post: edit_post fails first.
    const anon = await ctx.client().request('POST', `/wp/v2/posts/${post.id}`, {
      meta: { _yoast_wpseo_title: 'x' },
    });
    expect(anon.status).toBe(401);
    const contributor = await ctx.loginAs('carla', 'contributor');
    const other = await contributor.request('POST', `/wp/v2/posts/${post.id}`, {
      meta: { _yoast_wpseo_title: 'x' },
    });
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('rest_cannot_edit');

    // On her own draft the auth callback lets her set it, on create too.
    const own = await contributor.request('POST', '/wp/v2/posts', {
      title: 'Mine',
      meta: { _yoast_wpseo_title: 'My title' },
    });
    expect(own.status).toBe(201);
    expect(own.body.meta._yoast_wpseo_title).toBe('My title');

    // map_meta_cap() directly.
    const { currentUserCan } = await import('./auth/meta-caps');
    const admin = {
      id: 1,
      capabilities: { edit_posts: true, edit_others_posts: true, edit_published_posts: true },
    };
    expect(
      await currentUserCan(
        ctx.kernel,
        admin as never,
        'edit_post_meta',
        post.id,
        '_yoast_wpseo_title',
      ),
    ).toBe(true);
    expect(
      await currentUserCan(ctx.kernel, admin as never, 'edit_post_meta', post.id, '_edit_lock'),
    ).toBe(false);
    expect(
      await currentUserCan(ctx.kernel, admin as never, 'edit_post_meta', post.id, 'open_key'),
    ).toBe(true);
  });

  it('validates against the schema, coerces loose input, and deletes with null', async () => {
    const ctx = await site();
    await plugin(ctx, 'seo', { 'index.js': SEO_META });
    await ctx.kernel.plugins.activate('seo');
    const post = await publish(ctx, 'Schema');
    const url = `/wp/v2/posts/${post.id}`;

    const bad = await ctx.request('POST', url, { meta: { reading_level: 'hard' } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('rest_invalid_param');
    expect(bad.body.data.params.meta).toBe('meta.reading_level is not of type integer.');
    const tooHigh = await ctx.request('POST', url, { meta: { reading_level: 9 } });
    expect(tooHigh.status).toBe(400);

    const coerced = await ctx.request('POST', url, {
      meta: { reading_level: '4', pb_keywords: ['seo', 'meta'], unknown_key: 'ignored' },
    });
    expect(coerced.status).toBe(200);
    expect(coerced.body.meta.reading_level).toBe(4);
    expect(coerced.body.meta.pb_keywords).toEqual(['seo', 'meta']);
    expect(coerced.body.meta.unknown_key).toBeUndefined();
    expect(await ctx.kernel.meta.get('post', post.id, 'pb_keywords')).toEqual(['seo', 'meta']);

    const cleared = await ctx.request('POST', url, {
      meta: { reading_level: null, pb_keywords: [] },
    });
    expect(cleared.body.meta.reading_level).toBe(3);
    expect(cleared.body.meta.pb_keywords).toEqual([]);

    // A stored value that doesn't fit the schema reads as null (prepare_value()).
    await ctx.kernel.meta.update('post', post.id, 'reading_level', 'not a number');
    const read = await ctx.request('GET', url);
    expect(read.body.meta.reading_level).toBeNull();
  });

  it('purges the post’s pages when its meta changes, and takes everything back on deactivation', async () => {
    const ctx = await site();
    await plugin(ctx, 'seo', { 'index.js': SEO_META });
    await ctx.kernel.plugins.activate('seo');
    const post = await publish(ctx, 'Purged');
    ctx.purges.length = 0;
    await ctx.request('POST', `/wp/v2/posts/${post.id}`, { meta: { _yoast_wpseo_title: 'T' } });
    expect(ctx.purges.flatMap((p) => p.tags)).toContain(`post:${post.id}`);
    expect(ctx.purges.map((p) => p.reason)).toContain('added_post_meta');

    await ctx.kernel.plugins.deactivate('seo');
    const res = await ctx.request('GET', `/wp/v2/posts/${post.id}`);
    expect(res.body.meta).toEqual({});
    expect(ctx.kernel.meta.registered('post', 'post').size).toBe(0);
    expect(ctx.kernel.hooks.hasFilter('auth_post_meta__yoast_wpseo_title')).toBe(false);
    // The stored value stays, as WordPress keeps meta of deactivated plugins.
    expect(await ctx.kernel.meta.get('post', post.id, '_yoast_wpseo_title', true)).toBe('T');
  });

  it('serves term meta at /wp/v2/categories', async () => {
    const ctx = await site();
    await plugin(ctx, 'seo', { 'index.js': SEO_META });
    await ctx.kernel.plugins.activate('seo');
    const created = await ctx.request('POST', '/wp/v2/categories', {
      name: 'News',
      meta: { _yoast_wpseo_bctitle: 'Latest news' },
    });
    expect(created.status).toBe(201);
    expect(created.body.meta).toEqual({ _yoast_wpseo_bctitle: 'Latest news' });
    const list = await ctx.client().request('GET', '/wp/v2/categories?slug=news');
    expect(list.body[0].meta._yoast_wpseo_bctitle).toBe('Latest news');
    // Tags have no registered meta: still WordPress's empty list.
    const tag = await ctx.request('POST', '/wp/v2/tags', { name: 'x' });
    expect(tag.body.meta).toEqual([]);
    const author = await ctx.loginAs('ann', 'author');
    const denied = await author.request('POST', `/wp/v2/categories/${created.body.id}`, {
      meta: { _yoast_wpseo_bctitle: 'No' },
    });
    expect(denied.status).toBe(403);
  });

  it('refuses array meta in REST without an item schema, and defaults that don’t match', async () => {
    const ctx = await site();
    expect(() =>
      ctx.kernel.meta.register('post', 'list', { type: 'array', showInRest: true }),
    ).toThrow(/show_in_rest|showInRest\.schema\.items/);
    expect(() =>
      ctx.kernel.meta.register('post', 'count', { type: 'integer', default: 'many' }),
    ).toThrow(/must match the type/);
  });
});

/* -------------------------------------------- template_redirect and 404s */

const REDIRECTS = `
export default function register(api) {
  api.hooks.addAction('template_redirect', async (request) => {
    const redirects = await api.options.get('map', {});
    const target = redirects[request.path];
    if (target === 410) request.notFound(410);
    else if (target) request.redirect(target, 301);
    if (request.path === '/needs-main/') {
      const main = await request.main();
      globalThis.__mainWas404 = main.is404;
    }
  });
  api.hooks.addFilter('pre_handle_404', (preempt, main, url) =>
    url.pathname === '/virtual/' ? true : preempt,
  );
  api.hooks.addAction('pressbase_404', (request) => {
    globalThis.__notFound.push({ path: request.path, query: request.query, referrer: request.referrer });
  });
  api.rest.registerRoute('redirects/v1', '/add', {
    methods: 'POST',
    permission: (c) => api.rest.userCan(c, 'manage_options'),
    handler: async (c) => {
      const { from, to } = await c.req.json();
      await api.options.set('map', { ...(await api.options.get('map', {})), [from]: to });
      await api.cache.purgePaths([from]);
      return { ok: true };
    },
  });
}
`;

declare global {
  var __notFound: { path: string; query: string; referrer: string }[];
  var __mainWas404: boolean | undefined;
}

describe('template_redirect, pre_handle_404 and pressbase_404', () => {
  it('lets a plugin redirect before anything renders, even a live post, purging its path', async () => {
    globalThis.__notFound = [];
    const ctx = await site();
    await plugin(ctx, 'redirects', { 'index.js': REDIRECTS });
    await ctx.kernel.plugins.activate('redirects');
    const post = await publish(ctx, 'Old address');
    const oldPath = new URL(post.link).pathname;

    const before = await render(ctx, oldPath);
    expect(before.status).toBe(200);
    // Every answer carries its path's tag, so a purge can reach it (ADR 0017).
    expect(before.tags).toContain(`path:${oldPath.replace(/\/$/, '')}`);

    ctx.purges.length = 0;
    const added = await ctx.request('POST', '/redirects/v1/add', {
      from: oldPath,
      to: 'https://example.com/new/',
    });
    expect(added.status).toBe(200);
    expect(ctx.purges).toContainEqual({
      tags: [`path:${oldPath.replace(/\/$/, '')}`],
      reason: 'plugin:redirects',
    });

    const after = await render(ctx, `${oldPath}?utm=1`);
    expect(after.status).toBe(301);
    expect(after.headers.location).toBe('https://example.com/new/');
    expect(after.tags).toContain(`path:${oldPath.replace(/\/$/, '')}`);

    // Redirects run before robots.txt, sitemaps and feeds too, as in template-loader.php.
    await ctx.request('POST', '/redirects/v1/add', { from: '/feed/', to: '/news/' });
    expect((await render(ctx, '/feed/')).status).toBe(301);

    // 410 Gone renders the theme's not-found page, without the 404 action.
    await ctx.request('POST', '/redirects/v1/add', { from: '/gone/', to: 410 });
    const gone = await render(ctx, '/gone/');
    expect(gone.status).toBe(410);
    expect(gone.html).toContain('<!DOCTYPE html>');
    expect(globalThis.__notFound).toEqual([]);
  });

  it('refuses unsafe locations', async () => {
    const { TemplateRedirect, sanitizeRedirect } = await import('./frontend/template-redirect');
    expect(sanitizeRedirect('/ok/\r\nSet-Cookie: x')).toBe('/ok/Set-Cookie:%20x');
    expect(sanitizeRedirect('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeRedirect('//evil.example/')).toBeUndefined();
    const request = new TemplateRedirect(new URL('http://x/a/'), '', null, async () => {
      throw new Error('not needed');
    });
    expect(request.redirect('ftp://example.com/')).toBe(false);
    expect(request.redirect('/b/', 301)).toBe(true);
    expect(request.redirect('/c/')).toBe(false); // the first answer wins
    expect(request.answer).toEqual({ kind: 'redirect', location: '/b/', status: 301 });
  });

  it('shares the main query with the render, and lets pre_handle_404 keep a page', async () => {
    globalThis.__notFound = [];
    const ctx = await site();
    await plugin(ctx, 'redirects', { 'index.js': REDIRECTS });
    await ctx.kernel.plugins.activate('redirects');
    globalThis.__mainWas404 = undefined;
    const missing = await render(ctx, '/needs-main/');
    expect(missing.status).toBe(404);
    expect(globalThis.__mainWas404).toBe(true);

    const virtual = await render(ctx, '/virtual/');
    expect(virtual.status).toBe(200);
  });

  it('fires pressbase_404 with the path and referrer, and keeps those 404s out of the page cache', async () => {
    globalThis.__notFound = [];
    const ctx = await site();
    const plain = await render(ctx, '/nothing-here/');
    expect(plain.status).toBe(404);
    expect(plain.headers['cache-control']).toBe('public, max-age=0, must-revalidate');

    await plugin(ctx, 'redirects', { 'index.js': REDIRECTS });
    await ctx.kernel.plugins.activate('redirects');
    const logged = await render(ctx, '/nothing-here/?from=mail', {
      referer: 'https://example.org/links',
    });
    expect(logged.status).toBe(404);
    expect(logged.headers['cache-control']).toBe('no-store');
    // A sitemap that doesn't exist is a 404 too.
    await render(ctx, '/wp-sitemap-posts-nothing-1.xml');
    expect(globalThis.__notFound).toEqual([
      { path: '/nothing-here/', query: 'from=mail', referrer: 'https://example.org/links' },
      { path: '/wp-sitemap-posts-nothing-1.xml', query: '', referrer: '' },
    ]);
  });
});

/* ------------------------------------------------ canonical and wp_head */

const HEAD = `
export default function register(api) {
  api.hooks.removeAction('wp_head', 'rel_canonical');
  api.hooks.addAction('wp_head', async (out, page) => {
    const object = page.main.queriedObject;
    if (object && object.kind === 'post') {
      out.print('<link rel="canonical" href="' + (await api.content.canonicalUrl(object.post)) + '" data-seo />');
    }
  }, 1);
  api.hooks.addFilter('get_canonical_url', (url) => url + '?ref=canonical');
}
`;

describe('canonical URLs and core head output', () => {
  it('lets a plugin replace core’s rel_canonical and restores it on deactivation', async () => {
    const ctx = await site();
    const post = await publish(ctx, 'Canonical');
    const path = new URL(post.link).pathname;
    const before = await render(ctx, path);
    expect(before.html).toContain(`<link rel="canonical" href="${post.link}" />`);
    expect(ctx.kernel.coreCallbacks.has('wp_head', 'rel_canonical')).toBe(1);

    await plugin(ctx, 'head', { 'index.js': HEAD });
    await ctx.kernel.plugins.activate('head');
    const taken = await render(ctx, path);
    expect(taken.html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(taken.html).toContain(
      `<link rel="canonical" href="${post.link}?ref=canonical" data-seo />`,
    );
    expect(ctx.kernel.coreCallbacks.has('wp_head', 'rel_canonical')).toBe(false);
    const api = ctx.kernel.plugins.runtime('head')?.api;
    expect(api?.hooks.removeAction('wp_head', 'no_such_callback')).toBe(false);
    const draft = await ctx.request('POST', '/wp/v2/posts', { title: 'Draft' });
    expect(await api?.content.canonicalUrl(draft.body.id)).toBe(false);
    expect(await api?.content.permalink(post.id)).toBe(post.link);

    await ctx.kernel.plugins.deactivate('head');
    const restored = await render(ctx, path);
    expect(restored.html).toContain(`<link rel="canonical" href="${post.link}" />`);
    // Back in its place: after the title, before the feed links.
    expect(restored.html.indexOf('rel="canonical"')).toBeGreaterThan(
      restored.html.indexOf('<title>'),
    );
    expect(restored.html.indexOf('rel="canonical"')).toBeLessThan(
      restored.html.indexOf('application/rss+xml'),
    );
  });
});

/* ------------------------------------------------------------ api.cache */

describe('api.cache', () => {
  it('purges tags and paths, and checks them', async () => {
    const ctx = await site();
    await plugin(ctx, 'purger', { 'index.js': 'export default function () {}' });
    await ctx.kernel.plugins.activate('purger');
    const api = ctx.kernel.plugins.runtime('purger')?.api;
    ctx.purges.length = 0;
    await api?.cache.purge(['site', 'post:1', 'site']);
    await api?.cache.purgePaths(['/llms.txt', '/a/b/']);
    expect(ctx.purges).toEqual([
      { tags: ['site', 'post:1'], reason: 'plugin:purger' },
      { tags: ['path:/llms.txt', 'path:/a/b'], reason: 'plugin:purger' },
    ]);
    expect(api?.cache.pathTag('/caf%C3%A9/?x=1')).toBe('path:/caf%C3%A9');
    await expect(api?.cache.purge(['has space'])).rejects.toThrow(/isn't a cache tag/);
  });
});

/* -------------------------------------------- plugin files at the root */

const FILES = `
export default function register(api) {
  api.public.addFile('/llms.txt', async () => {
    const { posts } = await api.content.query({ post_type: 'post', posts_per_page: 5 });
    return '# ' + api.plugin.title + '\\n' + posts.map((p) => '- ' + p.title).join('\\n');
  });
  api.public.addFile('/.well-known/pressbase.json', () => ({ body: '{"ok":true}', headers: { 'x-robots-tag': 'noindex' } }));
  api.public.addFile('/missing.txt', () => null);
  api.public.addFile('/broken.txt', () => { throw new Error('file broke'); });
  api.public.addFile('/fresh.txt', () => String(Date.now()), { cache: false });
}
`;

describe('api.public.addFile', () => {
  it('serves files at fixed root paths while the plugin is active', async () => {
    const ctx = await site();
    await publish(ctx, 'Listed post');
    await plugin(ctx, 'files', { 'index.js': FILES });
    await ctx.kernel.plugins.activate('files');

    const llms = await render(ctx, '/llms.txt');
    expect(llms.status).toBe(200);
    expect(llms.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(llms.html).toContain('- Listed post');
    // Cached with what it read: a new post purges posts:post, and so the file.
    expect(llms.tags).toEqual(expect.arrayContaining(['site', 'path:/llms.txt', 'posts:post']));

    const json = await render(ctx, '/.well-known/pressbase.json');
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(json.headers['x-robots-tag']).toBe('noindex');
    expect((await render(ctx, '/missing.txt')).status).toBe(404);
    const broken = await render(ctx, '/broken.txt');
    expect(broken.status).toBe(500);
    expect((await render(ctx, '/fresh.txt')).headers['cache-control']).toBe('private, no-store');

    await ctx.kernel.plugins.deactivate('files');
    expect((await render(ctx, '/llms.txt')).status).toBe(404);
  });

  it('refuses core’s paths and another plugin’s', async () => {
    const ctx = await site();
    const { publicFilePathProblem } = await import('./frontend/public-files');
    for (const path of [
      '/robots.txt',
      '/wp-sitemap.xml',
      '/wp-sitemap-posts-post-1.xml',
      '/wp-anything.txt',
      '/admin/x.txt',
      '/feed',
      '/a/../b.txt',
      'no-slash.txt',
      '/dir/',
    ]) {
      expect(publicFilePathProblem(path), path).toBeDefined();
    }
    expect(publicFilePathProblem('/llms.txt')).toBeUndefined();
    expect(publicFilePathProblem('/0123abcd.txt')).toBeUndefined();

    await plugin(ctx, 'one', {
      'index.js': `export default (api) => api.public.addFile('/llms.txt', () => 'one');`,
    });
    await plugin(ctx, 'two', {
      'index.js': `export default (api) => api.public.addFile('/llms.txt', () => 'two');`,
    });
    await plugin(ctx, 'three', {
      'index.js': `export default (api) => api.public.addFile('/robots.txt', () => 'mine');`,
    });
    await ctx.kernel.plugins.activate('one');
    await expect(ctx.kernel.plugins.activate('two')).rejects.toThrow(/already served by one/);
    await expect(ctx.kernel.plugins.activate('three')).rejects.toThrow(/belongs to Pressbase/);
    expect((await render(ctx, '/robots.txt')).html).toContain('User-agent: *');
  });
});

/* -------------------------------------------------- plugin tables at scale */

const TABLES = `
export default function register(api) {}
`;

describe('plugin tables', () => {
  it('runs migrations with indexes, and api.db.query gives rows on any driver', async () => {
    const ctx = await site();
    await plugin(
      ctx,
      'redirector',
      {
        'index.js': TABLES,
        'migrations/0001-redirects.sql': `
create table redirector_redirects (
  id bigserial primary key,
  source text not null,
  target text not null,
  status smallint not null default 301,
  hits bigint not null default 0,
  last_hit timestamptz
);
create unique index redirector_redirects_source_idx on redirector_redirects (source);
create index redirector_redirects_last_hit_idx on redirector_redirects (last_hit);`,
      },
      { permissions: ['database'], migrations: 'migrations' },
    );
    await ctx.kernel.plugins.activate('redirector', { permissions: ['database'] });
    const db = ctx.kernel.plugins.runtime('redirector')?.api.db;
    if (!db) throw new Error('no database access');
    const { sql } = db;

    const indexes = await db.query<{ indexname: string }>(
      sql`select indexname from pg_indexes where tablename = 'redirector_redirects' order by indexname`,
    );
    expect(indexes.map((i) => i.indexname)).toEqual([
      'redirector_redirects_last_hit_idx',
      'redirector_redirects_pkey',
      'redirector_redirects_source_idx',
    ]);

    for (let i = 1; i <= 25; i++) {
      await db.query(
        sql`insert into redirector_redirects (source, target, last_hit)
            values (${`/old-${i}/`}, ${`/new-${i}/`}, ${new Date(Date.UTC(2026, 0, i)).toISOString()})`,
      );
    }
    // The unique index refuses a second rule for a source…
    await expect(
      db.query(sql`insert into redirector_redirects (source, target) values ('/old-1/', '/x/')`),
    ).rejects.toThrow();
    // …and makes an upsert one statement.
    const [hit] = await db.query<{ hits: string | number }>(
      sql`insert into redirector_redirects (source, target) values ('/old-1/', '/x/')
          on conflict (source) do update set hits = redirector_redirects.hits + 1
          returning hits`,
    );
    expect(Number(hit?.hits)).toBe(1);

    // Keyset pagination: "after the last id", never OFFSET.
    const pages: number[][] = [];
    let after = 0;
    for (;;) {
      const rows = await db.query<{ id: string | number }>(
        sql`select id from redirector_redirects where id > ${after} order by id limit 10`,
      );
      if (!rows.length) break;
      pages.push(rows.map((r) => Number(r.id)));
      after = Number(rows.at(-1)?.id);
    }
    expect(pages.map((p) => p.length)).toEqual([10, 10, 5]);

    // Pruning in small batches (what a daily cron event runs).
    const pruned = await db.query(
      sql`delete from redirector_redirects where id in (
            select id from redirector_redirects where last_hit < ${'2026-01-11T00:00:00Z'}
            order by last_hit limit 1000)
          returning id`,
    );
    expect(pruned).toHaveLength(10);
  });
});
