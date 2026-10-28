import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/schema';
import { metaRobots, separatorText } from '../src/shared';
import { aioseoToYoast, rankMathToYoast, replaceVars } from '../src/vars';
import { publish, render, site } from './helpers';

describe('title variables', () => {
  it('replaces Yoast’s %%variables%%, drops unknown ones and tidies separators', () => {
    const values = { title: 'Green tea', sitename: 'Tea House', sep: '-', page: '' };
    expect(replaceVars('%%title%% %%page%% %%sep%% %%sitename%%', values)).toBe('Green tea - Tea House');
    expect(replaceVars('%%title%% %%sep%% %%unknown%% %%sep%% %%sitename%%', values)).toBe(
      'Green tea - Tea House',
    );
    expect(replaceVars('%%sep%% %%sitename%% %%sep%%', values)).toBe('Tea House');
    expect(replaceVars('%%TITLE%%: %%page%%', { ...values, page: 'Page 2 of 3' })).toBe(
      'Green tea: Page 2 of 3',
    );
    expect(replaceVars('%%term_title%% Archives', { title: 'News', sep: '|' })).toBe('News Archives');
    expect(replaceVars('', values)).toBe('');
  });

  it('converts Rank Math and AIOSEO syntax and maps separators and robots', () => {
    expect(rankMathToYoast('%title% %sep% %sitename% %search_query% %term%')).toBe(
      '%%title%% %%sep%% %%sitename%% %%searchphrase%% %%term_title%%',
    );
    expect(aioseoToYoast('#post_title #separator_sa #site_title #hashtag')).toBe(
      '%%title%% %%sep%% %%sitename%% #hashtag',
    );
    expect(separatorText('sc-pipe')).toBe('|');
    expect(separatorText('nonsense')).toBe('-');
    expect(metaRobots({ noindex: '2' }, true)).toEqual({ index: true, follow: true, adv: [] });
    expect(metaRobots({ nofollow: '1', adv: 'noarchive,bogus' }, false)).toEqual({
      index: true,
      follow: false,
      adv: ['noarchive'],
    });
  });
});

describe('schema graph', () => {
  it('links nodes by stable @id and has Google’s required properties', () => {
    const nodes = buildGraph({
      home: 'https://example.org',
      siteName: 'Example',
      siteDescription: '',
      language: 'en-US',
      representation: { type: 'person', id: 4, name: 'Ada', sameAs: ['https://x.com/ada'] },
      page: {
        url: 'https://example.org/post/',
        type: 'WebPage',
        name: 'Post',
        image: { url: 'https://example.org/a.jpg', width: 1200, height: 630 },
      },
      breadcrumbs: [{ name: 'Home', url: 'https://example.org/' }, { name: 'Post' }],
      article: {
        headline: 'Post',
        datePublished: '2026-10-01T10:00:00+00:00',
        dateModified: '2026-10-02T10:00:00+00:00',
        author: { id: 4, name: 'Ada' },
        sections: [],
        keywords: [],
      },
    });
    const byType = Object.fromEntries(nodes.map((n) => [String(n['@type']), n]));
    expect(Object.keys(byType)).toEqual([
      'Article',
      'WebPage',
      'ImageObject',
      'BreadcrumbList',
      'WebSite',
      'Person,Organization',
    ]);
    const article = byType.Article!;
    for (const key of ['headline', 'datePublished', 'dateModified', 'author', 'image']) {
      expect(article).toHaveProperty(key);
    }
    expect(article.publisher).toEqual({ '@id': 'https://example.org/#/schema/person/4' });
    expect(byType.WebPage!.breadcrumb).toEqual({ '@id': 'https://example.org/post/#breadcrumb' });
    // The author and the site's person are one node.
    expect(nodes.filter((n) => String(n['@id']).includes('/schema/person/4'))).toHaveLength(1);
  });
});

describe('breadcrumbs block', () => {
  it('renders the same trail as the BreadcrumbList, through the block and the filter', async () => {
    const ctx = await site();
    const parent = await publish(ctx, { title: 'Services' }, 'pages');
    const child = await publish(
      ctx,
      {
        title: 'Repairs',
        parent: parent.id,
        content: '<!-- wp:pressbase-seo/breadcrumbs {"separator":"/"} /-->',
        meta: { _yoast_wpseo_bctitle: 'Fixing things' },
      },
      'pages',
    );
    const { html } = await render(ctx, child.link);
    expect(html).toContain('<nav class="pressbase-seo-breadcrumbs wp-block-pressbase-seo-breadcrumbs"');
    expect(html).toMatch(
      /<a href="http:\/\/localhost:3000\/">Home<\/a>.*<a href="http:\/\/localhost:3000\/services\/">Services<\/a>.*<span aria-current="page">Fixing things<\/span>/,
    );
    const filtered = await ctx.kernel.hooks.applyFilters('pressbase_seo_breadcrumbs', '', {});
    expect(filtered).toBe(''); // No page render in progress.
  });
});
