import { createHash } from 'node:crypto';
import { escAttr, escHtml, escUrl, stripAllTags } from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { and, eq } from 'drizzle-orm';
import type { CurrentUser } from '../auth/users';
import { theTitle } from '../blocks/helpers';
import { NAVIGATION_NOSCRIPT } from '../blocks/library/navigation';
import { permalink, permalinkContext } from '../content/permalinks';
import type { Kernel } from '../kernel';
import type { ActiveTheme } from '../themes/service';
import { siteIconTags } from '../themes/site-identity';
import { PRESSBASE_VERSION } from '../version';
import { templateHierarchy } from './hierarchy';
import { PageRender, withPage } from './page';
import { type MainQuery, resolveMainQuery } from './query';

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
  html: string;
}

export interface RenderRequest {
  /** Path and query string, e.g. `/2026/10/27/hello/?s=x`. */
  url: string;
  user: CurrentUser | null;
  cookies?: Map<string, string>;
  ifNoneMatch?: string;
  /** Render with this theme instead of the active one (the global styles preview). */
  theme?: ActiveTheme;
}

/** The URL of WordPress's front-end block styles, served by core (routes/frontend.ts). */
export const BLOCK_LIBRARY_CSS = '/wp-includes/css/dist/block-library/style.min.css';
const SKIP_LINK_CSS =
  '.skip-link.screen-reader-text{border:0;clip-path:inset(50%);height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute!important;width:1px;word-wrap:normal!important;word-break:normal!important}.skip-link.screen-reader-text:focus{background-color:#eee;clip-path:none;color:#444;display:block;font-size:1em;height:auto;left:5px;line-height:normal;padding:15px 23px 14px;text-decoration:none;top:5px;width:auto;z-index:100000}';

/** wp_get_document_title() */
async function documentTitle(kernel: Kernel, main: MainQuery): Promise<string> {
  const name = await kernel.options.get<string>('blogname', '');
  const tagline = await kernel.options.get<string>('blogdescription', '');
  const object = main.queriedObject;
  const parts: string[] = [];
  if (main.is404) parts.push('Page not found');
  else if (main.isSearch)
    parts.push(`Search Results for &#8220;${escHtml(main.search ?? '')}&#8221;`);
  else if (main.isFrontPage && !main.isPage) {
    parts.push(escHtml(name));
    if (tagline) parts.push(escHtml(tagline));
  } else if (object?.kind === 'post') parts.push(stripAllTags(theTitle(object.post)));
  else if (object?.kind === 'term') parts.push(escHtml(object.term.name));
  else if (object?.kind === 'author') parts.push(escHtml(object.author.displayName));
  else if (main.isDate && main.date) parts.push(String(main.date.year));
  if (main.paged > 1) parts.push(`Page ${main.paged}`);
  if (!(main.isFrontPage && !main.isPage)) parts.push(escHtml(name));
  return parts.filter(Boolean).join(' &#8211; ');
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
  if (user) classes.push('logged-in');
  classes.push(`wp-theme-${(await kernel.themes.active()).info.stylesheet}`, 'wp-embed-responsive');
  if (template) classes.push(`wp-block-template-${template}`);
  return classes.map((c) => c.replace(/[^A-Za-z0-9_-]/g, '')).join(' ');
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

/** Renders a public URL to a complete HTML document. */
export async function renderPublicPage(
  kernel: Kernel,
  request: RenderRequest,
): Promise<RenderedPage> {
  const url = new URL(request.url, 'http://pressbase.invalid');
  const requestedPath = `${url.pathname}${url.search}`;
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
  const user = request.user;
  const main = await resolveMainQuery(kernel, url, { user });
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

  const lang = ((await kernel.options.get<string>('locale', 'en_US')) || 'en_US').replace('_', '-');
  const title = await documentTitle(kernel, main);
  const blogPublic = await kernel.options.get<boolean>('blog_public', true);
  const head: string[] = [
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    blogPublic
      ? "<meta name='robots' content='max-image-preview:large' />"
      : "<meta name='robots' content='noindex, nofollow' />",
    `<title>${title}</title>`,
    `<meta name="generator" content="Pressbase ${escAttr(PRESSBASE_VERSION)}" />`,
  ];
  if (main.isSingular && object?.kind === 'post' && object.post.status === 'publish') {
    const link = await permalink(kernel, object.post, await permalinkContext(kernel));
    head.push(`<link rel="canonical" href="${escUrl(link)}" />`);
  }
  head.push(
    `<link rel='stylesheet' id='wp-block-library-css' href='${BLOCK_LIBRARY_CSS}?ver=${escAttr(PRESSBASE_VERSION)}' media='all' />`,
  );
  if (skip.target)
    head.push(`<style id='wp-block-template-skip-link-inline-css'>\n${SKIP_LINK_CSS}\n</style>`);
  const styleTag = (id: string, css: string) =>
    css ? `<style id='${id}'>\n${css.replaceAll('</style', '<\\/style')}\n</style>` : '';
  head.push(styleTag('global-styles-inline-css', theme.css.global + theme.css.custom));
  head.push(styleTag('block-style-variation-styles-inline-css', page.variationStyles.join('')));
  head.push(styleTag('core-block-supports-inline-css', page.supportStyles.join('')));
  head.push(styleTag('theme-block-styles-inline-css', theme.css.blockStyles));
  theme.stylesheets.forEach((href, i) => {
    const id = `${theme.info.stylesheet}-style${i ? `-${i}` : ''}-css`;
    head.push(
      `<link rel='stylesheet' id='${escAttr(id)}' href='${escAttr(href)}?ver=${escAttr(theme.info.version)}' media='all' />`,
    );
  });
  if (theme.css.fontFaces)
    head.push(`<style class='wp-fonts-local'>\n${theme.css.fontFaces}\n</style>`);
  if (page.scripts.size) head.push(NAVIGATION_NOSCRIPT);
  // wp_site_icon() (wp_head, priority 99).
  head.push(await siteIconTags(kernel));

  const scripts = [...page.scripts]
    .map((js) => `<script>${js.replaceAll('</script', '<\\/script')}</script>`)
    .join('\n');
  const skipLink = skip.target
    ? `<a class="skip-link screen-reader-text" id="wp-skip-link" href="#${escAttr(skip.target)}">Skip to content</a>\n`
    : '';
  const html = `<!DOCTYPE html>
<html lang="${escAttr(lang)}">
<head>
${head.filter(Boolean).join('\n')}
</head>
<body class="${escAttr(await bodyClasses(kernel, main, user, slug))}">
${skipLink}${skip.html}
${scripts}
</body>
</html>
`;

  const etag = `W/"${createHash('sha1').update(html).digest('base64url').slice(0, 27)}"`;
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    // Pages change whenever content does; caches must check back (the ETag makes that cheap).
    'cache-control': user ? 'private, no-cache' : 'public, max-age=0, must-revalidate',
    etag,
  };
  if (!blogPublic) headers['x-robots-tag'] = 'noindex, nofollow';
  const status = main.is404 ? 404 : 200;
  if (status === 200 && request.ifNoneMatch?.split(',').some((t) => t.trim() === etag)) {
    return { status: 304, headers, html: '' };
  }
  return { status, headers, html };
}
