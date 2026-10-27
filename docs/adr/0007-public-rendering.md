# 0007: Core renders the public site; apps/web serves it

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

v0.4 brings the public site: block themes such as Twenty Twenty-Five, rendered from `theme.json`, HTML templates and patterns. Rendering needs everything core owns: the main query, the block engine, every plugin's server-rendered blocks and render filters, the active theme and its styles. [ADR 0003](0003-core-separate-from-next.md) put all of that in `apps/core` so plugins and themes can be installed at runtime, without rebuilding a Next.js app, and planned an `apps/web` for the public site.

Two shapes were possible:

1. **Core renders HTML.** Core turns a URL into a complete document. A thin public app forwards requests to it.
2. **Next.js renders.** `apps/web` fetches data (posts, the template, styles) and builds the page with React.

## Decision

**Core renders the whole page; `apps/web` is a thin, cacheable front door.**

- Core exposes `GET /wp-json/pressbase/v1/render?url=/path/?query` and answers `{ status, headers, html }`: the HTTP status the page should have (200, 404, 301 with `location`, 304), the headers (`content-type`, `cache-control`, `etag`, `x-robots-tag`) and the document. The renderer (`apps/core/src/frontend/`) is WordPress's `wp()` + `template-loader.php` + `template-canvas.php`: parse the request, run the main query, walk the template hierarchy, render the template's blocks, assemble the head with the global styles.
- Theme files (`/wp-content/themes/*`), WordPress's block CSS (`/wp-includes/*`) and the post-password form (`/wp-login.php?action=postpass`) are served by core outside `/wp-json`, at WordPress's URLs.
- `apps/web` (Next.js, port 3001) has one route handler for every path. It forwards the path, the visitor's cookie and `If-None-Match` to the render endpoint and returns the HTML with core's status and allowed headers. `/wp-json`, `/wp-content` and `/wp-includes` are rewritten to core.
- The admin app (port 3000) rewrites any path it doesn't own to `apps/web`. The address entered at install (`home`) therefore serves both the site and `/admin`, as one WordPress origin serves both the site and `/wp-admin`.

A JSON envelope rather than core answering `/` directly keeps core's public surface the REST API, lets the web tier own redirects, caching and error pages, and lets a deployment put a CDN or Next.js cache in front without core knowing.

## Consequences

- Themes and plugins work without a rebuild: rendering happens in core, which loads them at runtime. A theme is a folder; activating it changes two options.
- WordPress block themes render with WordPress's markup and class names, so their CSS and the block library's CSS apply unchanged. There is no React on the public page and no hydration cost.
- Each page costs one HTTP hop from `apps/web` to core. Pages carry a strong validator (`ETag`) and `Cache-Control: public, max-age=0, must-revalidate` (`private` for logged-in visitors), so a CDN can serve repeat views with a cheap 304 round trip.
- `apps/web` is dynamic (`force-dynamic`) today. Time-based ISR or tag revalidation on `save_post` / `switch_theme` can come later without changing core.
- A Next.js developer can't write the public site in React. Headless sites still can: the REST API is complete, and nothing stops a separate Next.js app from consuming it.

## Alternatives considered

- **React rendering in `apps/web`:** block themes are HTML templates, and dynamic blocks are PHP-shaped server callbacks; re-implementing them in React would split the block engine in two and break plugin blocks, which only core can load.
- **Core serves HTML on its own port with no `apps/web`:** simplest, but core would have to own public concerns (static asset caching, error pages, a public port next to the admin API). It stays possible: the render endpoint is all a proxy needs.
- **Next.js middleware calling core:** same result as the route handler, but harder to test and to give a friendly error page when core is down.
