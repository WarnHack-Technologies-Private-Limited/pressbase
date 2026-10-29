import { describe, expect, it } from 'vitest';
import { cdata, ent2ncr, rfc822, w3cDate, xmlText } from './frontend/xml';
import { setup } from './test-utils';
import { assertWellFormedXml, elementTexts } from './test-xml';

/**
 * XML sitemaps (frontend/sitemaps.ts, WordPress's WP_Sitemaps) and
 * robots.txt (frontend/robots.ts, do_robots()).
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

async function render(ctx: Ctx, url: string) {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  expect(res.status).toBe(200);
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

const locs = (xml: string) => elementTexts(xml, 'loc');

describe('XML sitemaps', () => {
  it('lists every sitemap in the index, with the XSL stylesheet', async () => {
    const ctx = await site();
    await ctx.request('POST', '/wp/v2/tags', { name: 'Empty tag' });
    const index = await render(ctx, '/wp-sitemap.xml');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('application/xml; charset=UTF-8');
    const names = assertWellFormedXml(index.html);
    expect(names[0]).toBe('sitemapindex');
    expect(index.html).toContain(
      '<?xml-stylesheet type="text/xsl" href="http://localhost:3000/wp-sitemap-index.xsl" ?>',
    );
    // The installer's sample page and post, their category and author. No tags have posts.
    expect(locs(index.html)).toEqual([
      'http://localhost:3000/wp-sitemap-posts-post-1.xml',
      'http://localhost:3000/wp-sitemap-posts-page-1.xml',
      'http://localhost:3000/wp-sitemap-taxonomies-category-1.xml',
      'http://localhost:3000/wp-sitemap-users-1.xml',
    ]);
  });

  it('lists published posts with lastmod, leaving out drafts, private and protected posts', async () => {
    const ctx = await site();
    const shown = await post(ctx, { title: 'Shown & <told>' });
    await post(ctx, { title: 'Draft', status: 'draft' });
    await post(ctx, { title: 'Private', status: 'private' });
    await post(ctx, { title: 'Protected', password: 'pw' });
    const sitemap = await render(ctx, '/wp-sitemap-posts-post-1.xml');
    assertWellFormedXml(sitemap.html);
    expect(sitemap.html).toContain(
      '<?xml-stylesheet type="text/xsl" href="http://localhost:3000/wp-sitemap.xsl" ?>',
    );
    const urls = locs(sitemap.html);
    expect(urls).toHaveLength(2); // Hello world! and Shown
    expect(urls[1]).toBe(shown.link);
    expect(sitemap.html).not.toMatch(/draft|private|protected/i);
    // lastmod is DATE_W3C in the site's time zone (Asia/Kolkata in tests).
    expect(elementTexts(sitemap.html, 'lastmod')[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/,
    );
    expect(sitemap.tags).toContain(`post:${shown.id}`);
    expect(sitemap.tags).toContain('posts:post');
  });

  it('starts the pages sitemap with the home page when it shows the latest posts', async () => {
    const ctx = await site();
    const pages = await render(ctx, '/wp-sitemap-posts-page-1.xml');
    expect(locs(pages.html)[0]).toBe('http://localhost:3000/');
    expect(locs(pages.html)).toContain('http://localhost:3000/sample-page/');
  });

  it('paginates at the maximum number of URLs (2,000, filterable)', async () => {
    const ctx = await site();
    ctx.kernel.hooks.addFilter('wp_sitemaps_max_urls', () => 2);
    for (const title of ['One', 'Two', 'Three', 'Four']) await post(ctx, { title });
    // Hello world! + 4 posts = 5 → 3 pages of 2.
    const index = await render(ctx, '/wp-sitemap.xml');
    expect(locs(index.html).filter((l) => l.includes('posts-post'))).toEqual([
      'http://localhost:3000/wp-sitemap-posts-post-1.xml',
      'http://localhost:3000/wp-sitemap-posts-post-2.xml',
      'http://localhost:3000/wp-sitemap-posts-post-3.xml',
    ]);
    expect(locs((await render(ctx, '/wp-sitemap-posts-post-2.xml')).html)).toHaveLength(2);
    expect(locs((await render(ctx, '/wp-sitemap-posts-post-3.xml')).html)).toHaveLength(1);
    expect((await render(ctx, '/wp-sitemap-posts-post-4.xml')).status).toBe(404);
  });

  it('lists categories and tags that have posts, and authors', async () => {
    const ctx = await site();
    const tag = await ctx.request('POST', '/wp/v2/tags', { name: 'Green tea' });
    await ctx.request('POST', '/wp/v2/tags', { name: 'Unused' });
    await post(ctx, { title: 'Tagged', tags: [tag.body.id] });
    expect(locs((await render(ctx, '/wp-sitemap-taxonomies-post_tag-1.xml')).html)).toEqual([
      'http://localhost:3000/tag/green-tea/',
    ]);
    expect(locs((await render(ctx, '/wp-sitemap-taxonomies-category-1.xml')).html)).toEqual([
      'http://localhost:3000/category/uncategorized/',
    ]);
    const users = await render(ctx, '/wp-sitemap-users-1.xml');
    assertWellFormedXml(users.html);
    expect(locs(users.html)).toEqual(['http://localhost:3000/author/admin/']);
  });

  it('runs the provider, entry and taxonomy query filters', async () => {
    const ctx = await site();
    const { hooks } = ctx.kernel;
    const tag = await ctx.request('POST', '/wp/v2/tags', { name: 'Hidden' });
    const shown = await ctx.request('POST', '/wp/v2/tags', { name: 'Shown' });
    await post(ctx, { title: 'Tagged', tags: [tag.body.id, shown.body.id] });
    hooks.addFilter('wp_sitemaps_add_provider', (provider, name) =>
      name === 'users' ? false : provider,
    );
    hooks.addFilter('wp_sitemaps_taxonomies_query_args', (args, taxonomy) =>
      taxonomy === 'post_tag' ? { ...args, exclude: [tag.body.id] } : args,
    );
    hooks.addFilter('wp_sitemaps_taxonomies_entry', (entry, term) => ({
      ...entry,
      lastmod: `2026-01-0${term.id % 9}T00:00:00+00:00`,
    }));
    hooks.addFilter('wp_sitemaps_posts_entry', (entry, p) =>
      p.title === 'Tagged' ? { ...entry, changefreq: 'weekly', priority: 0.5 } : entry,
    );

    const index = await render(ctx, '/wp-sitemap.xml');
    expect(locs(index.html)).not.toContain('http://localhost:3000/wp-sitemap-users-1.xml');
    expect((await render(ctx, '/wp-sitemap-users-1.xml')).status).toBe(404);
    const tags = await render(ctx, '/wp-sitemap-taxonomies-post_tag-1.xml');
    expect(locs(tags.html)).toEqual(['http://localhost:3000/tag/shown/']);
    expect(tags.html).toContain(`<lastmod>2026-01-0${shown.body.id % 9}T00:00:00+00:00</lastmod>`);
    const posts = await render(ctx, '/wp-sitemap-posts-post-1.xml');
    assertWellFormedXml(posts.html);
    expect(posts.html).toMatch(
      /<\/lastmod><changefreq>weekly<\/changefreq><priority>0.5<\/priority>/,
    );
  });

  it('answers 404 for unknown providers, subtypes and pages', async () => {
    const ctx = await site();
    for (const url of [
      '/wp-sitemap-nope-1.xml',
      '/wp-sitemap-posts-attachment-1.xml',
      '/wp-sitemap-posts-post-0.xml',
      '/wp-sitemap-taxonomies-nope-1.xml',
    ]) {
      const res = await render(ctx, url);
      expect(res.status, url).toBe(404);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    }
  });

  it('serves the stylesheets as XSLT', async () => {
    const ctx = await site();
    for (const url of ['/wp-sitemap.xsl', '/wp-sitemap-index.xsl']) {
      const xsl = await render(ctx, url);
      expect(xsl.headers['content-type']).toBe('application/xml; charset=UTF-8');
      const names = assertWellFormedXml(xsl.html);
      expect(names[0]).toBe('xsl:stylesheet');
      expect(xsl.html).toContain('Test Site');
    }
    expect((await render(ctx, '/wp-sitemap.xsl')).html).toContain('← All sitemaps');
    // The index names each sitemap; URL lists lead with the path.
    const index = (await render(ctx, '/wp-sitemap-index.xsl')).html;
    for (const label of ['Posts', 'Pages', 'Categories', 'Tags', 'Authors']) {
      expect(index).toContain(`<span class="label">${label}</span>`);
    }
    expect(index).toContain('sitemap-subtype=post&amp;');
    expect((await render(ctx, '/wp-sitemap.xsl')).html).toContain(
      `<xsl:variable name="home" select="'http://localhost:3000'" />`,
    );
  });

  it('uses query strings with plain permalinks', async () => {
    const ctx = await site();
    await ctx.kernel.options.set('permalink_structure', '');
    const index = await render(ctx, '/?sitemap=index');
    expect(index.headers['content-type']).toBe('application/xml; charset=UTF-8');
    expect(locs(index.html)[0]).toBe(
      'http://localhost:3000/?sitemap=posts&amp;sitemap-subtype=post&amp;paged=1',
    );
    expect(index.html).toContain('href="http://localhost:3000/?sitemap-stylesheet=index"');
    const posts = await render(ctx, '/?sitemap=posts&sitemap-subtype=post&paged=1');
    expect(posts.status).toBe(200);
    expect((await render(ctx, '/wp-sitemap.xml')).status).toBe(404);
  });

  it('is off when the site discourages search engines', async () => {
    const ctx = await site();
    await ctx.request('POST', '/wp/v2/settings', { blog_public: false });
    for (const url of ['/wp-sitemap.xml', '/wp-sitemap-posts-post-1.xml', '/wp-sitemap.xsl']) {
      expect((await render(ctx, url)).status, url).toBe(404);
    }
    const index = await render(ctx, '/wp-sitemap.xml');
    expect(index.html).toContain("<meta name='robots' content='noindex, nofollow' />");
  });
});

describe('robots.txt', () => {
  it('allows crawling except the admin, and points at the sitemap', async () => {
    const ctx = await site();
    const robots = await render(ctx, '/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(robots.html).toBe(
      'User-agent: *\nDisallow: /admin/\n\nSitemap: http://localhost:3000/wp-sitemap.xml\n',
    );
  });

  it('disallows everything when the site discourages search engines', async () => {
    const ctx = await site();
    await ctx.request('POST', '/wp/v2/settings', { blog_public: false });
    const robots = await render(ctx, '/robots.txt');
    expect(robots.html).toBe('User-agent: *\nDisallow: /\n');
    expect(robots.tags).toContain('site');
  });

  it('runs the robots_txt filter', async () => {
    const ctx = await site();
    ctx.kernel.hooks.addFilter('robots_txt', (output) => `${output}Disallow: /private/\n`);
    expect((await render(ctx, '/robots.txt')).html).toContain('Disallow: /private/');
  });
});

describe('XML helpers', () => {
  it('escapes text, converts HTML entities and splits CDATA', () => {
    expect(xmlText('a & b <c> &hellip; &amp; &bogus; "q"')).toBe(
      'a &amp; b &lt;c&gt; &#8230; &amp; &amp;bogus; &quot;q&quot;',
    );
    expect(ent2ncr('&nbsp;&copy;&mdash;')).toBe('&#160;&#169;&#8212;');
    expect(cdata('x ]]> y\u0000')).toBe('<![CDATA[x ]]]]><![CDATA[> y]]>');
    expect(rfc822(new Date('2026-10-27T09:05:00Z'))).toBe('Tue, 27 Oct 2026 09:05:00 +0000');
    expect(w3cDate(new Date('2026-10-27T09:05:00Z'), 'Asia/Kolkata')).toBe(
      '2026-10-27T14:35:00+05:30',
    );
    expect(w3cDate(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(
      '2026-01-15T07:00:00-05:00',
    );
  });
});
