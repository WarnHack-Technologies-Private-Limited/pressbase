# 0008: An in-process, tag-indexed page cache in apps/web, purged by core

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

[ADR 0007](0007-public-rendering.md) made core render every public page and `apps/web` forward each request to it. Every view therefore costs a full render: the main query, every block, the global styles. Most visitors are anonymous and see the same bytes, so the public site should answer them from a cache and only render again when something they would see has changed.

Two things make this harder than "cache for N minutes":

- **Freshness.** Editors expect a published change to show at once. A time-based cache either serves stale pages or expires so quickly that it barely helps.
- **Personal pages.** Logged-in people see previews, private posts and their own drafts; a visitor who unlocked a password-protected post sees its content; a commenter sees their held comment (`?unapproved=`). None of these may be shared.

WordPress leaves this to caching plugins (WP Super Cache, W3 Total Cache, Batcache), which skip requests with login or post-password cookies and purge on `clean_post_cache`, `clean_term_cache`, `switch_theme` and option changes.

We looked at Next.js 16's own caching first. `apps/web` has a single catch-all **route handler** that proxies core's answer (HTML, RSS, Atom, XML sitemaps, robots.txt) with core's status code and headers. Next's data cache (`fetch(..., { next: { tags } })` with `revalidateTag()`) would cache core's JSON, but:

- the tags are only known **after** the render (core reports what the page read), whereas `fetch` tags must be given before the request;
- it would cache the `fetch` per URL regardless of the visitor, so the bypass rules would still have to live outside it;
- statuses (301, 404), stale-while-revalidate behaviour and conditional requests (304) would still need code of our own;
- `"use cache"` / Cache Components target React Server Components, not a proxy route returning arbitrary content types.

## Decision

**`apps/web` keeps its own in-process LRU page cache, indexed by cache tags that core attaches to each render, and core purges it through an authenticated internal endpoint.**

- **Tags from core.** While core renders a URL (a page, a feed, a sitemap or robots.txt), the content services record what was read in an `AsyncLocalStorage` scope (`apps/core/src/cache/tags.ts`): `post:{id}` for each post shown, `posts:{type}` for each listing, `term:{id}`, `terms:{taxonomy}`, `author:{id}`, `comments`, `home`, `search`, `404`, and `site` on everything. The render endpoint returns them as `tags`.
- **Purges from core.** `apps/core/src/cache/invalidation.ts` listens to the actions core already fires (WordPress's names: `transition_post_status`, `save_post`, `post_updated`, `set_object_terms`, `deleted_post`, `created_term` / `edited_term` / `delete_term`, `wp_insert_comment`, `edit_comment`, `transition_comment_status`, `profile_update`, `deleted_user`, `updated_option` / `deleted_option`, `switch_theme`, `edit_attachment`) and announces the stale tags with one action, `pressbase_cache_purge (tags, reason)`. Editing a published post in place purges only `post:{id}`; publishing, unpublishing or moving a post (date, slug, author, terms, password…) also purges its listings; options (including `pressbase_navigation_fallback`, which picks the header menu), the theme, menus, templates and other non-public post types purge `site`.
- **Delivery.** `apps/core/src/cache/notifier.ts` batches purges for 25 ms (one save fires several actions) and POSTs `{ "tags": [...] }` to `{WEB_URL}/_pressbase/revalidate` with `Authorization: Bearer <PRESSBASE_REVALIDATE_SECRET>`, once per URL in `WEB_URL` (comma-separated for several instances), retrying once. The endpoint compares the secret in constant time (both sides SHA-256-hashed, then `timingSafeEqual`).
- **The cache** (`apps/web/src/lib/page-cache.ts`): a size-bounded LRU (`PRESSBASE_PAGE_CACHE_MB`, 64 MB by default) keyed by path + query string. 200s are fresh for an hour and may be served stale for a day while a background refresh runs (stale-while-revalidate); 301s and 404s for one minute. The TTL is a backstop: purges are the main mechanism. Concurrent misses share one render. A render that started before a purge isn't stored (a generation counter), so a purge can't be undone by a slow render.
- **Never cached** (`apps/web/src/lib/cache-policy.ts`): methods other than GET/HEAD; requests with an `Authorization` header; requests with a session or personal cookie (`pressbase_*`, `wp-postpass*`, `comment_author_*`, `wordpress_logged_in_*`); `?preview`, `?unapproved`, `?moderation-hash`, `?replytocom`; any answer core marks `private` or `no-store` (logged-in renders, unlocked protected posts, held-comment previews); any status other than 200, 301 and 404. Cached renders are always made anonymously: `apps/web` sends core no cookie.
- **HTTP caching downstream** stays as ADR 0007 set it: `Cache-Control: public, max-age=0, must-revalidate` with an `ETag`, `private, no-cache` for personal pages. Browsers and any CDN revalidate every time and get a cheap `304` from `apps/web`'s cache, so nothing downstream can keep showing a page after an edit. The `x-pressbase-cache` header (`HIT`, `STALE`, `MISS`, `BYPASS`, `OFF`) says what happened.
- **Off by default.** Without `PRESSBASE_REVALIDATE_SECRET` (at least 16 characters) in both core's and `apps/web`'s environment, `apps/web` doesn't cache and core sends no purges: a cache nobody can purge would serve stale pages.

## Consequences

- Repeat anonymous views cost a map lookup; edits show on the next request. Logged-in people always get a fresh render.
- Precision depends on the services recording tags. A new block that reads content must go through `kernel.posts`, `queryPosts`, `kernel.terms` or `kernel.comments` (they record tags), or call `addCacheTags()` itself; anything missed is still covered by `site` purges and the TTL.
- The cache is per process. Several `apps/web` instances each hold a copy; list them all in core's `WEB_URL`. A shared store (Redis) can implement the same `PageCache` interface later.
- Purges are best effort. A purge lost while `apps/web` is down is bounded by the TTL; a restarted `apps/web` starts empty anyway. Core purges `site` when it starts, since a restart may bring new code, themes or plugins.
- Scheduled posts must go live without a page view to trigger `publishDue()`, so core now publishes due posts once a minute (what wp-cron's `publish_future_post` does).
- Integrations (a CDN purge, a static export) can listen to `pressbase_cache_purge` in core.

## Alternatives considered

- **Next.js data cache with `revalidateTag()`:** see Context. It would still need our own bypass, status and conditional-request logic, and tags would have to be guessed before the render.
- **Time-based caching only (`s-maxage`):** simple, but edits would take minutes to show, which editors read as "publishing is broken".
- **Caching in core:** core would cache HTML next to the database. It would duplicate the work of the public tier ADR 0007 gave caching to, and core would still need the same tags and purges.
- **CDN-only caching with purge APIs:** depends on a specific vendor; remains possible through `pressbase_cache_purge`.
