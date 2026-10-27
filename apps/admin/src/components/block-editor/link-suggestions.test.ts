import { describe, expect, it, vi } from 'vitest';
import {
  createLinkSuggestions,
  decodeEntities,
  type LinkSuggestion,
  sortSuggestions,
  toSuggestions,
} from './link-suggestions';

const suggestion = (title: string, kind: LinkSuggestion['kind'] = 'post-type'): LinkSuggestion => ({
  id: title.length,
  url: `http://localhost/${title}`,
  title,
  type: kind === 'post-type' ? 'post' : 'category',
  kind,
});

describe('toSuggestions', () => {
  it('maps search results as core-data does', () => {
    expect(
      toSuggestions(
        [
          {
            id: 4,
            title: 'Tom &amp; Jerry&#8217;s',
            url: 'http://x/tj/',
            type: 'post',
            subtype: 'page',
          },
          { id: 9, title: '', url: 'http://x/c/', type: 'category' },
          { id: 0, title: 'dropped', url: '', type: 'post' },
        ],
        'post-type',
      ),
    ).toEqual([
      { id: 4, title: 'Tom & Jerry’s', url: 'http://x/tj/', type: 'page', kind: 'post-type' },
      { id: 9, title: '(no title)', url: 'http://x/c/', type: 'category', kind: 'post-type' },
    ]);
  });

  it('decodes the entities WordPress titles carry', () => {
    expect(decodeEntities('<b>A</b> &ldquo;b&rdquo; &mdash; c &lt;d&gt;')).toBe('A “b” — c <d>');
  });
});

describe('sortSuggestions', () => {
  it('ranks every word first, then the phrase, then posts before terms, then prefixes', () => {
    const results = [
      suggestion('Black is my favourite colour'),
      suggestion('Cats that are black', 'taxonomy'),
      suggestion('Black cats are great', 'taxonomy'),
      suggestion('Black cats', 'post-type'),
    ];
    expect(sortSuggestions(results, 'black cat').map((r) => r.title)).toEqual([
      'Black cats',
      'Black cats are great',
      'Cats that are black',
      'Black is my favourite colour',
    ]);
    expect(
      sortSuggestions([suggestion('Concatenate'), suggestion('Caterpillar')], 'cat').map(
        (r) => r.title,
      ),
    ).toEqual(['Caterpillar', 'Concatenate']);
  });
});

describe('createLinkSuggestions', () => {
  it('searches posts and terms through /wp/v2/search', async () => {
    const fetcher = vi.fn(async ({ path }: { path: string }) =>
      path.includes('type=term')
        ? [{ id: 3, title: 'Gardening', url: 'http://x/category/gardening/', type: 'category' }]
        : [{ id: 7, title: 'Garden', url: 'http://x/garden/', type: 'post', subtype: 'page' }],
    );
    const fetchSuggestions = createLinkSuggestions(fetcher as never);
    const results = await fetchSuggestions('garden');
    expect(fetcher.mock.calls.map(([o]) => o.path)).toEqual([
      '/wp/v2/search?search=garden&per_page=20&type=post',
      '/wp/v2/search?search=garden&per_page=20&type=term',
    ]);
    expect(results).toEqual([
      { id: 7, title: 'Garden', url: 'http://x/garden/', type: 'page', kind: 'post-type' },
      {
        id: 3,
        title: 'Gardening',
        url: 'http://x/category/gardening/',
        type: 'category',
        kind: 'taxonomy',
      },
    ]);
    await fetchSuggestions('', { isInitialSuggestions: true, type: 'post' });
    expect(fetcher.mock.calls.at(-1)?.[0].path).toBe('/wp/v2/search?search=&per_page=3&type=post');
  });

  it('falls back to posts and pages when core has no search route, and remembers', async () => {
    const fetcher = vi.fn(async ({ path }: { path: string }) => {
      if (path.startsWith('/wp/v2/search')) throw { code: 'rest_no_route' };
      return path.startsWith('/wp/v2/pages')
        ? [{ id: 2, link: 'http://x/about/', type: 'page', title: { rendered: 'About' } }]
        : [];
    });
    const fetchSuggestions = createLinkSuggestions(fetcher as never);
    expect(await fetchSuggestions('about')).toEqual([
      { id: 2, url: 'http://x/about/', title: 'About', type: 'page', kind: 'post-type' },
    ]);
    fetcher.mockClear();
    await fetchSuggestions('about');
    expect(fetcher.mock.calls.every(([o]) => !o.path.startsWith('/wp/v2/search'))).toBe(true);
  });

  it('returns nothing for a failed search without giving up on the route', async () => {
    const fetcher = vi.fn(async (_options: { path: string }) => {
      throw { code: 'rest_invalid_param' };
    });
    const fetchSuggestions = createLinkSuggestions(fetcher as never);
    expect(await fetchSuggestions('x')).toEqual([]);
    await fetchSuggestions('y');
    expect(fetcher.mock.calls.at(-1)?.[0]).toMatchObject({
      path: expect.stringContaining('/search'),
    });
  });
});
