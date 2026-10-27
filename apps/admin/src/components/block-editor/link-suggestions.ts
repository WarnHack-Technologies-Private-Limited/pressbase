import apiFetch from '@wordpress/api-fetch';

/**
 * The editor's `__experimentalFetchLinkSuggestions` setting: what the link
 * popover searches. A port of core-data's fetchLinkSuggestions()
 * (@wordpress/core-data/src/fetch/__experimental-fetch-link-suggestions.ts):
 * posts and pages, then categories and tags, from /wp/v2/search, ranked the
 * same way. Post formats and attachments are left out (Pressbase has no post
 * formats, and links to files are added from the Media Library).
 *
 * If core has no /wp/v2/search (an older core), it falls back to searching
 * /wp/v2/posts and /wp/v2/pages directly, and remembers that for the session.
 */

export interface LinkSuggestion {
  id: number;
  url: string;
  title: string;
  /** post, page, category, post_tag… */
  type: string;
  kind: 'post-type' | 'taxonomy';
}

export interface SearchResult {
  id: number | string;
  title: string;
  url: string;
  type: string;
  subtype?: string;
}

interface RestItem {
  id: number;
  link: string;
  type: string;
  title: { rendered: string };
}

export interface SuggestionOptions {
  perPage?: number;
  isInitialSuggestions?: boolean;
  type?: 'post' | 'term' | 'post-format' | 'attachment';
  subtype?: string;
  page?: number;
}

type Fetch = <T>(options: { path: string }) => Promise<T>;

/** Turns the few entities WordPress titles contain back into text. */
export const decodeEntities = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&#8216;|&lsquo;/g, '‘')
    .replace(/&#8220;|&ldquo;/g, '“')
    .replace(/&#8221;|&rdquo;/g, '”')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&');

/** /wp/v2/search items → link suggestions (core-data's mapping). */
export function toSuggestions(
  results: SearchResult[],
  kind: LinkSuggestion['kind'],
): LinkSuggestion[] {
  return results
    .filter((result) => Boolean(result.id))
    .map((result) => ({
      id: Number(result.id),
      url: result.url,
      title: decodeEntities(result.title || '') || '(no title)',
      type: result.subtype || result.type,
      kind,
    }));
}

export const tokenize = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const plain = (text: string) =>
  (text ?? '').toLowerCase().trim().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/**
 * core-data's sortResults(): titles holding every word first, then the whole
 * phrase, then posts before terms, then titles that start with the search,
 * then how much of the matched word the search covers.
 */
export function sortSuggestions(results: LinkSuggestion[], search: string): LinkSuggestion[] {
  const tokens = tokenize(search);
  const needle = plain(search);
  const scored = results.map((result) => {
    const titleTokens = tokenize(result.title);
    const haystack = plain(result.title);
    const coverage = tokens.length
      ? (tokens.reduce(
          (total, token) =>
            total +
            titleTokens.reduce(
              (best, word) =>
                word.includes(token) ? Math.max(best, token.length / word.length) : best,
              0,
            ),
          0,
        ) /
          tokens.length) *
        10
      : 0;
    return {
      result,
      found: tokens.filter((token) => titleTokens.some((word) => word.includes(token))).length,
      contains: Boolean(needle && haystack.includes(needle)),
      begins: Boolean(needle && haystack.startsWith(needle)),
      type: result.kind === 'post-type' ? 2 : 1,
      coverage,
    };
  });
  scored.sort(
    (a, b) =>
      b.found - a.found ||
      Number(b.contains) - Number(a.contains) ||
      b.type - a.type ||
      Number(b.begins) - Number(a.begins) ||
      b.coverage - a.coverage,
  );
  return scored.map(({ result }) => result);
}

const isNoRoute = (error: unknown) =>
  (error as { code?: string } | undefined)?.code === 'rest_no_route';

/** Builds the setting around a fetcher (api-fetch in the editor, a stub in tests). */
export function createLinkSuggestions(fetcher: Fetch) {
  // null until the first search tells us whether /wp/v2/search exists.
  let hasSearch: boolean | null = null;
  // A function, so TypeScript doesn't narrow it across the awaits below.
  const searchMissing = () => hasSearch === false;

  const searchRoute = async (path: string, kind: LinkSuggestion['kind']) => {
    try {
      const results = await fetcher<SearchResult[]>({ path });
      hasSearch = true;
      return toSuggestions(results, kind);
    } catch (error) {
      if (isNoRoute(error)) hasSearch = false;
      return [];
    }
  };

  const legacy = async (search: string, per: number): Promise<LinkSuggestion[]> => {
    const query = (base: string) =>
      fetcher<RestItem[]>({
        path: `/wp/v2/${base}?search=${encodeURIComponent(search)}&per_page=${per}&_fields=id,link,type,title`,
      }).catch(() => [] as RestItem[]);
    const [posts, pages] = await Promise.all([query('posts'), query('pages')]);
    return [...posts, ...pages].map((item) => ({
      id: item.id,
      url: item.link,
      title: decodeEntities(item.title.rendered) || '(no title)',
      type: item.type,
      kind: 'post-type' as const,
    }));
  };

  return async function fetchLinkSuggestions(
    search: string,
    { perPage, isInitialSuggestions = false, type, subtype, page }: SuggestionOptions = {},
  ): Promise<LinkSuggestion[]> {
    const per = perPage ?? (isInitialSuggestions ? 3 : 20);
    const wantsPosts = !type || type === 'post';
    const wantsTerms = !type || type === 'term';
    // The fallback only knows posts and pages.
    const fallback = async () =>
      wantsPosts ? sortSuggestions(await legacy(search, per), search) : [];
    if (searchMissing()) return fallback();

    const params = (searchType: 'post' | 'term') => {
      const q = new URLSearchParams({ search, per_page: String(per), type: searchType });
      if (subtype) q.set('subtype', subtype);
      if (page) q.set('page', String(page));
      return `/wp/v2/search?${q}`;
    };
    const [posts, terms] = await Promise.all([
      wantsPosts ? searchRoute(params('post'), 'post-type') : [],
      wantsTerms ? searchRoute(params('term'), 'taxonomy') : [],
    ]);
    if (searchMissing()) return fallback();
    return sortSuggestions([...posts, ...terms], search);
  };
}

export const fetchLinkSuggestions = createLinkSuggestions(
  (options) => apiFetch(options) as Promise<never>,
);
