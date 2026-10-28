import { describe, expect, it } from 'vitest';
import { setup } from './test-utils';
import { assertWellFormedXml, elementTexts } from './test-xml';

/**
 * Feeds (frontend/feeds.ts): RSS 2.0 and Atom for the blog, archives, single
 * posts' comments and the site's comments, as WordPress's feed templates
 * print them, rendered through /pressbase/v1/render like any public URL.
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

async function post(ctx: Ctx, body: Record<string, unknown>) {
  const res = await ctx.request('POST', '/wp/v2/posts', { status: 'publish', ...body });
  expect(res.status).toBe(201);
  return res.body as { id: number; link: string };
}

const pathOf = (link: string) => new URL(link).pathname;

describe('RSS 2.0 feeds', () => {
  it('lists the latest posts with escaped titles and CDATA content', async () => {
    const ctx = await site();
    const hostileTitle = 'Tom & Jerry <script>alert(1)</script> say &hellip; ]]> “hi”';
    await post(ctx, {
      title: hostileTitle,
      content:
        '<!-- wp:paragraph --><p>Body with ]]> inside, an &amp; and a control\u0001 char</p><!-- /wp:paragraph -->',
    });
    await post(ctx, { title: 'Second', content: '<p>Two</p>' });

    const feed = await render(ctx, '/feed/');
    expect(feed.status).toBe(200);
    expect(feed.headers['content-type']).toBe('application/rss+xml; charset=UTF-8');
    expect(feed.headers['last-modified']).toBeTruthy();
    const names = assertWellFormedXml(feed.html);
    expect(names[0]).toBe('rss');
    expect(feed.html).toContain('<rss version="2.0"');
    expect(names.filter((n) => n === 'channel')).toHaveLength(1);
    for (const required of [
      'title',
      'link',
      'description',
      'lastBuildDate',
      'language',
      'atom:link',
    ]) {
      expect(names).toContain(required);
    }
    expect(elementTexts(feed.html, 'title')[0]).toBe('Test Site');
    expect(feed.html).toContain('<atom:link href="http://localhost:3000/feed/" rel="self"');

    const titles = elementTexts(feed.html, 'title').slice(1);
    // Newest first.
    expect(titles[0]).toBe('Second');
    // Script removed, markup escaped.
    expect(titles[1]).toBe('Tom &amp; Jerry  say … ]]&gt; “hi”');
    expect(feed.html).not.toContain('<script>');
    const encoded = elementTexts(feed.html, 'content:encoded');
    expect(encoded.some((c) => c.includes('Body with ]]'))).toBe(true);
    expect(feed.html).not.toContain('\u0001');
    // Items carry WordPress's fields.
    for (const field of [
      'guid',
      'pubDate',
      'dc:creator',
      'category',
      'description',
      'slash:comments',
    ]) {
      expect(names).toContain(field);
    }
    expect(feed.html).toMatch(
      /<pubDate>\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000<\/pubDate>/,
    );
    expect(feed.html).toContain('<category><![CDATA[Uncategorized]]></category>');
  });

  it('follows posts_per_rss and rss_use_excerpt (Settings → Reading)', async () => {
    const ctx = await site();
    for (const title of ['A', 'B', 'C']) {
      await post(ctx, {
        title,
        content: '<!-- wp:paragraph --><p>Full text here</p><!-- /wp:paragraph -->',
      });
    }
    const settings = await ctx.request('POST', '/wp/v2/settings', {
      posts_per_rss: 2,
      rss_use_excerpt: true,
    });
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({ posts_per_rss: 2, rss_use_excerpt: true });
    const feed = await render(ctx, '/feed/');
    assertWellFormedXml(feed.html);
    expect(elementTexts(feed.html, 'item')).toHaveLength(2);
    expect(feed.html).not.toContain('<content:encoded>');
    expect(elementTexts(feed.html, 'description').slice(1)[0]).toBe('Full text here');
    expect((await ctx.request('POST', '/wp/v2/settings', { posts_per_rss: 0 })).body.code).toBe(
      'rest_invalid_param',
    );
  });

  it('filters category, tag and author feeds, and 404s unknown ones', async () => {
    const ctx = await site();
    const news = await ctx.request('POST', '/wp/v2/categories', { name: 'News' });
    const tag = await ctx.request('POST', '/wp/v2/tags', { name: 'Tea' });
    await post(ctx, { title: 'In the news', categories: [news.body.id], tags: [tag.body.id] });
    await post(ctx, { title: 'Elsewhere' });

    for (const url of [
      '/category/news/feed/',
      `/?feed=rss2&cat=${news.body.id}`,
      '/tag/tea/feed/',
    ]) {
      const feed = await render(ctx, url);
      assertWellFormedXml(feed.html);
      const titles = elementTexts(feed.html, 'title');
      expect(titles.slice(1)).toEqual(['In the news']);
      expect(feed.tags).toContain(
        url.includes('tag') ? `term:${tag.body.id}` : `term:${news.body.id}`,
      );
    }
    expect(elementTexts((await render(ctx, '/category/news/feed/')).html, 'title')[0]).toBe(
      'News &#8211; Test Site',
    );
    const byAuthor = await render(ctx, '/author/admin/feed/');
    expect(elementTexts(byAuthor.html, 'item').length).toBe(3);

    const missing = await render(ctx, '/category/nope/feed/');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('shows approved comments: per post and site-wide', async () => {
    const ctx = await site();
    const hello = await post(ctx, { title: 'Talk to me' });
    const ok = await ctx.request('POST', '/wp/v2/comments', {
      post: hello.id,
      content: 'Nice & <b>bold</b> ]]> post',
    });
    expect(ok.status).toBe(201);
    const held = await ctx.request('POST', '/wp/v2/comments', {
      post: hello.id,
      content: 'Held one',
    });
    await ctx.request('POST', `/wp/v2/comments/${held.body.id}`, { status: 'hold' });

    const single = await render(ctx, `${pathOf(hello.link)}feed/`);
    assertWellFormedXml(single.html);
    expect(elementTexts(single.html, 'title')[0]).toBe('Comments on: Talk to me');
    expect(elementTexts(single.html, 'title').slice(1)).toEqual(['By: admin']);
    expect(single.html).toContain('Nice &amp; bold ]]&gt; post');
    expect(single.html).not.toContain('Held one');
    expect(single.html).toContain(`#comment-${ok.body.id}`);

    for (const url of ['/comments/feed/', '/?feed=comments-rss2']) {
      const all = await render(ctx, url);
      assertWellFormedXml(all.html);
      expect(elementTexts(all.html, 'title')[0]).toBe('Comments for Test Site');
      expect(all.html).toContain('Comment on Talk to me by admin');
      expect(all.html).not.toContain('Held one');
      expect(all.tags).toContain('comments');
    }
  });

  it('keeps protected content out of feeds', async () => {
    const ctx = await site();
    await post(ctx, {
      title: 'Locked',
      content: '<!-- wp:paragraph --><p>Secret words</p><!-- /wp:paragraph -->',
      password: 'pw',
    });
    const feed = await render(ctx, '/feed/');
    assertWellFormedXml(feed.html);
    expect(feed.html).not.toContain('Secret words');
    expect(feed.html).toContain('There is no excerpt because this is a protected post.');
    expect(feed.html).toContain('Protected: Locked');
  });
});

describe('Atom feeds', () => {
  it('lists the latest posts and comments as Atom', async () => {
    const ctx = await site();
    const created = await post(ctx, { title: 'Atomic & <odd>', content: '<p>Atom body</p>' });
    await ctx.request('POST', '/wp/v2/comments', { post: created.id, content: 'Atom reply' });
    for (const url of ['/feed/atom/', '/?feed=atom']) {
      const feed = await render(ctx, url);
      expect(feed.headers['content-type']).toBe('application/atom+xml; charset=UTF-8');
      const names = assertWellFormedXml(feed.html);
      expect(names[0]).toBe('feed');
      expect(feed.html).toContain('xmlns="http://www.w3.org/2005/Atom"');
      for (const field of ['entry', 'id', 'updated', 'published', 'summary', 'content', 'author']) {
        expect(names).toContain(field);
      }
      expect(feed.html).toMatch(/<updated>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/updated>/);
      expect(feed.html).toContain('<title type="html"><![CDATA[Atomic &amp;]]></title>');
    }
    const comments = await render(ctx, '/comments/feed/atom/');
    assertWellFormedXml(comments.html);
    expect(comments.html).toContain('Atom reply');
    expect(comments.html).toContain('thr:in-reply-to');
  });
});

describe('feed links in the page head', () => {
  it('advertises the site, comments, category and post comment feeds', async () => {
    const ctx = await site();
    const created = await post(ctx, { title: 'Linked' });
    const home = await render(ctx, '/');
    expect(home.html).toContain(
      '<link rel="alternate" type="application/rss+xml" title="Test Site » Feed" href="http://localhost:3000/feed/" />',
    );
    expect(home.html).toContain(
      'title="Test Site » Comments Feed" href="http://localhost:3000/comments/feed/"',
    );
    const single = await render(ctx, pathOf(created.link));
    expect(single.html).toContain(
      `title="Test Site » Linked Comments Feed" href="${created.link}feed/"`,
    );
    const category = await render(ctx, '/category/uncategorized/');
    expect(category.html).toContain(
      'title="Test Site » Uncategorized Category Feed" href="http://localhost:3000/category/uncategorized/feed/"',
    );
  });
});
