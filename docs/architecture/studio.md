# Studio

Studio is Pressbase's site editor: a full-screen screen at `/admin/studio` where a site owner edits their pages in the real theme, header and footer included. It does what WordPress's *Appearance → Editor* does, with the direct feel the [plan](../plans/visual-site-builder.md#the-screen) describes. The decision to build our own editor around `@wordpress/block-editor`, rather than use `@wordpress/edit-site`, is in [ADR 0021](../adr/0021-site-editor-and-templates-storage.md#studio-shell).

This page covers the shell (#28), saving through the user's draft (#31), the header and footer in place (#30), the Pages panel (#29), the Sections panel and section toolbar (#44), and where the rest of v0.8 plugs in.

![Studio, editing the home page](../assets/screenshots/studio-light.png)

## Opening Studio

- **Route:** `/admin/studio`, capability `edit_theme_options` (as `site-editor.php`), or `edit_pages` to work on pages only: see [People without design rights](#people-without-design-rights). Anyone else sees a notice and a way back.
- **Edit with Studio:** a row action on each page in *Pages*, and a button in the editor's top bar for a saved page (it asks first if there are unsaved changes). Both open `/admin/studio?page={id}`.
- **Menu:** its own item, *Design → Studio* (`lib/sections.ts`). *Appearance → Editor* (the Appearance tab, and `/admin/appearance/editor`) leads here.
- **Full-screen:** `AdminShell` renders `/admin/studio` without its sidebar and top bar (`isFullScreen()` in `components/shell/admin-shell.tsx`), keeping the toasts, the current user and plugins' UI modules.
- **Which page:** `?page={id}` opens that page; without it, the home page: the static front page (`show_on_front: page`), or the latest posts. The address follows the page picker, so a reload reopens the same page (a page the draft adds has no ID yet, so it isn't in the address). The reading settings come from the REST index (`show_on_front`, `page_on_front`, as WordPress's `get_index()` gives them to anyone), so people without `manage_options` open the right home page too.
- **Which draft:** the user's open changeset (`GET /pressbase/v1/changesets`), or the one `?changeset_uuid=` names (a preview's *Back to Studio* link). See [Saving](#saving-the-draft-publish-preview-discard).
- **Loading:** `components/studio/index.tsx` loads Studio with `next/dynamic` (`ssr: false`) after the editor's translations, like the post editor.

## The screen

```
┌ TopBar ───────────────────────────────────────────────────────────────────────┐
│ ← Dashboard  [Home ▾]  [▭ ▯ ▯]  ↶ ↷   ✦ Ask AI (soon)  ✓ Draft saved  Preview  [Publish 2] │
├ Rail ┬ Panel ─────────┬ Canvas (iframe) ─────────────────────┬ Inspector ──────┤
│Pages │ Pages          │  ┌ Header · all pages ────────────┐   │ Heading 3       │
│Elem. │ Home     Home  │  └────────────────────────────────┘   │ Content Style   │
│Sect. │ Menu           │   Fresh bread, every morning          │ Layout          │
│Layers│ About us       │  ┌ Footer · all pages ────────────┐   │ Typography …    │
│Styles│                │  └────────────────────────────────┘   │                 │
│Media │ (#29 note)     ├ Breadcrumb: Site › Home › Hero › Heading │                 │
│AI    │                │                                       │                 │
└──────┴────────────────┴───────────────────────────────────────┴─────────────────┘
```

| Part | Component | What it does now | Built out by |
| --- | --- | --- | --- |
| Top bar | `top-bar.tsx`, `publish-panel.tsx` | Back to the dashboard; the page picker (a native `<select>` of the page tree, plus *Home (latest posts)* when there's no static front page); Desktop / Tablet / Mobile (canvas widths 100%, 768px, 390px); undo and redo; *Ask AI* (marked *Coming soon*, explains itself on click); whether the draft is saved; Preview; *Publish N* with the list of changes and *Discard all* | #63 (Ask AI), #49 (per-device styles), #33 (command palette) |
| Left rail | `rail.tsx` | Seven panels; the open one sits beside the canvas (over it on narrow screens). Escape closes it and returns focus to its button | see below |
| Canvas | `studio.tsx`, `regions.tsx` | The page in its template, in the active theme; the header and footer editable in place | #35–#37 |
| Breadcrumb | `breadcrumb.tsx` | Site › Page › Section › Block for the selection; each step selects that level | — |
| Inspector | `inspector.tsx` | Nothing selected: the page (status, its template to choose, how to edit). A template part: that it's on every page, and *Reset to theme* once it differs from the theme's. A block: its card and the Content / Style / Layout tabs, under a note when it sits in a part | #32 (Simple / Advanced) |

### Left rail panels

Listed in `RAIL_PANELS` (`layout-model.ts`). A built panel (`interim: 'built'`) gets its content from Studio; the others name the issue that builds them out, so nothing looks broken:

| Panel | Today | Issue |
| --- | --- | --- |
| Pages | Built (#29): the page tree; add, rename, reorder and nest pages, choose the home page. See [The Pages panel](#the-pages-panel) | — |
| Elements | WordPress's block library (blocks, patterns, media) | #35: large tiles, drag and drop |
| Sections | Built (#44): the section library, searchable, click or drag to add. See [The Sections panel](#the-sections-panel) | #45 (Swap layout) |
| Layers | WordPress's list view | #50: rename, hide per device, drag to nest |
| Styles | A note and a link to Appearance → Styles | #46, #47 |
| Media | A note | #58 |
| AI | A note | #62 |

### Inspector tabs

`INSPECTOR_TABS` (`layout-model.ts`) puts each of `@wordpress/block-editor`'s `InspectorControls` groups in one tab (a test checks every group is placed exactly once):

| Tab | Groups |
| --- | --- |
| Content | `default` (block settings), `content`, `list`, `bindings`, `advanced` (collapsed) |
| Style | block style variations, `styles`, `typography`, `color`, `background`, `elements`, `border`, `effects`, `filter` |
| Layout | `layout`, `dimensions`, `position` |

The inspector renders `InspectorControls.Slot` for the active tab's groups, so a block's own controls and block supports appear without Studio knowing about them; plugin blocks' controls too. A tab with nothing for the selected block says so. Simple and Advanced (#32) narrow these lists per mode.

The inspector's controls are WordPress's, so they sit in a light scope in dark mode, like the post editor's Block tab.

## The canvas

### One block tree

The canvas is the page's template with its *regions* filled in (`canvas-model.ts`, `composeCanvas()`):

- each `core/template-part` block gets the part's blocks (from `/wp/v2/template-parts`) as inner blocks;
- the first `core/post-content` block gets the page's blocks (from `/wp/v2/pages/{id}`).

So the whole canvas is one `BlockEditorProvider` value with one undo history (`useStateWithHistory`, as in the post editor), and undo and redo cover every edit on the screen. WordPress's own site editor keeps each part and the page as separate core-data entities with their own edits; one tree is simpler and makes the [changeset](changesets.md) the single place where edits are split per entity.

Both region blocks save as self-closing comments (their `save` returns `null`), so serializing the template gives back the template unchanged, and a region's inner blocks are that entity's content. `regionBlocks()` reads each region back out: the page's blocks (`pageBlocks()`) and each part's, by slug (the first copy, when a part shows twice); `findRegions()` lists them in order.

Inside Studio, both blocks edit as plain containers of their inner blocks (`regions.tsx`, an `editor.BlockEdit` filter active only under `StudioRegionsProvider`), with the tag and classes the public site renders: `<header class="wp-block-template-part">` for a header part, `<div class="entry-content wp-block-post-content">` for the content. A part also gets its label (*Header · all pages*) as a real element in the canvas, shown on hover and while it or anything in it is selected; clicking it selects the part as a whole. The post editor keeps WordPress's components.

### Which template

`templateCandidates()` (`site-model.ts`) follows core's template hierarchy for the page (`apps/core/src/frontend/hierarchy.ts`): `front-page` for the home page, then the page's chosen template, `page-{slug}` (URL-encoded first), `page-{id}`, `page`, `singular`, `index`. The latest posts use `front-page`, `home`, `index`. `pickTemplate()` takes the first one `/wp/v2/templates` lists, customised copies included. WordPress's editor makes the same choice in the browser.

Template-part blocks get the template's `theme` attribute when the canvas is built, as WordPress adds it when reading a template, so the block editor's labels find the part.

### What can be edited

`editingModes()` sets the block editing modes (`setBlockEditingMode()`):

| Where | Mode | Why |
| --- | --- | --- |
| The template (root) | `disabled` | The template's own blocks (the page title, the featured image, the layout groups) are shown, not edited |
| The page's content (`core/post-content`) | `default` | Everything in the page is editable inline |
| A template part | `default` | The header and footer are edited in place (#30). With `partsEditable: false` (people without `edit_theme_options`, #29) its blocks are `disabled`: the part is selectable as a whole but locked |

Locked blocks without anything to show on the site (no featured image, no site logo) are hidden in the canvas (`canvas.css`). In an editable part, the site logo block shows its placeholder, so a logo can be added. Sections from unsynced patterns stay fully editable (`disableContentOnlyForUnsyncedPatterns`).

### Which blocks

`editorSettings({ context: 'studio' })` offers the site-editing blocks the post editor leaves out (`STUDIO_BLOCKS` in `block-editor/blocks.ts`): `core/template-part`, `core/post-content`, `core/site-logo`, `core/site-title` and `core/site-tagline`. Everything else in `UNSUPPORTED_BLOCKS` stays out of both (`blocks.test.ts`).

### Styles

The iframe gets WordPress's content styles (`STUDIO_CANVAS_STYLESHEETS`: the post editor's list without `canvas.css` and the classic `block-library-theme.css`), then the active theme from `GET /wp-block-editor/v1/settings`:

- `styles`: the global stylesheet (preset variables, preset classes, theme styles, custom CSS), passed to `BlockCanvas`, which scopes it to the canvas as WordPress does;
- `__unstableResolvedAssets.styles`: the theme's `@font-face` rules, block style CSS and stylesheets;
- `__experimentalFeatures` and the derived settings: the theme's palette, font sizes and spacing in the inspector.

The block list has the `wp-site-blocks` class, so the theme's root layout rules apply as on the site. `studio-canvas.css` adds only the admin's focus colour and the template part outline and label.

### Devices

Desktop, Tablet and Mobile set the canvas frame's width (`DEVICES` in `layout-model.ts`: 100%, 768px, 390px, under WordPress 7.1's `tablet` and `mobile` breakpoints). The iframe is that wide, so the theme's media queries apply. Per-device styles are #49.

## Saving: the draft, Publish, Preview, Discard

Studio never writes to the live site on its own ([Principle 4](../plans/visual-site-builder.md#principles)). Every edit goes into the user's open [changeset](changesets.md), and only *Publish* makes it live.

![The Publish list: two changes, each with an undo button, then Discard all and Publish](../assets/screenshots/studio-publish.png)

### What the canvas saves

`StudioEditor` knows each region's *live* markup (what visitors see), its *initial* markup (what the canvas opened with: the draft's version, or live) and, for a part, the theme file's markup. A moment after an edit (300 ms; serializing is the expensive part) it works out each region's entry (`desiredEntry()` in `changes-model.ts`):

| The region now | Entry |
| --- | --- |
| Back to what visitors see | none (`null` removes it) |
| A customised part back to exactly the theme's file | `wp_template_part:{slug}: { source: "theme" }` (a reset; publishing deletes the copy) |
| Anything else | `page:{id}: { content }` or `wp_template_part:{slug}: { content }` |

A page's entry is shared with the Pages panel, which writes `title`, `parent`, `menu_order` and `template` into it: each side merges its own fields (`useDraft().wantFields()`, `mergeFields()` in `changes-model.ts`), and an entry left with no fields goes. *Undo* on a page in the Publish list takes out the whole entry: its text and its place.

Markup is compared after a parse/serialize pass, so opening a page is never a change. Only regions edited where the person is working count: a change arrives with the selection in the page or in a part (or comes from undoing one, a Reset or an undo in the Publish list). Blocks that adjust themselves elsewhere on the canvas (a block migrating old markup, say) don't make the header an edit. The Navigation block fills in its fallback menu's `ref` when it loads; that's the menu it shows anyway, so a part that differs only by that (`withoutNavigationRef()`) isn't edited. Once a part is edited, it's saved with the `ref`, so the header names its menu ([navigation.md](navigation.md#why-an-option)).

Some blocks edit records outside the tree, in core-data (`entity-edits.ts`): the site title, tagline and logo edit the site record (`/wp/v2/settings`), saved as `option:blogname`, `option:blogdescription`, `option:site_logo` and `option:site_icon`; the Navigation block edits its menu, saved as `wp_navigation:{id}: { content }`. Nothing goes to their REST routes. A resumed draft's entries are laid back over those records; Discard and Publish clear the edits.

### The draft

`use-draft.ts` keeps the changeset in step: 800 ms after the last change it sends what differs (`entriesPatch()`) with `POST /pressbase/v1/changesets`, which starts the user's changeset or returns their open one. One request at a time; edits made meanwhile go in the next. Values the server stored differently (sanitised for people without `unfiltered_html`) aren't sent again. The top bar says *Saving…*, *Draft saved*, or *Couldn’t save. Try again*.

| Action | Does |
| --- | --- |
| **Publish N** | N is the number of entries in the draft. The button opens a panel listing them in plain words (`describeChange()`: *Footer · On every page*, *About us · Page*, *Site title*), each with an undo button, then *Discard all* and *Publish N changes*. Publishing saves what's pending, then `POST /pressbase/v1/changesets/{uuid}/publish`: everything goes live together. |
| **Undo one change** | On the canvas: the region goes back to what visitors see (one undo step), and the draft follows. Elsewhere (another page, the site title): the entry is removed. |
| **Discard all** | Asks first, then `DELETE /pressbase/v1/changesets/{uuid}` and reopens the page as visitors see it. |
| **Preview** | Saves what's pending, then opens the page with `?changeset_uuid=` in a new tab (the live page when the draft is empty). The preview's *Back to Studio* opens `/admin/studio?changeset_uuid=…`. |
| **Another page** | Saves first, then opens it, with the header and footer as just edited. If saving fails, Studio asks before leaving the edits behind. |
| **Leaving** | While edits aren't saved yet (or saving failed), the browser asks first (`beforeunload`). Saved edits are safe in the draft. |

### Reopening

Studio opens with the user's open changeset: the canvas shows its pages and parts, a toast says how many changes aren't published yet, and if a page or part in it changed on the live site after the draft did (someone published it meanwhile; `changedSince()` compares the entry's `date_modified_gmt` with the page's `modified_gmt`, or the part's `modified` in the site's time zone), a note above the canvas names them: publishing the draft would replace their version.

## The Pages panel

`pages-panel.tsx`, with the arithmetic in `pages-model.ts`. It shows the site's pages as the draft leaves them (`draftPages()`): live pages with the draft's titles, places and templates laid over, then the pages the draft adds. Every change is a changeset entry, so nothing is live until Publish, and Preview shows it.

![The Pages panel: a page added and nested under another, waiting for Publish](../assets/screenshots/studio-pages.png)

| Action | How | Entry |
| --- | --- | --- |
| Open a page | Click it (Enter on the keyboard) | — |
| **Add page** | The button at the top; a title, then *Add page*. The page opens on the canvas, marked *New*, so its sections can be added at once | `page:{slug}: { title, status: "publish", parent: 0, menu_order }`. Core creates the page on Publish (`postEntityHandler('page', { create: {} })`); the slug comes from the title, made unique (`newPageSlug()`) |
| Rename | ⋯ → *Rename*, in place (Enter keeps it, Escape doesn't) | `title` |
| Reorder | Drag a page above or below another (a line shows where); ⋯ → *Move up* / *Move down*; or Alt+↑ / Alt+↓ on the page | `parent`, `menu_order` |
| Nest | Drag a page onto another (it's highlighted); ⋯ → *Put under …* (the page above) / *Move out of …*; or Alt+→ / Alt+← | `parent`, `menu_order` |
| Home page | ⋯ → *Make this the home page* (published pages, people with `manage_options`) | `option:show_on_front: "page"`, `option:page_on_front: {id}` |
| Template | The inspector, with nothing selected: *Template*, from `/wp/v2/templates?post_type=page` (custom templates for pages, as WordPress's `get_page_templates()`). The canvas reopens in it | `template` (`_wp_page_template`; `""` for the default) |
| Details | ⋯ → *Edit details in Pages* (address, excerpt, featured image…) | — |

- **Order:** a move puts the page at its new place among its new siblings and numbers them again 0, 1, 2… (`movePage()`), so the order holds even where every `menu_order` was 0. Only pages whose parent or number changes get an entry, and a field back to its live value leaves the entry.
- **New pages as parents:** a page can go under a page the draft adds: `parent` names it by slug, and core writes the parent first (`after()` in the entity handler, `orderEntries()`). A new page can be the home page once it's published (it has no ID before).
- **Moves are announced** in a polite live region ("Opening times moved. It's now under Visit us."), and the page keeps focus. A move that can't be (a page under itself or its own child page) says so and changes nothing.
- After Publish, Studio reloads the pages and reading settings, and a page the draft added opens again by its new ID.

### Core support

- `postEntityHandler()` takes `template` (checked against the type's templates, as `check_template()`; written as `_wp_page_template`, as `handle_template()`) and a `parent` given as a slug. A changeset preview shows the template (`ChangesetPreview.templates`, read by `pageTemplateOf()`).
- Previews find moved and created pages at their new address: `get_page_by_path()` (`pageByPath()` in `frontend/query.ts`) and `get_page_uri()` (`pagePath()` in `content/permalinks.ts`) read through the preview.
- REST: pages' `template` field is the chosen custom template (it was always `""`), and the index (`GET /wp-json/`) has `show_on_front`, `page_on_front`, `page_for_posts` and `timezone_string`, as WordPress's has.

### People without design rights

Someone who can edit pages but not the site's design (`edit_pages` without `edit_theme_options`, an Editor by default) can open Studio:

- The Pages panel lists the pages they may edit (their own only, without `edit_others_pages`); adding needs `publish_pages`, arranging `edit_others_pages` (a move renumbers sibling pages), choosing the home page `manage_options`.
- The header and footer are shown but locked (`editingModes(blocks, { partsEditable: false })`). Selecting one says why: *"only people who can change the site's design can edit it"*, in the inspector and above the canvas. The Styles panel says the same.
- Their changes go into their own draft, which core checks entry by entry (`edit_post` on each page).

## The Sections panel

`sections-panel.tsx`, with the grouping and search in `sections-model.ts`. It lists the patterns from `/wp/v2/block-patterns/patterns` that are page sections (`sectionsOf()`): shown in inserters, not for a template part, a header or footer, another post type or a whole new page (`core/post-content`).

![The Sections panel open at a place on the page, with the section toolbar](../assets/screenshots/studio-sections.png)

- **Order:** the Pressbase library first (core's `pressbase/*` patterns, `source: core`), then the theme's, then plugins' (marked *Theme* and *Plugin*).
- **Categories:** each section is filed under its first category that isn't *Featured* or the theme's own collection (`pressbase` for `pressbase/pricing`), so library, theme and plugin sections of one kind sit together. A picker narrows to one category (with every section in it).
- **Search:** every word must appear in the title, description, keywords or category names.
- **Previews:** `BlockPreview` from `@wordpress/block-editor`, inside Studio's editor, so they're drawn in the site's own styles. Each is drawn only once it scrolls near view (`IntersectionObserver`), so the panel opens fast.
- **Adding:** click a section (or Enter on it) to add it after the selected section, or at the end; or at the place ＋ *Add section* chose (*"Adding after “Breads”."*, with a button to clear it). Or drag it onto the page: the tile hands the canvas's drop zones the same `wp-blocks` data WordPress's inserter does. Each add is one undo step, saved to the draft like any edit.

### The section toolbar

`section-toolbar.tsx`. Hovering a top-level section (a direct child of the page's content) outlines it and shows a floating toolbar in its top right corner; it also shows for the section that holds the selection, so keyboard users get it too. It's drawn in Studio's document over the iframe, so it follows the canvas in the tab order (←/→ move between its buttons, `role="toolbar"`, labelled *"Section 2 of 3: Pricing"*).

| Button | Does |
| --- | --- |
| ↑ / ↓ | Move the section up or down (`moveBlocksUp/Down`); disabled at the top or bottom |
| ⧉ | Duplicate it |
| ✦ | Ask AI: disabled until #63, and says so |
| ⋯ | Select section, Add a section above / below, Remove section |

*＋ Add section* buttons sit on the section's top and bottom edges and open the Sections panel at that place. Everything here is also in WordPress's block toolbar and Layers.

## Header and footer in place

![Editing the header: its outline and label, the note over the canvas, and Header in the breadcrumb](../assets/screenshots/studio-header.png)

- Hovering a part outlines it with its label; selecting it, or anything in it, keeps a solid outline (`has-child-selected`).
- Before the first keystroke the UI says the part is on every page: a note floats over the bottom of the canvas (*You’re editing the Header. It’s on every page…*), and the inspector shows *In the Header: changes show on every page*, with a way to select the whole part.
- The part's own settings offer **Reset to theme** once it differs from the theme's design: a customised copy (`source: custom` with a theme file), or a part the draft changes. It puts the theme file's blocks on the canvas (`GET /wp/v2/template-parts/{id}?source=theme`), one undo step; publishing deletes the copy.
- Edits are saved as `wp_template_part:{slug}` entries, never straight to `/wp/v2/template-parts`. Publishing the first edit of a theme's part makes its customised copy ([changesets.md](changesets.md#templates-and-template-parts)).

## Keyboard and accessibility

- The first Tab stop is *Skip to the page*, then the top bar, the rail, the canvas, the breadcrumb and the inspector, in that order.
- In the canvas, WordPress's keyboard model applies: Tab enters at the first selectable block (the header), the arrow keys move between blocks, Enter starts editing, Escape returns to selecting. Ctrl/⌘+Z and Ctrl/⌘+Shift+Z (or Ctrl+Y) undo and redo from anywhere.
- The device switch is a fieldset of toggle buttons (`aria-pressed`); the rail buttons have `aria-expanded`; the inspector tabs are a WAI-ARIA tablist (arrow keys, Home, End); the breadcrumb is a `nav` with `aria-current="location"` on the last step, and each step says its level to screen readers ("Section: Hero").
- Landmarks: the top bar (`header`, with a visually hidden `h1`), `nav` *Studio panels*, the open panel (`aside`, labelled by its heading), `main` (the canvas and breadcrumb), `aside` *Settings*.
- Under 900px the inspector becomes a drawer opened by *Settings* in the top bar (Escape closes it), panels slide over the canvas, and the device switch and Ask AI are hidden. Under 600px the rail shows icons only and the canvas uses the whole width.
- Animations stop under `prefers-reduced-motion`.

| Dark | Mobile |
| --- | --- |
| ![Studio in dark mode, with the Pages panel open](../assets/screenshots/studio-dark.png) | ![Studio on a phone](../assets/screenshots/studio-mobile.png) |

## Where the next issues plug in

| Issue | Where |
| --- | --- |
| #46, #47 Styles | a `wp_global_styles:{stylesheet}` entry through `useDraft().want()`; `describeChange()` already names it |
| #32 Simple / Advanced | `INSPECTOR_TABS` in `layout-model.ts` |
| #33 Command palette | inside `ShortcutProvider` in `studio.tsx` |
| #34 History | `useStateWithHistory` in `StudioEditor` |
| #35 Elements | the `elements` panel in `rail.tsx` |
| #36 Context menu, #37 handles | the canvas in `StudioEditor` |
| #45 Swap layout | the section toolbar (`section-toolbar.tsx`, marked where ‹ 2/5 › goes) and the inspector |
| #50 Layers | its panel in `rail.tsx` |
| #49 Responsive editing | `DEVICES` and the `device` state |
| #62, #63 AI | the `ai` panel; `onAskAi` in the top bar |

## Tests

- `components/studio/canvas-model.test.ts`: composing the canvas, regions, editing modes, the part a block sits in, the Navigation block's fallback `ref`, the breadcrumb.
- `components/studio/changes-model.test.ts`: which entry a region needs (content, reset, none), what to send, the order and wording of the Publish list, the site record's options, and drafts overtaken on the live site.
- `components/block-editor/blocks.test.ts`: the site-editing blocks in Studio only.
- `apps/core/src/changesets.test.ts`: `source: theme` entries (reset a part).
- `components/studio/site-model.test.ts`: which page opens, template candidates, the page tree.
- `components/studio/pages-model.test.ts`: the draft's pages and home page, new pages' slugs and addresses, moves (up, down, in, out, drops), the entries they make, shared page entries, who opens which pages.
- `components/studio/sections-model.test.ts`: which patterns are sections, their order and categories, search.
- `apps/core/src/changesets.test.ts` (#29): pages created by slug, nested under a new page, with a template; a preview at the new address; refusals.
- `e2e/tests/studio-panels.spec.ts`: add a page, nest it (drag and keyboard), set the home page, publish; Edit with Studio from Pages and the editor; an editor with the header, footer and styles locked; a pricing section added between two others, moved with the toolbar and undone, then published.
- `components/studio/layout-model.test.ts`: the tabs cover every inspector group; the rail's panels each name their issue; device widths.
- `apps/core/src/block-editor-settings.test.ts`: `/wp-block-editor/v1/settings`.
- `e2e/tests/studio.spec.ts`: opening a page with its header and footer, inline editing, undo and redo, selecting the header, Publish through a changeset, and the keyboard path.
- `e2e/tests/studio-saving.spec.ts`: an edit saved to the draft, reopened, previewed and published; undoing one change from the list and Discard all; the footer edited on one page and shown on every page, then Reset to theme.

## Not yet

- The featured image, excerpt and address in Studio (⋯ → *Edit details in Pages*). A renamed page's Title block on the canvas shows the saved title until Publish (a page the draft adds shows its title: the template's Title block is drawn as a heading, `withDraftTitle()`).
- Making a page the draft adds the home page before it's published, and removing pages (trash isn't a changeset entry yet).
- Editing the template itself (the page title, layout groups).
- People without `edit_theme_options` see an empty Navigation block in the header: menus (`wp_navigation`) need that capability, as in WordPress.
- Undo and redo of edits made outside the block tree (site title, tagline, logo, menu items): core-data keeps their own history. Undo one from the Publish list instead.
- *Create new menu* in the Navigation block saves that menu straight away, as in WordPress; only pointing the header at it waits for Publish.
- Telling apart "someone else published" from "you saved it in another screen": both show the note on reopening.
