# Plan: Pressbase SEO and the first-party plugins

Status: **accepted** 2026-10-28, with the decisions [below](#decisions). Written after v0.6.

## Summary

- **Build first-party plugins next (proposed v0.7), starting with Pressbase SEO,** a Yoast-class SEO plugin. SEO is the one plugin almost every WordPress site installs. Yoast SEO alone has 10+ million active installs, and Rank Math another 4+ million.
- **Ship them as plugins, not core.** Each one goes in `plugins/`, built with the public plugin SDK, exactly as a third party would. Every gap they hit in the plugin API gets fixed in core. That's the fastest way to a plugin API worth freezing at 1.0.
- **Store SEO data in Yoast's own meta keys and title-variable syntax.** WordPress sites arriving through the importer or the MySQL migration already carry that meta, so a migrated site keeps its titles, descriptions, canonicals and noindex settings with no conversion step. The trade-off is in [Decisions to make](#decisions-to-make).
- **Plugin order after SEO:** Forms, Anti-spam, Analytics, Backups, Security, and Email log. Each is matched to a top WordPress plugin and to what Pressbase already does in core (below).

## What WordPress sites install

The first page of WordPress.org's [popular plugins](https://wordpress.org/plugins/browse/popular/), October 2026, and what each means for Pressbase:

| WordPress plugin | Active installs | What it does | Pressbase |
| --- | --- | --- | --- |
| Elementor | 10M+ | Page builder | Not planned. Pressbase bets on the block editor; the site editor is the answer. |
| **Yoast SEO** | 10M+ | SEO | **Pressbase SEO, first.** |
| Contact Form 7 / WPForms | 10M+ / 5M+ | Forms | **Pressbase Forms**, second. |
| Classic Editor | 8M+ | The old editor | Not needed. |
| LiteSpeed Cache | 7M+ | Page cache, optimisation | Mostly core already: the tagged page cache. Image formats (WebP/AVIF) and lazy loading belong in core media. |
| WooCommerce | 7M+ | Shop | Later, and big: it needs a stable plugin API first. Out of scope for this plan. |
| Site Kit by Google | 5M+ | Analytics, Search Console | **Pressbase Analytics** (privacy-first stats, plus Search Console data in SEO). |
| Akismet | 5M+ | Spam filtering | **Pressbase Anti-spam**, for comments and forms. |
| All-in-One WP Migration / UpdraftPlus | 5M+ / 4M+ | Backups, migration | Migration is core (v0.6). **Pressbase Backups** adds scheduled backups. |
| Wordfence / Really Simple Security | 5M+ / 3M+ | Firewall, 2FA, hardening | Login throttling and HTTPS checks are core. **Pressbase Security** adds 2FA, passkeys and an activity log. |
| WP Mail SMTP | 4M+ | Email delivery | SMTP is core (environment). **Email log** is a small plugin, or a core screen. |
| Rank Math SEO | 4M+ | SEO | Covered by Pressbase SEO; its meta gets imported. |
| Duplicate Post / Duplicate Page | 3M+ each | Copy a post | Core: one "Duplicate" row action. Too small and too common for a plugin. |
| WPCode | 3M+ | Header and footer snippets | A careful plugin later: admin-only scripts in `wp_head`, with no PHP-style code execution. |
| Redirection (beyond page one) | 2M+ | Redirects, 404 log | Part of Pressbase SEO. |

Install counts come from WordPress.org's popular list; trade press reports Yoast between 10M and 13M ([Hostinger, 2026](https://www.hostinger.com/tutorials/wordpress-statistics)).

## Principles for first-party plugins

1. **Built only on the public API.** No imports from core's internals. When a plugin needs something, add it to `PluginApi` or the admin slots, document it, and type it in the SDK.
2. **No nags, no upsells, no dashboard ads.** The most common complaint about WordPress SEO plugins is admin clutter. Ours stay inside their own screens and panels.
3. **WordPress-compatible data.** Same option and meta names where WordPress plugins have a de facto standard, so content moves in and out.
4. **Calm and honest guidance.** Suggestions with reasons, not traffic lights to chase. Say what a check can't know (search intent, quality).
5. **Fast public pages.** No client-side scripts on the public site unless a feature needs one (forms). Output is cached, and purged on change.
6. **Headless-ready.** Everything a page's `<head>` gets is also in the REST API, as Yoast's `yoast_head_json` does.
7. **Same bar as core:** accessible (WCAG 2.2 AA), translatable (`api.i18n`), tested (unit and e2e), and documented. GPL-2.0-or-later.

## Pressbase SEO

### Goals

- A site moved from WordPress with Yoast or Rank Math keeps its search appearance on day one.
- An editor writing a post sees, in one panel, how it will look in search and when shared, and gets a short, honest list of improvements.
- Technical SEO is right by default: titles, canonicals, robots, sitemaps, structured data, Open Graph and X cards, and redirects. A site owner shouldn't have to configure anything to be correct.

### What Yoast and Rank Math offer (October 2026)

From [Yoast's feature list](https://yoast.com/features/) and comparisons ([Nexter](https://nexterwp.com/blog/rank-math-vs-yoast/), [Capterra](https://www.capterra.com/compare/219202-242098/Yoast-SEO-vs-Rank-Math)):

| Area | Yoast | Rank Math | Pressbase SEO |
| --- | --- | --- | --- |
| Titles and meta, with variables | Free | Free | **v1** |
| Search preview (desktop and mobile) | Free | Free | **v1** |
| Social previews (Facebook, X) | Premium | Free | **v1** |
| Canonical and robots meta | Free | Free | **v1** |
| Schema graph (Organization/Person, WebSite, WebPage, Article, BreadcrumbList) | Free | Free (24 types) | **v1** graph; more types in v2 |
| XML sitemaps | Free | Free | **v1**: extends core's `wp-sitemap.xml` |
| Breadcrumbs | Free | Free | **v1**: a block and a function |
| FAQ / How-to blocks | Free | Free | **v2** (FAQ first) |
| SEO and readability analysis | Free (one keyphrase) | Free (unlimited) | **v1**: one focus keyphrase, a small set of checks |
| Redirect manager and 404 log | Premium | Free | **v1** |
| Internal linking suggestions | Premium | Pro | **v2** (uses core search) |
| `robots.txt` editor | Free | Free | **v1**: extends core's `robots_txt` |
| `llms.txt` | Free (2025) | Free | **v1**: cheap, opt-in |
| IndexNow | Yes (late adopter) | Free | **v1**: pings on publish and update |
| Search Console data | Integration | Free | **v3**, with Analytics |
| AI generation of titles, descriptions, social text and alt text | Premium / AI+ | Pro | **v1**, opt-in, on the core AI client ([below](#ai)) |
| Local, News, Video SEO | Premium add-ons | Pro | Not planned |

### Data model: compatible by design

- **Post meta,** using Yoast's keys:
  - `_yoast_wpseo_title`, `_yoast_wpseo_metadesc`, `_yoast_wpseo_focuskw`
  - `_yoast_wpseo_canonical`, `_yoast_wpseo_meta-robots-noindex`, `_yoast_wpseo_meta-robots-nofollow`
  - `_yoast_wpseo_opengraph-title`, `-description`, `-image`, `_yoast_wpseo_twitter-title`, `-description`, `-image`
  - `_yoast_wpseo_primary_category`, `_yoast_wpseo_bctitle`, `_yoast_wpseo_is_cornerstone`
  - All registered with `show_in_rest` and an auth callback, so the editor reads and writes them through `/wp/v2`.
- **Term meta:** the same fields for categories and tags. The MySQL migration already attaches Yoast's `wpseo_taxonomy_meta` to terms.
- **Settings,** in Yoast-shaped options: `wpseo_titles` (title and description templates per post type and taxonomy, the separator, archive settings), `wpseo_social` (default image, profiles) and `wpseo` (feature toggles), registered through the plugin Settings API.
- **Title variables:** Yoast's `%%title%%`, `%%sep%%`, `%%sitename%%`, `%%excerpt%%`, `%%category%%`, `%%page%%` and the rest of the common set.
- **Importing from other plugins:** Rank Math (`rank_math_title`, `%title%`) and All in One SEO meta are read by a one-time import (Tools → SEO → Import) that converts the keys and the variable syntax.
- **Redirects:** a plugin table (`pressbase_seo_redirects`: source, target, type 301/302/307/410, regex flag, hits, last hit) and a capped 404 log. These are the plugin's first database migration, so they also test plugin migrations at scale.

### Public output

- **One `wp_head` block,** in the order Yoast uses:
  - title (through core's `document_title_parts`, `pre_get_document_title` and `document_title_separator`);
  - meta description, canonical, and robots (merged into core's `wp_robots`);
  - Open Graph and X tags;
  - one JSON-LD `@graph`.
- **The schema graph** has stable `@id`s (`{home}/#organization`, `{url}#webpage`, `{url}#breadcrumb`) and is extensible by a `pressbase_seo_schema_graph` filter. It's validated in tests against schema.org shapes and Google's required properties.
- **Sitemaps** extend core's `wp-sitemap.xml` through the existing `wp_sitemaps_*` filters: noindexed posts are excluded, `lastmod` is added, and image entries are added. There's no second sitemap system.
- **Redirects** are checked before routing, with a cached lookup. On a 404, the log records the path, referrer and count; IP addresses are never stored.
- **IndexNow:** on publish, update or delete, a queued job sends the URL list. The key file is served at `/{key}.txt`.
- **REST:** posts and terms get a `pressbase_seo_head` field (structured, plus rendered HTML) for headless sites.

### Editor and admin UX

- **Editor: one "SEO" panel** in the post sidebar, with four parts:
  1. **Search preview:** desktop and mobile toggle, the real rendered title and description, and a pixel-width measure (not a character count). Click a line to edit it, with variable chips.
  2. **Social preview:** Facebook and X cards, the image picker from the media library, and fallbacks shown ("Using the featured image").
  3. **Focus keyphrase and checks:** about 8 checks that still matter:
     - keyphrase in the title, the introduction and the slug;
     - the description's length and that it contains the keyphrase;
     - one H1, a reasonable heading structure, and alt text on images;
     - at least one internal link;
     - the title isn't already used by another post.

     Each check says why it matters and links to the part of the post to fix. There's no keyword density and no score to chase; at most a summary such as "2 suggestions".
  4. **Advanced:** canonical, noindex/nofollow, breadcrumb title, primary category, cornerstone.
- **Pre-publish:** an optional "SEO" item in the publish checklist, which never blocks publishing.
- **Posts list:** an SEO column (noindex badge, description set or missing) and a filter for "missing description".
- **Settings → SEO** (plugin Settings API pages):
  - **Site representation:** organisation or person, name, logo, and social profiles. These feed the schema graph.
  - **Search appearance:** templates per post type, taxonomy and archive, with a live preview, plus a toggle to noindex attachments, author archives and date archives.
  - **Social:** the default share image.
  - **Crawling:** sitemaps, the `robots.txt` editor, `llms.txt`, and IndexNow.
- **Tools → SEO:** redirects (list, add, CSV import and export) and the 404 log ("Create redirect" from a 404 row), plus the import from Rank Math and AIOSEO.
- **First run:** a three-question setup (organisation or person, name and logo, "Is the site ready to be indexed?"), shown once on the plugin's settings page. Never on the Dashboard.
- **Site Health:** checks for "search engines discouraged", "no site representation" and "sitemap reachable", through `site_status_tests`.

### Content analysis engine

- **Write our own, small and in TypeScript.** Yoast's analysis library (`yoastseo` on npm) is GPL-3.0, which would force the plugin to GPL-3.0 and pulls in a large dependency for checks we mostly don't want.
- **Same code in the browser and on the server:** live in the editor, and in a `pressbase seo audit` CLI command and a site-wide report.
- **Readability:** sentence length and passive voice for English first, with a pluggable per-language module. It's labelled as English-only until other languages exist.

### AI

WordPress 7.0 added an AI client (`wp_ai_client_prompt()`, with providers registered by plugins) and the Abilities API (`wp_register_ability()`). Pressbase ports both into core (gap 10), and Pressbase SEO is their first user.

- **Off until someone turns it on.** It's enabled per site, in **Settings → AI**, by someone with `manage_options`.
  - Provider keys live there, are never sent to the browser, and are shown masked.
  - `wp_supports_ai` can turn AI off per site or per request.
- **Suggestions, never silent edits.** In the SEO panel, a **Suggest** button next to the title, description, social text and image alt text returns two or three options. The editor picks one or none.
  - It sends the post's title, excerpt and the start of its content, and nothing private.
  - The panel says which provider is used.
- **Abilities:** SEO registers `pressbase-seo/suggest-meta`, `pressbase-seo/suggest-alt-text` and `pressbase-seo/audit-post` with input and output schemas. They're usable from the CLI and, later, by AI agents (MCP), with the same permission checks.
- **Providers:** Anthropic (Claude) first, then OpenAI and Google, each as a small provider module. The model is a setting, not hard-coded.
- **Costs and safety:**
  - every request is logged without its content (who, which ability, tokens);
  - a per-day request cap;
  - timeouts;
  - output is stripped of HTML and length-checked before it's shown.

### Out of scope for v1

- Search Console.
- Local, News and Video SEO.
- Multilingual hreflang: it waits for a multilingual story in core.
- WooCommerce product schema: it waits for commerce.

## Platform work first: plugin API gaps

Found by going through the SEO plugin feature by feature against `PluginApi` and the admin slots. These are core changes, with docs and SDK types, done before or alongside the plugin. Each one also serves the other plugins.

| # | Gap | Needed for | Size |
| --- | --- | --- | --- |
| 1 | **Register meta** with `show_in_rest`, a schema and an auth callback (`register_post_meta`, `register_term_meta`) | SEO fields, Forms settings | S |
| 2 | **Live editor data in UI modules:** `select('core/editor')`-style reads of the current title, content, slug, excerpt and featured image, and edits (`editPost`) through `window.pressbase` | The search preview and checks | M |
| 3 | **More admin slots:** a plugin sidebar in the editor (`PluginSidebar`), pre-publish panel items, posts-list columns and filters, term edit fields, user profile fields, row actions | The SEO panel, columns and term fields | M |
| 4 | **Plugin blocks:** `api.blocks.register()` with server render plus an editor module, loaded at runtime with no rebuild | Breadcrumbs, FAQ, and the Forms block | L |
| 5 | **Early request hooks:** `template_redirect`, `pre_handle_404` and a 404 action, run before the page cache. Make sure redirects bypass or purge cached pages. | Redirects, the 404 log | M |
| 6 | **Head and canonical filters:** `get_canonical_url` / `wp_get_canonical_url`, plus a way to remove core's own canonical and description output when a plugin takes over | SEO output | S |
| 7 | **Cache purges from plugins:** `api.cache.purge(tags)` so settings changes refresh affected pages | Every plugin with public output | S |
| 8 | **Plugin tables at scale:** migrations with indexes, and documented patterns for large tables | Redirects, form entries, logs | S |
| 9 | **Public routes from plugins:** a plugin-served file at a site-root path (`/{key}.txt`, `/llms.txt`) | IndexNow, llms.txt | S |
| 10 | **AI client and Abilities API,** ported from WordPress 7.x (`wp_ai_client_prompt()`, `wp_register_ability()`): a provider registry, Settings → AI for keys, `api.ai` and `api.abilities` for plugins, plus `/wp-abilities/v1` REST | SEO's AI suggestions, later agents | M |

## Other first-party plugins

| Plugin | v1 scope | Depends on | Size |
| --- | --- | --- | --- |
| **Pressbase Forms** | A form block (fields as inner blocks), validation shared by browser and server, entries stored with a CSV export, email notifications through core mail, a honeypot plus time-trap, optional Cloudflare Turnstile, and per-form webhooks | Gaps 3, 4, 8 | L |
| **Pressbase Anti-spam** | Checks comments and form submissions with local heuristics (links, blocklist, timing) and optionally Akismet's API with the site's key. Adds a "Spam" queue and false-positive training. | Comment and form hooks | M |
| **Pressbase Analytics** | Privacy-first page-view stats with no cookies and no IP storage (daily-salted hash), a Dashboard widget and top pages. Later: Search Console in SEO. | Gaps 3, 7; jobs | M |
| **Pressbase Backups** | Scheduled backups of the database (`pg_dump`, or a PGlite dump) and uploads to local disk or S3-compatible storage, with retention, a restore runbook, and a `pressbase backup` command | Jobs, CLI, the S3 adapter (roadmap) | M |
| **Pressbase Security** | TOTP 2FA and passkeys (WebAuthn) for logins, an activity log (who changed what), and session management | Login hooks in core | M |
| **Email log** | A log of sent mail with a resend action, plus SMTP settings UI over the environment variables | Mail hooks | S. Could be core. |
| **Duplicate post** | A "Duplicate" row action | — | S. **Core.** |

## Phases

1. **v0.7a, platform:** gaps 1, 2, 3, 5, 6, 7, 9 and 10, then 4. Each comes with an e2e test that uses it from a test plugin.
2. **v0.7b, Pressbase SEO v1:** everything marked v1 above, with a migration test from a WordPress + Yoast fixture (the MySQL migration fixture already has Yoast meta).
3. **v0.7c, Forms and Anti-spam:** gaps 4 and 8, plus the plugin block runtime.
4. **v0.8:** Analytics, Backups, Security, Email log, and Duplicate post in core.
5. **v1.0:** freeze the plugin API with what these plugins proved, then the security and accessibility audits from the roadmap.

**How we know SEO v1 is done:**
- A WordPress + Yoast site migrates and its rendered `<head>` matches Yoast's for titles, descriptions, canonicals, robots and Open Graph. Test this on the fixture and on a real site.
- Google's Rich Results test passes for posts, pages and the home page.
- Lighthouse SEO scores 100 on the demo site.
- No public JavaScript is added.

## Decisions

Settled on 2026-10-28:

1. **Storage:** Yoast's meta keys and title variables, for instant compatibility with migrated sites.
2. **Distribution:** bundled in this repo, in `plugins/`, like `daily-tips`.
3. **Analysis languages:** English only at launch; other languages are pluggable later.
4. **AI:** yes, in Pressbase SEO v1. It's opt-in, on a core AI client ported from WordPress 7.x ([AI](#ai), gap 10).
5. **Order after SEO:** to be decided later.

## Sources

- [WordPress.org popular plugins](https://wordpress.org/plugins/browse/popular/) (install counts)
- [Yoast SEO features and dates](https://yoast.com/features/)
- [Rank Math vs Yoast, Nexter (2026)](https://nexterwp.com/blog/rank-math-vs-yoast/) and [Capterra comparison](https://www.capterra.com/compare/219202-242098/Yoast-SEO-vs-Rank-Math)
- [Hostinger WordPress statistics 2026](https://www.hostinger.com/tutorials/wordpress-statistics)
- [`yoastseo` on npm](https://www.npmjs.com/package/yoastseo) (GPL-3.0)
- [IndexNow adoption by SEO plugins, Search Engine Land](https://searchengineland.com/indexnow-integrations-grow-as-bing-says-millions-of-sites-are-using-it-381168)
