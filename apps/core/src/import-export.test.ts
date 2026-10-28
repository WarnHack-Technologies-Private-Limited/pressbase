import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { schema } from '@pressbase/db';
import { and, asc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportWxr, generateWxr } from './import-export/exporter';
import { sampleWxr } from './import-export/fixture';
import { menuItemFromPost } from './import-export/menus';
import {
  isSerialized,
  maybeUnserialize,
  metaToWordPress,
  phpSerialize,
} from './import-export/php-serialize';
import { emptyPost } from './import-export/records';
import { fetchRemoteFile, isPrivateAddress, RemoteFileError } from './import-export/remote-file';
import { createRewriter } from './import-export/rewrite';
import { importWxr } from './import-export/service';
import { scanWxr, WxrReader } from './import-export/wxr-reader';
import { SITE, setup, type TestResponse } from './test-utils';

type Ctx = Awaited<ReturnType<typeof setup>>;

/* ------------------------------------------------------------ a file server */

let server: Server;
let mediaBase = '';
let png: Buffer;
let requests: string[] = [];

beforeAll(async () => {
  png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3a7d44' } })
    .png()
    .toBuffer();
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/wp-content/uploads/2019/05/garden-bed.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      res.end(png);
    } else if (req.url === '/redirect-private') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    } else if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
    } else if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(4096, 1));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mediaBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* --------------------------------------------------------------- helpers */

async function cookieFor(ctx: Ctx, login: string, password: string): Promise<string> {
  const res = await ctx.app.request('/wp-json/pressbase/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pressbase-request': '1' },
    body: JSON.stringify({ login, password }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function site(options: { allowPrivate?: boolean } = {}) {
  const ctx = await setup({ import: { allowPrivateHosts: options.allowPrivate ?? true } });
  await ctx.install();
  // Start empty: no sample post, page or comment.
  for (const post of await ctx.kernel.db.select().from(schema.posts))
    await ctx.kernel.posts.delete(post.id);
  const cookie = await cookieFor(ctx, SITE.username, SITE.password);
  return { ...ctx, cookie };
}

async function uploadXml(ctx: Ctx, cookie: string, xml: string): Promise<TestResponse> {
  const res = await ctx.app.request('/wp-json/pressbase/v1/import', {
    method: 'POST',
    headers: {
      cookie,
      'x-pressbase-request': '1',
      'content-type': 'application/xml',
      'content-disposition': 'attachment; filename="garden.WordPress.2026-10-01.xml"',
    },
    body: xml,
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

/** Uploads, starts and runs an import through the REST API and the job queue. */
async function runRestImport(
  ctx: Awaited<ReturnType<typeof site>>,
  xml: string,
  start: Record<string, unknown> = { fetch_attachments: true },
) {
  const uploaded = await uploadXml(ctx, ctx.cookie, xml);
  expect(uploaded.status).toBe(201);
  const started = await ctx.request(
    'POST',
    `/pressbase/v1/import/${uploaded.body.id}/start`,
    start,
  );
  expect(started.status).toBe(202);
  expect(started.body.status).toBe('queued');
  // The site's daily cron events are due too; the import must not fail.
  const run = await ctx.kernel.jobs.runDue();
  expect(run.failed).toBe(0);
  const done = await ctx.request('GET', `/pressbase/v1/import/${uploaded.body.id}`);
  expect(done.status).toBe(200);
  return { uploaded: uploaded.body, done: done.body };
}

async function postByTitle(ctx: Ctx, type: string, title: string) {
  const [post] = await ctx.kernel.db
    .select()
    .from(schema.posts)
    .where(and(eq(schema.posts.type, type), eq(schema.posts.title, title)));
  return post;
}

async function meta(ctx: Ctx, postId: number, key: string) {
  return ctx.kernel.posts.getMeta(postId, key);
}

/* ------------------------------------------------------------- unit tests */

describe('PHP serialization', () => {
  it('reads what WordPress stores', () => {
    expect(maybeUnserialize('a:2:{i:0;s:1:"a";i:1;s:1:"b";}')).toEqual(['a', 'b']);
    expect(maybeUnserialize('a:2:{s:5:"width";i:1200;s:5:"sizes";a:0:{}}')).toEqual({
      width: 1200,
      sizes: [],
    });
    expect(maybeUnserialize('s:6:"Tomás";')).toBe('Tomás');
    expect(maybeUnserialize('b:1;')).toBe(true);
    expect(maybeUnserialize('d:0.5;')).toBe(0.5);
    expect(maybeUnserialize('N;')).toBeNull();
    expect(maybeUnserialize('O:8:"stdClass":1:{s:1:"a";i:1;}')).toEqual({ a: 1 });
    expect(maybeUnserialize('plain text')).toBe('plain text');
    expect(maybeUnserialize('42')).toBe('42');
  });

  it('keeps PHP-only values as the original string', () => {
    const object = 'O:6:"WP_Foo":1:{s:1:"a";i:1;}';
    expect(maybeUnserialize(object)).toBe(object);
    const broken = 'a:2:{i:0;s:9:"short";}';
    expect(maybeUnserialize(broken)).toBe(broken);
  });

  it('writes what WordPress reads, and round-trips', () => {
    expect(phpSerialize({ width: 10, file: 'é.jpg' })).toBe(
      'a:2:{s:5:"width";i:10;s:4:"file";s:6:"é.jpg";}',
    );
    expect(metaToWordPress(5)).toBe('5');
    expect(metaToWordPress(true)).toBe('1');
    expect(metaToWordPress(null)).toBe('');
    expect(metaToWordPress('a:1:{i:0;i:1;}')).toBe('s:14:"a:1:{i:0;i:1;}";');
    const value = { sizes: { thumbnail: { file: 'x-150x150.jpg', width: 150 } }, list: [1, 'two'] };
    expect(maybeUnserialize(metaToWordPress(value))).toEqual(value);
    expect(maybeUnserialize(metaToWordPress('a:1:{i:0;i:1;}'))).toBe('a:1:{i:0;i:1;}');
    expect(isSerialized('i:5;')).toBe(true);
    expect(isSerialized('hello')).toBe(false);
  });
});

describe('WXR reader', () => {
  it('streams records from a file split into tiny chunks', async () => {
    const xml = sampleWxr('https://media.old.example');
    async function* chunks() {
      const bytes = Buffer.from(xml);
      for (let i = 0; i < bytes.length; i += 13) yield bytes.subarray(i, i + 13);
    }
    const records = [];
    for await (const record of new WxrReader(chunks()).records()) records.push(record);
    expect(records[0]).toMatchObject({
      kind: 'site',
      site: { wxr_version: '1.2', base_blog_url: 'https://old.example' },
    });
    const authors = records.filter((r) => r.kind === 'author');
    expect(authors.map((a) => a.kind === 'author' && a.author.author_display_name)).toEqual([
      'Maria Okafor',
      'Tomás Lind',
    ]);
    const terms = records.flatMap((r) => (r.kind === 'term' ? [r.term] : []));
    expect(terms.map((t) => `${t.term_taxonomy}:${t.slug}:${t.term_parent}`)).toEqual([
      'category:vegetables:',
      'category:tomatoes:vegetables',
      'post_tag:spring:',
      'nav_menu:main-menu:',
      'soil_type:loam:',
    ]);
    expect(terms[0]?.termmeta).toEqual([{ key: 'colour', value: 'green' }]);
    const posts = records.flatMap((r) => (r.kind === 'post' ? [r.post] : []));
    const first = posts[0];
    expect(first?.post_title).toBe('Raised bed in & out');
    expect(first?.post_content).toContain(']]> done.');
    expect(first?.is_sticky).toBe(true);
    expect(first?.terms).toContainEqual({
      domain: 'post_format',
      slug: 'post-format-gallery',
      name: 'Gallery',
    });
    expect(
      first?.comments.map((c) => [c.comment_id, c.comment_parent, c.comment_author_IP]),
    ).toEqual([
      [31, 0, '203.0.113.4'],
      [32, 31, ''],
    ]);
    expect(first?.comments[0]?.commentmeta).toEqual([{ key: 'rating', value: '5' }]);
    expect(posts.map((p) => p.post_type)).toEqual([
      'post',
      'page',
      'page',
      'attachment',
      'product',
      'nav_menu_item',
      'nav_menu_item',
      'nav_menu_item',
    ]);
  });

  it('summarises a file without importing it', async () => {
    const summary = await scanWxr({ xml: sampleWxr('https://media.old.example') });
    expect(summary.items).toBe(8);
    expect(summary.posts).toEqual({
      post: 1,
      page: 2,
      attachment: 1,
      product: 1,
      nav_menu_item: 3,
    });
    expect(summary.comments).toBe(2);
    expect(summary.authors.map((a) => a.author_login)).toEqual(['maria', 'tomas']);
  });

  it('refuses files that are not WXR', async () => {
    await expect(scanWxr({ xml: '<html><body>Hi</body></html>' })).rejects.toMatchObject({
      code: 'wxr_invalid',
    });
    await expect(
      scanWxr({ xml: '<rss><channel><title>A feed</title><item></item></channel></rss>' }),
    ).rejects.toMatchObject({
      code: 'wxr_invalid',
    });
  });

  it('reads classic menu items', () => {
    const post = {
      ...emptyPost(),
      post_id: 7,
      post_type: 'nav_menu_item',
      terms: [{ domain: 'nav_menu', slug: 'footer', name: 'Footer' }],
      postmeta: [
        { key: '_menu_item_type', value: 'taxonomy' },
        { key: '_menu_item_object', value: 'category' },
        { key: '_menu_item_object_id', value: '5' },
        { key: '_menu_item_classes', value: 'a:2:{i:0;s:4:"wide";i:1;s:0:"";}' },
      ],
    };
    expect(menuItemFromPost(post)).toMatchObject({
      menu: 'footer',
      type: 'taxonomy',
      objectId: 5,
      classes: ['wide'],
    });
    expect(menuItemFromPost({ ...post, terms: [] })).toBeUndefined();
  });
});

describe('content rewriting', () => {
  const rewrite = createRewriter({
    posts: new Map([
      [20, 120],
      [12, 112],
    ]),
    terms: new Map([[5, 105]]),
    urls: new Map([
      [
        'https://cdn.old.example/2019/05/doc.pdf',
        'http://new.example/wp-content/uploads/2019/05/doc.pdf',
      ],
    ]),
    sizePrefixes: new Map([
      [
        'https://old.example/wp-content/uploads/2019/05/photo',
        'http://new.example/wp-content/uploads/2019/05/photo-1',
      ],
    ]),
    oldBases: ['https://old.example'],
    newBase: 'http://new.example',
  });

  it('maps media URLs, sub-sizes, block IDs and links', () => {
    const html = [
      '<!-- wp:image {"id":20,"sizeSlug":"large"} -->',
      '<figure><img src="https://old.example/wp-content/uploads/2019/05/photo-300x200.jpg" class="wp-image-20"/></figure>',
      '<!-- /wp:image -->',
      '<a href="https://cdn.old.example/2019/05/doc.pdf">PDF</a>',
      '<a href="http://old.example/?page_id=12#top">About</a>.',
      '<a href="https://old.example/2019/05/hello/">Hello</a>',
      '<a href="https://old.example/?p=999">Unknown</a>',
      '<a href="https://old.example.community/">Elsewhere</a>',
      '<!-- wp:navigation-link {"label":"Veg","type":"category","id":5,"kind":"taxonomy","url":"https://old.example/category/veg/"} /-->',
      '<img src="https://old.example/wp-content/uploads/2019/05/photo2.jpg">',
    ].join('\n');
    const out = rewrite(html);
    expect(out).toContain('<!-- wp:image {"id":120,"sizeSlug":"large"} -->');
    expect(out).toContain(
      'src="http://new.example/wp-content/uploads/2019/05/photo-1-300x200.jpg" class="wp-image-120"',
    );
    expect(out).toContain('href="http://new.example/wp-content/uploads/2019/05/doc.pdf"');
    expect(out).toContain('href="http://new.example/?page_id=112#top">About</a>.');
    expect(out).toContain('href="http://new.example/2019/05/hello/"');
    expect(out).toContain('href="https://old.example/?p=999"');
    expect(out).toContain('href="https://old.example.community/"');
    expect(out).toContain('"id":105,"kind":"taxonomy","url":"http://new.example/category/veg/"');
    // photo2 isn't a sub-size of photo: only its address changes.
    expect(out).toContain('src="http://new.example/wp-content/uploads/2019/05/photo2.jpg"');
  });
});

describe('downloading attachments', () => {
  it('knows private addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946', '8.8.8.8']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('refuses private hosts, unsafe ports and other schemes by default', async () => {
    await expect(
      fetchRemoteFile(`${mediaBase}/wp-content/uploads/2019/05/garden-bed.png`, { maxBytes: 1e6 }),
    ).rejects.toMatchObject({
      code: 'import_unsafe_port',
    });
    await expect(
      fetchRemoteFile(`${mediaBase}/x.png`, {
        maxBytes: 1e6,
        safePorts: [Number(new URL(mediaBase).port)],
      }),
    ).rejects.toMatchObject({ code: 'import_private_host' });
    await expect(
      fetchRemoteFile('http://localhost/x.png', { maxBytes: 1e6 }),
    ).rejects.toMatchObject({
      code: 'import_private_host',
    });
    await expect(fetchRemoteFile('http://[::1]/x.png', { maxBytes: 1e6 })).rejects.toMatchObject({
      code: 'import_private_host',
    });
    await expect(fetchRemoteFile('file:///etc/passwd', { maxBytes: 1e6 })).rejects.toMatchObject({
      code: 'import_invalid_url',
    });
    // http_request_host_is_external can vouch for a host.
    const file = await fetchRemoteFile(`${mediaBase}/wp-content/uploads/2019/05/garden-bed.png`, {
      maxBytes: 1e6,
      hostIsExternal: (host) => host === '127.0.0.1',
    });
    expect(file.data.byteLength).toBe(png.length);
  });

  it('caps size and redirects, and checks every redirect', async () => {
    const allow = { allowPrivate: true };
    const file = await fetchRemoteFile(`${mediaBase}/wp-content/uploads/2019/05/garden-bed.png`, {
      maxBytes: 1e6,
      ...allow,
    });
    expect(file).toMatchObject({ filename: 'garden-bed.png', contentType: 'image/png' });
    await expect(
      fetchRemoteFile(`${mediaBase}/big`, { maxBytes: 1000, ...allow }),
    ).rejects.toMatchObject({
      code: 'import_file_too_big',
    });
    await expect(
      fetchRemoteFile(`${mediaBase}/loop`, { maxBytes: 1000, ...allow }),
    ).rejects.toMatchObject({
      code: 'import_too_many_redirects',
    });
    await expect(
      fetchRemoteFile(`${mediaBase}/missing`, { maxBytes: 1000, ...allow }),
    ).rejects.toBeInstanceOf(RemoteFileError);
    // Allowed to reach 127.0.0.1 through a vouched host, but the redirect to a metadata address isn't.
    await expect(
      fetchRemoteFile(`${mediaBase}/redirect-private`, {
        maxBytes: 1000,
        safePorts: [80, Number(new URL(mediaBase).port)],
        hostIsExternal: (host) => host === '127.0.0.1',
      }),
    ).rejects.toMatchObject({ code: 'import_private_host' });
  });
});

/* --------------------------------------------------------- the REST flow */

describe('importing a WXR file', () => {
  it('uploads, lists authors and counts what is in the file', async () => {
    const ctx = await site();
    const res = await uploadXml(ctx, ctx.cookie, sampleWxr(mediaBase));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      filename: 'garden.WordPress.2026-10-01.xml',
      status: 'uploaded',
      site: { title: 'Kitchen Garden Notes', url: 'https://old.example', wxr_version: '1.2' },
      counts: { items: 8, comments: 2 },
      unsupported_types: ['product'],
      can_create_users: true,
      can_fetch_attachments: true,
    });
    expect(res.body.authors).toEqual([
      { login: 'maria', email: 'maria@old.example', display_name: 'Maria Okafor' },
      { login: 'tomas', email: 'tomas@old.example', display_name: 'Tomás Lind' },
    ]);
    expect(res.body.users.map((u: { login: string }) => u.login)).toContain('admin');

    const list = await ctx.request('GET', '/pressbase/v1/import');
    expect(list.body.map((s: { id: string }) => s.id)).toEqual([res.body.id]);

    const bad = await uploadXml(ctx, ctx.cookie, '<html>not an export</html>');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('wxr_invalid');

    const deleted = await ctx.request('DELETE', `/pressbase/v1/import/${res.body.id}`);
    expect(deleted.status).toBe(200);
    expect((await ctx.request('GET', `/pressbase/v1/import/${res.body.id}`)).status).toBe(404);
  });

  it('is for people who can import', async () => {
    const ctx = await site();
    const editor = await ctx.loginAs('ed', 'editor');
    expect((await editor.request('GET', '/pressbase/v1/import')).status).toBe(403);
    // Only administrators hold `import` and `export`, as in WordPress.
    expect((await editor.request('GET', '/pressbase/v1/export')).status).toBe(403);
    ctx.clearCookie();
    expect((await ctx.request('GET', '/pressbase/v1/import')).status).toBe(401);
    expect((await ctx.request('GET', '/pressbase/v1/import/abc')).status).toBe(401);
  });

  it('imports everything as a background job, with a report', async () => {
    const ctx = await site();
    const { kernel } = ctx;
    const fired: string[] = [];
    kernel.hooks.addAction('import_start', () => void fired.push('import_start'));
    kernel.hooks.addAction('import_end', () => void fired.push('import_end'));
    kernel.hooks.addFilter('wp_import_post_data_raw', (post) => {
      fired.push(`raw:${post.post_id}`);
      return post;
    });
    requests = [];
    const { done } = await runRestImport(ctx, sampleWxr(mediaBase), {
      fetch_attachments: true,
      authors: { maria: { action: 'create' }, tomas: { action: 'map', user_id: 1 } },
    });
    expect(fired).toContain('import_start');
    expect(fired.at(-1)).toBe('import_end');
    expect(fired).toContain('raw:10');

    expect(done.status).toBe('completed');
    expect(done.progress).toMatchObject({ phase: 'done', done: 8, total: 8 });
    const report = done.report;
    expect(report.imported).toEqual({
      users: 1,
      terms: 5, // vegetables, tomatoes, spring, and compost and the gallery format, created with the post
      posts: { post: 1, page: 2, attachment: 1 },
      comments: 2,
      menus: 1,
    });
    expect(report.skippedPostTypes).toEqual({ product: 1 });
    expect(report.skippedTaxonomies).toEqual({ soil_type: 1 });
    expect(report.errors).toEqual({ total: 0, items: [] });
    expect(
      report.skipped.items.map((i: { code: string; title: string }) => `${i.code}:${i.title}`),
    ).toEqual(['invalid_taxonomy:Loam', 'invalid_post_type:Seed tray']);
    expect(requests).toEqual(['/wp-content/uploads/2019/05/garden-bed.png']);

    // Authors: a new user for maria, tomas mapped to the administrator.
    const [maria] = await kernel.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.login, 'maria'));
    expect(maria).toMatchObject({ email: 'maria@old.example', displayName: 'Maria Okafor' });

    // Terms, with their parent and meta.
    const veg = (await kernel.terms.list('category', { slug: ['vegetables'] })).terms[0];
    const tomatoes = (await kernel.terms.list('category', { slug: ['tomatoes'] })).terms[0];
    expect(tomatoes?.parent).toBe(veg?.id);
    expect(veg?.description).toBe('Everything that grows in beds');
    const [colour] = await kernel.db
      .select()
      .from(schema.termmeta)
      .where(eq(schema.termmeta.termId, veg?.id ?? 0));
    expect(colour).toMatchObject({ key: 'colour', value: 'green' });

    // The post.
    const post = await postByTitle(ctx, 'post', 'Raised bed in & out');
    expect(post).toMatchObject({
      slug: 'raised-bed',
      status: 'publish',
      authorId: maria?.id,
      commentStatus: 'open',
      guid: 'https://old.example/?p=10',
      date: new Date('2019-05-10T08:30:00Z'),
      modified: new Date('2019-06-01T10:00:00Z'),
      commentCount: 2,
    });
    const postId = post?.id ?? 0;
    const terms = await kernel.db
      .select({ taxonomy: schema.termTaxonomy.taxonomy, slug: schema.terms.slug })
      .from(schema.termRelationships)
      .innerJoin(
        schema.termTaxonomy,
        eq(schema.termTaxonomy.id, schema.termRelationships.termTaxonomyId),
      )
      .innerJoin(schema.terms, eq(schema.terms.id, schema.termTaxonomy.termId))
      .where(eq(schema.termRelationships.objectId, postId))
      .orderBy(asc(schema.terms.slug));
    expect(terms.map((t) => `${t.taxonomy}:${t.slug}`)).toEqual([
      'post_tag:compost',
      'post_format:post-format-gallery',
      'post_tag:spring',
      'category:tomatoes',
    ]);
    expect(await kernel.options.get('sticky_posts')).toEqual([postId]);
    expect(await meta(ctx, postId, 'bed_sizes')).toEqual({
      width: 120,
      plants: ['tomato', 'basil'],
    });
    expect(await meta(ctx, postId, '_edit_last')).toBe(maria?.id);
    // No revision is stored for imported content.
    expect(await kernel.posts.revisions(postId)).toEqual([]);

    // The attachment: downloaded into its original month, its URLs rewritten.
    const attachment = await postByTitle(ctx, 'attachment', 'garden-bed');
    expect(attachment).toMatchObject({
      parentId: postId,
      mimeType: 'image/png',
      excerpt: 'The bed in May',
    });
    expect(await meta(ctx, attachment?.id ?? 0, '_wp_attached_file')).toBe(
      '2019/05/garden-bed.png',
    );
    expect(await meta(ctx, attachment?.id ?? 0, '_wp_attachment_image_alt')).toBe(
      'A raised bed with young plants',
    );
    expect(await meta(ctx, postId, '_thumbnail_id')).toBe(attachment?.id);
    const fresh = post?.content ?? '';
    expect(fresh).toContain(`<!-- wp:image {"id":${attachment?.id},"sizeSlug":"large"} -->`);
    expect(fresh).toContain(
      `src="http://localhost:3000/wp-content/uploads/2019/05/garden-bed.png" alt="" class="wp-image-${attachment?.id}"`,
    );
    expect(fresh).toContain(
      'src="http://localhost:3000/wp-content/uploads/2019/05/garden-bed-150x150.png"',
    );
    expect(fresh).toContain('<a href="http://localhost:3000/about/">about page</a>');
    const about = await postByTitle(ctx, 'page', 'About');
    expect(fresh).toContain(`<a href="http://localhost:3000/?page_id=${about?.id}">`);
    expect(fresh).not.toContain(mediaBase);

    // Pages: the child came before its parent in the file.
    const team = await postByTitle(ctx, 'page', 'Team');
    expect(team).toMatchObject({ parentId: about?.id, menuOrder: 2, authorId: 1 });

    // Comments: threaded, with meta.
    const comments = await kernel.db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.postId, postId))
      .orderBy(asc(schema.comments.id));
    expect(comments.map((c) => [c.author, c.approved, c.authorIp])).toEqual([
      ['Ana', '1', '203.0.113.4'],
      ['Maria Okafor', '1', ''],
    ]);
    expect(comments[1]?.parentId).toBe(comments[0]?.id);
    expect(comments[1]?.userId).toBe(maria?.id);
    // PGlite reads JSON strings that look like numbers back as numbers.
    expect(String(await kernel.comments.getMeta(comments[0]?.id ?? 0, 'rating'))).toBe('5');

    // The classic menu became a block menu.
    const menu = await postByTitle(ctx, 'wp_navigation', 'Main menu');
    expect(menu?.status).toBe('publish');
    expect(menu?.content).toBe(
      [
        `<!-- wp:navigation-submenu {"label":"About","type":"page","id":${about?.id},"url":"http://localhost:3000/about/","kind":"post-type","isTopLevelItem":true} -->`,
        `<!-- wp:navigation-link {"label":"Team","type":"page","id":${team?.id},"url":"http://localhost:3000/about/team/","kind":"post-type"} /-->`,
        '<!-- /wp:navigation-submenu -->',
        '<!-- wp:navigation-link {"label":"Seed swap","url":"http://localhost:3000/seed-swap/","kind":"custom","opensInNewTab":true,"isTopLevelLink":true} /-->',
      ].join('\n'),
    );
  });

  it('skips what already exists when run again', async () => {
    const ctx = await site();
    const xml = sampleWxr(mediaBase);
    await runRestImport(ctx, xml);
    const count = async (
      table: typeof schema.posts | typeof schema.comments | typeof schema.terms,
    ) => (await ctx.kernel.db.select().from(table)).length;
    const before = [
      await count(schema.posts),
      await count(schema.comments),
      await count(schema.terms),
    ];
    requests = [];
    const { done } = await runRestImport(ctx, xml);
    expect(done.status).toBe('completed');
    expect(done.report.imported).toEqual({ users: 0, terms: 0, posts: {}, comments: 0, menus: 0 });
    const codes = done.report.skipped.items.map(
      (i: { kind: string; code: string }) => `${i.kind}:${i.code}`,
    );
    expect(codes.filter((c: string) => c === 'post:exists')).toHaveLength(3);
    expect(codes).toContain('attachment:exists');
    expect(codes).toContain('comment:exists');
    expect(codes).toContain('menu:exists');
    expect(codes).toContain('author:exists');
    expect([
      await count(schema.posts),
      await count(schema.comments),
      await count(schema.terms),
    ]).toEqual(before);
    expect(requests).toEqual([]);
  });

  it('reports attachments it was told not to download, and refuses private hosts', async () => {
    const off = await site();
    const { done } = await runRestImport(off, sampleWxr(mediaBase), { fetch_attachments: false });
    expect(done.report.imported.posts.attachment).toBeUndefined();
    expect(done.report.skipped.items.map((i: { code: string }) => i.code)).toContain(
      'attachment_fetch_disabled',
    );

    const guarded = await site({ allowPrivate: false });
    const second = await runRestImport(guarded, sampleWxr(mediaBase));
    expect(second.done.report.errors.items).toEqual([
      expect.objectContaining({ kind: 'attachment', code: 'import_unsafe_port' }),
    ]);
    // The post still imports; its featured image doesn't.
    const post = await postByTitle(guarded, 'post', 'Raised bed in & out');
    expect(await meta(guarded, post?.id ?? 0, '_thumbnail_id')).toBeUndefined();
  });

  it('falls back to the importing user when an author can’t be created', async () => {
    const ctx = await site();
    const xml = sampleWxr(mediaBase).replace('<![CDATA[tomas@old.example]]>', '<![CDATA[]]>');
    const { done } = await runRestImport(ctx, xml, { fetch_attachments: false });
    expect(done.report.authors).toMatchObject({ tomas: 1 });
    expect(done.report.errors.items).toContainEqual(
      expect.objectContaining({ kind: 'author', title: 'tomas', code: 'import_user_no_email' }),
    );
  });

  it('refuses author and attachment choices the user may not make', async () => {
    const ctx = await site();
    const uploaded = await uploadXml(ctx, ctx.cookie, sampleWxr(mediaBase));
    const bad = await ctx.request('POST', `/pressbase/v1/import/${uploaded.body.id}/start`, {
      authors: { maria: { action: 'map' } },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('rest_invalid_param');
    const ok = await ctx.request('POST', `/pressbase/v1/import/${uploaded.body.id}/start`, {});
    expect(ok.status).toBe(202);
    const again = await ctx.request('POST', `/pressbase/v1/import/${uploaded.body.id}/start`, {});
    expect(again.status).toBe(409);
  });

  it('imports from the CLI-facing function too', async () => {
    const ctx = await site();
    const report = await importWxr(
      ctx.kernel,
      { xml: sampleWxr(mediaBase) },
      { userId: 1, fetchAttachments: false },
    );
    expect(report.imported.posts).toEqual({ post: 1, page: 2 });
  });
});

/* -------------------------------------------------------------- exporting */

async function download(ctx: Ctx, cookie: string, query = '') {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/export/download${query}`, {
    headers: { cookie },
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('exporting', () => {
  it('offers WordPress’s export choices', async () => {
    const ctx = await site();
    await importWxr(
      ctx.kernel,
      { xml: sampleWxr(mediaBase) },
      { userId: 1, fetchAttachments: true },
    );
    const res = await ctx.request('GET', '/pressbase/v1/export');
    expect(res.status).toBe(200);
    expect(res.body.types.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(['post', 'page', 'attachment', 'wp_navigation']),
    );
    expect(res.body.types.map((t: { name: string }) => t.name)).not.toContain('revision');
    expect(res.body.months.post).toContain('2019-05');
    expect(res.body.authors.post.map((a: { name: string }) => a.name)).toContain('Maria Okafor');
    expect(res.body.categories.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(['Tomatoes', 'Vegetables']),
    );
    expect(res.body.statuses.map((s: { name: string }) => s.name)).toContain('draft');
  });

  it('streams a WXR 1.2 download', async () => {
    const ctx = await site();
    await importWxr(
      ctx.kernel,
      { xml: sampleWxr(mediaBase) },
      { userId: 1, fetchAttachments: true },
    );
    const res = await download(ctx, ctx.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/xml; charset=UTF-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="testsite\.WordPress\.\d{4}-\d{2}-\d{2}\.xml"$/,
    );
    const xml = res.text;
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8" \?>/);
    expect(xml).toContain('<wp:wxr_version>1.2</wp:wxr_version>');
    expect(xml).toContain('<wp:base_blog_url>http://localhost:3000</wp:base_blog_url>');
    expect(xml).toContain('<wp:category_parent><![CDATA[vegetables]]></wp:category_parent>');
    expect(xml).toContain(
      '<category domain="post_format" nicename="post-format-gallery"><![CDATA[Gallery]]></category>',
    );
    expect(xml).toContain(
      '<wp:meta_value><![CDATA[a:2:{s:5:"width";i:120;s:6:"plants";a:2:{i:0;s:6:"tomato";i:1;s:5:"basil";}}]]></wp:meta_value>',
    );
    expect(xml).toContain(']]]]><![CDATA[> done.');
    expect(xml).toContain('<wp:is_sticky>1</wp:is_sticky>');
    expect(xml).toContain(
      '<wp:attachment_url><![CDATA[http://localhost:3000/wp-content/uploads/2019/05/garden-bed.png]]></wp:attachment_url>',
    );
    expect(xml).toContain('<wp:author_login><![CDATA[maria]]></wp:author_login>');
    // It parses again, completely.
    const summary = await scanWxr({ xml });
    expect(summary.posts).toMatchObject({ post: 1, page: 2, attachment: 1, wp_navigation: 1 });
  });

  it('filters like export_wp()', async () => {
    const ctx = await site();
    await importWxr(
      ctx.kernel,
      { xml: sampleWxr(mediaBase) },
      { userId: 1, fetchAttachments: true },
    );
    const pages = await scanWxr({ xml: (await download(ctx, ctx.cookie, '?content=pages')).text });
    expect(pages.posts).toEqual({ page: 2 });
    expect(pages.terms).toEqual({});
    // Posts by category bring their attachments and featured images.
    const veg = await scanWxr({
      xml: (await download(ctx, ctx.cookie, '?content=posts&category=tomatoes')).text,
    });
    expect(veg.posts).toEqual({ post: 1, attachment: 1 });
    expect(veg.terms).toEqual({ category: 1 });
    const none = await scanWxr({
      xml: (await download(ctx, ctx.cookie, '?content=posts&category=vegetables')).text,
    });
    expect(none.posts).toEqual({});
    const may = await scanWxr({
      xml: (
        await download(
          ctx,
          ctx.cookie,
          '?content=posts&start_date=2019-05&end_date=2019-05&status=publish',
        )
      ).text,
    });
    expect(may.posts).toEqual({ post: 1, attachment: 1 });
    const later = await scanWxr({
      xml: (await download(ctx, ctx.cookie, '?content=posts&start_date=2019-06')).text,
    });
    expect(later.posts).toEqual({});
    const drafts = await scanWxr({
      xml: (await download(ctx, ctx.cookie, '?content=posts&status=draft')).text,
    });
    expect(drafts.posts).toEqual({});
    const bad = await download(ctx, ctx.cookie, '?start_date=yesterday');
    expect(bad.status).toBe(400);
  });

  it('writes to a stream for the CLI', async () => {
    const ctx = await site();
    const chunks: string[] = [];
    await exportWxr(ctx.kernel, { content: 'page' }, (chunk) => chunks.push(chunk));
    expect(chunks.join('')).toContain('</rss>');
    const all: string[] = [];
    for await (const chunk of generateWxr(ctx.kernel)) all.push(chunk);
    expect(all.join('')).toContain('<wp:wxr_version>1.2</wp:wxr_version>');
  });
});

describe('round trip', () => {
  it('exports a site and imports it into a fresh one', async () => {
    // Site A: imported content plus content made here.
    const a = await site();
    await importWxr(a.kernel, { xml: sampleWxr(mediaBase) }, { userId: 1, fetchAttachments: true });
    const extra = await a.kernel.posts.insert('post', {
      title: 'Written here',
      content: '<!-- wp:paragraph --><p>Draft notes</p><!-- /wp:paragraph -->',
      status: 'draft',
      authorId: 1,
      date: new Date('2026-09-01T12:00:00Z'),
    });
    await a.kernel.db
      .insert(schema.postmeta)
      .values({ postId: extra.id, key: 'mood', value: ['calm', { level: 2 }] });
    const chunks: string[] = [];
    await exportWxr(a.kernel, {}, (chunk) => chunks.push(chunk));
    const xml = chunks.join('');

    // Site B, fresh.
    const b = await site();
    const report = await importWxr(b.kernel, { xml }, { userId: 1, fetchAttachments: false });
    expect(report.errors.total).toBe(0);

    const snapshot = async (ctx: Ctx) => {
      const posts = await ctx.kernel.db
        .select()
        .from(schema.posts)
        .where(eq(schema.posts.type, 'post'))
        .orderBy(asc(schema.posts.title));
      const out = [];
      for (const post of posts) {
        const parent = post.parentId ? await ctx.kernel.posts.get(post.parentId) : undefined;
        const comments = await ctx.kernel.db
          .select()
          .from(schema.comments)
          .where(eq(schema.comments.postId, post.id))
          .orderBy(asc(schema.comments.date));
        const meta = await ctx.kernel.db
          .select({ key: schema.postmeta.key, value: schema.postmeta.value })
          .from(schema.postmeta)
          .where(eq(schema.postmeta.postId, post.id))
          .orderBy(asc(schema.postmeta.key));
        const terms = await ctx.kernel.db
          .select({ taxonomy: schema.termTaxonomy.taxonomy, slug: schema.terms.slug })
          .from(schema.termRelationships)
          .innerJoin(
            schema.termTaxonomy,
            eq(schema.termTaxonomy.id, schema.termRelationships.termTaxonomyId),
          )
          .innerJoin(schema.terms, eq(schema.terms.id, schema.termTaxonomy.termId))
          .where(eq(schema.termRelationships.objectId, post.id))
          .orderBy(asc(schema.terms.slug));
        const author = post.authorId
          ? (
              await ctx.kernel.db
                .select()
                .from(schema.users)
                .where(eq(schema.users.id, post.authorId))
            )[0]?.login
          : null;
        out.push({
          title: post.title,
          slug: post.slug,
          status: post.status,
          date: post.date.toISOString(),
          excerpt: post.excerpt,
          // IDs differ between the sites; everything else must match.
          content: post.content.replace(/(page_id=|"id":|wp-image-)\d+/g, '$1N'),
          author,
          parent: parent?.title ?? null,
          sticky: ((await ctx.kernel.options.get<number[]>('sticky_posts', [])) ?? []).includes(
            post.id,
          ),
          terms: terms.map((t) => `${t.taxonomy}:${t.slug}`),
          meta: meta.filter((m) => m.key !== '_thumbnail_id' && m.key !== '_edit_last'),
          comments: comments.map((c) => ({
            author: c.author,
            content: c.content,
            approved: c.approved,
            parent: !!c.parentId,
          })),
        });
      }
      const pages = await ctx.kernel.db
        .select({
          title: schema.posts.title,
          parentId: schema.posts.parentId,
          order: schema.posts.menuOrder,
        })
        .from(schema.posts)
        .where(eq(schema.posts.type, 'page'))
        .orderBy(asc(schema.posts.title));
      const categories = (
        await ctx.kernel.terms.list('category', { perPage: 100, orderby: 'slug' })
      ).terms.map((t) => `${t.slug}<${t.parent ? 'child' : 'top'}`);
      const menus = await ctx.kernel.db
        .select({ title: schema.posts.title })
        .from(schema.posts)
        .where(eq(schema.posts.type, 'wp_navigation'));
      return {
        posts: out,
        pages: pages.map((p) => [p.title, Boolean(p.parentId), p.order]),
        categories,
        menus,
      };
    };

    const before = await snapshot(a);
    const after = await snapshot(b);
    expect(after).toEqual(before);
    expect(before.posts).toHaveLength(2);
    expect(before.posts[1]?.meta).toContainEqual({ key: 'mood', value: ['calm', { level: 2 }] });
  });
});
