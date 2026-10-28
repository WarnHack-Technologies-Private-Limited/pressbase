import { schema } from '@pressbase/db';
import { and, asc, countDistinct, eq, inArray } from 'drizzle-orm';
import { authorPostsUrl, type SiteInfo, siteInfo, termLink } from '../blocks/helpers';
import { addCacheTags, CacheTag } from '../cache/tags';
import { permalink, permalinkContext } from '../content/permalinks';
import { type QueryArgs, queryPosts } from '../content/query';
import type { Kernel } from '../kernel';
import { w3cDate, xmlText } from './xml';

/**
 * XML sitemaps — WordPress's WP_Sitemaps (wordpress/wp-includes/sitemaps/):
 * the index at /wp-sitemap.xml, one sitemap per provider, subtype and page
 * (`/wp-sitemap-posts-post-1.xml`, `-posts-page-`, `-taxonomies-category-`,
 * `-taxonomies-post_tag-`, `/wp-sitemap-users-1.xml`), 2,000 URLs per page,
 * and the XSL stylesheets that make them readable in a browser. With plain
 * permalinks the query-string forms (`/?sitemap=index`) are used instead.
 *
 * Sitemaps are off (404) when the site asks search engines not to index it
 * (`blog_public`), as wp_sitemaps_enabled() decides.
 *
 * One deliberate difference: WordPress lists password-protected posts; they
 * have nothing to index, so Pressbase leaves them out (filter
 * `wp_sitemaps_posts_query_args` to change that).
 */

/** wp_sitemaps_get_max_urls() */
export const SITEMAP_MAX_URLS = 2000;

export type SitemapRequest =
  | { kind: 'index' }
  | { kind: 'stylesheet'; type: 'sitemap' | 'index' }
  | { kind: 'sitemap'; provider: string; subtype: string; page: number };

/** WP_Sitemaps::register_rewrites() and the sitemap query variables. */
export function parseSitemapRequest(url: URL, pretty: boolean): SitemapRequest | undefined {
  const q = url.searchParams;
  if (url.pathname === '/' && (q.has('sitemap') || q.has('sitemap-stylesheet'))) {
    const stylesheet = q.get('sitemap-stylesheet');
    if (stylesheet === 'sitemap' || stylesheet === 'index')
      return { kind: 'stylesheet', type: stylesheet };
    const sitemap = q.get('sitemap') ?? '';
    if (sitemap === 'index') return { kind: 'index' };
    const page = Number(q.get('paged') ?? 1);
    return {
      kind: 'sitemap',
      provider: sitemap,
      subtype: q.get('sitemap-subtype') ?? '',
      page: Number.isInteger(page) && page > 0 ? page : 0,
    };
  }
  if (!pretty) return undefined;
  const path = url.pathname;
  if (path === '/wp-sitemap.xml') return { kind: 'index' };
  if (path === '/wp-sitemap.xsl') return { kind: 'stylesheet', type: 'sitemap' };
  if (path === '/wp-sitemap-index.xsl') return { kind: 'stylesheet', type: 'index' };
  const full = /^\/wp-sitemap-([a-z]+?)-([a-z\d_-]+?)-(\d+?)\.xml$/.exec(path);
  if (full) {
    return {
      kind: 'sitemap',
      provider: full[1] ?? '',
      subtype: full[2] ?? '',
      page: Number(full[3]),
    };
  }
  const short = /^\/wp-sitemap-([a-z]+?)-(\d+?)\.xml$/.exec(path);
  if (short)
    return { kind: 'sitemap', provider: short[1] ?? '', subtype: '', page: Number(short[2]) };
  return undefined;
}

interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

interface Provider {
  name: string;
  /** Object subtypes ('' for providers without, like users). */
  subtypes(): Promise<string[]>;
  maxPages(subtype: string): Promise<number>;
  urls(page: number, subtype: string): Promise<SitemapEntry[]>;
}

/** wp_sitemaps_enabled() */
export async function sitemapsEnabled(kernel: Kernel): Promise<boolean> {
  const enabled = Boolean(await kernel.options.get('blog_public', true));
  return Boolean(await kernel.hooks.applyFilters('wp_sitemaps_enabled', enabled));
}

/** WP_Sitemaps_Index::get_index_url() */
export function sitemapIndexUrl(site: SiteInfo): string {
  return site.pretty ? `${site.home}/wp-sitemap.xml` : `${site.home}/?sitemap=index`;
}

/** WP_Sitemaps_Provider::get_sitemap_url() */
function sitemapUrl(site: SiteInfo, provider: string, subtype: string, page: number): string {
  if (!site.pretty) {
    const params = new URLSearchParams({ sitemap: provider });
    if (subtype) params.set('sitemap-subtype', subtype);
    params.set('paged', String(page));
    return `${site.home}/?${params}`;
  }
  return `${site.home}/wp-sitemap-${[provider, subtype, page].filter(Boolean).join('-')}.xml`;
}

/** wp_sitemaps_get_max_urls( $object_type ): 2,000, filterable per object type. */
async function maxUrls(kernel: Kernel, objectType: 'post' | 'term' | 'user'): Promise<number> {
  const value = Number(
    await kernel.hooks.applyFilters('wp_sitemaps_max_urls', SITEMAP_MAX_URLS, objectType),
  );
  return Number.isInteger(value) && value > 0 ? value : SITEMAP_MAX_URLS;
}

async function providers(kernel: Kernel, site: SiteInfo): Promise<Provider[]> {
  const maxPosts = await maxUrls(kernel, 'post');
  const maxTerms = await maxUrls(kernel, 'term');
  const maxUsers = await maxUrls(kernel, 'user');

  // WP_Sitemaps_Posts: public, viewable post types except attachments.
  const postTypes = async () =>
    (await kernel.hooks.applyFilters(
      'wp_sitemaps_post_types',
      kernel.postTypes
        .all()
        .filter((t) => t.public && ['post', 'page'].includes(t.name))
        .map((t) => t.name),
    )) as string[];
  const postArgs = async (type: string, page: number): Promise<QueryArgs> =>
    (await kernel.hooks.applyFilters(
      'wp_sitemaps_posts_query_args',
      {
        post_type: type,
        post_status: 'publish',
        has_password: false,
        orderby: 'id',
        order: 'ASC',
        posts_per_page: maxPosts,
        paged: page,
      } satisfies QueryArgs,
      type,
    )) as QueryArgs;
  const showOnFrontPosts = async () =>
    (await kernel.options.get<string>('show_on_front', 'posts')) === 'posts';

  const posts: Provider = {
    name: 'posts',
    subtypes: postTypes,
    async maxPages(type) {
      if (!(await postTypes()).includes(type)) return 0;
      const { maxPages } = await queryPosts(kernel, await postArgs(type, 1));
      const min = type === 'page' && (await showOnFrontPosts()) ? 1 : 0;
      return Math.max(min, maxPages);
    },
    async urls(page, type) {
      if (!(await postTypes()).includes(type)) return [];
      const { posts: rows } = await queryPosts(kernel, {
        ...(await postArgs(type, page)),
        no_found_rows: true,
      });
      const list: SitemapEntry[] = [];
      // The home page leads the pages sitemap when it shows the latest posts.
      if (type === 'page' && page === 1 && (await showOnFrontPosts())) {
        const { posts: latest } = await queryPosts(kernel, {
          post_type: 'post',
          post_status: 'publish',
          orderby: 'modified',
          posts_per_page: 1,
          no_found_rows: true,
        });
        list.push({
          loc: `${site.home}/`,
          ...(latest[0] ? { lastmod: w3cDate(latest[0].modified, site.timeZone) } : {}),
        });
      }
      const links = await permalinkContext(kernel);
      for (const post of rows) {
        list.push({
          loc: await permalink(kernel, post, links),
          lastmod: w3cDate(post.modified, site.timeZone),
        });
      }
      return list;
    },
  };

  // WP_Sitemaps_Taxonomies: public taxonomies, terms with published posts.
  const taxonomies = async () =>
    (await kernel.hooks.applyFilters(
      'wp_sitemaps_taxonomies',
      kernel.taxonomies
        .all()
        .filter((t) => t.public && ['category', 'post_tag'].includes(t.name))
        .map((t) => t.name),
    )) as string[];
  const terms: Provider = {
    name: 'taxonomies',
    subtypes: taxonomies,
    async maxPages(taxonomy) {
      if (!(await taxonomies()).includes(taxonomy)) return 0;
      const { total } = await kernel.terms.list(taxonomy, { hideEmpty: true, perPage: 1 });
      return Math.ceil(total / maxTerms);
    },
    async urls(page, taxonomy) {
      if (!(await taxonomies()).includes(taxonomy)) return [];
      const { terms: rows } = await kernel.terms.list(taxonomy, {
        hideEmpty: true,
        orderby: 'id',
        perPage: maxTerms,
        page,
      });
      return rows.map((term) => ({ loc: termLink(site, term) }));
    },
  };

  // WP_Sitemaps_Users: authors with published posts (pages and attachments don't count).
  const authorTypes = async () => (await postTypes()).filter((t) => t !== 'page');
  const authorsWhere = async () =>
    and(eq(schema.posts.status, 'publish'), inArray(schema.posts.type, await authorTypes()));
  const users: Provider = {
    name: 'users',
    subtypes: async () => [''],
    async maxPages() {
      if (!(await authorTypes()).length) return 0;
      const [row] = await kernel.db
        .select({ n: countDistinct(schema.posts.authorId) })
        .from(schema.posts)
        .innerJoin(schema.users, eq(schema.users.id, schema.posts.authorId))
        .where(await authorsWhere());
      addCacheTags(CacheTag.posts('post'));
      return Math.ceil((row?.n ?? 0) / maxUsers);
    },
    async urls(page) {
      if (!(await authorTypes()).length) return [];
      const rows = await kernel.db
        .selectDistinct({
          id: schema.users.id,
          nicename: schema.users.nicename,
          login: schema.users.login,
        })
        .from(schema.users)
        .innerJoin(schema.posts, eq(schema.users.id, schema.posts.authorId))
        .where(await authorsWhere())
        .orderBy(asc(schema.users.login), asc(schema.users.id))
        .limit(maxUsers)
        .offset((page - 1) * maxUsers);
      addCacheTags(CacheTag.posts('post'), ...rows.map((u) => CacheTag.author(u.id)));
      return rows.map((user) => ({ loc: authorPostsUrl(site, user) }));
    },
  };
  return [posts, terms, users];
}

export interface SitemapDocument {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const XML_HEADERS = { 'content-type': 'application/xml; charset=UTF-8' };

/** WP_Sitemaps::render_sitemaps(): the document, or undefined for a 404. */
export async function renderSitemap(
  kernel: Kernel,
  request: SitemapRequest,
): Promise<SitemapDocument | undefined> {
  if (!(await sitemapsEnabled(kernel))) return undefined;
  const site = await siteInfo(kernel);
  const stylesheet = (type: 'sitemap' | 'index') =>
    site.pretty
      ? `${site.home}/wp-sitemap${type === 'index' ? '-index' : ''}.xsl`
      : `${site.home}/?sitemap-stylesheet=${type}`;

  if (request.kind === 'stylesheet') {
    return {
      status: 200,
      headers: { ...XML_HEADERS, 'cache-control': 'public, max-age=3600' },
      body: sitemapStylesheet(request.type, site, sitemapIndexUrl(site)),
    };
  }

  const all = await providers(kernel, site);
  if (request.kind === 'index') {
    // WP_Sitemaps_Index::get_sitemap_list()
    const locs: string[] = [];
    for (const provider of all) {
      for (const subtype of await provider.subtypes()) {
        const pages = await provider.maxPages(subtype);
        for (let page = 1; page <= pages; page++) {
          locs.push(sitemapUrl(site, provider.name, subtype, page));
        }
      }
    }
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="${xmlText(stylesheet('index'))}" ?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `\t<sitemap><loc>${xmlText(loc)}</loc></sitemap>`).join('\n')}
</sitemapindex>
`;
    return { status: 200, headers: { ...XML_HEADERS }, body };
  }

  const provider = all.find((p) => p.name === request.provider);
  if (!provider || request.page < 1) return undefined;
  const subtypes = await provider.subtypes();
  if (!subtypes.includes(request.subtype)) return undefined;
  const urls = await provider.urls(request.page, request.subtype);
  if (!urls.length) return undefined;
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="${xmlText(stylesheet('sitemap'))}" ?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) =>
      `\t<url><loc>${xmlText(u.loc)}</loc>${u.lastmod ? `<lastmod>${xmlText(u.lastmod)}</lastmod>` : ''}</url>`,
  )
  .join('\n')}
</urlset>
`;
  return { status: 200, headers: { ...XML_HEADERS }, body };
}

/**
 * The index lists sitemap URLs only (the protocol has no titles), so the
 * stylesheet names each from its URL: pretty (`-posts-page-`) or plain
 * (`sitemap-subtype=page&`) forms. Unknown providers show their URL.
 */
const INDEX_NAMES: [string, string, string][] = [
  ['-posts-post-', 'sitemap-subtype=post&', 'Posts'],
  ['-posts-page-', 'sitemap-subtype=page&', 'Pages'],
  ['-taxonomies-category-', 'sitemap-subtype=category&', 'Categories'],
  ['-taxonomies-post_tag-', 'sitemap-subtype=post_tag&', 'Tags'],
  ['-users-', 'sitemap=users&', 'Authors'],
];
const INDEX_WHENS = INDEX_NAMES.map(
  ([pretty, plain, label]) =>
    `<xsl:when test="contains( sitemap:loc, '${pretty}' ) or contains( sitemap:loc, '${xmlText(plain)}' )"><span class="label">${label}</span></xsl:when>`,
).join('');
const INDEX_LABEL = `<xsl:choose>${INDEX_WHENS}<xsl:otherwise><span class="label"><xsl:value-of select="sitemap:loc" /></span></xsl:otherwise></xsl:choose><span class="sub"><xsl:value-of select="sitemap:loc" /></span>`;
/** A URL as its path, with the site's address muted in front. */
const URL_LABEL = `<xsl:choose><xsl:when test="$home != '' and starts-with( sitemap:loc, $home )"><span class="host"><xsl:value-of select="$home" /></span><span class="path"><xsl:value-of select="substring-after( sitemap:loc, $home )" /></span></xsl:when><xsl:otherwise><span class="path"><xsl:value-of select="sitemap:loc" /></span></xsl:otherwise></xsl:choose>`;

/**
 * WP_Sitemaps_Stylesheet: XSLT that shows a sitemap as a page. Same data as
 * WordPress's (URL, last modified, the count), restyled to read like the
 * rest of Pressbase: the site's name, a link back to the index, readable
 * dates, light and dark schemes, and a layout that works on a phone.
 */
export function sitemapStylesheet(
  type: 'sitemap' | 'index',
  site: SiteInfo,
  indexUrl: string,
): string {
  const isIndex = type === 'index';
  const rows = isIndex ? 'sitemap:sitemapindex/sitemap:sitemap' : 'sitemap:urlset/sitemap:url';
  const name = xmlText(site.name || 'This site');
  // The site's address as an XPath string literal (URLs can't hold a raw apostrophe; drop any).
  const homeLiteral = xmlText(site.home.replaceAll("'", ''));
  const lead = isIndex
    ? 'This index lists the sitemaps of this site. Search engines read them to find every public post, page, category, tag and author.'
    : 'These are the public addresses in this sitemap. Search engines read them to find and refresh the site’s content.';
  const css = `
:root{color-scheme:light dark;--bg:#f6f7f7;--surface:#fff;--text:#1e1e1e;--muted:#5c5f62;--line:#e0e0e0;--zebra:#fafafa;--accent:#2f5fd0;--pill:#eef2fc}
@media (prefers-color-scheme:dark){:root{--bg:#141516;--surface:#1d1f21;--text:#ececec;--muted:#a3a7ab;--line:#2f3235;--zebra:#212326;--accent:#8fb0ff;--pill:#24304d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1040px;margin:0 auto;padding:48px 24px 64px}
.eyebrow{margin:0 0 6px;color:var(--muted);font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.eyebrow a{color:inherit;text-decoration:none}
.eyebrow a:hover{color:var(--accent)}
h1{margin:0 0 10px;font-size:28px;line-height:1.2;font-weight:650;letter-spacing:-.01em}
.lead{margin:0 0 24px;max-width:62ch;color:var(--muted)}
.lead a{color:var(--accent)}
.bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin:0 0 12px}
.count{display:inline-block;padding:3px 10px;border-radius:999px;background:var(--pill);color:var(--accent);font-size:13px;font-weight:600}
.back{color:var(--accent);font-size:14px;text-decoration:none}
.back:hover{text-decoration:underline}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
table{width:100%;border-collapse:collapse;table-layout:fixed}
th,td{padding:11px 16px;text-align:left;vertical-align:top}
th{position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--line);color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.03em;text-transform:uppercase}
tbody tr:nth-child(even) td{background:var(--zebra)}
tbody tr+tr td{border-top:1px solid var(--line)}
td.loc a{display:block;color:var(--text);text-decoration:none;overflow-wrap:anywhere;direction:ltr}
.label{display:block;font-weight:600}
.sub,.host{color:var(--muted)}
.sub{display:block;font-size:13px}
.path{font-weight:500}
td.loc a:hover .label,td.loc a:hover .path{color:var(--accent);text-decoration:underline}
td.loc a:focus-visible,.back:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
th.lastmod,td.lastmod{width:200px;white-space:nowrap;color:var(--muted);font-variant-numeric:tabular-nums}
.empty{padding:32px 16px;text-align:center;color:var(--muted)}
footer{margin-top:20px;color:var(--muted);font-size:13px}
footer a{color:inherit}
@media (max-width:640px){.wrap{padding:28px 16px 40px}h1{font-size:23px}th.lastmod,td.lastmod{width:auto}thead{display:none}tr{display:block;padding:10px 14px}td{display:block;padding:2px 0;background:none!important;border:0!important}tbody tr+tr{border-top:1px solid var(--line)}}
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet
\t\tversion="1.0"
\t\txmlns:xsl="http://www.w3.org/1999/XSL/Transform"
\t\txmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9"
\t\texclude-result-prefixes="sitemap"
\t\t>

\t<xsl:output method="html" encoding="UTF-8" indent="yes" doctype-system="about:legacy-compat" />

\t<xsl:variable name="has-lastmod" select="count( /${rows}/sitemap:lastmod )" />
\t<xsl:variable name="home" select="'${homeLiteral}'" />

\t<xsl:template match="/">
\t\t<html lang="en">
\t\t\t<head>
\t\t\t\t<meta name="viewport" content="width=device-width, initial-scale=1" />
\t\t\t\t<meta name="robots" content="noindex, follow" />
\t\t\t\t<title>XML Sitemap${isIndex ? '' : ' (part)'} · ${name}</title>
\t\t\t\t<style>${css}</style>
\t\t\t</head>
\t\t\t<body>
\t\t\t\t<main class="wrap">
\t\t\t\t\t<p class="eyebrow"><a href="${xmlText(site.home)}/">${name}</a></p>
\t\t\t\t\t<h1>XML Sitemap</h1>
\t\t\t\t\t<p class="lead">${lead} <a href="https://www.sitemaps.org/">Learn more about XML sitemaps.</a></p>
\t\t\t\t\t<div class="bar">
\t\t\t\t\t\t<span class="count"><xsl:value-of select="count( ${rows} )" /><xsl:text> </xsl:text><xsl:choose><xsl:when test="count( ${rows} ) = 1">${isIndex ? 'sitemap' : 'URL'}</xsl:when><xsl:otherwise>${isIndex ? 'sitemaps' : 'URLs'}</xsl:otherwise></xsl:choose></span>
${isIndex ? '' : `\t\t\t\t\t\t<a class="back" href="${xmlText(indexUrl)}">← All sitemaps</a>\n`}\t\t\t\t\t</div>
\t\t\t\t\t<div class="card">
\t\t\t\t\t\t<xsl:choose>
\t\t\t\t\t\t\t<xsl:when test="count( ${rows} ) = 0">
\t\t\t\t\t\t\t\t<p class="empty">Nothing is listed here yet.</p>
\t\t\t\t\t\t\t</xsl:when>
\t\t\t\t\t\t\t<xsl:otherwise>
\t\t\t\t\t\t<table>
\t\t\t\t\t\t\t<thead>
\t\t\t\t\t\t\t\t<tr>
\t\t\t\t\t\t\t\t\t<th class="loc" scope="col">${isIndex ? 'Sitemap' : 'URL'}</th>
\t\t\t\t\t\t\t\t\t<xsl:if test="$has-lastmod"><th class="lastmod" scope="col">Last modified</th></xsl:if>
\t\t\t\t\t\t\t\t</tr>
\t\t\t\t\t\t\t</thead>
\t\t\t\t\t\t\t<tbody>
\t\t\t\t\t\t\t\t<xsl:for-each select="${rows}">
\t\t\t\t\t\t\t\t\t<tr>
\t\t\t\t\t\t\t\t\t\t<td class="loc"><a href="{sitemap:loc}">${isIndex ? INDEX_LABEL : URL_LABEL}</a></td>
\t\t\t\t\t\t\t\t\t\t<xsl:if test="$has-lastmod">
\t\t\t\t\t\t\t\t\t\t\t<td class="lastmod">
\t\t\t\t\t\t\t\t\t\t\t\t<xsl:if test="sitemap:lastmod">
\t\t\t\t\t\t\t\t\t\t\t\t\t<time datetime="{sitemap:lastmod}"><xsl:value-of select="concat( substring( sitemap:lastmod, 1, 10 ), ' ', substring( sitemap:lastmod, 12, 5 ) )" /></time>
\t\t\t\t\t\t\t\t\t\t\t\t</xsl:if>
\t\t\t\t\t\t\t\t\t\t\t</td>
\t\t\t\t\t\t\t\t\t\t</xsl:if>
\t\t\t\t\t\t\t\t\t</tr>
\t\t\t\t\t\t\t\t</xsl:for-each>
\t\t\t\t\t\t\t</tbody>
\t\t\t\t\t\t</table>
\t\t\t\t\t\t\t</xsl:otherwise>
\t\t\t\t\t\t</xsl:choose>
\t\t\t\t\t</div>
\t\t\t\t\t<footer>Generated by Pressbase.${isIndex ? '' : '<xsl:if test="$has-lastmod"> Dates are in the site’s time zone.</xsl:if>'}</footer>
\t\t\t\t</main>
\t\t\t</body>
\t\t</html>
\t</xsl:template>
</xsl:stylesheet>
`;
}
