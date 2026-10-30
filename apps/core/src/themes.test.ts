import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { setup } from './test-utils';

/**
 * Themes and the public site: the Pressbase theme rendering the home page,
 * single posts, pages, archives, search and 404s through
 * /pressbase/v1/render, plus theme listing, activation and asset serving.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

/** A page of the public site, as apps/web asks for it. */
async function page(ctx: Ctx, url: string, headers: Record<string, string> = {}) {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`, {
    headers,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { status: number; headers: Record<string, string>; html: string };
}

/** The visible text of the <main> element, tags removed. */
const mainOf = (html: string) => /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? '';

async function post(ctx: Ctx, body: Record<string, unknown>, type = 'posts') {
  const res = await ctx.request('POST', `/wp/v2/${type}`, { status: 'publish', ...body });
  expect(res.status).toBe(201);
  return res.body as { id: number; link: string; slug: string };
}

describe('themes', () => {
  it('lists the bundled theme as active, WordPress-shaped', async () => {
    const ctx = await site();
    const res = await ctx.request('GET', '/wp/v2/themes');
    expect(res.status).toBe(200);
    const theme = res.body.find((t: { stylesheet: string }) => t.stylesheet === 'pressbase');
    expect(theme).toMatchObject({
      stylesheet: 'pressbase',
      template: 'pressbase',
      name: { raw: 'Pressbase' },
      version: '1.0.0',
      status: 'active',
      is_block_theme: true,
      screenshot: 'http://localhost:3000/wp-content/themes/pressbase/screenshot.png',
    });
    expect(theme.tags.raw).toContain('full-site-editing');
  });

  it('needs switch_themes to list themes, edit_posts for the active one', async () => {
    const ctx = await site();
    const author = await ctx.loginAs('writer', 'author');
    expect((await author.request('GET', '/wp/v2/themes')).status).toBe(403);
    expect((await author.request('GET', '/wp/v2/themes?status=active')).status).toBe(200);
    expect(
      (await author.request('POST', '/pressbase/v1/themes/pressbase/activate')).body.code,
    ).toBe('rest_cannot_manage_themes');
  });

  it('activates an installed block theme from the data directory', async () => {
    const ctx = await site();
    const dir = path.join(ctx.dataDir, 'themes', 'tiny');
    await mkdir(path.join(dir, 'templates'), { recursive: true });
    await writeFile(path.join(dir, 'style.css'), '/*\nTheme Name: Tiny\nVersion: 0.1\n*/');
    await writeFile(
      path.join(dir, 'templates', 'index.html'),
      '<!-- wp:site-title /--><!-- wp:paragraph --><p>Tiny theme</p><!-- /wp:paragraph -->',
    );
    expect((await ctx.request('POST', '/pressbase/v1/themes/missing/activate')).status).toBe(404);
    const res = await ctx.request('POST', '/pressbase/v1/themes/tiny/activate');
    expect(res.body).toMatchObject({ stylesheet: 'tiny', status: 'active' });
    expect(await ctx.kernel.options.get('stylesheet')).toBe('tiny');
    const home = await page(ctx, '/');
    expect(home.html).toContain('<p>Tiny theme</p>');
    expect(home.html).toContain('wp-theme-tiny');
  });

  it('registers the theme patterns, converted from PHP', async () => {
    const ctx = await site();
    const patterns = (await ctx.request('GET', '/wp/v2/block-patterns/patterns')).body as {
      name: string;
      content: string;
    }[];
    const footer = patterns.find((p) => p.name === 'pressbase/footer');
    expect(footer?.content).toContain(
      'Powered by <a href="https://github.com/WarnHack-Technologies-Private-Limited/pressbase" rel="nofollow">Pressbase</a>',
    );
    expect(footer?.content).toContain('src="/wp-content/themes/pressbase/assets/images/');
    expect(patterns.some((p) => p.content.includes('<?php'))).toBe(false);
    const categories = (await ctx.request('GET', '/wp/v2/block-patterns/categories')).body;
    expect(categories.map((c: { name: string }) => c.name)).toContain('pressbase_page');
  });

  it('serves theme files safely', async () => {
    const ctx = await site();
    const font = await ctx.app.request(
      '/wp-content/themes/pressbase/assets/fonts/manrope/Manrope-VariableFont_wght.woff2',
    );
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect(font.headers.get('x-content-type-options')).toBe('nosniff');
    const etag = font.headers.get('etag') ?? '';
    const again = await ctx.app.request(
      '/wp-content/themes/pressbase/assets/fonts/manrope/Manrope-VariableFont_wght.woff2',
      { headers: { 'if-none-match': etag } },
    );
    expect(again.status).toBe(304);
    const css = await ctx.app.request('/wp-includes/css/dist/block-library/style.min.css');
    expect(css.status).toBe(200);
    expect(await css.text()).toContain('wp-block-navigation');

    // Source files, unknown themes and traversal are 404s.
    for (const url of [
      '/wp-content/themes/pressbase/functions.php',
      '/wp-content/themes/pressbase/theme.json',
      '/wp-content/themes/pressbase/templates/index.html',
      '/wp-content/themes/pressbase/patterns/footer.php',
      '/wp-content/themes/nope/style.css',
      '/wp-content/themes/pressbase/..%2F..%2Fpackage.json',
      '/wp-content/themes/pressbase/assets%2F..%2F..%2Fstyle.css',
      '/wp-content/themes/pressbase/.hidden.css',
      '/wp-includes/../package.json',
      '/wp-includes/css/dist/block-library/missing.css',
    ]) {
      expect((await ctx.app.request(url)).status, url).toBe(404);
    }
  });

  it('refuses symlinks that leave the theme folder', async () => {
    const ctx = await site();
    const dir = path.join(ctx.dataDir, 'themes', 'linky');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'style.css'), '/*\nTheme Name: Linky\n*/');
    await writeFile(path.join(ctx.dataDir, 'secret.css'), 'secret');
    await symlink(path.join(ctx.dataDir, 'secret.css'), path.join(dir, 'leak.css'));
    expect((await ctx.app.request('/wp-content/themes/linky/style.css')).status).toBe(200);
    expect((await ctx.app.request('/wp-content/themes/linky/leak.css')).status).toBe(404);
  });
});

describe('public site with the Pressbase theme', () => {
  it('renders the home page: header, latest posts through core/query, footer', async () => {
    const ctx = await site();
    await post(ctx, {
      title: 'Second story',
      content: '<!-- wp:paragraph --><p>Body two</p><!-- /wp:paragraph -->',
    });
    const home = await page(ctx, '/');
    expect(home.status).toBe(200);
    expect(home.headers['content-type']).toBe('text/html; charset=utf-8');
    const { html } = home;
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>Test Site</title>');
    expect(html).toContain("id='global-styles-inline-css'");
    expect(html).toContain('--wp--preset--color--accent: #3b4cca;');
    expect(html).toContain("<style class='wp-fonts-local'>");
    expect(html).toContain('/wp-content/themes/pressbase/style.css?ver=1.0.0');
    expect(html).toContain('<body class="home blog');
    expect(html).toContain('<div class="wp-site-blocks">');
    expect(html).toContain('<header class="wp-block-template-part">');
    expect(html).toMatch(
      /<p class="wp-block-site-title"><a href="http:\/\/localhost:3000" target="_self" rel="home">Test Site<\/a><\/p>/,
    );
    // Main and its layout support classes and generated container CSS.
    expect(html).toMatch(
      /<main id="wp--skip-link--target" class="wp-block-group is-layout-flow wp-container-core-group-is-layout-[0-9a-f]{8} wp-block-group-is-layout-flow"/,
    );
    expect(html).toContain('Skip to content');
    expect(html).toMatch(
      /class="wp-block-group is-content-justification-right is-nowrap is-layout-flex wp-container-core-group-is-layout-[0-9a-f]{8} wp-block-group-is-layout-flex"/,
    );
    expect(html).toMatch(
      /id='core-block-supports-inline-css'>\n[^<]*\.wp-container-core-group-is-layout-[0-9a-f]{8}\{flex-wrap:nowrap;gap:var\(--wp--preset--spacing--40\);justify-content:flex-end;\}/,
    );
    // The blog heading, the posts in a grid and the footer pattern.
    expect(html).toContain(
      '<h1 class="wp-block-heading has-text-align-center has-display-font-size">Notes, essays and <em>news</em>.</h1>',
    );
    expect(html).toMatch(
      /<ul class="columns-3 has-native-responsive-grid is-style-reveal wp-block-post-template is-layout-grid wp-container-core-post-template-is-layout-[0-9a-f]{8} wp-block-post-template-is-layout-grid"><li class="wp-block-post post-\d+ post type-post status-publish format-standard hentry category-uncategorized"/,
    );
    expect(html).toContain('Second story');
    expect(html).toContain('Body two');
    expect(html.indexOf('Second story')).toBeLessThan(html.indexOf('Hello world!'));
    expect(html).toContain('<footer class="wp-block-template-part">');
    expect(html).toContain(
      'Powered by <a href="https://github.com/WarnHack-Technologies-Private-Limited/pressbase" rel="nofollow">Pressbase</a>',
    );
    // Navigation falls back to the page list, with the responsive overlay.
    expect(html).toContain(
      '<button aria-haspopup="dialog" aria-label="Open menu" class="wp-block-navigation__responsive-container-open">',
    );
    expect(html).toContain('wp-block-pages-list__item');
    expect(html).toContain('<noscript>');
    // No PHP, no unrendered comment blocks.
    expect(html).not.toContain('<?php');
    expect(html).not.toContain('<!-- wp:');
  });

  it('paginates the main query with /page/N/ and 404s past the end', async () => {
    const ctx = await site();
    await ctx.kernel.options.set('posts_per_page', 1);
    await post(ctx, { title: 'Newer' });
    const first = await page(ctx, '/');
    expect(first.html).toContain('Newer');
    expect(first.html).toContain('<nav class="alignwide wp-block-query-pagination');
    expect(first.html).toMatch(
      /<a href="http:\/\/localhost:3000\/page\/2\/" class="wp-block-query-pagination-next">Next Page<span class='wp-block-query-pagination-next-arrow is-arrow-arrow' aria-hidden='true'>→<\/span><\/a>/,
    );
    const second = await page(ctx, '/page/2/');
    expect(second.status).toBe(200);
    expect(second.html).toContain('Hello world!');
    expect(second.html).toContain(
      '<span aria-current="page" class="page-numbers current">2</span>',
    );
    expect(second.html).toContain('paged-2');
    expect((await page(ctx, '/page/9/')).status).toBe(404);
  });

  it('renders a single post with title, featured image, author, terms and post navigation', async () => {
    const ctx = await site();
    const jpeg = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();
    const form = new FormData();
    form.set('file', new File([new Uint8Array(jpeg)], 'cover.jpg', { type: 'image/jpeg' }));
    const cookie = (
      await ctx.app.request('/wp-json/pressbase/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pressbase-request': '1' },
        body: JSON.stringify({ login: 'admin', password: 'correct horse battery staple' }),
      })
    ).headers
      .get('set-cookie')
      ?.split(';')[0];
    const media = (await (
      await ctx.app.request('/wp-json/wp/v2/media', {
        method: 'POST',
        headers: { cookie: cookie ?? '', 'x-pressbase-request': '1' },
        body: form,
      })
    ).json()) as { id: number };
    const tag = (await ctx.request('POST', '/wp/v2/tags', { name: 'Gardens' })).body;
    const created = await post(ctx, {
      title: 'A walk <em>outside</em>',
      content: '<!-- wp:paragraph --><p>Leaves everywhere.</p><!-- /wp:paragraph -->',
      featured_media: media.id,
      tags: [tag.id],
    });
    const url = new URL(created.link).pathname;
    expect(url).toMatch(/^\/\d{4}\/\d{2}\/\d{2}\/a-walk-outside\/$/);
    const { status, html } = await page(ctx, url);
    expect(status).toBe(200);
    expect(html).toContain('<title>A walk outside &#8211; Test Site</title>');
    expect(html).toMatch(
      /<body class="wp-singular post-template-default single single-post postid-\d+ single-format-standard/,
    );
    expect(html).toContain(
      '<h1 class="wp-block-post-title has-xxx-large-font-size">A walk <em>outside</em></h1>',
    );
    expect(html).toMatch(
      /<figure class="alignwide wp-block-post-featured-image" style="margin-top:var\(--wp--preset--spacing--50\);margin-bottom:var\(--wp--preset--spacing--50\);"><img width="1200" height="800" src="http:\/\/localhost:3000\/wp-content\/uploads\/\d{4}\/\d{2}\/cover\.jpg" class="attachment-post-thumbnail size-post-thumbnail wp-post-image" alt="" style="aspect-ratio:16\/9;width:100%;object-fit:cover;" decoding="async" fetchpriority="high"/,
    );
    expect(html).toContain('srcset=');
    expect(html).toContain(
      '<div class="entry-content alignfull wp-block-post-content has-global-padding is-layout-constrained wp-block-post-content-is-layout-constrained"><p>Leaves everywhere.</p></div>',
    );
    expect(html).toMatch(/class="wp-block-post-author-name__link">admin<\/a>/);
    expect(html).toContain('rel="tag">Gardens</a>');
    expect(html).toContain('<div class="taxonomy-post_tag is-style-links wp-block-post-terms"');
    // Block style variations (the outline buttons) are generated per instance.
    expect(html).toMatch(/is-style-outline--\d/);
    expect(html).toContain("id='block-style-variation-styles-inline-css'");
    // Previous post link to the sample post; no next.
    expect(html).toMatch(
      /<div class="post-navigation-link-previous wp-block-post-navigation-link"><span class="wp-block-post-navigation-link__arrow-previous is-arrow-arrow" aria-hidden="true">←<\/span><a href="[^"]+hello-world\/" rel="prev">Hello world!<\/a><\/div>/,
    );
    expect(html).toContain(
      '<div class="post-navigation-link-next wp-block-post-navigation-link"></div>',
    );
    expect(html).toMatch(
      /<link rel="canonical" href="http:\/\/localhost:3000\/\d{4}\/\d{2}\/\d{2}\/a-walk-outside\/" \/>/,
    );
    // The comments area renders, with the reply form posting to /wp-comments-post.
    expect(html).toContain('<div class="wp-block-comments');
    expect(html).toContain('id="respond"');
    expect(html).toMatch(/<form[^>]+action="[^"]*\/wp-comments-post(\.php)?"/);
    expect(mainOf(html)).toContain('From the <em>journal</em>');
  });

  it('redirects ?p= and missing trailing slashes to the permalink, and keeps drafts private', async () => {
    const ctx = await site();
    const created = await post(ctx, { title: 'Moved' });
    const byId = await page(ctx, `/?p=${created.id}`);
    expect(byId.status).toBe(301);
    expect(byId.headers.location).toBe(created.link);
    const noSlash = await page(ctx, new URL(created.link).pathname.replace(/\/$/, ''));
    expect(noSlash.status).toBe(301);
    const draft = await post(ctx, { title: 'Secret draft', status: 'draft' });
    expect((await page(ctx, `/?p=${draft.id}`)).status).toBe(404);
    const priv = await post(ctx, { title: 'Members', status: 'private' });
    expect((await page(ctx, `/?p=${priv.id}`)).status).toBe(404);
  });

  it('asks for the password of a protected post', async () => {
    const ctx = await site();
    const created = await post(ctx, {
      title: 'Locked',
      content: '<!-- wp:paragraph --><p>Hidden words</p><!-- /wp:paragraph -->',
      password: 'open sesame',
    });
    const url = new URL(created.link).pathname;
    const locked = await page(ctx, url);
    expect(locked.html).toContain('class="post-password-form"');
    expect(locked.html).not.toContain('Hidden words');
    expect(locked.html).toContain('Protected: Locked');
    const form = new URLSearchParams({ post_password: 'open sesame', redirect_to: url });
    const res = await ctx.app.request('/wp-login.php?action=postpass', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(url);
    const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
    const unlocked = await page(ctx, url, { cookie });
    expect(unlocked.html).toContain('Hidden words');
    // Off-site redirects are refused.
    const evil = await ctx.app.request('/wp-login.php?action=postpass', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        post_password: 'x',
        redirect_to: 'https://evil.example/',
      }).toString(),
    });
    expect(evil.headers.get('location')).toBe('http://localhost:3000/');
  });

  it('renders a page by its nested path with the page template', async () => {
    const ctx = await site();
    const parent = await post(ctx, { title: 'About' }, 'pages');
    await post(
      ctx,
      {
        title: 'Our team',
        parent: parent.id,
        content: '<!-- wp:paragraph --><p>We are three.</p><!-- /wp:paragraph -->',
      },
      'pages',
    );
    const { status, html } = await page(ctx, '/about/our-team/');
    expect(status).toBe(200);
    expect(html).toMatch(
      /<body class="wp-singular page-template-default page page-id-\d+ page-child parent-pageid-\d+/,
    );
    expect(html).toContain('<h1 class="wp-block-post-title has-display-font-size">Our team</h1>');
    expect(html).toContain('We are three.');
    expect(html).not.toContain('wp-block-post-author-name__link');
    expect((await page(ctx, '/our-team/')).status).toBe(404);
  });

  it('renders a category archive with its title and description', async () => {
    const ctx = await site();
    const cat = (
      await ctx.request('POST', '/wp/v2/categories', {
        name: 'Recipes',
        description: 'Things to cook.',
      })
    ).body;
    await post(ctx, { title: 'Soup', categories: [cat.id] });
    const { status, html } = await page(ctx, '/category/recipes/');
    expect(status).toBe(200);
    expect(html).toContain('<title>Recipes &#8211; Test Site</title>');
    expect(html).toMatch(/<body class="archive category category-recipes category-\d+/);
    expect(html).toContain(
      '<h1 class="has-text-align-center wp-block-query-title has-xxx-large-font-size">Category: <span>Recipes</span></h1>',
    );
    expect(html).toContain(
      '<div class="has-text-align-center wp-block-term-description has-large-font-size"><p>Things to cook.</p>',
    );
    expect(mainOf(html)).toContain('Soup');
    expect(mainOf(html)).not.toContain('Hello world!');
    expect((await page(ctx, '/category/nothing-here/')).status).toBe(404);
    // A tag archive uses the archive template too.
    expect((await page(ctx, '/tag/missing/')).status).toBe(404);
  });

  it('renders search results and the no-results message', async () => {
    const ctx = await site();
    await post(ctx, { title: 'Tomato season', content: 'Red and ripe.' });
    const found = await page(ctx, '/?s=tomato');
    expect(found.status).toBe(200);
    expect(found.html).toContain(
      '<title>Search Results for &#8220;tomato&#8221; &#8211; Test Site</title>',
    );
    expect(found.html).toMatch(/<body class="search search-results/);
    expect(found.html).toContain(
      '<h1 class="has-text-align-center wp-block-query-title has-xxx-large-font-size">Search results for: &#8220;tomato&#8221;</h1>',
    );
    expect(mainOf(found.html)).toContain('Tomato season');
    expect(found.html).not.toContain('Sorry, nothing matched.');
    const none = await page(ctx, '/?s=zucchini');
    expect(none.html).toMatch(/<body class="search search-no-results/);
    expect(none.html).toContain('Sorry, nothing matched. Try a search with different words.');
    expect(none.html).toContain('wp-block-search__input');
  });

  it('answers 404 with the 404 template', async () => {
    const ctx = await site();
    const { status, html, headers } = await page(ctx, '/no/such/thing/');
    expect(status).toBe(404);
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
    expect(html).toContain('<title>Page not found &#8211; Test Site</title>');
    expect(html).toContain('<body class="error404');
    expect(html).toContain('This page took <em>another</em> road.');
    expect(html).toContain('Error 404');
  });

  it('honours a static front page and a posts page (Settings → Reading)', async () => {
    const ctx = await site();
    const front = await post(
      ctx,
      { title: 'Welcome', content: '<!-- wp:paragraph --><p>Hi there</p><!-- /wp:paragraph -->' },
      'pages',
    );
    const blog = await post(ctx, { title: 'Journal' }, 'pages');
    await ctx.request('POST', '/wp/v2/settings', {
      show_on_front: 'page',
      page_on_front: front.id,
      page_for_posts: blog.id,
    });
    const home = await page(ctx, '/');
    expect(home.html).toMatch(
      /<body class="home wp-singular page-template-default page page-id-\d+/,
    );
    expect(home.html).toContain('Hi there');
    expect(home.html).not.toContain('Hello world!');
    const journal = await page(ctx, '/journal/');
    expect(journal.html).toMatch(/<body class="blog/);
    expect(mainOf(journal.html)).toContain('Hello world!');
  });

  it('renders date and author archives', async () => {
    const ctx = await site();
    const year = new Date().getFullYear();
    const byYear = await page(ctx, `/${year}/`);
    expect(byYear.status).toBe(200);
    expect(byYear.html).toContain(`Year: <span>${year}</span>`);
    const author = await page(ctx, '/author/admin/');
    expect(author.status).toBe(200);
    expect(author.html).toContain('Author: <span><span class="vcard">admin</span></span>');
    expect((await page(ctx, '/author/nobody/')).status).toBe(404);
  });

  it('returns 304 for an unchanged page and refuses absolute URLs', async () => {
    const ctx = await site();
    const first = await page(ctx, '/');
    const again = await page(ctx, '/', { 'if-none-match': first.headers.etag ?? '' });
    expect(again.status).toBe(304);
    const bad = await ctx.app.request(
      `/wp-json/pressbase/v1/render?url=${encodeURIComponent('https://evil.example/')}`,
    );
    expect(bad.status).toBe(400);
  });

  it('is unavailable before installation', async () => {
    const ctx = await setup();
    const res = await ctx.app.request('/wp-json/pressbase/v1/render?url=/');
    expect(res.status).toBe(503);
  });
});
