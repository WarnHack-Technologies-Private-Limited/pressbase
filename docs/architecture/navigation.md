# Navigation menus

How Pressbase stores, edits and renders navigation menus. Menus work the way they do in a WordPress block theme: a menu is a `wp_navigation` post whose content is navigation block markup, and the Navigation block (`core/navigation`) shows it.

| Piece | Location | WordPress equivalent |
|---|---|---|
| The post type | `apps/core/src/content/post-types.ts` | `register_post_type( 'wp_navigation' )` in `create_initial_post_types()` (`wp-includes/post.php`) |
| Fallback menu | `apps/core/src/content/navigation.ts` | `WP_Navigation_Fallback` (`class-wp-navigation-fallback.php`) |
| REST | `/wp/v2/navigation` (`routes/posts.ts`), `routes/navigation.ts` | `WP_REST_Posts_Controller`, `WP_REST_Navigation_Fallback_Controller` |
| Rendering | `apps/core/src/blocks/library/navigation.ts`, `page-list.ts` | `blocks/navigation.php`, `navigation-link.php`, `navigation-submenu.php`, `home-link.php`, `page-list.php` |
| Menu editor | `apps/admin/src/components/appearance/menu-editor.tsx`, `lib/menus.ts` | The site editor's Navigation screen; `nav-menus.php` for classic themes |
| Block editor | `apps/admin/src/components/block-editor/blocks.ts`, `features.ts` | — |

## The `wp_navigation` post type

Registered with WordPress's arguments: not public (no URLs of its own, not searchable), `show_in_rest` at `rest_base` `navigation`, supports `title`, `editor` and `revisions`, and every capability except `read` mapped to `edit_theme_options`. So:

- only administrators (who hold `edit_theme_options`) can create, edit, publish or delete menus, or read drafts;
- **published menus are readable by anyone** at `/wp/v2/navigation`, as in WordPress (the menu is on every page anyway);
- the post's `link` is `?post_type=wp_navigation&p={id}` (`get_post_permalink()` for non-public types).

The content is block markup:

```html
<!-- wp:navigation-link {"label":"Home","type":"page","id":2,"url":"https://example.com/","kind":"post-type","isTopLevelLink":true} /-->
<!-- wp:navigation-submenu {"label":"About","type":"page","id":3,"url":"https://example.com/about/","kind":"post-type","isTopLevelItem":true} -->
<!-- wp:navigation-link {"label":"Team","type":"page","id":4,"url":"https://example.com/about/team/","kind":"post-type"} /-->
<!-- /wp:navigation-submenu -->
<!-- wp:navigation-link {"label":"Shop","url":"https://shop.example.com","kind":"custom","opensInNewTab":true,"isTopLevelLink":true} /-->
```

Menus are saved through `kernel.posts` like every other post, so `save_post`, `save_post_wp_navigation`, `wp_insert_post`, `transition_post_status`, `deleted_post` and friends fire. Anything that caches rendered pages should listen to those for `wp_navigation` too, and to `updated_option` for `pressbase_navigation_fallback` (below): both change the header of every page.

## Which menu a Navigation block shows

`WP_Navigation_Block_Renderer::get_inner_blocks()`, in order:

1. **`ref`**: the `wp_navigation` post with that ID, if it's published. (Blocks saved with the legacy `navigationMenuId` attribute still work.) A `ref` to a missing, draft or trashed menu falls through to the fallback, as in WordPress.
2. **Inner blocks** saved inside the block itself (Twenty Twenty-Five's footer columns, for example).
3. **The fallback** (`block_core_navigation_get_fallback_blocks()`), for a block with neither. Twenty Twenty-Five's header is one: `<!-- wp:navigation {"overlayBackgroundColor":"base","overlayTextColor":"contrast",…} /-->`.

The fallback is:

1. **The chosen menu**: the menu chosen in Appearance → Menus with **Use in the header**, stored as the ID in the `pressbase_navigation_fallback` option, while it's a published menu.
2. **The newest published menu**, as WordPress does.
3. **A page list** (`<!-- wp:page-list /-->`).

Then `block_core_navigation_render_fallback` and `block_core_navigation_render_inner_blocks` filter the blocks, and a menu that contains a Navigation block renders nothing (`block_core_navigation_block_tree_has_block_type()`).

### Why an option

Block themes have no menu locations. In WordPress you'd point the header at a menu by editing the header template part in the site editor, which stores a customised copy of the part (`wp_template_part`) with a `ref`. Pressbase doesn't customise templates yet, so the choice is recorded where the renderer already looks when a theme's block has no `ref`: the fallback. That keeps theme files untouched, works for any block theme whose header uses a ref-less Navigation block, and is easy to undo (set it to 0 and the newest menu shows again). Once the site editor arrives, editing the header part can write a real `ref`, and the option keeps working for themes that don't.

The `GET /wp-block-editor/v1/navigation-fallback` endpoint returns the same menu, so a Navigation block inserted in the block editor without a menu picks the header's menu, as it would in WordPress.

### Never written on a page view

WordPress's `WP_Navigation_Fallback::get_fallback()` *creates* a "Navigation" menu (a page list) the first time a fallback is needed, even while rendering the public site for an anonymous visitor. Pressbase only reads during a page render; the menu is created by the REST endpoint, which the block editor calls. What visitors see is the same page list either way.

## REST

| Method | Route | Permission | Notes |
|---|---|---|---|
| GET / POST | `/wp/v2/navigation` | read: anyone for published menus · create: `edit_theme_options` | The posts controller (same parameters). `OPTIONS` answers `Allow: GET, POST` or `GET`. |
| GET / POST / PUT / PATCH / DELETE | `/wp/v2/navigation/{id}` | `edit_post` / `delete_post` → `edit_theme_options` | Single responses carry `Allow`; edit-context items carry `_links.self[0].targetHints.allow`. Revisions at `…/revisions`. |
| GET | `/wp-block-editor/v1/navigation-fallback` | `edit_theme_options`, `edit_posts` | `{ id, _links }`; creates the page-list menu when there's none. `?_embed` adds `_embedded.self` with `status`, `title.raw` and `content.raw` (WordPress widens the embed context the same way). |
| GET / PUT | `/pressbase/v1/navigation-fallback` | `edit_theme_options` | `{ id, current }`: the chosen menu (0 for none) and the menu ref-less Navigation blocks show now (0: the page list). `PUT { id }` chooses a published menu, or 0 to go back to the newest. |
| POST | `/pressbase/v1/navigation-preview` | `edit_theme_options` | `{ content, title, url? }` → `{ status, html }`: the public page at `url` (default `/`) with this markup in place of the fallback menu. Nothing is saved; `Cache-Control: no-store`. |

## Rendering

The markup is WordPress's, so the block library's CSS (`/wp-includes/css/dist/block-library/style.min.css`) and themes style it:

- **Navigation**: `<nav class="… wp-block-navigation" aria-label="…">`, items in `<ul class="wp-block-navigation__container">`, the responsive overlay (`wp-block-navigation__responsive-container`, with the overlay colours as classes), layout classes (`items-justified-*`, `is-vertical`, `no-wrap`). The accessible name is `ariaLabel`, else the menu's title, else "Navigation" (WordPress leaves fallback menus unnamed; Pressbase names every `<nav>`), made unique per page ("Navigation 2").
- **Links** (`navigation-link`): `<li class="wp-block-navigation-item"><a class="wp-block-navigation-item__content" href="…"><span class="wp-block-navigation-item__label">…</span></a>`, with `target="_blank"`, `rel`, `title`, the description span, and `block_core_navigation_link_maybe_urldecode()`.
- **Submenus** (`navigation-submenu`): as WordPress's `submenuVisibility` says (`hover` by default, `click`, `always`). On hover with submenu icons, the label stays a link and a toggle follows it: `<button aria-label="About submenu" class="wp-block-navigation__submenu-icon wp-block-navigation-submenu__toggle" aria-expanded="false">`. On click, the label itself is the toggle button. The submenu list takes the Navigation block's overlay colours (`has-base-background-color`…), so dropdowns stay readable on any header.
- **Current items**: an item whose `id` and `kind` match the page being shown gets `current-menu-item` and `aria-current="page"`; a submenu containing it gets `current-menu-ancestor`. The home link is current on the front page (and the blog home when it isn't the posts page); the page list marks the current page and its ancestors.
- **Unpublished targets**: links to posts and pages render only while the target is published (`block_core_shared_navigation_item_should_render()`, filter `render_block_core_navigation_link_allowed_post_status`), so trashing a page removes it from menus.
- **Escaping**: labels and descriptions go through the title allow-list (`wp_kses_post()`'s job: no scripts, no event handlers), `href` through `escUrl()` (`javascript:`, `data:` and other schemes outside `wp_allowed_protocols()` become an empty `href`), `rel` and `title` through `escAttr()`. Custom colours must look like colours to reach a `style` attribute.

### Interactivity without the Interactivity API

WordPress drives menus with `@wordpress/block-library/navigation/view` on the Interactivity API. Pressbase prints one small inline script (`NAVIGATION_SCRIPT`) when a page has a responsive menu or a submenu toggle:

- the menu button opens the overlay as a modal dialog (`role="dialog"`, `aria-modal`), focuses the close button, keeps Tab inside, and Escape or Close returns focus to the menu button;
- a submenu toggle flips `aria-expanded`, which the block library's CSS uses to show the submenu; opening one closes its open siblings; Escape closes the submenu that has focus and returns focus to its toggle; focus leaving a submenu, or a click elsewhere, closes it;
- hover opens submenus with CSS, as in WordPress.

**Without JavaScript**, a `<noscript>` style shows the overlay's items in place of the menu button and opens a submenu whenever something in it has keyboard focus (`:focus-within`), so every link stays reachable with the keyboard.

## Appearance → Menus

`/admin/appearance/menus` (capability `edit_theme_options`) is a focused menu editor rather than a site editor:

- **Menus**: the menu to edit (a select when there are several), **New menu**, rename, **Delete menu** (asks first). Creating a menu never changes the header by itself: if the header was showing the newest menu by default, that menu is chosen explicitly first. With no menus, the empty state offers **Create a menu from your pages** (links nested like the pages) or an empty one.
- **Use in the header** sets `pressbase_navigation_fallback`; the menu that's in the header shows a badge.
- **Structure**: items as a tree. Drag an item by its handle (before, after, or onto a link to nest it), or use the keyboard: with the handle focused, ↑/↓ move it among its siblings, → puts it in the submenu of the item above, ← takes it out. Each item's panel has the same moves as buttons ("Move up", "Into submenu of “About”", "Out of “About”"), WordPress's classic menu screen's pattern. Moves are announced in a polite live region, and focus stays on the control used.
- **Items**: label, link (custom links), description, open in a new tab; **Remove from menu** (with Undo). A Page List item can be replaced with page links. Other blocks in a menu (Search, Social icons…) are kept as they are.
- **Add items** from Pages, Posts, Categories (searched with `/wp/v2/search`) or a custom link (web addresses, paths, `mailto:` and `tel:` only), plus a home link. New items go at the end.
- **Preview**: the site's header with the menu as it is now, saved or not, at desktop or mobile width, in a sandboxed frame (`allow-scripts` only, links disabled), so the mobile overlay can be tried.
- **Save menu** in the save bar writes `title` and `content` (the serialised tree) to `/wp/v2/navigation/{id}`.

The tree model and its operations are pure functions in `apps/admin/src/lib/menus.ts` (`parseMenu`, `serializeMenu`, `moveItem`, `dropItem`, `canMove`, `canDrop`…), tested in `menus.test.ts`. Nesting is limited to five levels (the block's `maxNestingLevel`), and only links can hold a submenu. Attributes the editor doesn't show (`rel`, `title`, styles, metadata) are kept on save.

## The Navigation block in the block editor

`core/navigation`, `navigation-link`, `navigation-submenu`, `home-link`, `page-list` and `page-list-item` are offered once the `navigation` feature probe finds `/wp/v2/navigation` (and, being dynamic, once core reports them in `/wp/v2/block-types`). The block's own menu selector lists menus from `/wp/v2/navigation`, checks permissions with `OPTIONS` (the `Allow` header), and a new block without a menu starts from `/wp-block-editor/v1/navigation-fallback`, which is the header's menu. `core/navigation-overlay-close` (custom overlays) stays hidden. When the post is saved, menus the block edited are saved too (`BlockEditorHandle.saveMenus()`).

## Not yet

- Classic menus (`nav_menu` terms, `/wp/v2/menus`, `/wp/v2/menu-items`, `/wp/v2/menu-locations`) and `WP_Classic_To_Block_Menu_Converter`: there are no classic menus to convert. The importer (v0.6) should convert a WordPress site's classic menus into `wp_navigation` posts the way the converter does.
- Custom overlays (`overlay` template parts, `core/navigation-overlay-close`), `__unstableLocation`, Block Hooks in menus.
- Menu edits made through a Navigation block in the post editor are saved when the post is saved (the dirty `wp_navigation` records core-data holds, as WordPress's multi-entity save does), but the post's "Unsaved changes" state doesn't notice menu-only edits. Appearance → Menus is the place to edit menus.
- The Navigation block asks for classic menus (`GET /wp/v2/menus`) and settings permissions (`OPTIONS /wp/v2/settings`); both answer 404 (`rest_no_route`) and the block carries on, but the requests show in the browser console.
- Post type archive links as current items (no custom post type archives yet).
