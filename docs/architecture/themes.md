# Themes and the public site

How Pressbase loads WordPress block themes, turns `theme.json` into CSS, and renders the public site. The decision behind the design is [ADR 0007](../adr/0007-public-rendering.md).

| Piece | Location | WordPress equivalent |
|---|---|---|
| theme.json engine | `packages/theme-json` (`@pressbase/theme-json`) | `WP_Theme_JSON`, `WP_Theme_JSON_Resolver`, `wp_get_global_stylesheet()`, fluid typography, `wp_get_layout_style()`, `WP_Font_Face` |
| Themes | `apps/core/src/themes/` (`kernel.themes`) | `WP_Theme`, `search_theme_directories()`, `switch_theme()`, `_register_theme_block_patterns()` |
| Installing and deleting themes | `apps/core/src/themes/install.ts` | `Theme_Upgrader::install()`, `check_package()`, `delete_theme()` |
| Style variations, sanitising user styles | `packages/theme-json/src/{style-variations,sanitize}.ts` | `get_style_variations()`, the site editor's variation logic, `remove_insecure_properties()`, `safecss_filter_attr()` |
| User global styles | `apps/core/src/themes/global-styles.ts`, `routes/global-styles.ts` | `wp_global_styles`, `WP_REST_Global_Styles_Controller` (+ revisions) |
| Site logo and icon | `apps/core/src/themes/site-identity.ts` | `get_custom_logo()`, `WP_Site_Icon`, `wp_site_icon()` |
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

The same endpoint answers feeds, sitemaps and `robots.txt`, and `apps/web` caches anonymous answers by the cache tags core returns with each render. See [The public site](public-site.md).

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

Not ported yet: responsive (viewport) style states, duotone filters and background image uploads in global styles.

The package also holds the pieces of the site editor and of WordPress's save path that global styles need: `style-variations.ts` (sorting, applying and recognising style variations) and `sanitize.ts` (`removeInsecureProperties()`, `isSafeCssDeclaration()`, `validateCustomCss()`). Both are described below.

## Themes in core

`kernel.themes` finds themes in two folders: the repository's `themes/` (bundled) and `<PRESSBASE_DATA_DIR>/themes` (installed; a folder there wins over a bundled one with the same name). A theme is a folder with a `style.css` header (`Theme Name`, `Version`, `Template`…); it can render if it has `templates/index.html` (a block theme). Child themes (`Template:` header) take templates, parts and patterns from the child first, then the parent, and merge the child's `theme.json` over the parent's.

The active theme comes from the `stylesheet` and `template` options (the installer sets `twentytwentyfive`). A missing theme falls back to the default. `kernel.themes.active()` loads and caches it: templates, parts with their areas, `theme.json` resolved against the registered block types, the global stylesheet, patterns and the stylesheets to enqueue. `kernel.themes.activate(stylesheet)` switches, fires `switch_theme` and reloads. `kernel.themes.reload()` picks up edited theme files.

Theme files are served at `/wp-content/themes/{theme}/…` with the uploads' safety rules: each path segment decoded and checked (no `..`, hidden files, encoded slashes or control characters), only static types (CSS, JS, images, fonts, video; never PHP, HTML, JSON or Markdown), the real path must stay in the theme folder, `nosniff`, a sandboxing CSP on SVG, `ETag` and `Last-Modified` with 304s. The same rules apply to uploaded themes.

## Installing and deleting themes

Site owners add themes with **Appearance → Themes → Upload theme**, `POST /pressbase/v1/themes` or `pressbase theme install`, and remove them with the theme card's **Delete**, `DELETE /pressbase/v1/themes/{stylesheet}` or `pressbase theme delete`. All three call `kernel.themes.install()` and `kernel.themes.delete()` (`apps/core/src/themes/install.ts`), which run one at a time. The decision is [ADR 0025](../adr/0025-theme-install-and-delete.md).

### Installing: `kernel.themes.install(zip, { overwrite, filename })`

A port of `Theme_Upgrader::install()` and `check_package()` (`wp-admin/includes/class-theme-upgrader.php`) with `WP_Upgrader::install_package()`:

1. **Size.** The archive may be as large as the upload limit (`PRESSBASE_MAX_UPLOAD_MB`), at most 32 MB, as for plugins (`413 rest_upload_file_too_big`); once unpacked, four times that.
2. **The archive.** Read by the shared strict ZIP reader (`apps/core/src/files/zip.ts`, also used for plugins and language packs): zip-slip paths (`incompatible_archive_path`), links and special files (`incompatible_archive_symlink`), encryption, ZIP64, damaged entries, duplicates and more than 5,000 files (`incompatible_archive`), and zip bombs (`incompatible_archive_too_big`) are refused before anything is written. An empty archive is `incompatible_archive_empty`. `__MACOSX/` and `.DS_Store` are skipped.
3. **Where the theme is.** As WordPress decides: when everything sits in one top-level folder, that folder is the theme; otherwise the archive's root is.
4. **The theme.** `style.css` must exist (`incompatible_archive_theme_no_style`) and have a `Theme Name` header (`incompatible_archive_theme_no_name`). It must be a **block theme**, with `templates/index.html` (or the legacy `block-templates/index.html`). A classic theme, with `index.php` but no block template, is refused with `pressbase_theme_not_block_theme` and a message saying Pressbase runs block themes only; an archive with neither is `incompatible_archive_theme_no_index`. WordPress accepts a child theme without an index file; Pressbase needs `templates/index.html` in child themes too, because it only activates themes that have one. `Requires at least` and `Requires PHP` are not checked: they describe WordPress and PHP.
5. **The folder name** (the theme's `stylesheet`): the top-level folder's name, else the uploaded file's name without `.zip`, else the theme's name, sanitised as `sanitize_file_name()` does and then limited to the characters Pressbase accepts in theme folder names (`A–Z a–z 0–9 _ -`; accents dropped, anything else becomes `-`). `My Theme (1)` becomes `My-Theme-1`.
6. **An existing theme** with that folder name, uploaded or bundled, is `409 folder_exists` unless `overwrite` is set. The error's `data` holds the `current` and `uploaded` theme's name, version, author, parent (`template`) and `source`, for the admin's "Replace the installed theme?" step (WordPress's *Replace current with uploaded*, `Theme_Installer_Skin::do_overwrite()`).
7. **Unpacking.** Files are written into a hidden staging folder in `<dataDir>/themes` (`.upload-…`; folders starting with a dot are never listed), then renamed into place. With `overwrite`, the old folder is renamed aside first and removed once the new one is in place, or moved back if the rename fails, so a half-written theme is never seen. A bundled theme is never touched: its replacement is installed in the data directory, which wins over the bundled folder, and deleting it brings the bundled copy back.
8. **After.** If the theme is the active theme or the active theme's parent, it stays active: the `template` option follows a changed `Template:` header, the theme is reloaded, and the page cache is purged (`site` tag, reason `theme_overwrite`, from `cache/invalidation.ts`). Then `upgrader_process_complete (null, { action: 'install', type: 'theme', themes: [stylesheet] })` fires (WordPress passes its `WP_Upgrader`; Pressbase has none), and, when a theme was replaced, `upgrader_overwrote_package (filename, newThemeData, 'theme')` with the `check_package()` headers (`Name`, `Version`, `Author`, `Template`, `RequiresWP`, `RequiresPHP`).

Installing never activates a theme; that's `activate()` (`switch_theme()`), as in WordPress. The CLI's `--activate` calls it after installing.

### Deleting: `kernel.themes.delete(stylesheet)`

`delete_theme()` (`wp-admin/includes/theme.php`) with the checks of `wp-admin/themes.php`:

- **Refused:** the active theme (`rest_cannot_delete_active_theme`), the parent of the active child theme (`pressbase_cannot_delete_parent_theme`, WordPress's *delete-active-child*), and themes bundled with Pressbase (`pressbase_cannot_delete_bundled_theme`): they live in the repository's read-only `themes/` folder. The checks use both the `stylesheet` and `template` options and the theme actually loaded, which differ when the stored theme is missing and the default is used.
- `delete_theme (stylesheet)` fires, the folder is removed, then `deleted_theme (stylesheet, deleted)`; a folder that can't be removed is `500 could_not_remove_theme`.
- The theme's translations in `languages/themes` (`{stylesheet}-{locale}.po`, `.mo`, `.l10n.php`, `-{hash}.json`) are removed, as `delete_theme()` does.
- The `theme_mods_{stylesheet}` option is removed. **WordPress 7.1.3 leaves it** (only `remove_theme_mods()` deletes it); Pressbase cleans it up because nothing else would.
- The theme's `wp_global_styles` post stays, as in WordPress: reinstalling the theme brings its saved styles back.

Deleting an inactive theme changes nothing visitors see, so nothing is purged.

### REST and the admin

`/wp/v2/themes` items carry two extra fields: `pressbase_source` (`bundled` or `site`) and `pressbase_deletable` (true for an uploaded theme that is neither active nor the active theme's parent). The admin shows **Delete** in a theme card's menu only when `pressbase_deletable` is true and the user has `delete_themes`, and **Upload theme** only with `install_themes`. See [REST API](rest-api.md) for the endpoints and error codes.

### Capabilities

`POST /pressbase/v1/themes` checks `upload_themes`, which `map_meta_cap()` maps to `install_themes` (`upload_plugins` maps to `install_plugins` the same way; `apps/core/src/auth/meta-caps.ts`). Pressbase has no multisite and no `DISALLOW_FILE_MODS`, so nothing maps to `do_not_allow`. Deleting checks `delete_themes`. All three capabilities belong to administrators only.

### What an uploaded theme can do

Pressbase never runs a theme's PHP. It reads `style.css` headers, `theme.json`, `styles/`, HTML templates and parts, and interprets the small PHP subset of `patterns/*.php` described below; `functions.php` and any other `.php` file are ignored, and none of them is ever served. But a theme's templates, patterns, CSS and JavaScript reach every visitor (a template can contain an HTML block with a script), so only install themes you trust.

## Global styles

What a site owner changes about a theme's look — WordPress's "global styles" — is the **custom origin** of theme.json, layered over WordPress's defaults and the theme. Pressbase stores and merges it as WordPress does.

```
default (WordPress)  ─┐
theme.json (parent → child) ─┤ WP_Theme_JSON::merge()  ──▶ global stylesheet ──▶ <style id='global-styles-inline-css'>
user global styles (wp_global_styles post) ─┘
```

### Style variations

A block theme's `styles/` folder holds two kinds of partial theme.json files (`WP_Theme_JSON_Resolver::get_style_variations()`, read recursively, child theme first, a child file hiding a parent file with the same name, sorted by path):

- **Block style variations** have `blockTypes` (`styles/blocks/*.json`, `styles/sections/*.json`). They register block styles such as `section-1` and are part of the theme layer (above).
- **Theme style variations** don't. Twenty Twenty-Five ships 23: eight full ones (`01-evening.json` … `08-midnight.json`), eight colour-only (`styles/colors/*.json`) and seven typography-only (`styles/typography/*.json`). `kernel.themes.active().variations` lists them with presets keyed by the `theme` origin, as WordPress's REST API returns them; a file without `title` is named after itself.

As in the site editor, a variation is never "active" by reference. **Choosing one writes it into the user's global styles** (`applyStyleVariation()`):

- a **full** variation replaces the user's settings and styles;
- a **colour** (or **typography**) variation keeps every other user value, removes the user's colour (or typography) values (`removePropertiesFromObject()`) and deep-merges the variation's in (`mergeBaseAndUserConfigs()`, lists replaced).

`styleVariationKind()` tells the kinds apart the way the editor does (`isVariationWithProperties(variation, ['color'])`: every value lives under a `color` key), and `isStyleVariationApplied()` recognises a variation inside a user config, so a screen can show which is in use. A variation's palette is stored as `settings.color.palette.theme`, so it **replaces** the theme's palette (same slugs, new colours) rather than adding to it; the same goes for a typography variation's `fontFamilies` — its fonts load, the theme's no longer do. The tests in `packages/theme-json/src/style-variations.test.ts` merge Evening, Noon and the typography presets over Twenty Twenty-Five and check the stylesheet.

### User global styles

Stored as WordPress stores them (`apps/core/src/themes/global-styles.ts`):

- One **`wp_global_styles` post per theme**, slug `wp-global-styles-{stylesheet}`, status `publish`, title "Custom Styles", content a user theme.json: `{"version":3,"isGlobalStylesUserThemeJSON":true,"settings":{…},"styles":{…}}` with `<`, `>` and `&` escaped. WordPress also tags the post with a `wp_theme` term; Pressbase finds it by slug.
- The post type is registered as in `create_initial_post_types()`: not public, `read` → `edit_posts`, everything else → `edit_theme_options`, with **revisions**. Every save keeps one.
- It is created on demand, the first time the active theme is listed through `/wp/v2/themes` (the `wp:user-global-styles` link), as `get_user_global_styles_post_id()` does.
- **Saving** (`POST /wp/v2/global-styles/{id}`): a missing `styles` or `settings` keeps the stored value; `styles.css` must pass `validate_custom_css()` (no `</style`, nor a prefix of it at the end) for everyone; for users **without `unfiltered_html`**, `removeInsecureProperties()` keeps only declarations that pass `safecss_filter_attr()` (preset references, `calc()`/`var()`/`clamp()`…, http(s) `url()`s on url properties, gradients on backgrounds — no other functions, `\`, `&`, `}`, `=`, comments, and, stricter than WordPress, no `;`, `{`, `<`, `>`), presets with safe names, slugs and values, and plain settings; custom CSS survives only with `edit_css` (which maps to `unfiltered_html`). Unknown blocks are dropped.
- **Rendering**: the active theme's styles are resolved with the user config as the custom origin. When the custom origin is merged, values that could escape a declaration are dropped again and custom CSS that could close the style element is ignored, so a hand-edited post can't break the page either.
- After any save of a `wp_global_styles` post (`save_post_wp_global_styles`), `kernel.themes.refreshStyles()` rebuilds the active theme's stylesheet (without re-reading theme files) and core fires **`pressbase_global_styles_updated`** `(stylesheet, post, config)` — the hook for cache invalidation. Renders already running keep the styles they started with.

### The live preview

`POST /pressbase/v1/global-styles/preview` takes `{ url, styles?, settings? }`, prepares them exactly as a save would (validation and sanitising included) on top of the stored config, and renders the page through the normal renderer with `kernel.themes.withUserStyles(config)` — a copy of the active theme with those styles — passed as `RenderRequest.theme`. Block supports read the theme from the page render, so layout widths change too. Nothing is written: not the post, not a revision, not the theme cache. The answer has `cache-control: no-store` and `x-robots-tag: noindex`.

The admin shows it in a sandboxed `iframe` (`srcdoc`, `sandbox="allow-same-origin"`: same origin so theme fonts load, no scripts) and keeps links and the search form inside the preview.

### Site identity: logo and icon

`apps/core/src/themes/site-identity.ts`:

- **Settings** `site_logo` and `site_icon` (attachment IDs, `0` for none) are registered in `/wp/v2/settings`, as WordPress registers them. The REST index (`/wp-json/`) also carries `site_logo`, `site_icon` and `site_icon_url`.
- **Logo.** `core/site-logo` renders `get_custom_logo()`'s markup: `<a href="{home}/" class="custom-logo-link" rel="home">` (with `aria-current="page"` on the front page) around `<img class="custom-logo">`, alt text from the image, else the site title; the block's `width` scales width and height; `is-default-size` without one.
- **Icon.** When `site_icon` changes (and on first use, for sites that got the option another way), the image is cropped from its centre to squares of WP_Site_Icon's sizes — 512, 270, 192, 180 and 32 pixels — saved as PNGs beside it (`photo-32x32.png`) and recorded in its metadata as `site_icon-{size}`, so they are deleted with it. WordPress makes a separate cropped attachment through its cropper; Pressbase has no cropper yet.
- **Head tags** (`wp_site_icon()`, filter `site_icon_meta_tags`), printed near the end of the public page head:

  ```html
  <link rel="icon" href="…/mark-32x32.png" sizes="32x32" />
  <link rel="icon" href="…/mark-192x192.png" sizes="192x192" />
  <link rel="apple-touch-icon" href="…/mark-180x180.png" />
  <meta name="msapplication-TileImage" content="…/mark-270x270.png" />
  ```

- Deleting the image clears the option (`WP_Site_Icon::delete_attachment_data()`); the same goes for the logo.
- The admin uses the icon as its favicon and in the sidebar, in place of the site's initial.

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

Translation functions translate through the theme's text domain in the site's language, and pattern titles and descriptions are translated as WordPress translates them (see [Internationalisation](i18n.md#themes)). Anything else — a variable, another function, `include`, backticks, `<?=` — makes the loader skip the whole pattern with a warning in the log. All 98 Twenty Twenty-Five patterns load.

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
| `/category/{path}/`, `?cat=`, `?category_name=` | Category archive, including child categories (`category` is the category base) |
| `/tag/{slug}/`, `?tag=` | Tag archive (`tag` is the tag base) |
| `/author/{nicename}/`, `?author=` | Author archive |
| `/search/{term}/`, `?s=` | Search (posts and pages) |
| The permalink structure, e.g. `/2026/10/27/hello/` | A single post (the date parts must match) |
| `/2026/`, `/2026/10/`, `/2026/10/27/`, `?m=202610` | Date archives, in the site's time zone |
| `/{parent}/{child}/`, `?page_id=` | A page by its path (`get_page_by_path()`); the posts page (`page_for_posts`) lists posts |
| `?p=` | A post by ID |
| anything else | 404 |

With `/%postname%/`-style structures, pages are tried before posts ("verbose page rules"). With plain permalinks, only query strings route.

`redirect_canonical()`'s main cases are covered: `?p=` and `?page_id=` redirect (301) to the pretty permalink, and pretty URLs without their trailing slash redirect to it. The structure and the category and tag bases are set in Settings → Permalinks; addresses from earlier settings redirect to the new ones (see [The public site](public-site.md#permalinks)).

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
3. Wraps the result in `<div class="wp-site-blocks">`, adds the skip link (`#wp--skip-link--target` on the first `<main>`), and runs `wp_enqueue_scripts`, `wp_head`, `wp_body_open` and `wp_footer` ([Scripts and styles](scripts-and-styles.md)). Core's own callbacks build the head: `<title>` (`wp_get_document_title()`), robots meta, canonical link, the block library CSS (`/wp-includes/css/dist/block-library/style.min.css`, WordPress 7.1.3's), global styles, variation and block support CSS, the theme's stylesheets (enqueued with `kernel.styles`) and `@font-face` rules. `<body>` gets `get_body_class()`'s classes.
4. Answers `404` for 404s, with `Cache-Control: public, max-age=0, must-revalidate` (private for logged-in visitors, unlocked protected posts and held-comment previews) and an `ETag`; a matching `If-None-Match` gives 304. The head links the site's feeds (`feed_links()`, `feed_links_extra()`).
5. Returns the cache tags of everything the render read (`tags`), for `apps/web`'s page cache ([ADR 0008](../adr/0008-public-page-caching.md)).

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
| `core/read-more`, `core/post-author`, `core/avatar`, `core/site-logo` | Avatars are initials on a colour, as an inline SVG: no Gravatar request, so no reader's or author's email hash leaves the site. The site logo renders once `site_logo` is set (see *Site identity*). |

## Building a Pressbase-compatible block theme

Any WordPress block theme that keeps its logic in `theme.json`, templates and patterns works:

1. A folder with `style.css` (header with at least `Theme Name`) and `templates/index.html`. Zip it and upload it in **Appearance → Themes**, or copy the folder into `<PRESSBASE_DATA_DIR>/themes/`.
2. `theme.json` (schema 2 or 3), `parts/*.html` with areas declared in `templateParts`, `templates/*.html` named after the hierarchy, `styles/blocks/*.json` and `styles/sections/*.json` for block style variations.
3. Patterns as `patterns/*.php`, using only the PHP subset above, or as plain block markup.
4. Static assets referenced with `file:./` (fonts) or through `get_template_directory_uri()` in patterns.
5. Activate it in **Appearance**.

Anything a theme does in `functions.php` doesn't happen; keep styles in `theme.json` and `style.css` (stylesheets listed in `compat.ts` are enqueued with `kernel.styles` in `wp_enqueue_scripts` — a theme manifest for stylesheets and block styles is planned with the plugin loader).

## Not yet

- The site editor: editing templates and parts (`wp_template`, `wp_template_part`). Global styles have the essentials (Appearance → Styles); per-block styles, shadows, borders, the style book and "Additional CSS" in the admin are still to come (the REST API takes them already).
- Responsive style states, duotone; the image cropper for the site icon (the centre is used).
- The admin bar, oEmbed.
- Post formats, sticky-post styling beyond ordering, attachment pages, custom post type archives.
