# Pressbase SEO

Pressbase's first first-party plugin, a Yoast-class SEO plugin, bundled in [`plugins/pressbase-seo`](../../plugins/pressbase-seo). It's built only on the public plugin API (`@pressbase/plugin-sdk` and `window.pressbase`), as a third party would build it; every gap it hit was fixed in core first. The plan and the decisions are in [Plan: Pressbase SEO and the first-party plugins](../plans/first-party-plugins.md). What it does for site owners: [the plugin's README](../../plugins/pressbase-seo/README.md).

## Shape

| Path | What |
| --- | --- |
| `plugin.json` | `main: dist/index.js`, `admin.module: dist/admin/index.js`, permissions `database` (its tables), `options` (Yoast's options) and `network` (IndexNow) |
| `migrations/0001-redirects.sql` | `pressbase_seo_redirects` (unique `source`, `regex` flag, status 301/302/307/410, hits) and `pressbase_seo_404s` (unique `path`, last referrer, hits, last seen; never IPs) |
| `src/index.ts` | `register(api)`: meta, head hooks, sitemaps, crawling, redirects, breadcrumbs, settings, REST routes, Site Health, the CLI, AI abilities |
| `src/shared.ts`, `src/vars.ts` | Yoast's meta keys, option shapes and defaults; `%%variable%%` replacement and the Rank Math / AIOSEO converters. Shared with the browser |
| `src/head.ts`, `src/schema.ts` | what a page's head gets (`computeHead`), the breadcrumb trail, the JSON-LD graph (pure) |
| `src/analysis/` | the content checks, the pixel-width measure. Pure TypeScript, no DOM or Node APIs: the editor and the server run the same code |
| `src/redirects.ts`, `src/sitemaps.ts`, `src/crawl.ts` | redirects and the 404 log; sitemap filters; robots.txt, `llms.txt`, IndexNow |
| `src/importers.ts`, `src/audit.ts`, `src/health.ts`, `src/ai.ts` | Rank Math and AIOSEO imports; the server-side audit; Site Health tests; the AI abilities |
| `src/admin/*.tsx` | the browser modules: the editor tab and the list and term extensions (`index`), Settings → SEO (`settings`), Tools → SEO (`tools`) |
| `build.mjs` | esbuild: the server bundle, the three admin modules (JSX mapped to `window.pressbase.jsxRuntime`), the admin's string list, and the `.pot` with `--pot` |
| `test/` | plugin tests against a real kernel on PGlite (`@pressbase/core`'s test harness): the plugin is copied into the site's plugin folder and activated through REST |

### TypeScript with a build step

The plugin is TypeScript, compiled by esbuild (`pnpm --filter pressbase-seo build`), unlike `daily-tips`, which stays plain JavaScript as the no-build example. The reasons:

- the analysis engine is the same code in the browser and on the server and must be unit-tested; one typed source, bundled twice, is the simplest way to guarantee that;
- it's large (a dozen server modules, three admin modules) and uses most of `PluginApi`: the SDK's types catch API misuse at build time;
- it's what `create-pressbase-plugin` scaffolds, so the first-party plugin shows the path third parties take.

It's a workspace package (`plugins/*` in `pnpm-workspace.yaml`), so turbo builds it with `pnpm build`, watches it with `pnpm dev` (`node build.mjs --watch`), and typechecks and tests it after the SDK's build (`pressbase-seo#typecheck`, `pressbase-seo#test`). The Docker image builds every bundled plugin and copies `plugins/` next to core, without sources or `node_modules`. `dist/` isn't committed.

## Storage: Yoast's, so migrated sites keep their search appearance

- **Post meta:** `_yoast_wpseo_title`, `_metadesc`, `_focuskw`, `_canonical`, `_meta-robots-noindex` (`'1'` noindex, `'2'` index, `'0'` the type's default), `_meta-robots-nofollow`, `_meta-robots-adv`, `_opengraph-title`/`-description`/`-image`/`-image-id`, `_twitter-*`, `_primary_category`, `_bctitle`, `_is_cornerstone`. All registered with `api.meta.registerPostMeta('', …)`, `showInRest` and an auth callback (core has already required `edit_post`), and sanitised (flags, IDs and URLs are checked).
- **Term meta:** the keys Yoast keeps in its `wpseo_taxonomy_meta` option (`wpseo_title`, `wpseo_desc`, `wpseo_noindex` = `index`/`noindex`/`default`, `wpseo_canonical`, `wpseo_bctitle`…), which the MySQL migration moves onto each term. Registered for categories and tags.
- **Options:** `wpseo_titles` (separator, templates per post type, taxonomy and archive, noindex toggles, site representation, breadcrumb labels), `wpseo_social` (profiles, default image, card type) and `wpseo` (sitemaps, `enable_llms_txt`), registered with `api.settings.register(…, { type: 'object', option })` and a sanitiser. Pressbase's own settings (robots.txt additions, IndexNow, automatic slug redirects, first run done) are one object, `pressbase_seo_settings`, rather than invented Yoast keys.
- **Not sure / differs from Yoast:** the person `@id` is `{home}/#/schema/person/{user id}` (Yoast hashes the login); `noindex-attachment` defaults to on; Yoast's attachment-page redirect isn't implemented; post types with `noindex-{type}` leave the sitemap entirely.

## Public output

| Need | Plugin API |
| --- | --- |
| The title | `pre_get_document_title` (with the main query: a core addition) |
| Robots | `wp_robots` merged: Yoast's `index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1`, or `noindex`; core's own `noindex, nofollow` wins while the site discourages search engines |
| Description, canonical, Open Graph, X, JSON-LD | one `wp_head` callback at priority 1, after core's robots and title; core's `rel_canonical` removed by name (`api.hooks.removeAction('wp_head', 'rel_canonical')`), restored on deactivation |
| URLs | `api.content.canonicalUrl`, `permalink`, `termLink`, `author`, `attachmentImage` |
| Caching | `api.cache.addTags('pressbase-seo:settings')` on every head, sitemap, robots.txt and `llms.txt` render; `updated_option` for Yoast's options purges that tag |

One `computeHead(context)` per render is memoised on the main query, so the robots filter, the title and the head block share it. The same function answers the REST field `pressbase_seo_head` (`rest_prepare_post`, `rest_prepare_page`, and the new `rest_prepare_{taxonomy}`), in the `view` context only: `{ title, description, canonical, robots, og_*, og_image, twitter, breadcrumbs, schema, html }`, shaped like Yoast's `yoast_head_json`.

The schema graph follows Yoast's: `Article` (posts), `WebPage`/`CollectionPage`/`ProfilePage`/`SearchResultsPage`, `ImageObject`, `BreadcrumbList`, `WebSite` with a `SearchAction`, and `Organization` or `Person`, linked by `@id`. Filters: `pressbase_seo_schema_graph (graph, context)` and `pressbase_seo_head (head, context)`.

## Sitemaps

Core's `wp-sitemap.xml` through its filters, several of which were added to core for this: `wp_sitemaps_enabled` (the toggle), `wp_sitemaps_post_types` and `wp_sitemaps_taxonomies` (noindexed types), `wp_sitemaps_add_provider` (authors, when author archives are noindexed), `wp_sitemaps_posts_query_args` and `wp_sitemaps_taxonomies_query_args` (noindexed posts and terms, read with one query each on `postmeta`/`termmeta`), and `wp_sitemaps_taxonomies_entry` (`lastmod`: the term's newest published post).

## Redirects and the 404 log

- `template_redirect` matches the path against an in-memory lookup (a Map of exact sources, a list of regex rules), loaded once and dropped on any change. `request.redirect(location, status)` or `request.notFound(410)`; hits are counted on uncached requests.
- Rule changes purge the source path (`api.cache.purgePaths`), or `site` for regex rules and big CSV imports ([ADR 0017](../adr/0017-early-request-hooks-and-the-page-cache.md)).
- `pressbase_404` upserts the path with the last referrer (probes for `.php` and the like are skipped). A daily `api.cron` event deletes entries older than 90 days and keeps at most 5,000 rows.
- `post_updated`: when a published post's slug changes, a 301 from the old path is created (and a rule from the new path, which would loop, removed). Settings → SEO can turn this off.

## Crawling

- `robots_txt`: the additions from Settings → SEO, after core's rules, only while the site is public.
- `api.public.addFile('/llms.txt')`: off (`null`, a 404) until `wpseo.enable_llms_txt`; the site's name and tagline, then pages and the latest posts as Markdown links.
- IndexNow: a key in `pressbase_seo_indexnow_key`, served at `/{key}.txt` (`cache: false`). `transition_post_status` (publish, update, unpublish, trash) and `before_delete_post` queue an `indexnow` job (`api.jobs`, singleton per URL) that posts to `api.indexnow.org`. On by default only while `blog_public` is on; local and test hosts never ping.

## Admin

| Place | Slot or API |
| --- | --- |
| Editor tab "SEO": search preview (desktop/mobile, pixel widths), social preview (Facebook/X, image from `MediaPicker`, fallbacks named), keyphrase and checks, advanced fields | `PluginSidebar`, `PluginSidebarMoreMenuItem`, `editor.usePost` and `editPost({ meta })` |
| "SEO" in Ready to publish? (never blocks) | `PluginPrePublishPanel` |
| SEO column and "Missing description" filter | `PostsListColumn`, `PostsListFilter`, and `rest_post_query`/`rest_page_query` on the server |
| Category and tag fields | `TermEditFields` (`editMeta`) |
| Settings → SEO, with the first-run questions | `api.admin.addPage({ parent: 'settings', entry })`, saving through `/pressbase/v1/plugin-pages/…` (the Settings API's validation and sanitisers) |
| Tools → SEO | `api.admin.addPage({ parent: 'tools', entry })` and the plugin's REST routes |

The admin modules' strings are wrapped in `__()`. The build lists them in `dist/admin-strings.json`; `GET /pressbase-seo/v1/l10n` returns their translations through `api.i18n` (text domain `pressbase-seo`, `languages/`), since the browser has no translation files. `languages/pressbase-seo.pot` comes from `node build.mjs --pot`.

## The content analysis

Ten checks, in `src/analysis/`: keyphrase in the SEO title, the introduction and the slug; the description's length (with the pixel width) and keyphrase; no second H1; no skipped heading levels; alt text on images; at least one internal link; the title not used by another published post (the server answers that one: `GET /pressbase-seo/v1/duplicates`). Each result has a status (`good`, `improve`, `na`), a message about this post, and why it matters. There's no score: the summary is "2 suggestions". English only; the matching handles case, accents, word order, stopwords and simple plurals. Search titles and descriptions are measured in pixels with an Arial width table (Google's 600 px title, 920 px desktop and 680 px mobile description: approximations).

## AI

On core's AI client ([AI](ai.md), [ADR 0019](../adr/0019-ai-client-and-abilities.md)). Three abilities in the `pressbase-seo` category, all with input and output schemas, permission callbacks (`edit_post` for the post, or `edit_posts`; `upload_files` too for alt text) and `showInRest`:

- `pressbase-seo/suggest-meta` `{ field: title | description | social-title | social-description, postId?, title?, excerpt?, content?, keyphrase? }` → `{ options, provider, model }`;
- `pressbase-seo/suggest-alt-text` `{ attachmentId? | filename?, caption?, postTitle?, context? }` → the same; the model sees text only, which the panel says;
- `pressbase-seo/audit-post` `{ postId, explain? }` → the checks and a summary, plus a short model-written `advice` with `explain`.

They send only the title, the excerpt and the first 1,500 characters of the content as plain text (nothing of a password-protected post), ask for JSON, and strip, unquote, de-duplicate and length-check what comes back. AI errors keep their codes (`prompt_prevented` 503, `ai_daily_limit_reached` 429…). The editor shows **Suggest** buttons (title, description, social title and description, and alt text for images without any) only when `GET /pressbase-seo/v1/ai` says `api.ai.supportsAi()`; it runs them through `/wp-abilities/v1/…/run`, lists the options with "Use this", never applies one by itself, and names the provider and model.

## Core additions made for it

Each in its own commit with tests and docs:

- `wp_robots`, `pre_get_document_title`, `document_title_separator`, `document_title_parts` and `document_title` receive the main query.
- Sitemaps: `wp_sitemaps_add_provider`, `wp_sitemaps_taxonomies_query_args`, and the entry filters `wp_sitemaps_posts_entry`, `wp_sitemaps_taxonomies_entry`, `wp_sitemaps_users_entry` (with `changefreq` and `priority` printed).
- `rest_prepare_{taxonomy}` on terms.
- `api.content.termLink()`, `author()`, `attachmentImage()` and `mainQuery()`.
- `window.pressbase.components.MediaPicker`.

## Tests

`plugins/pressbase-seo/test/` (run `pnpm --filter pressbase-seo test`, which builds first): head output and the graph, title variables, robots and canonicals, REST meta auth and sanitising, the REST head field, sitemaps exclusions, robots.txt and `llms.txt`, IndexNow, redirects (statuses, regex, 410, purges, CSV, slug changes), the 404 log and its cap, imports, the CLI audit, Site Health, the AI abilities on a mocked provider, the breadcrumbs block, and a migration of the WordPress + Yoast fixture whose `<head>` is checked. `src/analysis/analysis.test.ts` covers the checks. End to end: `e2e/tests/plugin-seo.spec.ts`.
