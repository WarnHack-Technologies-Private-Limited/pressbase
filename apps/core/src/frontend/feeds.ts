import { escAttr, escUrl, stripAllTags } from '@pressbase/blocks';
import type { CurrentUser } from '../auth/users';
import {
  authorOf,
  type SiteInfo,
  siteInfo,
  termLink,
  theExcerpt,
  theTitle,
} from '../blocks/helpers';
import { postPasswordRequired } from '../blocks/library/template';
import { addCacheTags, CacheTag } from '../cache/tags';
import { commentText, plainText } from '../comments/format';
import { commentLink } from '../comments/links';
import type { Comment } from '../comments/service';
import { permalink, permalinkContext } from '../content/permalinks';
import type { Post } from '../content/posts';
import { queryPosts } from '../content/query';
import type { Kernel } from '../kernel';
import { type MainQuery, resolveMainQuery } from './query';
import { documentTitle } from './title';
import { atomDate, cdata, rfc822, xmlText } from './xml';

/**
 * Feeds — WordPress's feed templates (wordpress/wp-includes/feed-rss2.php,
 * feed-rss2-comments.php, feed-atom.php, feed-atom-comments.php), the feed
 * functions in feed.php and the feed rewrite rules of class-wp-rewrite.php.
 *
 * A feed is the main query of the URL it is attached to: `/category/news/feed/`
 * runs the category archive's query with `posts_per_rss` items, so every
 * archive, the blog, search results and single posts (their comments) have
 * one. `/feed/` and `?feed=rss2` are the latest posts; `/comments/feed/` and
 * `?feed=comments-rss2` the latest comments; `/feed/atom/` is Atom.
 * The legacy `rss` (0.92) and `rdf` (RSS 1.0) names are answered with RSS 2.0.
 */

export type FeedFormat = 'rss2' | 'atom';

export interface FeedRequest {
  format: FeedFormat;
  /** withcomments: the comments feed. */
  comments: boolean;
  /** The URL the feed belongs to, with the feed parts removed. */
  url: URL;
}

const FEED_NAMES = new Set(['feed', 'rss2', 'rss', 'rdf', 'atom']);

/** WP_Rewrite's feed rules and the `feed` query variable. */
export function parseFeedRequest(url: URL, pretty: boolean): FeedRequest | undefined {
  const query = url.searchParams.get('feed');
  if (query !== null) {
    let name = query.toLowerCase();
    let comments = url.searchParams.get('withcomments') === '1';
    if (name.startsWith('comments-')) {
      comments = true;
      name = name.slice('comments-'.length);
    }
    if (!FEED_NAMES.has(name)) return undefined;
    const stripped = new URL(url);
    stripped.searchParams.delete('feed');
    stripped.searchParams.delete('withcomments');
    return { format: name === 'atom' ? 'atom' : 'rss2', comments, url: stripped };
  }
  if (!pretty) return undefined;
  // (.+?)/feed/(feed|rdf|rss|rss2|atom)/?$ and (.+?)/feed/?$, plus comments/feed/.
  const match = /^(.*?\/)?feed(?:\/(feed|rdf|rss|rss2|atom))?\/?$/.exec(url.pathname);
  if (!match) return undefined;
  let prefix = match[1] ?? '/';
  let comments = false;
  if (prefix === '/comments/') {
    comments = true;
    prefix = '/';
  }
  const stripped = new URL(url);
  stripped.pathname = prefix;
  return { format: match[2] === 'atom' ? 'atom' : 'rss2', comments, url: stripped };
}

/** get_feed_link(), get_post_comments_feed_link() and friends. */
export const feedLinks = {
  posts(site: SiteInfo, format: FeedFormat = 'rss2'): string {
    if (!site.pretty) return `${site.home}/?feed=${format}`;
    return `${site.home}/feed/${format === 'rss2' ? '' : 'atom/'}`;
  },
  comments(site: SiteInfo, format: FeedFormat = 'rss2'): string {
    if (!site.pretty) return `${site.home}/?feed=comments-${format}`;
    return `${site.home}/comments/feed/${format === 'rss2' ? '' : 'atom/'}`;
  },
  /** A feed for an archive or post whose page is at `pageUrl`, or its query string form. */
  attached(site: SiteInfo, pageUrl: string, plainQuery: string, format: FeedFormat = 'rss2') {
    if (!site.pretty || pageUrl.includes('?')) {
      return `${site.home}/?${plainQuery}&feed=${format}`;
    }
    return `${pageUrl.replace(/\/?$/, '/')}feed/${format === 'rss2' ? '' : 'atom/'}`;
  },
};

const CONTENT_TYPES: Record<FeedFormat, string> = {
  rss2: 'application/rss+xml; charset=UTF-8',
  atom: 'application/atom+xml; charset=UTF-8',
};

export interface FeedDocument {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface FeedContext {
  kernel: Kernel;
  site: SiteInfo;
  user: CurrentUser | null;
  format: FeedFormat;
  /** The feed's own URL (self_link()). */
  self: string;
  language: string;
}

/** Renders a feed, or answers 404 when the URL it's attached to doesn't exist. */
export async function renderFeed(
  kernel: Kernel,
  request: FeedRequest,
  { user, path }: { user: CurrentUser | null; path: string },
): Promise<FeedDocument | { notFound: true }> {
  const perPage = Number(await kernel.options.get('posts_per_rss', 10)) || 10;
  const main = await resolveMainQuery(kernel, request.url, { user, feed: { perPage } });
  if (main.is404 || main.redirect) return { notFound: true };
  const site = await siteInfo(kernel);
  const locale = (await kernel.options.get<string>('locale', 'en_US')) || 'en_US';
  const ctx: FeedContext = {
    kernel,
    site,
    user,
    format: request.format,
    self: `${site.home}${path}`,
    language: locale.replace('_', '-'),
  };
  const object = main.queriedObject;
  const singular = main.isSingular && object?.kind === 'post' ? object.post : undefined;
  let body: string;
  let updated: Date;
  if (singular || request.comments) {
    ({ body, updated } = await commentsFeed(ctx, main, singular));
  } else {
    ({ body, updated } = await postsFeed(ctx, main));
  }
  return {
    status: 200,
    headers: {
      'content-type': CONTENT_TYPES[request.format],
      'last-modified': updated.toUTCString(),
    },
    body,
  };
}

/** get_feed_build_date(): the newest modification among the items, else of any published post. */
async function buildDate(kernel: Kernel, dates: Date[]): Promise<Date> {
  if (dates.length) return new Date(Math.max(...dates.map((d) => d.getTime())));
  const { posts } = await queryPosts(kernel, {
    post_type: 'any',
    post_status: 'publish',
    orderby: 'modified',
    posts_per_page: 1,
    no_found_rows: true,
  });
  return posts[0]?.modified ?? new Date(0);
}

/** get_the_category_rss(): category and tag names, once each. */
async function categoryNames(kernel: Kernel, post: Post): Promise<string[]> {
  const names = new Set<string>();
  for (const taxonomy of ['category', 'post_tag']) {
    if (!kernel.taxonomies.get(taxonomy)?.objectTypes.has(post.type)) continue;
    const { terms } = await kernel.terms.list(taxonomy, { post: post.id, perPage: 100 });
    for (const term of terms) names.add(term.name);
  }
  return [...names];
}

/** the_content_feed(): the rendered blocks, or the excerpt message for protected posts. */
async function contentFeed(ctx: FeedContext, post: Post): Promise<string> {
  if (postPasswordRequired(post)) return theExcerpt(post);
  const html = await ctx.kernel.blocks.render(post.content, {
    context: { postId: post.id, postType: post.type },
    user: ctx.user,
  });
  return String(await ctx.kernel.hooks.applyFilters('the_content_feed', html, ctx.format));
}

async function postsFeed(
  ctx: FeedContext,
  main: MainQuery,
): Promise<{ body: string; updated: Date }> {
  const { kernel, site, format } = ctx;
  const hooks = kernel.hooks;
  const useExcerpt = Boolean(await kernel.options.get('rss_use_excerpt', false));
  const links = await permalinkContext(kernel);
  const title = xmlText(
    await hooks.applyFilters('wp_title_rss', await documentTitle(kernel, main), format),
  );
  const description = xmlText(site.description);
  const updated = await buildDate(
    kernel,
    main.posts.map((p) => p.modified),
  );
  const items: string[] = [];
  for (const post of main.posts) {
    const link = String(
      await hooks.applyFilters('the_permalink_rss', await permalink(kernel, post, links)),
    );
    const itemTitle = String(
      await hooks.applyFilters('the_title_rss', stripAllTags(theTitle(post))),
    );
    const excerpt = String(await hooks.applyFilters('the_excerpt_rss', theExcerpt(post)));
    const author = (await authorOf(kernel, post.authorId))?.displayName ?? '';
    const categories = await categoryNames(kernel, post);
    const open = await kernel.comments.commentsOpen(post);
    const hasComments = post.commentCount > 0 || open;
    const commentsFeed = feedLinks.attached(
      site,
      link,
      `${post.type === 'page' ? 'page_id' : 'p'}=${post.id}`,
      format,
    );
    const content = useExcerpt ? '' : await contentFeed(ctx, post);

    if (format === 'rss2') {
      const lines = [
        '\t<item>',
        `\t\t<title>${xmlText(itemTitle)}</title>`,
        `\t\t<link>${xmlText(link)}</link>`,
      ];
      if (hasComments) {
        lines.push(
          `\t\t<comments>${xmlText(`${link}#${post.commentCount ? 'comments' : 'respond'}`)}</comments>`,
        );
      }
      lines.push(
        `\t\t<dc:creator>${cdata(author)}</dc:creator>`,
        `\t\t<pubDate>${rfc822(post.date)}</pubDate>`,
        ...categories.map((name) => `\t\t<category>${cdata(name)}</category>`),
        `\t\t<guid isPermaLink="false">${xmlText(post.guid)}</guid>`,
        `\t\t<description>${cdata(excerpt)}</description>`,
      );
      if (!useExcerpt) {
        lines.push(
          `\t\t<content:encoded>${cdata(content.length ? content : excerpt)}</content:encoded>`,
        );
      }
      if (hasComments) {
        lines.push(
          `\t\t<wfw:commentRss>${xmlText(commentsFeed)}</wfw:commentRss>`,
          `\t\t<slash:comments>${post.commentCount}</slash:comments>`,
        );
      }
      lines.push('\t</item>');
      items.push(lines.join('\n'));
    } else {
      const lines = [
        '\t<entry>',
        `\t\t<author>\n\t\t\t<name>${xmlText(author)}</name>\n\t\t</author>`,
        `\t\t<title type="html">${cdata(xmlText(itemTitle))}</title>`,
        `\t\t<link rel="alternate" type="text/html" href="${xmlText(link)}" />`,
        `\t\t<id>${xmlText(post.guid)}</id>`,
        `\t\t<updated>${atomDate(post.modified)}</updated>`,
        `\t\t<published>${atomDate(post.date)}</published>`,
        ...categories.map(
          (name) => `\t\t<category scheme="${xmlText(site.home)}" term="${xmlText(name)}" />`,
        ),
        `\t\t<summary type="html">${cdata(excerpt)}</summary>`,
      ];
      if (!useExcerpt) {
        lines.push(
          `\t\t<content type="html" xml:base="${xmlText(link)}">${cdata(content)}</content>`,
        );
      }
      if (hasComments) {
        lines.push(
          `\t\t<link rel="replies" type="text/html" href="${xmlText(`${link}#comments`)}" thr:count="${post.commentCount}" />`,
          `\t\t<link rel="replies" type="application/atom+xml" href="${xmlText(commentsFeed)}" thr:count="${post.commentCount}" />`,
          `\t\t<thr:total>${post.commentCount}</thr:total>`,
        );
      }
      lines.push('\t</entry>');
      items.push(lines.join('\n'));
    }
  }

  const body =
    format === 'rss2'
      ? `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"
\txmlns:content="http://purl.org/rss/1.0/modules/content/"
\txmlns:wfw="http://wellformedweb.org/CommentAPI/"
\txmlns:dc="http://purl.org/dc/elements/1.1/"
\txmlns:atom="http://www.w3.org/2005/Atom"
\txmlns:sy="http://purl.org/rss/1.0/modules/syndication/"
\txmlns:slash="http://purl.org/rss/1.0/modules/slash/"
>

<channel>
\t<title>${title}</title>
\t<atom:link href="${xmlText(ctx.self)}" rel="self" type="application/rss+xml" />
\t<link>${xmlText(site.home)}</link>
\t<description>${description}</description>
\t<lastBuildDate>${rfc822(updated)}</lastBuildDate>
\t<language>${xmlText(ctx.language)}</language>
\t<sy:updatePeriod>hourly</sy:updatePeriod>
\t<sy:updateFrequency>1</sy:updateFrequency>
\t<generator>Pressbase</generator>
${items.join('\n')}
</channel>
</rss>
`
      : `<?xml version="1.0" encoding="UTF-8"?><feed
\txmlns="http://www.w3.org/2005/Atom"
\txmlns:thr="http://purl.org/syndication/thread/1.0"
\txml:lang="${xmlText(ctx.language)}"
>
\t<title type="text">${title}</title>
\t<subtitle type="text">${description}</subtitle>

\t<updated>${atomDate(updated)}</updated>

\t<link rel="alternate" type="text/html" href="${xmlText(site.home)}" />
\t<id>${xmlText(ctx.self)}</id>
\t<link rel="self" type="application/atom+xml" href="${xmlText(ctx.self)}" />
\t<generator uri="https://github.com/WarnHack-Technologies-Private-Limited/pressbase">Pressbase</generator>
${items.join('\n')}
</feed>
`;
  return { body, updated };
}

/** feed-rss2-comments.php / feed-atom-comments.php: one post's comments, or the newest site-wide. */
async function commentsFeed(
  ctx: FeedContext,
  main: MainQuery,
  singular: Post | undefined,
): Promise<{ body: string; updated: Date }> {
  const { kernel, site, format } = ctx;
  const perPage = main.perPage;
  // WP_Query's comment feed: approved comments (not notes), newest first.
  const { comments } = await kernel.comments.query({
    ...(singular ? { post__in: [singular.id] } : { post_status: ['publish'] }),
    status: 'approve',
    type: ['comment', 'pingback', 'trackback'],
    orderby: 'date_gmt',
    order: 'DESC',
    number: perPage,
  });
  addCacheTags(singular ? CacheTag.post(singular.id) : CacheTag.comments);
  const options = await kernel.comments.options();
  const links = await permalinkContext(kernel);
  const postLink = singular ? await permalink(kernel, singular, links) : site.home;
  const singularTitle = singular ? stripAllTags(theTitle(singular)) : '';
  const siteTitle = await documentTitle(kernel, main);
  const title = singular
    ? `${format === 'rss2' ? 'Comments on: ' : 'Comments on '}${singularTitle}`
    : `Comments for ${siteTitle}`;
  const updated = await buildDate(kernel, [
    ...main.posts.slice(0, singular ? 1 : 0).map((p) => p.modified),
    ...comments.map((c) => c.date),
  ]);

  const posts = new Map<number, Post | undefined>();
  const postOf = async (c: Comment) => {
    if (!posts.has(c.postId)) posts.set(c.postId, await kernel.posts.get(c.postId));
    return posts.get(c.postId);
  };

  const items: string[] = [];
  for (const comment of comments) {
    const post = await postOf(comment);
    if (!post || (!singular && post.status !== 'publish')) continue;
    const link = await commentLink(kernel, comment, post, options, links);
    const author = String(
      await kernel.hooks.applyFilters('comment_author_rss', comment.author || 'Anonymous'),
    );
    const itemTitle = singular
      ? `By: ${author}`
      : `Comment on ${stripAllTags(theTitle(post))} by ${author}`;
    const guid = `${post.guid}#comment-${comment.id}`;
    const locked = postPasswordRequired(post);
    const text = locked
      ? ''
      : String(
          await kernel.hooks.applyFilters('comment_text', commentText(comment.content), comment),
        );
    const plain = locked
      ? 'Protected Comments: Please enter your password to view comments.'
      : String(await kernel.hooks.applyFilters('comment_text_rss', plainText(comment.content)));

    if (format === 'rss2') {
      items.push(
        [
          '\t<item>',
          `\t\t<title>${xmlText(itemTitle)}</title>`,
          `\t\t<link>${xmlText(link)}</link>`,
          `\t\t<dc:creator>${cdata(author)}</dc:creator>`,
          `\t\t<pubDate>${rfc822(comment.date)}</pubDate>`,
          `\t\t<guid isPermaLink="false">${xmlText(guid)}</guid>`,
          locked
            ? `\t\t<description>${xmlText(plain)}</description>`
            : `\t\t<description>${cdata(plain)}</description>`,
          `\t\t<content:encoded>${cdata(locked ? plain : text)}</content:encoded>`,
          '\t</item>',
        ].join('\n'),
      );
    } else {
      const parent = comment.parentId ? await kernel.comments.get(comment.parentId) : undefined;
      const postUrl = await permalink(kernel, post, links);
      const inReplyTo = parent
        ? `\t\t<thr:in-reply-to ref="${xmlText(`${post.guid}#comment-${parent.id}`)}" href="${xmlText(await commentLink(kernel, parent, post, options, links))}" type="text/html" />`
        : `\t\t<thr:in-reply-to ref="${xmlText(post.guid)}" href="${xmlText(postUrl)}" type="text/html" />`;
      items.push(
        [
          '\t<entry>',
          `\t\t<title>${xmlText(itemTitle)}</title>`,
          `\t\t<link rel="alternate" href="${xmlText(link)}" type="text/html" />`,
          `\t\t<author>\n\t\t\t<name>${xmlText(author)}</name>${
            comment.authorUrl ? `\n\t\t\t<uri>${xmlText(escUrl(comment.authorUrl))}</uri>` : ''
          }\n\t\t</author>`,
          `\t\t<id>${xmlText(guid)}</id>`,
          `\t\t<updated>${atomDate(comment.date)}</updated>`,
          `\t\t<published>${atomDate(comment.date)}</published>`,
          `\t\t<content type="html" xml:base="${xmlText(link)}">${cdata(locked ? plain : text)}</content>`,
          inReplyTo,
          '\t</entry>',
        ].join('\n'),
      );
    }
  }

  const description = xmlText(site.description);
  const body =
    format === 'rss2'
      ? `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"
\txmlns:content="http://purl.org/rss/1.0/modules/content/"
\txmlns:dc="http://purl.org/dc/elements/1.1/"
\txmlns:atom="http://www.w3.org/2005/Atom"
\txmlns:sy="http://purl.org/rss/1.0/modules/syndication/"
>
<channel>
\t<title>${xmlText(title)}</title>
\t<atom:link href="${xmlText(ctx.self)}" rel="self" type="application/rss+xml" />
\t<link>${xmlText(postLink)}</link>
\t<description>${description}</description>
\t<lastBuildDate>${rfc822(updated)}</lastBuildDate>
\t<sy:updatePeriod>hourly</sy:updatePeriod>
\t<sy:updateFrequency>1</sy:updateFrequency>
\t<generator>Pressbase</generator>
${items.join('\n')}
</channel>
</rss>
`
      : `<?xml version="1.0" encoding="UTF-8"?><feed
\txmlns="http://www.w3.org/2005/Atom"
\txml:lang="${xmlText(ctx.language)}"
\txmlns:thr="http://purl.org/syndication/thread/1.0"
>
\t<title type="text">${xmlText(title)}</title>
\t<subtitle type="text">${description}</subtitle>

\t<updated>${atomDate(updated)}</updated>

\t<link rel="alternate" type="text/html" href="${xmlText(singular ? `${postLink}#comments` : site.home)}" />
\t<link rel="self" type="application/atom+xml" href="${xmlText(ctx.self)}" />
\t<id>${xmlText(ctx.self)}</id>
${items.join('\n')}
</feed>
`;
  return { body, updated };
}

/** feed_links() and feed_links_extra(): the <link rel="alternate"> tags of a page's head. */
export async function feedLinkTags(kernel: Kernel, main: MainQuery): Promise<string[]> {
  const site = await siteInfo(kernel);
  const name = site.name;
  const link = (title: string, href: string) =>
    `<link rel="alternate" type="application/rss+xml" title="${escAttr(title)}" href="${escAttr(href)}" />`;
  const tags = [
    link(`${name} » Feed`, feedLinks.posts(site)),
    link(`${name} » Comments Feed`, feedLinks.comments(site)),
  ];
  const object = main.queriedObject;
  if (main.isSingular && object?.kind === 'post') {
    const post = object.post;
    if (post.commentCount > 0 || (await kernel.comments.commentsOpen(post))) {
      const url = await permalink(kernel, post, await permalinkContext(kernel));
      const query = `${post.type === 'page' ? 'page_id' : 'p'}=${post.id}`;
      tags.push(
        link(
          `${name} » ${stripAllTags(theTitle(post))} Comments Feed`,
          feedLinks.attached(site, url, query),
        ),
      );
    }
  } else if (object?.kind === 'term') {
    const term = object.term;
    const label = term.taxonomy === 'post_tag' ? 'Tag' : 'Category';
    const query =
      term.taxonomy === 'category' ? `cat=${term.id}` : `tag=${encodeURIComponent(term.slug)}`;
    tags.push(
      link(
        `${name} » ${term.name} ${label} Feed`,
        feedLinks.attached(site, termLink(site, term), query),
      ),
    );
  } else if (object?.kind === 'author') {
    const author = object.author;
    const url = site.pretty ? `${site.home}/author/${author.nicename}/` : '';
    tags.push(
      link(
        `${name} » Posts by ${author.displayName} Feed`,
        feedLinks.attached(site, url || `${site.home}/?`, `author=${author.id}`),
      ),
    );
  } else if (main.isSearch) {
    const term = main.search ?? '';
    const url = site.pretty ? `${site.home}/search/${encodeURIComponent(term)}/` : '';
    tags.push(
      link(
        `${name} » Search Results for “${term}” Feed`,
        feedLinks.attached(site, url || `${site.home}/?`, `s=${encodeURIComponent(term)}`),
      ),
    );
  }
  return tags;
}
