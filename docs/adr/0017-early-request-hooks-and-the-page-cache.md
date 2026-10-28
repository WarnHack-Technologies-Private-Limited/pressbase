# 0017: Early request hooks run inside the cached render; redirects win by purging the path

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

v0.7 gives plugins WordPress's early request hooks ([plan](../plans/first-party-plugins.md), gap 5): `template_redirect`, so a plugin (Pressbase SEO's redirect manager) can answer a URL with a redirect before the page renders, `pre_handle_404`, and an action when a 404 is served, so a plugin can keep a 404 log with the path and referrer. Gap 9 adds plugin files at fixed root paths (`/llms.txt`, `/{indexnow-key}.txt`).

All of these meet the public page cache ([ADR 0008](0008-public-page-caching.md)). `apps/web` answers anonymous requests from its own cache and only asks core when it misses, so:

- a redirect added for `/old-post/` must win over the page `apps/web` already cached at that address, which may be a live post's page (200, cached for an hour, then served stale for a day);
- a 404 served from the cache never reaches core, so a 404 log would miss repeat hits;
- a plugin file must not keep showing stale content, nor answer after its plugin is deactivated.

In WordPress there is no shared page cache in core; `template_redirect` runs on every request, and caching plugins usually skip 404s (`handle_404()` sends `nocache_headers()`).

## Decision

**The early hooks run inside core's render, the same render the page cache stores. A plugin makes its change visible by purging what it affects, and every render carries a `path:{path}` tag so a change tied to an address can be purged precisely.**

- **`template_redirect`** fires once per render in `frontend/render.ts`, before robots.txt, sitemaps, feeds, plugin files and theme pages (as `template-loader.php` fires it before `do_robots()` and `do_feed()`). A callback answers with `request.redirect(location, status)` or `request.notFound(404 | 410)`; the first answer wins (WordPress's `exit`). The main query is lazy (`request.main()`) and shared with the render, so path-only redirects cost nothing extra.
- **Every answer carries `path:{path}`** (`CacheTag.path()`, normalised: no trailing slash, no query string; hashed beyond 200 characters). `api.cache.purgePaths(['/old-post/'])` drops every cached answer for that path, whatever the query string. A redirect plugin purges the source path when it adds, edits or removes a rule; the next request reaches core, `template_redirect` answers 301, and `apps/web` keeps that 301 for its usual minute. Regex rules, which can match anything, purge `site`.
- **404s with a listener aren't cached.** While anything is hooked to `pressbase_404`, 404 answers carry `Cache-Control: no-store`, so every hit reaches core and the action. Without a listener, 404s stay cached for a minute as before. `apps/web` forwards the `Referer` header to core (for uncached and cache-filling requests alike).
- **`pre_handle_404`** is applied where the main query decides a URL matched nothing (`resolveMainQuery()`), as `WP::handle_404()` does; returning anything but `false` renders the page with status 200.
- **Plugin files** are answered by the same render, after core's own files and before theme pages, so they are cached and tagged like any page: what the handler reads is recorded by the content services, plus `site` and the path tag. Activating or deactivating a plugin already purges `site`. A file whose content can't be tied to purges is registered with `cache: false` (`private, no-store`).
- **Decide from the URL and the site's data, never from the visitor.** A render is shared by every anonymous visitor; a hook that redirects by cookie, user agent or referrer would serve its decision to everyone. This is the rule head output already follows (ADR 0008).

## Consequences

- No extra request per page view: cached pages are still answered by `apps/web` alone, and the early hooks cost nothing on a hit.
- A redirect takes effect as soon as the plugin purges, on every `apps/web` instance core notifies. A plugin that forgets to purge is bounded by the cache's lifetimes (a minute for 301s and 404s, an hour plus stale time for pages), which is why `api.cache.purgePaths()` is the documented step.
- Every cached entry carries one more tag. The tag index grows by one entry per path.
- A site with a 404 logger renders every 404, as WordPress does. Bots probing for missing files cost a render each; a 404 log plugin should keep its write cheap (or queue it) and cap its table.
- Concurrent cache misses for one URL share a render, so the 404 action sees one of their referrers.

## Alternatives considered

- **Check redirects in `apps/web` before the cache** (a lookup in core per request, or a redirect table synchronised to `apps/web`). Correct without purges, but either costs a round trip on every cached hit or moves business logic and a second data store into `apps/web`, which ADR 0007 keeps logic-free.
- **Purge `site` on every redirect change.** Simple and correct, but one redirect edit would empty the whole cache; redirect imports of thousands of rules would do it thousands of times (batching softens this, but a path purge is exact).
- **Never cache 404s.** Simplest for 404 logs, but it would remove the cache's protection against bots for sites that don't log 404s. Tying it to a listener keeps both.
- **Report cached 404 hits from `apps/web` to core asynchronously.** Keeps 404s cached while logging them, but needs a new endpoint, a queue in `apps/web`, and authentication for something a plugin can opt out of; not worth it yet.
