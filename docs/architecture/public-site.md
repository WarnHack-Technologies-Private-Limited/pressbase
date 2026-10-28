# The public site: caching, feeds, sitemaps and robots.txt

How the public site stays fast (a page cache with precise invalidation) and findable (RSS and Atom feeds, XML sitemaps, `robots.txt`). Page rendering itself is in [Themes](themes.md); the caching decision is [ADR 0008](../adr/0008-public-page-caching.md).

| Piece | Location | WordPress equivalent |
|---|---|---|
| Cache tags | `apps/core/src/cache/tags.ts` | the cache groups caching plugins key on |
| Invalidation | `apps/core/src/cache/invalidation.ts` | `clean_post_cache()`, `clean_term_cache()`, caching plugins' purge hooks |
| Purge delivery | `apps/core/src/cache/notifier.ts` | a caching plugin's purge request to Varnish or a CDN |
| Page cache | `apps/web/src/lib/{page-cache,cache-policy,serve,revalidate}.ts` | WP Super Cache / Batcache |
| Feeds | `apps/core/src/frontend/feeds.ts` | `feed-rss2.php`, `feed-rss2-comments.php`, `feed-atom.php`, `feed-atom-comments.php`, `feed.php`, `feed_links()` |
| Sitemaps | `apps/core/src/frontend/sitemaps.ts` | `wp-includes/sitemaps/*` (`WP_Sitemaps`, its providers, index, renderer and stylesheet) |
| robots.txt | `apps/core/src/frontend/robots.ts` | `do_robots()`, `WP_Sitemaps::add_robots()` |
| XML output | `apps/core/src/frontend/xml.ts` | `esc_xml()`, `ent2ncr()` |

## Routing

Core's render endpoint (`GET /wp-json/pressbase/v1/render?url=…`) handles every public URL, in this order:

1. `/robots.txt` → `text/plain; charset=utf-8`.
2. Sitemaps (`/wp-sitemap.xml`, `/wp-sitemap-*.xml`, `/wp-sitemap.xsl`, `/wp-sitemap-index.xsl`, or `?sitemap=` / `?sitemap-stylesheet=` with plain permalinks) → `application/xml; charset=UTF-8`.
3. Feeds (`…/feed/`, `…/feed/atom/`, `?feed=`) → `application/rss+xml` or `application/atom+xml`.
4. Anything else is a page of the theme.

`apps/web`'s catch-all route forwards all of these, so they work on the public origin and, through the admin's fallback rewrite to `apps/web`, on the admin origin too. The response keeps core's `content-type`.

## Page caching

```
Browser ──▶ apps/web ──(HIT)──────────────────────────▶ cached page (or 304)
               │ MISS: anonymous render
               ▼
            core: render + tags ["site","home","posts:post","post:12",…]
               ▲
               │ editor saves post 12
            core: save_post → pressbase_cache_purge(["post:12"])
               │ POST /_pressbase/revalidate  Authorization: Bearer <secret>
               ▼
            apps/web: drops every page tagged post:12
```

### Tags

| Tag | Carried by |
|---|---|
| `site` | every response |
| `home` | the front page |
| `post:{id}` | any page showing the post: its own page, a listing it appears in, a neighbour's previous/next link, a feed item |
| `posts:{type}`, `posts:any` | any page listing posts of that type (the query's membership can change) |
| `term:{id}` | a term's archive, and pages showing the term (post terms, category lists) |
| `terms:{taxonomy}` | pages listing a taxonomy's terms (category lists, tag clouds, sitemaps) |
| `author:{id}` | an author's archive, bylines |
| `comments` | site-wide comment lists (latest comments, the comments feed) |
| `search`, `404` | search results and not-found answers, which new content can change |

Content services record tags as they read (`kernel.posts.get`, `queryPosts`, `kernel.terms`, `kernel.comments.query`, author lookups); outside a render, recording does nothing. A block that reads the database directly should call `addCacheTags()`.

### What purges what

| Change | Tags purged |
|---|---|
| Edit a published post in place (title, content, excerpt, meta) | `post:{id}` |
| Publish, unpublish, trash, delete, or change date, slug, author, parent, order, password or terms | `post:{id}`, `posts:{type}`, `posts:any`, `search`, `404`, `home` (posts), `author:{id}`, `terms:{taxonomy}`, the old and new `term:{id}` |
| Sticky posts | `posts:post`, `posts:any`, `home`, `search` |
| Create, edit, delete a term | `term:{id}`, `terms:{taxonomy}` (and listings, on delete) |
| An approved comment arrives, is edited, or is approved / unapproved | `post:{id}`, `comments` |
| A profile changes | `author:{id}` |
| Any public option (`updated_option`, including `pressbase_navigation_fallback` for header menus, Settings → Reading, the site title), a theme switch, a menu, template or other non-public post type, a deleted user | `site` |

Core also purges `site` when it starts: a restart may bring new code or theme files.

Drafts, pending and private posts purge nothing: anonymous visitors never saw them. Internal options (`pressbase_db_version`, `pressbase_comment_hash_key`, `cron`, transients) never purge.

### What is never cached

- Methods other than `GET` and `HEAD`.
- Requests with an `Authorization` header, a session cookie (`pressbase_*`), a post password cookie (`wp-postpass*`) or a commenter cookie (`comment_author_*`). Logged-in people always get a fresh render.
- `?preview`, `?unapproved`, `?moderation-hash`, `?replytocom`.
- Answers core marks `private` or `no-store`: logged-in renders, unlocked password-protected posts, held-comment previews.
- Statuses other than 200, 301 and 404. 301s and 404s are kept one minute; 200s an hour, then served stale for up to a day while a refresh runs.

`x-pressbase-cache` on every public response says what happened: `HIT`, `STALE`, `MISS`, `BYPASS` or `OFF`.

### Turning it on

Set the same `PRESSBASE_REVALIDATE_SECRET` (16+ random characters, e.g. `openssl rand -hex 32`) for core and `apps/web`, and set core's `WEB_URL` to where `apps/web` listens (comma-separated for several instances). Both apps read the repository's `.env` in development. Without the secret, nothing is cached. `PRESSBASE_PAGE_CACHE_MB` (default 64) bounds the cache's memory.

## Feeds

A feed is the main query of the URL it's attached to, with `posts_per_rss` items (Settings → Reading, default 10):

| URL | Feed |
|---|---|
| `/feed/`, `/feed/rss2/`, `?feed=rss2` | latest posts (RSS 2.0); `/feed/atom/`, `?feed=atom` as Atom |
| `/comments/feed/`, `?feed=comments-rss2` | latest approved comments |
| `/category/{slug}/feed/`, `/tag/{slug}/feed/`, `/author/{nicename}/feed/` | that archive's posts |
| `/{post}/feed/` | the post's approved comments |
| `/search/{term}/feed/`, `?s=…&feed=rss2` | search results |

The legacy `rss` and `rdf` names answer RSS 2.0. A feed of a URL that doesn't exist is a 404. `rss_use_excerpt` (Settings → Reading → "For each post in a feed, include") drops `content:encoded` / Atom `content`, as in WordPress. Password-protected posts give only their excerpt, and their comments a "Protected Comments" notice.

**Escaping.** Text goes through `esc_xml()` (`xmlText()`): `& < > " '` escaped, HTML named entities (`&hellip;`) converted to numeric references XML understands, and characters XML 1.0 forbids dropped. HTML content is wrapped in CDATA, with `]]>` split across two sections. Feeds are tested to stay well-formed with hostile titles and content.

Pages advertise their feeds in the head (`feed_links()` and `feed_links_extra()`): the site's posts and comments feeds, plus the post's comments feed on singular views, and the category, tag, author or search feed on archives.

Filters: `wp_title_rss`, `the_title_rss`, `the_permalink_rss`, `the_excerpt_rss`, `the_content_feed`, `comment_author_rss`, `comment_text_rss`.

## Sitemaps

WordPress core sitemaps, at the same URLs:

| URL | Contents |
|---|---|
| `/wp-sitemap.xml` | the index: one entry per provider, subtype and page |
| `/wp-sitemap-posts-post-{n}.xml`, `/wp-sitemap-posts-page-{n}.xml` | published posts and pages, with `lastmod`; the pages sitemap starts with the home page when it shows the latest posts |
| `/wp-sitemap-taxonomies-category-{n}.xml`, `-post_tag-{n}.xml` | terms with published posts |
| `/wp-sitemap-users-{n}.xml` | authors with published posts |
| `/wp-sitemap.xsl`, `/wp-sitemap-index.xsl` | XSLT stylesheets that show a sitemap as a readable page in a browser: the index names each sitemap (Posts, Pages, Categories, Tags, Authors), URL lists lead with the path and mute the site's address, in light and dark schemes and on phones |

Each sitemap holds at most 2,000 URLs (`wp_sitemaps_max_urls`). Drafts, private and password-protected posts are left out (WordPress lists protected posts; there is nothing to index behind the form). With plain permalinks, the query-string forms are used (`/?sitemap=index`, `/?sitemap=posts&sitemap-subtype=post&paged=1`). An unknown provider, subtype or page is a 404.

Sitemaps are off (404) when Settings → Reading asks search engines not to index the site (`blog_public` false), as `wp_sitemaps_enabled()` decides.

Filters: `wp_sitemaps_enabled`, `wp_sitemaps_max_urls`, `wp_sitemaps_post_types`, `wp_sitemaps_posts_query_args`, `wp_sitemaps_taxonomies`.

## robots.txt

`do_robots()`:

```
User-agent: *
Disallow: /admin/

Sitemap: https://example.com/wp-sitemap.xml
```

When the site discourages search engines, `Disallow: /` and no sitemap line; pages also carry `noindex` in the robots meta tag and `X-Robots-Tag`. The `do_robotstxt` action runs first and the `robots_txt` filter (`output, public`) last.

## Not yet

- RSS 1.0 (`rdf`) and RSS 0.92 documents (both answered with RSS 2.0), enclosures, the `rss2_item` / `rss2_head` actions.
- Custom post type and custom taxonomy providers beyond posts, pages, categories and tags (they arrive with registering custom types).
- A shared page cache across `apps/web` instances (each holds its own; core purges them all).
- Browsers are removing XSLT (Chrome already shows a deprecation banner over styled sitemaps). Crawlers read the XML either way; a script-based or HTML view will replace the stylesheets for people.
