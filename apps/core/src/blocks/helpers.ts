import type { WPBlock } from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import type { CurrentUser } from '../auth/users';
import { addCacheTags, CacheTag } from '../cache/tags';
import type { Post } from '../content/posts';
import { sanitizePostTitle } from '../content/sanitize';
import type { Term } from '../content/terms';
import type { Kernel } from '../kernel';
import { formatPhpDate } from './php-date';

/**
 * What core's render callbacks receive as `block.services`: the kernel (for
 * queries, terms, options and permalinks), the user the page is rendered for,
 * and whether this render answers a REST request (wp_is_serving_rest_request()).
 */
export interface BlockServices {
  kernel: Kernel;
  user: CurrentUser | null;
  rest: boolean;
  /**
   * Query variables of the page being rendered (get_query_var()): the comment
   * blocks read `cpage`, `replytocom`, `unapproved` and `moderation-hash`.
   */
  query?: Record<string, string>;
}

export type CoreBlock = WPBlock<BlockServices>;

export interface SiteInfo {
  home: string;
  siteUrl: string;
  name: string;
  description: string;
  pretty: boolean;
  timeZone: string;
  dateFormat: string;
}

/** The options most render callbacks read (get_bloginfo(), home_url(), date_format…). */
export async function siteInfo(kernel: Kernel): Promise<SiteInfo> {
  const get = <T>(name: string, fallback: T) => kernel.options.get<T>(name, fallback);
  const home = (await get('home', '')).replace(/\/+$/, '');
  return {
    home,
    siteUrl: (await get('siteurl', home)).replace(/\/+$/, ''),
    name: await get('blogname', ''),
    description: await get('blogdescription', ''),
    pretty: (await get('permalink_structure', '')) !== '',
    timeZone: await get('timezone_string', 'UTC'),
    dateFormat: await get('date_format', 'F j, Y'),
  };
}

/** The query variable each taxonomy's archive uses ($taxonomy->query_var). */
export function taxonomyQueryVar(taxonomy: string): string {
  if (taxonomy === 'category') return 'category_name';
  if (taxonomy === 'post_tag') return 'tag';
  return taxonomy;
}

/** get_term_link() */
export function termLink(site: SiteInfo, term: Pick<Term, 'id' | 'slug' | 'taxonomy'>): string {
  if (site.pretty) {
    const base = term.taxonomy === 'post_tag' ? 'tag' : term.taxonomy;
    return `${site.home}/${base}/${term.slug}/`;
  }
  if (term.taxonomy === 'category') return `${site.home}/?cat=${term.id}`;
  return `${site.home}/?${taxonomyQueryVar(term.taxonomy)}=${encodeURIComponent(term.slug)}`;
}

/** get_author_posts_url() */
export function authorPostsUrl(site: SiteInfo, author: { id: number; nicename: string }): string {
  return site.pretty
    ? `${site.home}/author/${author.nicename}/`
    : `${site.home}/?author=${author.id}`;
}

/** get_month_link() */
export function monthLink(site: SiteInfo, year: number, month: number): string {
  const mm = String(month).padStart(2, '0');
  return site.pretty ? `${site.home}/${year}/${mm}/` : `${site.home}/?m=${year}${mm}`;
}

/** wp_login_url() / wp_logout_url(): the admin app's sign-in screen. */
export function loginUrl(site: SiteInfo, redirect = ''): string {
  return `${site.siteUrl}/login${redirect ? `?redirect_to=${encodeURIComponent(redirect)}` : ''}`;
}

export function logoutUrl(site: SiteInfo, redirect = ''): string {
  const query = new URLSearchParams({ action: 'logout' });
  if (redirect) query.set('redirect_to', redirect);
  return `${site.siteUrl}/login?${query}`;
}

/**
 * get_the_title(): the title with WordPress's "Protected:" and "Private:"
 * prefixes. Titles are passed through the title allow-list again on output,
 * so a raw `<script>` saved by a user with unfiltered_html can't run inside a
 * server-rendered block (WordPress prints such titles as-is).
 */
export function theTitle(post: Pick<Post, 'title' | 'password' | 'status'>): string {
  let title = sanitizePostTitle(post.title);
  if (post.password) title = `Protected: ${title}`;
  else if (post.status === 'private') title = `Private: ${title}`;
  return title;
}

/** get_the_date() */
export function theDate(site: SiteInfo, date: Date, format = ''): string {
  return formatPhpDate(format || site.dateFormat, date, site.timeZone);
}

/** wp_trim_words(): the first `count` words, with `more` when anything was cut. */
export function trimWords(text: string, count: number, more = '&hellip;'): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= count) return words.join(' ');
  return `${words.slice(0, Math.max(count, 0)).join(' ')}${more}`;
}

/**
 * get_the_excerpt() / wp_trim_excerpt(): the hand-written excerpt, or the
 * content's text cut to `length` words with " [&hellip;]".
 */
export function theExcerpt(
  post: Pick<Post, 'excerpt' | 'content' | 'password'>,
  length = 55,
): string {
  if (post.password) return 'There is no excerpt because this is a protected post.';
  if (post.excerpt.trim()) return sanitizePostTitle(post.excerpt);
  const text = post.content
    .replace(/<(script|style)[^>]*?>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>?/g, ' ')
    .replace(/\]\]>/g, ']]&gt;');
  return trimWords(text, length, ' [&hellip;]');
}

/** A user's display name and nicename, for bylines and author links. */
export async function authorOf(
  kernel: Kernel,
  id: number | null,
): Promise<{ id: number; displayName: string; nicename: string } | undefined> {
  if (!id) return undefined;
  const [user] = await kernel.db
    .select({
      id: schema.users.id,
      displayName: schema.users.displayName,
      nicename: schema.users.nicename,
    })
    .from(schema.users)
    .where(eq(schema.users.id, id));
  if (user) addCacheTags(CacheTag.author(user.id));
  return user;
}

/** The post a post-context block points at: `postId` from block context. */
export async function contextPost(block: CoreBlock): Promise<Post | undefined> {
  const id = Number(block.context.postId);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return block.services.kernel.posts.get(id);
}
