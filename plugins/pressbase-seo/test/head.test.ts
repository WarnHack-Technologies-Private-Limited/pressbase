import { describe, expect, it } from 'vitest';
import { api, graph, head, meta, publish, render, site } from './helpers';

/** Public output: title, description, canonical, robots, Open Graph, X and the schema graph. */

describe('head output', () => {
  it('prints Yoast-compatible tags for a post from its _yoast_wpseo_* meta', async () => {
    const ctx = await site();
    const cat = await ctx.request('POST', '/wp/v2/categories', { name: 'Recipes' });
    const post = await publish(ctx, {
      title: 'Green tea basics',
      content: '<!-- wp:paragraph --><p>How to brew green tea well.</p><!-- /wp:paragraph -->',
      categories: [cat.body.id],
      meta: {
        _yoast_wpseo_title: '%%title%% %%sep%% Brewing guide %%sep%% %%sitename%%',
        _yoast_wpseo_metadesc: 'Water temperature, timing and leaves: brew %%title%% the calm way.',
        _yoast_wpseo_focuskw: 'green tea',
      },
    });
    const { html } = await render(ctx, post.link);
    const h = head(html);
    expect(h).toContain('<title>Green tea basics - Brewing guide - Test Site</title>');
    expect(h).toContain(
      '<meta name="description" content="Water temperature, timing and leaves: brew Green tea basics the calm way." />',
    );
    expect(h.match(/rel="canonical"/g)).toHaveLength(1);
    expect(h).toContain(`<link rel="canonical" href="${post.link}" />`);
    expect(h).toContain(
      "<meta name='robots' content='index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1' />",
    );
    expect(meta(h, 'property', 'og:type')).toBe('article');
    expect(meta(h, 'property', 'og:title')).toBe('Green tea basics - Brewing guide - Test Site');
    expect(meta(h, 'property', 'og:url')).toBe(post.link);
    expect(meta(h, 'property', 'og:site_name')).toBe('Test Site');
    expect(meta(h, 'property', 'article:published_time')).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(meta(h, 'name', 'twitter:card')).toBe('summary_large_image');

    const nodes = graph(h);
    const types = nodes.map((n) => n['@type']);
    expect(types).toEqual(['Article', 'WebPage', 'BreadcrumbList', 'WebSite', 'Person']);
    const article = nodes[0] as Record<string, unknown>;
    expect(article['@id']).toBe(`${post.link}#article`);
    expect(article.headline).toBe('Green tea basics');
    expect(article.articleSection).toEqual(['Recipes']);
    expect(article.author).toEqual({ name: 'admin', '@id': 'http://localhost:3000/#/schema/person/1' });
    const crumbs = nodes[2] as { itemListElement: Record<string, unknown>[] };
    expect(crumbs.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'http://localhost:3000/' },
      { '@type': 'ListItem', position: 2, name: 'Recipes', item: 'http://localhost:3000/category/recipes/' },
      { '@type': 'ListItem', position: 3, name: 'Green tea basics' },
    ]);
    const website = nodes[3] as Record<string, unknown>;
    expect(website['@id']).toBe('http://localhost:3000/#website');
    expect(JSON.stringify(website.potentialAction)).toContain('?s={search_term_string}');
  });

  it('uses the post type template, noindex and nofollow, and a custom canonical', async () => {
    const ctx = await site();
    const post = await publish(ctx, {
      title: 'Hidden',
      meta: {
        '_yoast_wpseo_meta-robots-noindex': '1',
        '_yoast_wpseo_meta-robots-nofollow': '1',
      },
    });
    const h = head((await render(ctx, post.link)).html);
    expect(h).toContain('<title>Hidden - Test Site</title>');
    expect(h).toContain("<meta name='robots' content='noindex, nofollow' />");
    // No canonical on a noindexed page, as Yoast does.
    expect(h).not.toContain('rel="canonical"');

    const other = await publish(ctx, {
      title: 'Syndicated',
      meta: { _yoast_wpseo_canonical: 'https://example.org/original/' },
    });
    expect(head((await render(ctx, other.link)).html)).toContain(
      '<link rel="canonical" href="https://example.org/original/" />',
    );
  });

  it('follows wpseo_titles: separator, templates and archive noindex, and purges on change', async () => {
    const ctx = await site();
    const seo = api(ctx);
    const purges: string[][] = [];
    ctx.kernel.hooks.addAction('pressbase_cache_purge', async (tags: string[]) => {
      purges.push(tags);
    });
    await seo.settings.set('titles', {
      ...(await seo.settings.get<Record<string, unknown>>('titles')),
      separator: 'sc-pipe',
      'title-post': '%%title%% %%sep%% %%sitename%%',
      'metadesc-post': 'About %%title%%.',
      'noindex-author-wpseo': true,
      'title-tax-category': '%%term_title%% topics %%sep%% %%sitename%%',
    });
    expect(purges).toContainEqual(['pressbase-seo:settings']);
    const post = await publish(ctx, { title: 'Templated' });
    const h = head((await render(ctx, post.link)).html);
    expect(h).toContain('<title>Templated | Test Site</title>');
    expect(h).toContain('<meta name="description" content="About Templated." />');
    expect(head((await render(ctx, '/author/admin/')).html)).toContain('noindex');
    const category = head((await render(ctx, '/category/uncategorized/')).html);
    expect(category).toContain('<title>Uncategorized topics | Test Site</title>');
    expect(category).toContain('<link rel="canonical" href="http://localhost:3000/category/uncategorized/" />');
    expect(graph(category).map((n) => n['@type'])).toContain('CollectionPage');
  });

  it('describes the home page, the organisation and the default share image', async () => {
    const ctx = await site();
    const seo = api(ctx);
    await seo.settings.set('titles', {
      ...(await seo.settings.get<Record<string, unknown>>('titles')),
      company_or_person: 'company',
      company_name: 'Tea House Ltd',
      company_logo: 'https://cdn.example.org/logo.png',
    });
    await seo.settings.set('social', {
      ...(await seo.settings.get<Record<string, unknown>>('social')),
      facebook_site: 'https://www.facebook.com/teahouse',
      twitter_site: 'teahouse',
      og_default_image: 'https://cdn.example.org/share.png',
    });
    const h = head((await render(ctx, '/')).html);
    expect(h).toContain('<link rel="canonical" href="http://localhost:3000/" />');
    expect(meta(h, 'property', 'og:type')).toBe('website');
    expect(meta(h, 'property', 'og:image')).toBe('https://cdn.example.org/share.png');
    expect(meta(h, 'name', 'twitter:site')).toBe('@teahouse');
    const org = graph(h).find((n) => n['@type'] === 'Organization') as Record<string, unknown>;
    expect(org).toMatchObject({
      '@id': 'http://localhost:3000/#organization',
      name: 'Tea House Ltd',
      sameAs: ['https://www.facebook.com/teahouse', 'https://x.com/teahouse'],
    });
    expect((org.logo as Record<string, unknown>).url).toBe('https://cdn.example.org/logo.png');
    const website = graph(h).find((n) => n['@type'] === 'WebSite') as Record<string, unknown>;
    expect(website.publisher).toEqual({ '@id': 'http://localhost:3000/#organization' });
  });

  it('leaves search and 404 pages out of the index and lets the graph be filtered', async () => {
    const ctx = await site();
    expect(head((await render(ctx, '/?s=tea')).html)).toContain('noindex');
    const missing = await render(ctx, '/no-such-page/');
    expect(head(missing.html)).toContain('<title>Page not found - Test Site</title>');
    expect(head(missing.html)).toContain('noindex');

    ctx.kernel.hooks.addFilter('pressbase_seo_schema_graph', (nodes) => [
      ...(nodes as unknown[]),
      { '@type': 'FAQPage', '@id': 'http://localhost:3000/#faq' },
    ]);
    const post = await publish(ctx, { title: 'Filtered' });
    expect(graph(head((await render(ctx, post.link)).html)).map((n) => n['@type'])).toContain('FAQPage');
  });

  it('adds pressbase_seo_head to posts and terms in REST', async () => {
    const ctx = await site();
    const post = await publish(ctx, { title: 'Headless', meta: { _yoast_wpseo_metadesc: 'For apps.' } });
    const res = await ctx.client().request('GET', `/wp/v2/posts/${post.id}`);
    expect(res.body.pressbase_seo_head).toMatchObject({
      title: 'Headless - Test Site',
      description: 'For apps.',
      canonical: post.link,
      og_type: 'article',
    });
    expect(res.body.pressbase_seo_head.html).toContain('<meta name="description" content="For apps." />');
    expect(res.body.pressbase_seo_head.schema['@graph'].length).toBeGreaterThan(2);
    const terms = await ctx.client().request('GET', '/wp/v2/categories');
    expect(terms.body[0].pressbase_seo_head.title).toBe('Uncategorized Archives - Test Site');
  });
});
