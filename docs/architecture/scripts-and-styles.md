# Public page hooks, scripts and styles

How plugins (and core) add to the `<head>`, the start of `<body>` and the footer of public pages, and how scripts and stylesheets are registered, ordered and printed. This is WordPress's `wp_head()` / `wp_body_open()` / `wp_footer()` with `WP_Scripts` and `WP_Styles`.

| Piece | Location | WordPress equivalent |
|---|---|---|
| Hooks, `kernel.scripts`, `kernel.styles`, core's head callbacks | `apps/core/src/frontend/head.ts` | `general-template.php`, `default-filters.php`, `script-loader.php`, `functions.wp-scripts.php`, `functions.wp-styles.php` |
| Dependency resolution and tags | `apps/core/src/frontend/dependencies.ts` | `class-wp-dependencies.php`, `class-wp-scripts.php`, `class-wp-styles.php` |
| Document title | `apps/core/src/frontend/title.ts` | `wp_get_document_title()` |
| Page assembly | `apps/core/src/frontend/render.ts` | `template-canvas.php` |

## The output model

WordPress's head callbacks `echo`. Pressbase's receive an `HtmlOutput` and call `out.print(html)`:

```ts
kernel.hooks.addAction('wp_head', (out, page) => {
  out.print(`<meta name="theme-color" content="${escAttr(color)}" />`);
});
kernel.hooks.addAction('wp_footer', async (out) => {
  out.print(await analyticsSnippet()); // async callbacks are awaited
}, 20);
```

Callbacks run one at a time in priority order (async ones are awaited before the next starts), so output lands in priority order, as WordPress's echoes do. Each `print()` piece goes on its own line. The output is HTML as given: escape what you print (`escHtml`, `escAttr`, `escUrl` from `@pressbase/blocks`).

The renderer renders the template first, then runs, inside the page's render context:

1. `wp_enqueue_scripts (page)`: enqueue scripts and styles for this page.
2. `wp_head (out, page)`: printed after `<meta charset>`.
3. `wp_body_open (out, page)`: printed right after `<body>`, before the skip link.
4. `wp_footer (out, page)`: printed before `</body>`.

Blocks render before the hooks run, so a block's render callback can enqueue a script or style and it is printed in the head (WordPress's block themes work the same way: the template is rendered before `wp_head()`).

`page` is the `PageRender` (`frontend/page.ts`): `page.main` is the main query (`is404`, `isSingular`, `queriedObject`…), `page.theme` the active theme, `page.user` the visitor.

### Core's callbacks and their priorities

| Hook | Priority | Prints | WordPress |
|---|---|---|---|
| `wp_enqueue_scripts` | 10 | the block library CSS, skip link CSS, global styles, block supports and style variation CSS, the theme's block styles and stylesheets | `wp_common_block_scripts_and_styles()`, `wp_enqueue_global_styles()`, the theme's `functions.php` |
| `wp_head` | 0 | viewport meta | `_block_template_viewport_meta_tag()` |
| `wp_head` | 1 | robots meta, `<title>`, generator, canonical link | `wp_robots()`, `_wp_render_title_tag()`, `wp_generator()`, `rel_canonical()` |
| `wp_head` | 2 | feed links | `feed_links()`, `feed_links_extra()` |
| `wp_head` | 8 | enqueued styles | `wp_print_styles()` |
| `wp_head` | 9 | head scripts | `wp_print_head_scripts()` |
| `wp_head` | 50 | `@font-face` rules, the navigation `<noscript>` style | `wp_print_font_faces()` |
| `wp_head` | 99 | site icon | `wp_site_icon()` |
| `wp_footer` | 10 | the navigation block's script | its view script |
| `wp_footer` | 20 | late styles, footer scripts | `wp_print_footer_scripts()` |

WordPress prints the generator and canonical link at priority 10; Pressbase prints them at 1 so the head keeps the order it had before these hooks existed. A plugin's callback at the default priority 10 lands after the stylesheets and head scripts, as in WordPress.

## Cache safety

Everything printed through these hooks is part of the page `apps/web` caches and serves to every anonymous visitor ([ADR 0008](../adr/0008-public-page-caching.md)). So:

- Never print per-visitor output: names, nonces, CSRF tokens, cart contents, "logged in as". `page.user` is `null` for every render that can be cached; logged-in renders are never cached, but don't rely on that to personalise the head.
- Output that depends on site data must change only with that data. When it changes, purge: `kernel.hooks.doAction('pressbase_cache_purge', ['site'], 'my-plugin')`.
- Per-visitor behaviour belongs in a script that runs in the browser and asks a REST endpoint.

## `kernel.scripts` and `kernel.styles`

| Pressbase | WordPress |
|---|---|
| `kernel.scripts.register(handle, src, deps?, ver?, { inFooter?, strategy? })` | `wp_register_script()` |
| `kernel.scripts.enqueue(handle, src?, deps?, ver?, options?)` | `wp_enqueue_script()` |
| `kernel.scripts.dequeue(handle)` / `deregister(handle)` | `wp_dequeue_script()` / `wp_deregister_script()` |
| `kernel.scripts.is(handle, 'registered' \| 'enqueued' \| 'to_do' \| 'done')` | `wp_script_is()` |
| `kernel.scripts.addInline(handle, code, 'before' \| 'after')` | `wp_add_inline_script()` |
| `kernel.scripts.localize(handle, objectName, data)` | `wp_localize_script()` |
| `kernel.styles.register(handle, src, deps?, ver?, media?)` | `wp_register_style()` |
| `kernel.styles.enqueue(handle, src?, deps?, ver?, media?)` | `wp_enqueue_style()` |
| `kernel.styles.dequeue` / `deregister` / `is` | `wp_dequeue_style()`, `wp_deregister_style()`, `wp_style_is()` |
| `kernel.styles.addInline(handle, css)` | `wp_add_inline_style()` |

Plugins use `api.scripts` and `api.styles`: the same calls, with relative sources resolved to the plugin's own `public/` files, its version as the default `ver`, and site-wide registrations removed on deactivation ([Plugins](plugins.md#scripts-styles-and-static-files)).

**Scope.** Called while a page renders (in `wp_enqueue_scripts`, a block's render callback, `wp_head`), these change that page only: each render starts from its own copy of the registrations. Called outside a render (when a plugin loads, on `init`), they change the site-wide registrations every page starts from; a handle enqueued there is on every public page.

**Semantics,** as `WP_Dependencies`:

- A handle is registered once; registering it again is ignored (returns `false`). Enqueueing an unregistered handle waits for it to be registered.
- Dependencies print first, every handle prints once per page (head and footer never repeat one), and a handle whose dependency is missing is not printed.
- `ver`: `undefined` is Pressbase's version, `null` none, a string that string. It is added as `?ver=` (before any `#fragment`). `handle?arg=1` adds a query argument.
- `inFooter` puts a script in the footer, unless a head script depends on it, which moves it to the head.
- `strategy: 'defer' | 'async'` adds the attribute and `data-wp-strategy`, when it is safe: a script that a blocking (no strategy) script depends on, or that has inline code after it, blocks; an `async` script that a deferred script depends on becomes `defer` (WordPress 6.3's `get_eligible_loading_strategy()`).
- `src: false` registers an alias: a handle that only groups dependencies or carries inline code.
- Inline code and `localize()` data are printed with `</script` / `</style` escaped; `localize()` JSON escapes `<`, `>` and `&`, and the variable name must be a JavaScript identifier.
- Sources are `http(s)`, protocol-relative or root-relative URLs (a relative path gets a leading `/`), passed through `escUrl()`.

Script tags use `wp_get_script_tag()`'s markup (`<script src="…" id="handle-js"></script>`); link and inline style tags keep `WP_Styles`' single quotes (`<link rel='stylesheet' id='handle-css' href='…' media='all' />`).

Not ported: script concatenation (`load-scripts.php`), script translations, conditional comments, RTL stylesheets, `fetchpriority`, script modules and the import map.

## Filters

| Filter | Arguments | Notes |
|---|---|---|
| `script_loader_src`, `style_loader_src` | `src, handle` | an empty string skips the tag |
| `script_loader_tag` | `tag, handle, src` | the whole tag, with its inline `before` / `after` scripts |
| `style_loader_tag` | `tag, handle, href, media` | the `<link>` |
| `wp_robots` | `robots` | `{ directive: true \| 'value' }`; defaults `max-image-preview: large`, or `noindex, nofollow` when the site discourages search engines |
| `pre_get_document_title` | `title` | a non-empty string replaces the title |
| `document_title_separator` | `separator` | default `&#8211;` |
| `document_title_parts` | `parts` | `{ title, page?, tagline?, site? }`, joined in that order; plain text, escaped at the end |
| `document_title` | `title` | the joined title, before escaping |
| `the_generator` | `html, type` | the generator meta tag; return `''` to drop it |
| `body_class` | `classes, extra` | the `<body>` classes (sanitised and de-duplicated after the filter) |
| `language_attributes` | `output, doctype` | the `<html>` attributes, e.g. `lang="en-US"`; printed as returned, so escape what you add |
