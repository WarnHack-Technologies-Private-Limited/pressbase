import { createHash } from 'node:crypto';
import { escAttr } from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { and, eq } from 'drizzle-orm';
import type { CurrentUser } from '../auth/users';
import { POSTPASS_COOKIE } from '../blocks/library/template';
import { addCacheTags, CacheTag, collectCacheTags } from '../cache/tags';
import { localeToLang } from '../i18n/locale';
import type { Kernel } from '../kernel';
import type { ActiveTheme } from '../themes/service';
import { parseFeedRequest, renderFeed } from './feeds';
import { HtmlOutput } from './head';
import { templateHierarchy } from './hierarchy';
import { PageRender, withPage } from './page';
import type { PublicFile, PublicFileBody } from './public-files';
import { type MainQuery, resolveMainQuery } from './query';
import { renderRobots } from './robots';
import { parseSitemapRequest, renderSitemap } from './sitemaps';
import { type NotFoundRequest, TemplateRedirect } from './template-redirect';

export { BLOCK_LIBRARY_CSS } from './head';

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    body_class: [classes: string[], extra: string[]];
    language_attributes: [output: string, doctype: string];
  }
}

/**
 * The public site's renderer: WordPress's template-loader.php,
 * locate_block_template(), get_the_block_template_html() and
 * template-canvas.php, as one function. Given a URL it runs the main query,
 * picks a template from the hierarchy, renders its blocks and wraps them in
 * a complete HTML document with the global styles.
 */

export interface RenderedPage {
  status: number;
  headers: Record<string, string>;
  /** The response body: an HTML document, or XML / plain text for feeds, sitemaps and robots.txt. */
  html: string;
  /**
   * What the response depends on (cache/tags.ts). apps/web files its cached
   * copy under these tags and drops it when core purges one of them.
   */
  tags: string[];
}

/** Every response anonymous visitors may share; private ones say so. */
const PUBLIC_CACHE = 'public, max-age=0, must-revalidate';

export interface RenderRequest {
  /** Path and query string, e.g. `/2026/10/27/hello/?s=x`. */
  url: string;
  user: CurrentUser | null;
  cookies?: Map<string, string>;
  ifNoneMatch?: string;
  /** Render with this theme instead of the active one (the global styles preview). */
  theme?: ActiveTheme;
  /** The Referer header, for `template_redirect` and `pressbase_404`. */
  referrer?: string;
}

/** get_body_class() */
async function bodyClasses(
  kernel: Kernel,
  main: MainQuery,
  user: CurrentUser | null,
  template: string,
): Promise<string> {
  const classes: string[] = [];
  const object = main.queriedObject;
  if (main.isFrontPage) classes.push('home');
  if (main.isHome) classes.push('blog');
  if (main.isArchive) classes.push('archive');
  if (main.isDate) classes.push('date');
  if (main.isSearch)
    classes.push('search', main.posts.length ? 'search-results' : 'search-no-results');
  if (main.isPaged) classes.push('paged');
  if (main.is404) classes.push('error404');
  if (object?.kind === 'post') {
    const post = object.post;
    if (main.isSingle) {
      classes.push(
        'wp-singular',
        `${post.type}-template-default`,
        'single',
        `single-${post.type}`,
        `postid-${post.id}`,
        'single-format-standard',
      );
    }
    if (main.isPage) {
      classes.push('wp-singular', 'page-template-default', 'page', `page-id-${post.id}`);
      if (post.parentId) classes.push('page-child', `parent-pageid-${post.parentId}`);
    }
  }
  if (object?.kind === 'term') {
    const prefix = object.term.taxonomy === 'post_tag' ? 'tag' : object.term.taxonomy;
    classes.push(prefix, `${prefix}-${object.term.slug}`, `${prefix}-${object.term.id}`);
  }
  if (object?.kind === 'author')
    classes.push('author', `author-${object.author.nicename}`, `author-${object.author.id}`);
  if (main.isPaged) {
    const kind = main.isSearch
      ? 'search'
      : main.isCategory
        ? 'category'
        : main.isTag
          ? 'tag'
          : main.isAuthor
            ? 'author'
            : main.isDate
              ? 'date'
              : main.isHome
                ? 'home'
                : 'archive';
    classes.push(`paged-${main.paged}`, `${kind}-paged-${main.paged}`);
  }
  if (kernel.i18n.isRtl()) classes.push('rtl');
  if (user) classes.push('logged-in');
  classes.push(`wp-theme-${(await kernel.themes.active()).info.stylesheet}`, 'wp-embed-responsive');
  if (template) classes.push(`wp-block-template-${template}`);
  const filtered = await kernel.hooks.applyFilters('body_class', classes, []);
  const unique = new Set(
    (Array.isArray(filtered) ? filtered : classes)
      .filter((c): c is string => typeof c === 'string')
      .map((c) => c.replace(/[^A-Za-z0-9_-]/g, ''))
      .filter(Boolean),
  );
  return [...unique].join(' ');
}

/** The custom template chosen for a post (_wp_page_template meta). */
async function pageTemplateOf(kernel: Kernel, main: MainQuery): Promise<string | undefined> {
  const object = main.queriedObject;
  if (object?.kind !== 'post') return undefined;
  const [row] = await kernel.db
    .select({ value: schema.postmeta.value })
    .from(schema.postmeta)
    .where(
      and(eq(schema.postmeta.postId, object.post.id), eq(schema.postmeta.key, '_wp_page_template')),
    );
  const value = row?.value;
  return typeof value === 'string' && value && value !== 'default'
    ? value.replace(/\.html$/, '')
    : undefined;
}

/** Adds WordPress's skip link target to the first <main> (wp_enqueue_block_template_skip_link()). */
function addSkipLinkTarget(html: string): { html: string; target: string | undefined } {
  const match = /<main\b([^>]*)>/i.exec(html);
  if (!match) return { html, target: undefined };
  const existing = /\sid\s*=\s*"([^"]*)"/i.exec(match[1] ?? '')?.[1];
  if (existing) return { html, target: existing };
  const tag = `<main id="wp--skip-link--target"${match[1] ?? ''}>`;
  return {
    html: html.slice(0, match.index) + tag + html.slice(match.index + match[0].length),
    target: 'wp--skip-link--target',
  };
}

/** WordPress's comment-page rewrite: /my-post/comment-page-2/ → cpage=2. */
const COMMENT_PAGE = /\/comment-page-(\d+)\/?$/;

/** Query variables the comment blocks read (comment pages, replies, held-comment previews). */
const COMMENT_QUERY_VARS = ['cpage', 'replytocom', 'unapproved', 'moderation-hash'] as const;

type Rendered = Omit<RenderedPage, 'tags'>;

/**
 * Renders a public URL: robots.txt, a sitemap, a feed or a page of the
 * theme. Collects the cache tags of everything the render reads, and answers
 * 304 when the visitor's ETag still matches.
 */
export async function renderPublicPage(
  kernel: Kernel,
  request: RenderRequest,
): Promise<RenderedPage> {
  // Public pages are in the site's language, whoever asks (get_locale(), not the user's).
  const { result, tags } = await kernel.i18n.withLocale(kernel.i18n.getLocale(), () =>
    collectCacheTags(() => route(kernel, request)),
  );
  const headers = { ...result.headers };
  if (result.status === 200 && !headers.etag) {
    headers.etag = `W/"${createHash('sha1').update(result.html).digest('base64url').slice(0, 27)}"`;
  }
  headers['cache-control'] ??= request.user ? 'private, no-cache' : PUBLIC_CACHE;
  // path:{path} lets a purge reach every cached answer for this path (ADR 0017).
  const pathTag = CacheTag.path(new URL(request.url, 'http://pressbase.invalid').pathname);
  const allTags = [
    CacheTag.site,
    pathTag,
    ...tags.filter((t) => t !== CacheTag.site && t !== pathTag),
  ];
  const etag = headers.etag;
  if (
    result.status === 200 &&
    etag &&
    request.ifNoneMatch?.split(',').some((t) => t.trim() === etag)
  ) {
    return { status: 304, headers, html: '', tags: allTags };
  }
  return { ...result, headers, tags: allTags };
}

/** The URL a page renders, without WordPress's comment-page suffix, and the comment query variables. */
function pageUrl(requestUrl: string): { url: URL; commentQuery: Record<string, string> } {
  const url = new URL(requestUrl, 'http://pressbase.invalid');
  const commentQuery: Record<string, string> = {};
  for (const name of COMMENT_QUERY_VARS) {
    const value = url.searchParams.get(name);
    if (value !== null) commentQuery[name] = value;
  }
  const commentPage = COMMENT_PAGE.exec(url.pathname);
  if (commentPage?.[1]) {
    commentQuery.cpage = commentPage[1];
    url.pathname = url.pathname.replace(COMMENT_PAGE, '/');
  }
  return { url, commentQuery };
}

async function route(kernel: Kernel, request: RenderRequest): Promise<Rendered> {
  const url = new URL(request.url, 'http://pressbase.invalid');
  const pretty = (await kernel.options.get<string>('permalink_structure', '')) !== '';
  const cacheControl = request.user ? 'private, no-cache' : PUBLIC_CACHE;

  // template_redirect (template-loader.php): before anything is served.
  const early = new TemplateRedirect(url, request.referrer ?? '', request.user, () =>
    resolveMainQuery(kernel, pageUrl(request.url).url, { user: request.user }),
  );
  await kernel.hooks.doAction('template_redirect', early);
  const answer = early.answer;
  if (answer?.kind === 'redirect') {
    return {
      status: answer.status,
      headers: { location: answer.location, 'cache-control': 'no-cache' },
      html: '',
    };
  }
  if (answer?.kind === 'not-found') {
    return renderPage(kernel, request, { notFound: true, status: answer.status });
  }

  // do_robots(): /robots.txt, whatever the permalink structure.
  if (url.pathname === '/robots.txt') {
    return {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': cacheControl },
      html: await renderRobots(kernel),
    };
  }

  // WP_Sitemaps::render_sitemaps(): a 404 page when off or out of range.
  const sitemap = parseSitemapRequest(url, pretty);
  if (sitemap) {
    const doc = await renderSitemap(kernel, sitemap);
    if (doc) {
      return {
        status: doc.status,
        headers: { 'cache-control': cacheControl, ...doc.headers },
        html: doc.body,
      };
    }
    return renderPage(kernel, request, { notFound: true });
  }

  // Feeds (do_feed()).
  const feed = parseFeedRequest(url, pretty);
  if (feed) {
    const doc = await renderFeed(kernel, feed, {
      user: request.user,
      path: `${url.pathname}${url.search}`,
    });
    if ('notFound' in doc) return renderPage(kernel, request, { notFound: true });
    return {
      status: doc.status,
      headers: { ...doc.headers, 'cache-control': cacheControl },
      html: doc.body,
    };
  }

  // Files plugins serve at fixed paths (/llms.txt), after core's own.
  const file = kernel.publicFiles.get(url.pathname);
  if (file) {
    const served = await servePublicFile(kernel, file, request, url, cacheControl);
    return served ?? renderPage(kernel, request, { notFound: true });
  }

  return renderPage(kernel, request, { main: early.resolvedMain });
}

/** A plugin file's answer; undefined when the handler has nothing to serve (a 404). */
async function servePublicFile(
  kernel: Kernel,
  file: PublicFile,
  request: RenderRequest,
  url: URL,
  cacheControl: string,
): Promise<Rendered | undefined> {
  const result = await file.handler({
    path: url.pathname,
    query: new URLSearchParams(url.search),
    user: request.user,
  });
  if (result === null || result === undefined) return undefined;
  const headers: Record<string, string> = {};
  let status = 200;
  let body: string;
  if (typeof result === 'string') {
    body = result;
  } else {
    const answer: PublicFileBody = result;
    status = answer.status ?? 200;
    for (const [name, value] of Object.entries(answer.headers ?? {})) {
      headers[name.toLowerCase()] = value;
    }
    if (answer.contentType) headers['content-type'] = answer.contentType;
    body = String(answer.body ?? '');
  }
  headers['content-type'] ??= file.contentType;
  headers['x-content-type-options'] = 'nosniff';
  headers['cache-control'] = file.cache ? cacheControl : 'private, no-store';
  return { status, headers, html: body };
}

/** Renders a page of the theme to a complete HTML document. */
async function renderPage(
  kernel: Kernel,
  request: RenderRequest,
  {
    notFound = false,
    status,
    main: resolved,
  }: {
    notFound?: boolean;
    /** The status of a forced not-found answer (410 from `template_redirect`). */
    status?: number;
    /** The main query `template_redirect` already resolved. */
    main?: Promise<MainQuery>;
  } = {},
): Promise<Rendered> {
  const requested = new URL(request.url, 'http://pressbase.invalid');
  const requestedPath = `${requested.pathname}${requested.search}`;
  const { url, commentQuery } = pageUrl(request.url);
  const user = request.user;
  const main =
    !notFound && resolved ? await resolved : await resolveMainQuery(kernel, url, { user, notFound });
  // What the page is about (the rest is recorded as it renders).
  const queried = main.queriedObject;
  addCacheTags(
    queried?.kind === 'post' && CacheTag.post(queried.post.id),
    queried?.kind === 'term' && CacheTag.term(queried.term.id),
    queried?.kind === 'author' && CacheTag.author(queried.author.id),
    main.isFrontPage && CacheTag.home,
    main.isSearch && CacheTag.search,
    main.is404 && CacheTag.notFound,
  );
  if (main.redirect) {
    return {
      status: main.redirect.status,
      headers: { location: main.redirect.location, 'cache-control': 'no-cache' },
      html: '',
    };
  }
  const theme = request.theme ?? (await kernel.themes.active());
  const candidates = templateHierarchy(main, await pageTemplateOf(kernel, main));
  const slug = candidates.find((c) => theme.templates.has(c)) ?? 'index';
  const template = theme.templates.get(slug);
  const home = (await kernel.options.get<string>('home', '')).replace(/\/+$/, '');
  const page = new PageRender(theme, main, user, home, requestedPath, request.cookies);
  // This page's copy of the site-wide scripts and styles (kernel.scripts / kernel.styles).
  page.scripts = kernel.scripts.forPage();
  page.styles = kernel.styles.forPage();

  // Singular views render with the post as context (the loop's global $post).
  const object = main.queriedObject;
  const context =
    main.isSingular && object?.kind === 'post'
      ? { postId: object.post.id, postType: object.post.type }
      : {};
  let body = '';
  if (template) {
    body = await withPage(page, () =>
      kernel.blocks.render(template.content, { context, user, query: commentQuery }),
    );
  }
  const skip = addSkipLinkTarget(`<div class="wp-site-blocks">${body}</div>`);
  page.skipLinkTarget = skip.target;

  // template-canvas.php: wp_head(), wp_body_open() and wp_footer() around the
  // template, after it rendered (blocks may have enqueued scripts and styles).
  const head = new HtmlOutput();
  const bodyOpen = new HtmlOutput();
  const footer = new HtmlOutput();
  await withPage(page, async () => {
    await kernel.hooks.doAction('wp_enqueue_scripts', page);
    await kernel.hooks.doAction('wp_head', head, page);
    await kernel.hooks.doAction('wp_body_open', bodyOpen, page);
    await kernel.hooks.doAction('wp_footer', footer, page);
  });

  // get_language_attributes(): `dir="rtl"` for right-to-left languages
  // (is_rtl()), then `lang`; printed as filtered, like WordPress.
  const lang = localeToLang(kernel.i18n.getLocale());
  const languageAttributes = await kernel.hooks.applyFilters(
    'language_attributes',
    `${kernel.i18n.isRtl() ? 'dir="rtl" ' : ''}lang="${escAttr(lang)}"`,
    'html',
  );
  const blogPublic = await kernel.options.get<boolean>('blog_public', true);
  const skipLink = skip.target
    ? `<a class="skip-link screen-reader-text" id="wp-skip-link" href="#${escAttr(skip.target)}">${kernel.i18n.esc_html__('Skip to content')}</a>\n`
    : '';
  const html = `<!DOCTYPE html>
<html${languageAttributes ? ` ${languageAttributes}` : ''}>
<head>
<meta charset="UTF-8" />${head.empty ? '' : `\n${head}`}
</head>
<body class="${escAttr(await bodyClasses(kernel, main, user, slug))}">
${bodyOpen.empty ? '' : `${bodyOpen}\n`}${skipLink}${skip.html}
${footer}
</body>
</html>
`;

  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    // Pages change whenever content does; caches must check back (the ETag makes that cheap).
    'cache-control': user ? 'private, no-cache' : PUBLIC_CACHE,
  };
  // Pages that depend on the visitor never go in a shared cache: an unlocked
  // password-protected post, a held comment shown to its author.
  if (request.cookies?.has(POSTPASS_COOKIE) && !user)
    headers['cache-control'] = 'private, no-cache';
  if (commentQuery.unapproved !== undefined) headers['cache-control'] = 'private, no-store';
  if (!blogPublic) headers['x-robots-tag'] = 'noindex, nofollow';
  const code = main.is404 ? (status ?? 404) : 200;
  if (code === 404 && kernel.hooks.hasAction('pressbase_404')) {
    // Every 404 reaches the listeners: the page cache must not answer repeats (ADR 0017).
    headers['cache-control'] = 'no-store';
    const info: NotFoundRequest = {
      path: requested.pathname,
      query: requested.search.replace(/^\?/, ''),
      referrer: request.referrer ?? '',
      user,
      main,
    };
    await kernel.hooks.doAction('pressbase_404', info);
  }
  return { status: code, headers, html };
}
