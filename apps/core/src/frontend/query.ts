import { schema } from '@pressbase/db';
import { and, eq, isNull } from 'drizzle-orm';
import { currentUserCan } from '../auth/meta-caps';
import type { CurrentUser } from '../auth/users';
import { siteInfo, termLink } from '../blocks/helpers';
import { addCacheTags, CacheTag } from '../cache/tags';
import {
  basePath,
  type PermalinkBases,
  permalink,
  permalinkBases,
  permalinkContext,
  permalinkHistory,
} from '../content/permalinks';
import type { Post } from '../content/posts';
import { type QueryArgs, queryPosts } from '../content/query';
import type { Term } from '../content/terms';
import type { Kernel } from '../kernel';

/**
 * Request routing and the main query — WP::parse_request() with
 * WP_Rewrite's rules (wordpress/wp-includes/class-wp.php,
 * class-wp-rewrite.php), WP_Query::parse_query() / get_posts() for the main
 * query, and the redirects of redirect_canonical() that matter
 * (canonical-template.php).
 *
 * Instead of generating a regular expression per rewrite rule, the path is
 * matched in WordPress's rule order: /page/N, category, tag, author and
 * search bases, the post permalink structure, date archives, then pages by
 * path (pages first when the structure starts with %postname%, WordPress's
 * "verbose page rules").
 */

export interface Author {
  id: number;
  nicename: string;
  displayName: string;
  description: string;
}

export type QueriedObject =
  | { kind: 'post'; post: Post }
  | { kind: 'term'; term: Term }
  | { kind: 'author'; author: Author }
  | null;

export interface MainQuery {
  /** The arguments queryPosts() ran with (core/query blocks with `inherit` reuse them). */
  args: QueryArgs;
  posts: Post[];
  found: number;
  maxPages: number;
  paged: number;
  perPage: number;
  queriedObject: QueriedObject;
  search: string | undefined;
  date: { year: number; month?: number; day?: number } | undefined;
  /** Set when the request should redirect instead (redirect_canonical()). */
  redirect?: { location: string; status: 301 | 302 };
  isHome: boolean;
  isFrontPage: boolean;
  isSingle: boolean;
  isPage: boolean;
  isSingular: boolean;
  isArchive: boolean;
  isCategory: boolean;
  isTag: boolean;
  isTax: boolean;
  isAuthor: boolean;
  isDate: boolean;
  isYear: boolean;
  isMonth: boolean;
  isDay: boolean;
  isSearch: boolean;
  is404: boolean;
  isPaged: boolean;
}

function emptyQuery(): MainQuery {
  return {
    args: {},
    posts: [],
    found: 0,
    maxPages: 0,
    paged: 1,
    perPage: 10,
    queriedObject: null,
    search: undefined,
    date: undefined,
    isHome: false,
    isFrontPage: false,
    isSingle: false,
    isPage: false,
    isSingular: false,
    isArchive: false,
    isCategory: false,
    isTag: false,
    isTax: false,
    isAuthor: false,
    isDate: false,
    isYear: false,
    isMonth: false,
    isDay: false,
    isSearch: false,
    is404: false,
    isPaged: false,
  };
}

/** WordPress's public query variables, as WP::parse_request() collects them. */
export interface QueryVars {
  p?: number;
  page_id?: number;
  name?: string;
  pagename?: string;
  s?: string;
  cat?: number;
  category_name?: string;
  tag?: string;
  author?: number;
  author_name?: string;
  year?: number;
  monthnum?: number;
  day?: number;
  paged?: number;
  preview?: boolean;
  /** Path fragments matched against the post permalink structure. */
  postDate?: { year?: number; monthnum?: number; day?: number };
  error?: '404';
}

const positiveInt = (value: string | null | undefined): number | undefined => {
  if (value === null || value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
};

/** The permalink structure as a regular expression (WP_Rewrite::generate_rewrite_rules()). */
function structureRegex(structure: string): { regex: RegExp; tags: string[] } | undefined {
  if (!structure.includes('%postname%') && !structure.includes('%post_id%')) return undefined;
  const tags: string[] = [];
  const pattern = structure
    .replace(/^\/+|\/+$/g, '')
    .split(/(%[a-z_]+%)/)
    .map((part) => {
      const tag = /^%([a-z_]+)%$/.exec(part)?.[1];
      if (!tag) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      tags.push(tag);
      switch (tag) {
        case 'year':
          return '([0-9]{4})';
        case 'monthnum':
        case 'day':
        case 'hour':
        case 'minute':
        case 'second':
          return '([0-9]{1,2})';
        case 'post_id':
          return '([0-9]+)';
        case 'category':
          return '(.+?)';
        default:
          return '([^/]+)';
      }
    })
    .join('');
  // An optional trailing page number (/2/) belongs to multi-page posts.
  return { regex: new RegExp(`^${pattern}(?:/([0-9]+))?$`), tags };
}

const DEFAULT_BASES: PermalinkBases = { category: 'category', tag: 'tag' };

/** The rest of `path` after a base (`topics/all`), or undefined when it doesn't start with it. */
function afterBase(path: string, base: string): string[] | undefined {
  if (!path.startsWith(`${base}/`)) return undefined;
  const rest = path.slice(base.length + 1).split('/');
  return rest.every(Boolean) ? rest : undefined;
}

/**
 * WP::parse_request(): the query variables for a URL. `bases` are the
 * category and tag bases (Settings → Permalinks).
 */
export function parseRequest(
  url: URL,
  structure: string,
  bases: PermalinkBases = DEFAULT_BASES,
): QueryVars {
  const vars: QueryVars = {};
  const q = url.searchParams;
  const pretty = structure !== '';
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    return { error: '404' };
  }
  path = path.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');

  if (pretty && path) {
    const paged = /^(?:(.*)\/)?page\/([0-9]+)$/.exec(path);
    if (paged) {
      vars.paged = positiveInt(paged[2]);
      path = paged[1] ?? '';
    }
  }
  if (pretty && path) {
    const segments = path.split('/');
    const [base, ...rest] = segments;
    const category = afterBase(path, bases.category);
    const tag = afterBase(path, bases.tag);
    if (category) vars.category_name = category[category.length - 1];
    else if (tag?.length === 1) vars.tag = tag[0];
    else if (base === 'author' && rest.length === 1) vars.author_name = rest[0];
    else if (base === 'search' && rest.length === 1) vars.s = rest[0];
    else {
      const post = structureRegex(structure);
      const match = post?.regex.exec(path);
      const date = /^([0-9]{4})(?:\/([0-9]{1,2}))?(?:\/([0-9]{1,2}))?$/.exec(path);
      const verbose = /^\/?%(postname|category|tag|author)%/.test(structure);
      if (verbose) vars.pagename = path;
      if (match && post) {
        const postDate: QueryVars['postDate'] = {};
        post.tags.forEach((tag, i) => {
          const value = match[i + 1] ?? '';
          if (tag === 'postname') vars.name = value;
          else if (tag === 'post_id') vars.p = positiveInt(value);
          else if (tag === 'year') postDate.year = Number(value);
          else if (tag === 'monthnum') postDate.monthnum = Number(value);
          else if (tag === 'day') postDate.day = Number(value);
        });
        vars.postDate = postDate;
      } else if (date && !(structure.startsWith('/%postname%') && !verbose)) {
        vars.year = Number(date[1]);
        if (date[2]) vars.monthnum = Number(date[2]);
        if (date[3]) vars.day = Number(date[3]);
      } else if (!verbose) {
        vars.pagename = path;
      }
    }
  } else if (path) {
    // Plain permalinks: only the home page has a path.
    return { error: '404' };
  }

  // Query string variables (WP's public query vars) apply with any structure.
  const p = positiveInt(q.get('p'));
  if (p) vars.p = p;
  const pageId = positiveInt(q.get('page_id'));
  if (pageId) vars.page_id = pageId;
  if (q.has('s')) vars.s = q.get('s') ?? '';
  const cat = positiveInt(q.get('cat'));
  if (cat) vars.cat = cat;
  if (q.get('category_name')) vars.category_name = q.get('category_name') ?? undefined;
  if (q.get('tag')) vars.tag = q.get('tag') ?? undefined;
  const author = positiveInt(q.get('author'));
  if (author) vars.author = author;
  if (q.get('author_name')) vars.author_name = q.get('author_name') ?? undefined;
  if (q.get('name')) vars.name = q.get('name') ?? undefined;
  if (q.get('pagename')) vars.pagename = q.get('pagename') ?? undefined;
  const m = q.get('m');
  if (m && /^\d{4,8}$/.test(m)) {
    vars.year = Number(m.slice(0, 4));
    if (m.length >= 6) vars.monthnum = Number(m.slice(4, 6));
    if (m.length >= 8) vars.day = Number(m.slice(6, 8));
  }
  for (const key of ['year', 'monthnum', 'day'] as const) {
    const value = positiveInt(q.get(key));
    if (value) vars[key] = value;
  }
  const paged = positiveInt(q.get('paged'));
  if (paged) vars.paged = paged;
  if (q.get('preview') === 'true') vars.preview = true;
  return vars;
}

/** The statuses a visitor may see in a listing: published, plus private ones they can read. */
async function readableStatuses(user: CurrentUser | null, type: string): Promise<string[]> {
  const capability = type === 'page' ? 'read_private_pages' : 'read_private_posts';
  return user?.capabilities[capability] ? ['publish', 'private'] : ['publish'];
}

/** Whether a single post may be shown: published, or private/draft the visitor can read. */
async function canView(kernel: Kernel, user: CurrentUser | null, post: Post): Promise<boolean> {
  if (post.status === 'publish') return true;
  if (post.status === 'trash' || post.status === 'auto-draft' || post.status === 'inherit')
    return false;
  if (post.status === 'private') return currentUserCan(kernel, user, 'read_post', post.id);
  // Drafts, pending and scheduled posts: previews for people who can edit them.
  return currentUserCan(kernel, user, 'edit_post', post.id);
}

/** get_page_by_path(): walks the slugs down from the top level. */
async function pageByPath(kernel: Kernel, pagePath: string): Promise<Post | undefined> {
  const slugs = pagePath.split('/').filter(Boolean);
  let parent: number | null = null;
  let found: Post | undefined;
  for (const slug of slugs) {
    const rows: Post[] = await kernel.db
      .select()
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.type, 'page'),
          eq(schema.posts.slug, slug),
          parent === null ? isNull(schema.posts.parentId) : eq(schema.posts.parentId, parent),
        ),
      )
      .limit(1);
    found = rows[0];
    if (!found) return undefined;
    parent = found.id;
  }
  return found;
}

async function termBySlug(
  kernel: Kernel,
  taxonomy: string,
  slug: string,
): Promise<Term | undefined> {
  const { terms } = await kernel.terms.list(taxonomy, { slug: [slug], perPage: 1 });
  return terms[0];
}

async function authorBy(
  kernel: Kernel,
  by: { id?: number; nicename?: string },
): Promise<Author | undefined> {
  const where = by.id ? eq(schema.users.id, by.id) : eq(schema.users.nicename, by.nicename ?? '');
  const [row] = await kernel.db
    .select({
      id: schema.users.id,
      nicename: schema.users.nicename,
      displayName: schema.users.displayName,
    })
    .from(schema.users)
    .where(where);
  if (!row) return undefined;
  addCacheTags(CacheTag.author(row.id));
  const [meta] = await kernel.db
    .select({ value: schema.usermeta.value })
    .from(schema.usermeta)
    .where(and(eq(schema.usermeta.userId, row.id), eq(schema.usermeta.key, 'description')));
  return { ...row, description: typeof meta?.value === 'string' ? meta.value : '' };
}

function localDate(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** The UTC instants bounding a local calendar range, for date archives. */
function dateRange(timeZone: string, year: number, month?: number, day?: number): [Date, Date] {
  const offsetAt = (utc: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(new Date(utc));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return (
      Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour'),
        get('minute'),
        get('second'),
      ) - utc
    );
  };
  const local = (y: number, m: number, d: number) => {
    const guess = Date.UTC(y, m, d);
    return new Date(guess - offsetAt(guess));
  };
  if (day) return [local(year, (month ?? 1) - 1, day), local(year, (month ?? 1) - 1, day + 1)];
  if (month) return [local(year, month - 1, 1), local(year, month, 1)];
  return [local(year, 0, 1), local(year + 1, 0, 1)];
}

export interface ResolveOptions {
  user: CurrentUser | null;
  /**
   * The request is a feed (WP_Query's is_feed): `posts_per_rss` replaces
   * `posts_per_page`, canonical redirects don't apply, and `/` is always the
   * latest posts, even with a static front page.
   */
  feed?: { perPage: number };
  /** Answer 404 whatever the URL (a sitemap URL while sitemaps are off). */
  notFound?: boolean;
}

/** Runs the main query for a URL: what WordPress's wp() does. */
export async function resolveMainQuery(
  kernel: Kernel,
  url: URL,
  options: ResolveOptions,
): Promise<MainQuery> {
  const main = await mainQuery(kernel, url, options);
  if (!main.is404 || options.feed || options.notFound) return main;
  const location = await oldPermalinkRedirect(kernel, url);
  if (location) main.redirect = { location, status: 301 };
  return main;
}

/**
 * Where an address from an earlier permalink setting lives now: the post a
 * previous structure names (by slug or ID), or the term a previous category
 * or tag base names. Like WordPress's wp_old_slug_redirect() and
 * redirect_guess_404_permalink(), only for 404s; the history is kept by
 * routes/permalinks.ts.
 */
export async function oldPermalinkRedirect(kernel: Kernel, url: URL): Promise<string | undefined> {
  const history = await permalinkHistory(kernel);
  const current = await kernel.options.get<string>('permalink_structure', '');
  const bases = await permalinkBases(kernel);
  let path = url.pathname;
  try {
    path = decodeURIComponent(path)
      .replace(/\/{2,}/g, '/')
      .replace(/^\/+|\/+$/g, '');
  } catch {
    return undefined;
  }
  if (!path) return undefined;
  const target = async (post: Post | undefined) => {
    if (post?.type !== 'post' || post.status !== 'publish') return undefined;
    const link = await permalink(kernel, post, await permalinkContext(kernel));
    return new URL(link, 'http://x').pathname === url.pathname ? undefined : link;
  };

  for (const structure of history.structures) {
    if (!structure || structure === current) continue;
    const vars = parseRequest(new URL(url.pathname, 'http://x'), structure, bases);
    if (vars.p) {
      const found = await target(await kernel.posts.get(vars.p));
      if (found) return found;
    }
    if (vars.name) {
      const candidates: Post[] = await kernel.db
        .select()
        .from(schema.posts)
        .where(
          and(
            eq(schema.posts.type, 'post'),
            eq(schema.posts.status, 'publish'),
            eq(schema.posts.slug, vars.name),
          ),
        );
      const timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
      const date = vars.postDate ?? {};
      const post =
        candidates.find((candidate) => {
          const local = localDate(candidate.date, timeZone);
          return (
            (!date.year || local.year === date.year) &&
            (!date.monthnum || local.month === date.monthnum) &&
            (!date.day || local.day === date.day)
          );
        }) ?? (candidates.length === 1 ? candidates[0] : undefined);
      const found = await target(post);
      if (found) return found;
    }
  }

  const site = await siteInfo(kernel);
  const termRedirect = async (taxonomy: string, old: string[], now: string) => {
    for (const base of old) {
      if (base === now) continue;
      const rest = afterBase(path, basePath(base, now));
      const slug = rest?.[rest.length - 1];
      if (!slug || (taxonomy === 'post_tag' && rest.length !== 1)) continue;
      const term = await termBySlug(kernel, taxonomy, slug);
      if (term) return termLink(site, term);
    }
    return undefined;
  };
  return (
    (await termRedirect('category', history.categoryBases, bases.category)) ??
    (await termRedirect('post_tag', history.tagBases, bases.tag))
  );
}

async function mainQuery(
  kernel: Kernel,
  url: URL,
  { user, feed, notFound: forceNotFound }: ResolveOptions,
): Promise<MainQuery> {
  const get = <T>(name: string, fallback: T) => kernel.options.get<T>(name, fallback);
  const structure = await get('permalink_structure', '');
  const home = (await get('home', '')).replace(/\/+$/, '');
  const timeZone = await get('timezone_string', 'UTC');
  const showOnFront = await get('show_on_front', 'posts');
  const pageOnFront = Number(await get('page_on_front', 0));
  const pageForPosts = Number(await get('page_for_posts', 0));
  const perPage = feed?.perPage ?? (Number(await get('posts_per_page', 10)) || 10);
  const main = emptyQuery();
  main.perPage = perPage;
  const notFound = () => {
    const q = emptyQuery();
    q.is404 = true;
    q.perPage = perPage;
    return q;
  };
  if (forceNotFound) return notFound();

  // redirect_canonical(): pretty URLs end with a slash.
  if (!feed && structure.endsWith('/') && url.pathname !== '/' && !url.pathname.endsWith('/')) {
    const last = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    if (!last.includes('.')) {
      main.redirect = { location: `${home}${url.pathname}/${url.search}`, status: 301 };
      return main;
    }
  }

  const vars = parseRequest(url, structure, await permalinkBases(kernel));
  if (vars.error) return notFound();
  const paged = vars.paged ?? 1;
  main.paged = paged;
  main.isPaged = paged > 1;
  const links = await permalinkContext(kernel);

  // A post or page by ID (?p=, ?page_id=) redirects to its pretty permalink.
  const canonical = async (post: Post): Promise<MainQuery | undefined> => {
    if (feed || !structure || post.status !== 'publish') return undefined;
    const link = await permalink(kernel, post, links);
    const expected = new URL(link, 'http://x');
    if (
      expected.pathname !== url.pathname ||
      url.searchParams.has('p') ||
      url.searchParams.has('page_id')
    ) {
      const q = emptyQuery();
      q.redirect = { location: link, status: 301 };
      return q;
    }
    return undefined;
  };

  const singular = async (post: Post | undefined, kind: 'post' | 'page'): Promise<MainQuery> => {
    if (!post || !(await canView(kernel, user, post))) return notFound();
    const redirect = await canonical(post);
    if (redirect) return redirect;
    if (post.type === 'page' && post.id === pageForPosts && pageForPosts) {
      return listing({ isHome: true, queriedObject: { kind: 'post', post } });
    }
    main.posts = [post];
    main.found = 1;
    main.maxPages = 1;
    main.queriedObject = { kind: 'post', post };
    main.isSingular = true;
    main.isSingle = kind === 'post' && post.type !== 'page';
    main.isPage = post.type === 'page';
    main.isFrontPage = showOnFront === 'page' && post.id === pageOnFront;
    main.args = { p: post.id, post_type: post.type, post_status: post.status };
    return main;
  };

  const listing = async (
    flags: Partial<MainQuery>,
    extra: QueryArgs = {},
    postTypes: string | string[] = 'post',
  ): Promise<MainQuery> => {
    Object.assign(main, flags);
    const types = Array.isArray(postTypes) ? postTypes : [postTypes];
    const statuses = new Set<string>();
    for (const type of types) for (const s of await readableStatuses(user, type)) statuses.add(s);
    const args: QueryArgs = {
      post_type: postTypes,
      post_status: [...statuses],
      posts_per_page: perPage,
      paged,
      ...extra,
    };
    let result = await queryPosts(kernel, args);
    // Sticky posts lead the first page of the blog (WP_Query's "sticky posts" handling).
    if (main.isHome && paged === 1 && !extra.s) {
      const sticky = (await get<number[]>('sticky_posts', [])).filter((id) => Number.isInteger(id));
      if (sticky.length) {
        const stickyPosts = (
          await queryPosts(kernel, { ...args, post__in: sticky, posts_per_page: -1, paged: 1 })
        ).posts;
        const ids = new Set(stickyPosts.map((p) => p.id));
        result = {
          ...result,
          posts: [...stickyPosts, ...result.posts.filter((p) => !ids.has(p.id))],
        };
      }
    }
    main.args = args;
    main.posts = result.posts;
    main.found = result.found;
    main.maxPages = result.maxPages;
    // WordPress answers 404 for a page number past the end.
    if (paged > 1 && result.posts.length === 0) return notFound();
    return main;
  };

  // Search.
  if (vars.s !== undefined) {
    main.search = vars.s;
    return listing({ isSearch: true }, { s: vars.s }, ['post', 'page']);
  }

  // Single posts and pages.
  if (vars.p) {
    const post = await kernel.posts.get(vars.p);
    if (!post || !['post', 'page'].includes(post.type)) return notFound();
    return singular(post, post.type === 'page' ? 'page' : 'post');
  }
  if (vars.page_id) {
    const post = await kernel.posts.get(vars.page_id);
    return singular(post?.type === 'page' ? post : undefined, 'page');
  }
  if (vars.pagename) {
    const page = await pageByPath(kernel, vars.pagename);
    if (page) return singular(page, 'page');
    // Verbose page rules fall through to the post rules when no page matches.
    if (!vars.name) {
      if (vars.year) {
        // handled below
      } else return notFound();
    }
  }
  if (vars.name) {
    const candidates: Post[] = await kernel.db
      .select()
      .from(schema.posts)
      .where(and(eq(schema.posts.type, 'post'), eq(schema.posts.slug, vars.name)));
    const date = vars.postDate ?? {};
    const post = candidates.find((candidate) => {
      const local = localDate(candidate.date, timeZone);
      return (
        (!date.year || local.year === date.year) &&
        (!date.monthnum || local.month === date.monthnum) &&
        (!date.day || local.day === date.day)
      );
    });
    return singular(post, 'post');
  }

  // Taxonomy archives.
  if (vars.category_name || vars.cat) {
    const term = vars.cat
      ? await kernel.terms.get('category', vars.cat)
      : await termBySlug(kernel, 'category', vars.category_name ?? '');
    if (!term) return notFound();
    return listing(
      { isArchive: true, isCategory: true, queriedObject: { kind: 'term', term } },
      { tax_query: [{ taxonomy: 'category', terms: [term.id] }] },
    );
  }
  if (vars.tag) {
    const term = await termBySlug(kernel, 'post_tag', vars.tag);
    if (!term) return notFound();
    return listing(
      { isArchive: true, isTag: true, queriedObject: { kind: 'term', term } },
      { tax_query: [{ taxonomy: 'post_tag', terms: [term.id] }] },
    );
  }
  if (vars.author || vars.author_name) {
    const author = await authorBy(kernel, { id: vars.author, nicename: vars.author_name });
    if (!author) return notFound();
    return listing(
      { isArchive: true, isAuthor: true, queriedObject: { kind: 'author', author } },
      { author: author.id },
    );
  }

  // Date archives.
  if (vars.year) {
    const { year, monthnum: month, day } = vars;
    if ((month && (month < 1 || month > 12)) || (day && (day < 1 || day > 31))) return notFound();
    const [after, before] = dateRange(timeZone, year, month, day);
    main.date = { year, month, day };
    return listing(
      {
        isArchive: true,
        isDate: true,
        isYear: !month,
        isMonth: Boolean(month && !day),
        isDay: Boolean(day),
      },
      { date_after: new Date(after.getTime() - 1), date_before: before },
    );
  }

  // The front page.
  if (
    url.pathname === '/' ||
    url.pathname === '' ||
    (structure && /^\/page\/\d+\/?$/.test(url.pathname))
  ) {
    if (showOnFront === 'page' && pageOnFront && !feed) {
      const page = await kernel.posts.get(pageOnFront);
      if (page?.type === 'page' && page.status === 'publish') {
        main.posts = [page];
        main.found = 1;
        main.maxPages = 1;
        main.queriedObject = { kind: 'post', post: page };
        main.isFrontPage = true;
        main.isPage = true;
        main.isSingular = true;
        main.args = { p: page.id, post_type: 'page' };
        return main;
      }
    }
    return listing({ isHome: true, isFrontPage: showOnFront !== 'page' || !pageOnFront });
  }
  return notFound();
}
