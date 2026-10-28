import type { MainQuery, PluginApi, Post, Term } from '@pressbase/plugin-sdk';
import { escAttr, escHtml, escUrl, jsonForScript, plainText, trimText } from './html';
import { buildGraph, type GraphNode, type SchemaImage, type SchemaInput } from './schema';
import {
  bool,
  META,
  type MetaName,
  metaKey,
  metaRobots,
  postTypeAppearance,
  type SeoMeta,
  separatorText,
  str,
  TERM_META_NAMES,
  taxonomyAppearance,
  type WpseoSocial,
  type WpseoTitles,
} from './shared';
import { getSite, getSocial, getTitles, type Site } from './store';
import { replaceVars, type VarValues } from './vars';

/**
 * Everything a page's <head> gets from Pressbase SEO, computed once per
 * render (and for the REST field `pressbase_seo_head`): the title, the
 * meta description, canonical, robots, Open Graph and X tags, breadcrumbs
 * and the schema graph.
 */

export interface Author {
  id: number;
  displayName: string;
  nicename: string;
  description: string;
}

export type Target =
  | { kind: 'post'; post: Post; front?: boolean }
  | { kind: 'term'; term: Term }
  | { kind: 'home' }
  | { kind: 'author'; author: Author }
  | { kind: 'date'; date: { year: number; month?: number; day?: number } }
  | { kind: 'search'; search: string }
  | { kind: '404' }
  | { kind: 'other' };

export interface RenderContext {
  target: Target;
  paged: number;
  maxPages: number;
  /** The request's path without the query (archives' canonicals). */
  path?: string;
}

export interface Crumb {
  name: string;
  url?: string;
}

export interface Robots {
  index: boolean;
  follow: boolean;
  adv: string[];
}

export interface ImageInfo {
  url: string;
  width?: number;
  height?: number;
  type?: string;
  alt?: string;
  /** Where it came from, for the editor's "Using the featured image". */
  source: 'set' | 'featured' | 'content' | 'default';
}

export interface HeadData {
  title: string;
  description: string;
  canonical: string;
  robots: Robots;
  og: { property: string; content: string }[];
  twitter: { name: string; content: string }[];
  image: ImageInfo | null;
  breadcrumbs: Crumb[];
  schema: { '@context': 'https://schema.org'; '@graph': GraphNode[] };
}

declare module '@pressbase/plugin-sdk' {
  interface FilterRegistry {
    /** The schema graph's nodes, before printing. */
    pressbase_seo_schema_graph: [graph: GraphNode[], context: RenderContext];
    /** Everything computed for a page's head. */
    pressbase_seo_head: [head: HeadData, context: RenderContext];
  }
}

export function targetFromMain(main: MainQuery, path?: string): RenderContext {
  const object = main.queriedObject;
  let target: Target = { kind: 'other' };
  if (main.is404) target = { kind: '404' };
  else if (main.isSearch) target = { kind: 'search', search: main.search ?? '' };
  else if (object?.kind === 'post')
    target = { kind: 'post', post: object.post, front: main.isFrontPage };
  else if (main.isFrontPage || main.isHome) target = { kind: 'home' };
  else if (object?.kind === 'term') target = { kind: 'term', term: object.term };
  else if (object?.kind === 'author') target = { kind: 'author', author: object.author };
  else if (main.isDate && main.date) target = { kind: 'date', date: main.date };
  return {
    target,
    paged: main.paged || 1,
    maxPages: main.maxPages || 1,
    path: path?.split('?')[0],
  };
}

export async function readMeta(
  api: PluginApi,
  type: 'post' | 'term',
  id: number,
  names: MetaName[] = Object.keys(META) as MetaName[],
): Promise<SeoMeta> {
  const out: SeoMeta = {};
  for (const name of names) {
    const value = await api.meta.get(type, id, metaKey(type, name), true);
    if (value !== undefined && value !== null && value !== '') out[name] = String(value);
  }
  return out;
}

function iso(date: Date | string): string {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function pagedUrl(url: string, paged: number, pretty: boolean): string {
  if (paged <= 1) return url;
  if (!pretty || url.includes('?')) return `${url}${url.includes('?') ? '&' : '?'}paged=${paged}`;
  return `${url.replace(/\/?$/, '/')}page/${paged}/`;
}

/** The first image in the content, for og:image when nothing else is set. */
function firstContentImage(content: string): string | undefined {
  return /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(content)?.[1];
}

export function excerptOf(post: Pick<Post, 'excerpt' | 'content'>): string {
  const own = plainText(post.excerpt ?? '');
  return own || trimText(plainText(post.content ?? ''), 155);
}

async function attachment(api: PluginApi, id: unknown): Promise<SchemaImage & { type?: string; alt?: string } | null> {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const image = await api.content.attachmentImage(n);
  return image
    ? { url: image.url, width: image.width, height: image.height, type: image.mimeType, alt: image.alt, caption: image.alt }
    : null;
}

/** The post's categories, the primary one (Yoast's primary term) first. */
async function postCategories(api: PluginApi, post: Post, meta: SeoMeta): Promise<Term[]> {
  if (post.type !== 'post') return [];
  const ids = (await api.content.terms.objectTermIds([post.id], 'category')).get(post.id) ?? [];
  const terms: Term[] = [];
  for (const id of ids) {
    const term = await api.content.terms.get('category', id);
    if (term) terms.push(term);
  }
  const primary = Number(meta.primaryCategory);
  terms.sort((a, b) => Number(b.id === primary) - Number(a.id === primary));
  return terms;
}

async function termAncestors(api: PluginApi, term: Term): Promise<Term[]> {
  const chain: Term[] = [];
  let parent = term.parent;
  for (let i = 0; parent && i < 20; i++) {
    const next = await api.content.terms.get(term.taxonomy, parent);
    if (!next) break;
    chain.unshift(next);
    parent = next.parent;
  }
  return chain;
}

async function crumbName(api: PluginApi, type: 'post' | 'term', id: number, fallback: string) {
  const bc = await api.meta.get(type, id, metaKey(type, 'bctitle'), true);
  return typeof bc === 'string' && bc.trim() ? bc.trim() : fallback;
}

/**
 * The breadcrumb trail: Home, then the primary category (and its parents)
 * for posts, a page's parents, a term's parents, then the current item. The
 * Breadcrumbs block and the BreadcrumbList schema both use it.
 */
export async function breadcrumbTrail(
  api: PluginApi,
  context: RenderContext,
  titles?: WpseoTitles,
  site?: Site,
): Promise<Crumb[]> {
  const t = titles ?? (await getTitles(api));
  const s = site ?? (await getSite(api));
  const home: Crumb = { name: str(t['breadcrumbs-home'], 'Home') || 'Home', url: `${s.home}/` };
  const target = context.target;
  switch (target.kind) {
    case 'home':
      return [{ name: home.name }];
    case 'post': {
      if (target.front) return [{ name: home.name }];
      const post = target.post;
      const trail: Crumb[] = [home];
      if (post.type === 'post') {
        const meta = await readMeta(api, 'post', post.id, ['primaryCategory']);
        const [primary] = await postCategories(api, post, meta);
        if (primary) {
          for (const term of [...(await termAncestors(api, primary)), primary]) {
            trail.push({
              name: await crumbName(api, 'term', term.id, term.name),
              url: await api.content.termLink(term),
            });
          }
        }
      } else if (post.parentId) {
        const parents: Crumb[] = [];
        let parentId: number | null = post.parentId;
        for (let i = 0; parentId && i < 20; i++) {
          const parent = await api.content.posts.get(parentId);
          if (!parent || parent.status !== 'publish') break;
          const url = await api.content.permalink(parent);
          parents.unshift({
            name: await crumbName(api, 'post', parent.id, plainText(parent.title)),
            ...(url ? { url } : {}),
          });
          parentId = parent.parentId;
        }
        trail.push(...parents);
      }
      const url = await api.content.permalink(post);
      trail.push({
        name: await crumbName(api, 'post', post.id, plainText(post.title)),
        ...(url ? { url } : {}),
      });
      return trail;
    }
    case 'term': {
      const trail: Crumb[] = [home];
      for (const term of [...(await termAncestors(api, target.term)), target.term]) {
        trail.push({
          name: await crumbName(api, 'term', term.id, term.name),
          url: await api.content.termLink(term),
        });
      }
      return trail;
    }
    case 'author':
      return [
        home,
        { name: `${str(t['breadcrumbs-archiveprefix'], 'Archives for')} ${target.author.displayName}`.trim() },
      ];
    case 'search':
      return [home, { name: `${str(t['breadcrumbs-searchprefix'], 'You searched for')} ${target.search}`.trim() }];
    case '404':
      return [home, { name: str(t['breadcrumbs-404crumb'], 'Error 404: Page not found') }];
    case 'date':
      return [home, { name: `${str(t['breadcrumbs-archiveprefix'], 'Archives for')} ${dateLabel(target.date, s.locale)}`.trim() }];
    default:
      return [home];
  }
}

function dateLabel(date: { year: number; month?: number; day?: number }, locale: string): string {
  const d = new Date(Date.UTC(date.year, (date.month ?? 1) - 1, date.day ?? 1));
  const options: Intl.DateTimeFormatOptions = date.day
    ? { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }
    : date.month
      ? { year: 'numeric', month: 'long', timeZone: 'UTC' }
      : { year: 'numeric', timeZone: 'UTC' };
  try {
    return d.toLocaleDateString(locale.replace('_', '-'), options);
  } catch {
    return d.toLocaleDateString('en-US', options);
  }
}

function sameAs(social: WpseoSocial): string[] {
  const list = [
    social.facebook_site,
    social.twitter_site
      ? social.twitter_site.startsWith('http')
        ? social.twitter_site
        : `https://x.com/${social.twitter_site.replace(/^@/, '')}`
      : '',
    ...(Array.isArray(social.other_social_urls) ? social.other_social_urls : []),
  ];
  return [...new Set(list.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)))];
}

async function representation(
  api: PluginApi,
  titles: WpseoTitles,
  social: WpseoSocial,
  site: Site,
): Promise<SchemaInput['representation']> {
  if (titles.company_or_person === 'person') {
    const id = Number(titles.company_or_person_user_id);
    const user = id ? await api.content.author(id) : undefined;
    if (!user) return null;
    const image =
      (await attachment(api, titles.person_logo_id)) ??
      (titles.person_logo ? { url: titles.person_logo } : undefined);
    return { type: 'person', id, name: user.name, ...(image ? { image } : {}), sameAs: sameAs(social) };
  }
  const name = titles.company_name || '';
  if (!name) return null;
  const logo =
    (await attachment(api, titles.company_logo_id)) ??
    (titles.company_logo ? { url: titles.company_logo } : undefined);
  void site;
  return { type: 'company', name, ...(logo ? { logo } : {}), sameAs: sameAs(social) };
}

/** Compute the head for a page (or a post or term outside a render, for REST). */
export async function computeHead(api: PluginApi, context: RenderContext): Promise<HeadData> {
  const [titles, social, site] = await Promise.all([getTitles(api), getSocial(api), getSite(api)]);
  const sep = separatorText(titles.separator);
  const pretty = site.permalinkStructure !== '';
  const language = site.locale.replace('_', '-');
  const now = new Date();
  const { paged, maxPages, target } = context;
  const vars: VarValues = {
    sitename: site.name,
    sitedesc: site.description,
    sep,
    page: paged > 1 ? `Page ${paged} of ${Math.max(paged, maxPages)}` : '',
    pagenumber: String(paged),
    pagetotal: String(Math.max(paged, maxPages)),
    currentyear: String(now.getFullYear()),
    currentmonth: now.toLocaleDateString('en-US', { month: 'long' }),
    currentday: String(now.getDate()),
    currentdate: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
  };

  let titleTemplate = '';
  let descTemplate = '';
  let canonical = '';
  let robots: Robots = { index: true, follow: true, adv: [] };
  let meta: SeoMeta = {};
  let ogType = 'website';
  let image: ImageInfo | null = null;
  let excerpt = '';
  let pageType: SchemaInput['page']['type'] = 'CollectionPage';
  let article: SchemaInput['article'];
  let profile: SchemaInput['profile'];
  let published: string | undefined;
  let modified: string | undefined;
  const ogExtra: { property: string; content: string }[] = [];

  switch (target.kind) {
    case 'post': {
      const post = target.post;
      meta = await readMeta(api, 'post', post.id);
      const appearance = postTypeAppearance(titles, post.type);
      const type = api.postTypes.get(post.type);
      const categories = await postCategories(api, post, meta);
      excerpt = excerptOf(post);
      const author = post.authorId ? await api.content.author(post.authorId) : undefined;
      const parent = post.parentId ? await api.content.posts.get(post.parentId) : undefined;
      Object.assign(vars, {
        title: plainText(post.title),
        excerpt,
        excerpt_only: plainText(post.excerpt ?? ''),
        category: categories.map((c) => c.name).join(', '),
        primary_category: categories[0]?.name ?? '',
        date: dateLabelFromDate(post.date, site.locale),
        modified: dateLabelFromDate(post.modified, site.locale),
        name: author?.name ?? '',
        user_description: author?.description ?? '',
        pt_single: type?.singularLabel ?? '',
        pt_plural: type?.label ?? '',
        focuskw: meta.focuskw ?? '',
        id: String(post.id),
        parent_title: parent ? plainText(parent.title) : '',
      });
      titleTemplate = meta.title ?? appearance.title;
      descTemplate = meta.metadesc ?? appearance.metadesc;
      robots = metaRobots(meta, appearance.noindex);
      if (post.status !== 'publish') robots.index = false;
      const permalink = (await api.content.canonicalUrl(post)) || (await api.content.permalink(post)) || '';
      canonical = meta.canonical || permalink;
      ogType = target.front ? 'website' : 'article';
      pageType = 'WebPage';
      published = iso(post.date);
      modified = iso(post.modified);
      if (ogType === 'article') {
        ogExtra.push({ property: 'article:published_time', content: published });
        if (modified !== published) ogExtra.push({ property: 'article:modified_time', content: modified });
        if (social.facebook_site) ogExtra.push({ property: 'article:publisher', content: social.facebook_site });
      }
      const set = (await attachment(api, meta.ogImageId)) ?? (meta.ogImage ? { url: meta.ogImage } : null);
      const featured = await attachment(api, await api.meta.get('post', post.id, '_thumbnail_id', true));
      const inContent = firstContentImage(post.content ?? '');
      image = set
        ? { ...set, source: 'set' }
        : featured
          ? { ...featured, source: 'featured' }
          : inContent
            ? { url: inContent, source: 'content' }
            : null;
      if (post.type === 'post' && !target.front) {
        const tags = (await api.content.terms.objectTermIds([post.id], 'post_tag')).get(post.id) ?? [];
        const keywords: string[] = [];
        for (const id of tags) {
          const tag = await api.content.terms.get('post_tag', id);
          if (tag) keywords.push(tag.name);
        }
        const words = plainText(post.content ?? '').split(/\s+/).filter(Boolean).length;
        article = {
          headline: plainText(post.title),
          datePublished: published,
          dateModified: modified,
          ...(author ? { author: { id: author.id, name: author.name, url: author.url } } : {}),
          sections: categories.map((c) => c.name),
          keywords,
          wordCount: words,
        };
      }
      break;
    }
    case 'term': {
      const term = target.term;
      meta = await readMeta(api, 'term', term.id, TERM_META_NAMES);
      const appearance = taxonomyAppearance(titles, term.taxonomy);
      const description = plainText(term.description);
      Object.assign(vars, {
        title: term.name,
        term_title: term.name,
        term_description: description,
        category_description: term.taxonomy === 'category' ? description : '',
        tag_description: term.taxonomy === 'post_tag' ? description : '',
        category: term.taxonomy === 'category' ? term.name : '',
        tag: term.taxonomy === 'post_tag' ? term.name : '',
        focuskw: meta.focuskw ?? '',
        archive_title: term.name,
      });
      excerpt = description;
      titleTemplate = meta.title ?? appearance.title;
      descTemplate = meta.metadesc ?? appearance.metadesc;
      robots = metaRobots(
        { ...meta, noindex: meta.noindex === 'noindex' ? '1' : meta.noindex === 'index' ? '2' : '0' },
        appearance.noindex,
      );
      canonical = meta.canonical || pagedUrl(await api.content.termLink(term), paged, pretty);
      const set = (await attachment(api, meta.ogImageId)) ?? (meta.ogImage ? { url: meta.ogImage } : null);
      image = set ? { ...set, source: 'set' } : null;
      break;
    }
    case 'home':
      titleTemplate = str(titles['title-home-wpseo'], '');
      descTemplate = str(titles['metadesc-home-wpseo'], '');
      canonical = pagedUrl(`${site.home}/`, paged, pretty);
      excerpt = site.description;
      break;
    case 'author': {
      const author = await api.content.author(target.author.id);
      Object.assign(vars, {
        name: target.author.displayName,
        user_description: target.author.description,
        archive_title: target.author.displayName,
      });
      titleTemplate = str(titles['title-author-wpseo'], '');
      descTemplate = str(titles['metadesc-author-wpseo'], '');
      robots.index = !bool(titles['noindex-author-wpseo'], false);
      canonical = pagedUrl(author?.url ?? `${site.home}${context.path ?? '/'}`, paged, pretty);
      pageType = 'ProfilePage';
      profile = {
        id: target.author.id,
        name: target.author.displayName,
        ...(author?.url ? { url: author.url } : {}),
        description: target.author.description,
      };
      break;
    }
    case 'date':
      vars.date = dateLabel(target.date, site.locale);
      vars.archive_title = vars.date;
      titleTemplate = str(titles['title-archive-wpseo'], '');
      descTemplate = str(titles['metadesc-archive-wpseo'], '');
      robots.index = !bool(titles['noindex-archive-wpseo'], false);
      canonical = context.path ? `${site.home}${context.path}` : '';
      break;
    case 'search':
      vars.searchphrase = target.search;
      titleTemplate = str(titles['title-search-wpseo'], '');
      robots.index = false;
      pageType = 'SearchResultsPage';
      break;
    case '404':
      titleTemplate = str(titles['title-404-wpseo'], '');
      robots.index = false;
      break;
    default:
      break;
  }

  const title = replaceVars(titleTemplate, vars) || site.name;
  const description = replaceVars(descTemplate, vars);
  if (!image) {
    const fallback =
      (await attachment(api, social.og_default_image_id)) ??
      (social.og_default_image ? { url: social.og_default_image } : null);
    if (fallback) image = { ...fallback, source: 'default' };
  }
  // Only what can be indexed gets a canonical (Yoast leaves it out on noindexed pages).
  if (!robots.index && !meta.canonical) canonical = '';

  const breadcrumbs =
    target.kind === 'other' ? [] : await breadcrumbTrail(api, context, titles, site);

  const og: { property: string; content: string }[] = [];
  const twitter: { name: string; content: string }[] = [];
  const isFrontHome = target.kind === 'home' || (target.kind === 'post' && target.front);
  const ogTitle =
    meta.ogTitle ||
    (isFrontHome && social.og_frontpage_title) ||
    title;
  const ogDescription =
    meta.ogDescription ||
    (isFrontHome && social.og_frontpage_desc) ||
    description ||
    excerpt;
  if (social.opengraph !== false && target.kind !== '404' && target.kind !== 'search') {
    og.push({ property: 'og:locale', content: site.locale });
    og.push({ property: 'og:type', content: ogType });
    og.push({ property: 'og:title', content: replaceVars(ogTitle, vars) });
    if (ogDescription) og.push({ property: 'og:description', content: replaceVars(ogDescription, vars) });
    if (canonical) og.push({ property: 'og:url', content: canonical });
    if (site.name) og.push({ property: 'og:site_name', content: site.name });
    og.push(...ogExtra);
    if (image) {
      og.push({ property: 'og:image', content: image.url });
      if (image.width) og.push({ property: 'og:image:width', content: String(image.width) });
      if (image.height) og.push({ property: 'og:image:height', content: String(image.height) });
      if (image.type) og.push({ property: 'og:image:type', content: image.type });
    }
  }
  if (social.twitter !== false && target.kind !== '404' && target.kind !== 'search') {
    twitter.push({ name: 'twitter:card', content: social.twitter_card_type || 'summary_large_image' });
    if (meta.twitterTitle) twitter.push({ name: 'twitter:title', content: replaceVars(meta.twitterTitle, vars) });
    if (meta.twitterDescription)
      twitter.push({ name: 'twitter:description', content: replaceVars(meta.twitterDescription, vars) });
    const twImage = (await attachment(api, meta.twitterImageId))?.url ?? meta.twitterImage;
    if (twImage) twitter.push({ name: 'twitter:image', content: twImage });
    if (social.twitter_site)
      twitter.push({ name: 'twitter:site', content: `@${social.twitter_site.replace(/^@|^https?:\/\/(?:www\.)?(?:twitter|x)\.com\//g, '')}` });
  }

  const pageUrl = canonical || `${site.home}${context.path ?? '/'}`;
  let graph: GraphNode[] = [];
  if (target.kind !== '404' && target.kind !== 'other') {
    graph = buildGraph({
      home: site.home,
      siteName: titles.website_name || site.name,
      siteDescription: site.description,
      language,
      representation: await representation(api, titles, social, site),
      page: {
        url: pageUrl,
        type: pageType,
        name: title,
        ...(description ? { description } : {}),
        ...(published ? { datePublished: published } : {}),
        ...(modified ? { dateModified: modified } : {}),
        ...(image && image.source !== 'default' ? { image: { url: image.url, width: image.width, height: image.height, caption: image.alt } } : {}),
      },
      breadcrumbs,
      ...(article ? { article } : {}),
      ...(profile ? { profile } : {}),
    });
    graph = (await api.hooks.applyFilters('pressbase_seo_schema_graph', graph, context)) as GraphNode[];
  }

  const head: HeadData = {
    title,
    description,
    canonical,
    robots,
    og,
    twitter,
    image,
    breadcrumbs,
    schema: { '@context': 'https://schema.org', '@graph': graph },
  };
  return (await api.hooks.applyFilters('pressbase_seo_head', head, context)) as HeadData;
}

function dateLabelFromDate(value: Date | string, locale: string): string {
  const d = new Date(value);
  return dateLabel({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, locale);
}

/** Robots as wp_robots directives (Yoast's: index, follow and the max-* hints). */
export function robotsDirectives(robots: Robots): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {
    [robots.index ? 'index' : 'noindex']: true,
    [robots.follow ? 'follow' : 'nofollow']: true,
  };
  for (const a of robots.adv) out[a] = true;
  if (robots.index && !robots.adv.includes('nosnippet')) {
    out['max-image-preview'] = 'large';
    out['max-snippet'] = '-1';
    out['max-video-preview'] = '-1';
  }
  return out;
}

/** The tags printed in wp_head after core's robots and title (WordPress's order, as Yoast prints). */
export function renderHead(head: HeadData, options: { title?: boolean; robots?: boolean } = {}): string {
  const lines: string[] = ['<!-- Pressbase SEO -->'];
  if (options.title) lines.push(`<title>${escHtml(head.title)}</title>`);
  if (head.description) lines.push(`<meta name="description" content="${escAttr(head.description)}" />`);
  if (options.robots) {
    const directives = Object.entries(robotsDirectives(head.robots)).map(([k, v]) =>
      typeof v === 'string' ? `${k}:${v}` : k,
    );
    lines.push(`<meta name="robots" content="${escAttr(directives.join(', '))}" />`);
  }
  if (head.canonical) {
    const href = escUrl(head.canonical);
    if (href) lines.push(`<link rel="canonical" href="${href}" />`);
  }
  for (const { property, content } of head.og) {
    lines.push(`<meta property="${escAttr(property)}" content="${escAttr(content)}" />`);
  }
  for (const { name, content } of head.twitter) {
    lines.push(`<meta name="${escAttr(name)}" content="${escAttr(content)}" />`);
  }
  if (head.schema['@graph'].length) {
    lines.push(`<script type="application/ld+json" class="pressbase-seo-schema">${jsonForScript(head.schema)}</script>`);
  }
  lines.push('<!-- / Pressbase SEO -->');
  return lines.join('\n');
}
