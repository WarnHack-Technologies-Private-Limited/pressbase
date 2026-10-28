# Themes and the public site

How Pressbase loads WordPress block themes, turns `theme.json` into CSS, and renders the public site. The decision behind the design is [ADR 0007](../adr/0007-public-rendering.md).

| Piece | Location | WordPress equivalent |
|---|---|---|
| theme.json engine | `packages/theme-json` (`@pressbase/theme-json`) | `WP_Theme_JSON`, `WP_Theme_JSON_Resolver`, `wp_get_global_stylesheet()`, fluid typography, `wp_get_layout_style()`, `WP_Font_Face` |
| Themes | `apps/core/src/themes/` (`kernel.themes`) | `WP_Theme`, `search_theme_directories()`, `switch_theme()`, `_register_theme_block_patterns()` |
| Block supports needing the theme | `apps/core/src/themes/supports.ts` | `block-supports/layout.php`, `elements.php`, `position.php`, `typography.php`, `block-style-variations.php` |
| Request routing, main query | `apps/core/src/frontend/query.ts` | `WP::parse_request()`, `WP_Rewrite`, `WP_Query` main query, `redirect_canonical()` |
| Template hierarchy | `apps/core/src/frontend/hierarchy.ts` | `template-loader.php`, `get_*_template()` |
| Document | `apps/core/src/frontend/render.ts` | `get_the_block_template_html()`, `template-canvas.php`, `wp_get_document_title()`, `get_body_class()` |
| Template blocks | `apps/core/src/blocks/library/{template,query,navigation,post-media}.ts` | `wp-includes/blocks/*.php` |
| Public app | `apps/web` | the web server in front of `index.php` |

## Request flow

```
Browser ── GET /2026/10/27/hello/ ──▶ apps/admin :3000 (fallback rewrite) ─┐
Browser ── GET /2026/10/27/hello/ ──▶ apps/web   :3001 ◀─────────────────────┘
                                         │ GET /wp-json/pressbase/v1/render?url=/2026/10/27/hello/
                                         ▼  (cookie, If-None-Match forwarded)
                                      apps/core :4000
                                         1. resolveMainQuery()   parse URL, run the main query
                                         2. templateHierarchy()  single-post-hello → single-post → single → singular → index
                                         3. render the template  kernel.blocks.render(), inside a PageRender
                                         4. assemble the document global styles, block support CSS, fonts
                                         ▼
                                      { status: 200, headers: {…}, html: "<!DOCTYPE html>…" }
```

`/wp-json/*`, `/wp-content/*`, `/wp-includes/*` and `/wp-login.php` are proxied straight to core by both Next.js apps.

## The theme.json engine

`@pressbase/theme-json` is pure: it never touches the file system. Callers pass the parsed files in.

```ts
import { getGlobalStylesheet, resolveThemeJson } from '@pressbase/theme-json';

const resolved = resolveThemeJson({
  theme: themeJson,                 // the theme's theme.json
  blockStyleVariations: partials,   // styles/blocks/*.json, styles/sections/*.json
  user: globalStyles,               // the custom origin (user global styles), optional
  blocks,                           // registered block types (supports, selectors, styles)
});
const { stylesheet, customCss, fontFaces } = getGlobalStylesheet(resolved, {
  resolveFileUri: (path) => `/wp-content/themes/my-theme/${path}`,
});
```

What it does, as WordPress does:

- **Origins.** WordPress's own `theme.json` (`default`), the theme's (`theme`) and user styles (`custom`) merge with `array_replace_recursive()` semantics. Presets are kept per origin. A theme preset that reuses a default slug is dropped while `defaultPalette`, `defaultFontSizes`, `defaultSpacingSizes`… are on, and theme font and spacing sizes without a name borrow the default's.
- **Schema.** Version 2 files are migrated to version 3. `appearanceTools` opts into its settings. `var:preset|color|base` becomes `var(--wp--preset--color--base)`. Styles for unknown blocks and unknown style variations are dropped.
- **Spacing scale.** `spacingScale` generates the `--wp--preset--spacing--20…80` presets (`compute_spacing_sizes()`).
- **Stylesheet** (`get_stylesheet()`), in WordPress's order:
  1. `variables`: preset custom properties on `:root` (aspect ratios, colours, gradients, font sizes, font families, spacing, shadows, radius and dimension sizes) and `settings.custom` as `--wp--custom--*`. Block-level presets go on the block's selector.
  2. `styles`: root layout rules (content and wide sizes, `.wp-site-blocks`, root padding aware alignments, block gap, the `is-layout-*` base and gap rules), then the body, elements (`a:where(:not(.wp-element-button))`, headings, buttons, captions…) and blocks, using WordPress's `:root :where(…)` zero-specificity selectors, feature selectors from `block.json`, pseudo states and `&`-nested custom CSS.
  3. `presets`: the `.has-*-color`, `.has-*-background-color`, `.has-*-font-size`… classes, with `!important`.
  4. `custom-css`: `styles.css`.
- **Fluid typography.** Font sizes become `clamp()` values when `settings.typography.fluid` is on, exactly as `wp_get_typography_font_size_value()` computes them.
- **Fonts.** `fontFace` declarations become `@font-face` rules; `file:./` sources resolve to the theme's URL.
- **Block style variations.** Variation styles are not in the global stylesheet: like WordPress 6.6+, they are generated per block instance (`blockStyleVariationInstanceStyles()`), scoped to a class such as `is-style-post-terms-1--2`.

The tests in `packages/theme-json/src/theme-json.test.ts` compare the output for Twenty Twenty-Five with what WordPress 7.1 prints.

Not ported yet: responsive (viewport) style states, duotone filters, background image uploads in global styles, and style variations of the whole theme (`styles/*.json` colour and typography presets are loaded by nothing until the site editor arrives).

## Themes in core

`kernel.themes` finds themes in two folders: the repository's `themes/` (bundled) and `<PRESSBASE_DATA_DIR>/themes` (installed; a folder there wins over a bundled one with the same name). A theme is a folder with a `style.css` header (`Theme Name`, `Version`, `Template`…); it can render if it has `templates/index.html` (a block theme). Child themes (`Template:` header) take templates, parts and patterns from the child first, then the parent, and merge the child's `theme.json` over the parent's.

The active theme comes from the `stylesheet` and `template` options (the installer sets `twentytwentyfive`). A missing theme falls back to the default. `kernel.themes.active()` loads and caches it: templates, parts with their areas, `theme.json` resolved against the registered block types, the global stylesheet, patterns and the stylesheets to enqueue. `kernel.themes.activate(stylesheet)` switches, fires `switch_theme` and reloads. `kernel.themes.reload()` picks up edited theme files.

Theme files are served at `/wp-content/themes/{theme}/…` with the uploads' safety rules: each path segment decoded and checked (no `..`, hidden files, encoded slashes or control characters), only static types (CSS, JS, images, fonts, video; never PHP, HTML, JSON or Markdown), the real path must stay in the theme folder, `nosniff`, a sandboxing CSP on SVG, `ETag` and `Last-Modified` with 304s.

### Twenty Twenty-Five

Bundled unchanged in `themes/twentytwentyfive` (GPL-2.0-or-later; see its `NOTICE.md`).

### functions.php

Pressbase never runs PHP. What block themes typically do in `functions.php` is listed per theme in `apps/core/src/themes/compat.ts`. For Twenty Twenty-Five:

| functions.php | Pressbase |
|---|---|
| `wp_enqueue_style( 'twentytwentyfive-style', style.min.css )` | Enqueued. |
| `register_block_style( 'core/list', 'checkmark-list' )` with inline CSS | Registered, CSS printed. |
| `register_block_pattern_category()` × 2 | Registered. |
| `add_theme_support( 'post-formats' )` | Recorded; posts are always "standard" until post formats exist. |
| `add_editor_style()` | Not yet: the editor doesn't load theme styles. |
| `register_block_bindings_source( 'twentytwentyfive/format' )` | Not yet: block bindings arrive later. |

### Patterns in PHP files

Theme patterns are `patterns/*.php`: a header comment and block markup with small PHP snippets. `themes/php-patterns.ts` reads the headers WordPress reads (`Title`, `Slug`, `Description`, `Categories`, `Keywords`, `Block Types`, `Post Types`, `Template Types`, `Viewport Width`, `Inserter`) and **interprets** a tiny, safe subset of PHP instead of running it:

- statements: `echo expr[, expr];` and calls to `_e()`, `esc_html_e()`, `esc_attr_e()`, `printf()`;
- expressions: quoted strings (no variable interpolation), `.` concatenation, and calls to `__()`, `_x()`, `esc_html__()`, `esc_attr__()`, `esc_html_x()`, `esc_attr_x()`, `esc_html()`, `esc_attr()`, `esc_url()`, `wp_kses_post()`, `sprintf()`, `get_template_directory_uri()`, `get_stylesheet_directory_uri()`, `get_theme_file_uri()`, `get_parent_theme_file_uri()`;
- comments, and PHP's rule that a newline right after `?>` is swallowed.

Translation functions return the English text until i18n arrives (v0.6). Anything else — a variable, another function, `include`, backticks, `<?=` — makes the loader skip the whole pattern with a warning in the log. All 98 Twenty Twenty-Five patterns load.

Theme URLs in patterns and font faces are root-relative (`/wp-content/themes/…`), so they work on every origin that proxies core.

## Block supports at render time

Some block supports need the active theme's settings, so core applies them as `render_block_data` / `render_block` filters (`themes/supports.ts`), for static blocks (Group, Columns…) as well as dynamic ones:

- **Layout**: `is-layout-flow|constrained|flex|grid`, `wp-block-{name}-is-layout-*`, `has-global-padding` (root padding aware alignments), `is-content-justification-*`, `is-nowrap`, `is-vertical`, and a `wp-container-{block}-is-layout-{hash}` class with its generated CSS (content and wide sizes, full-width margins, flex alignment, grid columns, block gap). The hash is `wp_unique_id_from_values()`'s, so classes are stable between requests. Child layout (`selfStretch`, `flexSize`, grid spans) gets `wp-container-content-{hash}`.
- **Elements**: link, heading and button colours set on a block get a `wp-elements-N` class and CSS.
- **Position**: sticky and fixed, when the theme allows them.
- **Typography**: custom font sizes become fluid.
- **Style variations**: per-instance variation styles (above).

Generated CSS is collected by the page render and printed in the head (`core-block-supports-inline-css`, `block-style-variation-styles-inline-css`), as WordPress does. In REST responses (`content.rendered`) the classes apply and the CSS is dropped.

Spacing, border, typography, colour, dimensions and shadow styles that don't depend on the theme are applied by `getBlockWrapperAttributes()` in `@pressbase/blocks` (see [Blocks](blocks.md)).

WordPress registers every core block on the server. Pressbase now does too (`apps/core/src/blocks/wordpress-blocks.ts`, generated from `block.json` by `scripts/generate-wordpress-data.mjs`), so supports apply to static blocks. Core blocks WordPress renders only on the server that Pressbase doesn't have yet (the comment blocks, RSS, calendar…) stay unregistered and render nothing, instead of showing their saved placeholder.

## Request routing

`resolveMainQuery()` reads the URL like `WP::parse_request()` with the default rewrite rules, in WordPress's order:

| URL | Query |
|---|---|
| `/` | Latest posts (`show_on_front = posts`), or the front page (`show_on_front = page`, `page_on_front`) |
| `…/page/N/`, `?paged=N` | Page N of a listing; past the last page is a 404 |
| `/category/{path}/`, `?cat=`, `?category_name=` | Category archive, including child categories |
| `/tag/{slug}/`, `?tag=` | Tag archive |
| `/author/{nicename}/`, `?author=` | Author archive |
| `/search/{term}/`, `?s=` | Search (posts and pages) |
| The permalink structure, e.g. `/2026/10/27/hello/` | A single post (the date parts must match) |
| `/2026/`, `/2026/10/`, `/2026/10/27/`, `?m=202610` | Date archives, in the site's time zone |
| `/{parent}/{child}/`, `?page_id=` | A page by its path (`get_page_by_path()`); the posts page (`page_for_posts`) lists posts |
| `?p=` | A post by ID |
| anything else | 404 |

With `/%postname%/`-style structures, pages are tried before posts ("verbose page rules"). With plain permalinks, only query strings route.

`redirect_canonical()`'s main cases are covered: `?p=` and `?page_id=` redirect (301) to the pretty permalink, and pretty URLs without their trailing slash redirect to it.

**Visibility.** Listings show published posts, plus private ones to people with `read_private_posts`. A single draft, pending or scheduled post shows only to people who can edit it (a preview); a private one to people who can read it; otherwise 404. **Passwords:** a protected post shows WordPress's password form in place of its content (and no featured image). The form posts to `/wp-login.php?action=postpass`, which stores a hash of the password in the `wp-postpass` cookie for 10 days and redirects back (same-site only).

## The template hierarchy

`templateHierarchy()` lists candidates in `template-loader.php`'s order; the first template the theme has wins, `index` is last:

| View | Candidates |
|---|---|
| 404 | `404` |
| Search | `search` |
| Front page | `front-page`, then the home or page candidates |
| Blog home | `home`, `index` |
| Single post | custom template, `single-post-{slug}`, `single-post`, `single`, `singular` |
| Page | custom template (`_wp_page_template`), `page-{slug}`, `page-{id}`, `page`, `singular` |
| Category | `category-{slug}`, `category-{id}`, `category`, `archive` |
| Tag | `tag-{slug}`, `tag-{id}`, `tag`, `archive` |
| Author | `author-{nicename}`, `author-{id}`, `author`, `archive` |
| Date | `date`, `archive` |

## Rendering a page

`renderPublicPage()`:

1. Runs the main query; a redirect answers immediately.
2. Picks the template and renders it with `kernel.blocks.render()`, inside a `PageRender` (`frontend/page.ts`) that travels with the render through `AsyncLocalStorage`: the main query (for `core/query` with `inherit`, pagination, titles), unique IDs, the collected CSS and scripts, the request's path and cookies. Singular views render with the post as context.
3. Wraps the result in `<div class="wp-site-blocks">`, adds the skip link (`#wp--skip-link--target` on the first `<main>`), and builds the head: `<title>` (`wp_get_document_title()`), robots meta, canonical link, the block library CSS (`/wp-includes/css/dist/block-library/style.min.css`, WordPress 7.1.3's), global styles, variation and block support CSS, the theme's stylesheets and `@font-face` rules. `<body>` gets `get_body_class()`'s classes.
4. Answers `404` for 404s, with `Cache-Control: public, max-age=0, must-revalidate` (private for logged-in visitors) and an `ETag`; a matching `If-None-Match` gives 304.

### Template blocks

| Block | Notes |
|---|---|
| `core/template-part` | The theme's `parts/{slug}.html`; the tag comes from the part's area (`header`, `footer`, else `div`). Recursion-guarded. |
| `core/pattern` | A registered pattern's blocks, rendered in place with the surrounding context. |
| `core/post-content` | The post's blocks in `<div class="entry-content wp-block-post-content">`; the password form when locked. |
| `core/query`, `core/post-template` | `inherit: true` shows the main query; other queries run `build_query_vars_from_query_block()` and paginate with `?query-{id}-page=N`. Items get `get_post_class()`. |
| `core/query-pagination` (+ `-previous`, `-next`, `-numbers`) | `paginate_links()` markup, arrows, `/page/N/` links. |
| `core/query-title`, `core/query-no-results`, `core/term-description` | Archive titles with WordPress's prefixes (`Category: <span>…</span>`). |
| `core/navigation`, `-link`, `-submenu`, `core/home-link`, `core/page-list` | WordPress's markup. A `wp_navigation` menu by `ref`; without a `ref` or items (Twenty Twenty-Five's header), the menu chosen in Appearance → Menus, else the newest menu, else a page list. Accessible submenu toggles (`aria-expanded`), the responsive overlay as a modal dialog, a small inline script instead of the Interactivity API, and a `<noscript>` style so menus work without JavaScript. Current items get `current-menu-item` and `aria-current`. See [Navigation](navigation.md). |
| `core/post-featured-image` | `wp_get_attachment_image()` with `srcset`, aspect ratio, `fetchpriority="high"` on the first image, lazy loading after. |
| `core/post-navigation-link` | Previous (older) and next (newer) posts, with arrows and labels. |
| `core/read-more`, `core/post-author`, `core/avatar`, `core/site-logo` | Avatars are initials on a colour, as an inline SVG: no Gravatar request, so no reader's or author's email hash leaves the site. The site logo renders once a `site_logo` option exists. |

## Building a Pressbase-compatible block theme

Any WordPress block theme that keeps its logic in `theme.json`, templates and patterns works:

1. A folder in `<PRESSBASE_DATA_DIR>/themes/` with `style.css` (header with at least `Theme Name`) and `templates/index.html`.
2. `theme.json` (schema 2 or 3), `parts/*.html` with areas declared in `templateParts`, `templates/*.html` named after the hierarchy, `styles/blocks/*.json` and `styles/sections/*.json` for block style variations.
3. Patterns as `patterns/*.php`, using only the PHP subset above, or as plain block markup.
4. Static assets referenced with `file:./` (fonts) or through `get_template_directory_uri()` in patterns.
5. Activate it in **Appearance**.

Anything a theme does in `functions.php` doesn't happen; keep styles in `theme.json` and `style.css` (enqueued only through `compat.ts` for now — a theme manifest for stylesheets and block styles is planned with the plugin loader).

## Not yet

- The site editor: editing templates, parts and global styles (`wp_template`, `wp_template_part`, `wp_global_styles` post types). Navigation menus (`wp_navigation`) are edited in Appearance → Menus; see [Navigation](navigation.md).
- Theme style variations (`styles/*.json`), responsive style states, duotone.
- Comments blocks (being built separately; they render nothing until registered), RSS feeds, the admin bar, `wp_head` hooks for plugins, oEmbed.
- Post formats, sticky-post styling beyond ordering, attachment pages, custom post type archives.
- Caching rendered pages in `apps/web` with revalidation on content changes.
