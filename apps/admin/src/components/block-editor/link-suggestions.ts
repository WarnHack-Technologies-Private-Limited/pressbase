import apiFetch from '@wordpress/api-fetch';

/**
 * The editor's `__experimentalFetchLinkSuggestions` setting: what the link
 * popover searches. WordPress uses /wp/v2/search; until core has it, this
 * searches published posts and pages directly.
 */

export interface LinkSuggestion {
  id: number;
  url: string;
  title: string;
  type: string;
  kind: 'post-type';
}

interface RestItem {
  id: number;
  link: string;
  type: string;
  title: { rendered: string };
}

const decode = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

export async function fetchLinkSuggestions(
  search: string,
  {
    perPage = 10,
    isInitialSuggestions = false,
  }: { perPage?: number; isInitialSuggestions?: boolean } = {},
): Promise<LinkSuggestion[]> {
  const per = isInitialSuggestions ? 3 : perPage;
  const query = (base: string) =>
    apiFetch<RestItem[]>({
      path: `/wp/v2/${base}?search=${encodeURIComponent(search)}&per_page=${per}&_fields=id,link,type,title`,
    }).catch(() => [] as RestItem[]);
  const [posts, pages] = await Promise.all([query('posts'), query('pages')]);
  return [...posts, ...pages].slice(0, per).map((item) => ({
    id: item.id,
    url: item.link,
    title: decode(item.title.rendered) || '(no title)',
    type: item.type,
    kind: 'post-type',
  }));
}
