# Studio

Studio is Pressbase's site editor: a full-screen screen at `/admin/studio` where a site owner edits their pages in the real theme, header and footer included. It does what WordPress's *Appearance → Editor* does, with the direct feel the [plan](../plans/visual-site-builder.md#the-screen) describes. The decision to build our own editor around `@wordpress/block-editor`, rather than use `@wordpress/edit-site`, is in [ADR 0021](../adr/0021-site-editor-and-templates-storage.md#studio-shell).

This page covers the shell (#28): its layout, how the canvas is built, and where the rest of v0.8 plugs in.

![Studio, editing the home page](../assets/screenshots/studio-light.png)

## Opening Studio

- **Route:** `/admin/studio`, capability `edit_theme_options` (as `site-editor.php`). People without it see a notice and a way back. Authors opening their own pages is #29.
- **Menu:** its own item, *Design → Studio* (`lib/sections.ts`). *Appearance → Editor* (the Appearance tab, and `/admin/appearance/editor`) leads here.
- **Full-screen:** `AdminShell` renders `/admin/studio` without its sidebar and top bar (`isFullScreen()` in `components/shell/admin-shell.tsx`), keeping the toasts, the current user and plugins' UI modules.
- **Which page:** `?page={id}` opens that page; without it, the home page: the static front page (`show_on_front: page`), or the latest posts. The address follows the page picker, so a reload reopens the same page.
- **Loading:** `components/studio/index.tsx` loads Studio with `next/dynamic` (`ssr: false`) after the editor's translations, like the post editor.

## The screen

```
┌ TopBar ───────────────────────────────────────────────────────────────────────┐
│ ← Dashboard  [Home ▾]  [▭ ▯ ▯]  ↶ ↷              ✦ Ask AI (soon)  Preview  Publish │
├ Rail ┬ Panel ─────────┬ Canvas (iframe) ─────────────────────┬ Inspector ──────┤
│Pages │ Pages          │  ┌ Header · every page ───────────┐   │ Heading 3       │
│Elem. │ Home     Home  │  └────────────────────────────────┘   │ Content Style   │
│Sect. │ Menu           │   Fresh bread, every morning          │ Layout          │
│Layers│ About us       │  ┌ Footer · every page ───────────┐   │ Typography …    │
│Styles│                │  └────────────────────────────────┘   │                 │
│Media │ (#29 note)     ├ Breadcrumb: Site › Home › Hero › Heading │                 │
│AI    │                │                                       │                 │
└──────┴────────────────┴───────────────────────────────────────┴─────────────────┘
```

| Part | Component | What it does now | Built out by |
| --- | --- | --- | --- |
| Top bar | `top-bar.tsx` | Back to the dashboard; the page picker (a native `<select>` of the page tree, plus *Home (latest posts)* when there's no static front page); Desktop / Tablet / Mobile (canvas widths 100%, 768px, 390px); undo and redo; *Ask AI* (marked *Coming soon*, explains itself on click); Preview; Publish | #31 (Publish N, Discard), #63 (Ask AI), #49 (per-device styles), #33 (command palette) |
| Left rail | `rail.tsx` | Seven panels; the open one sits beside the canvas (over it on narrow screens). Escape closes it and returns focus to its button | see below |
| Canvas | `studio.tsx` | The page in its template, in the active theme | #30, #35–#37 |
| Breadcrumb | `breadcrumb.tsx` | Site › Page › Section › Block for the selection; each step selects that level | — |
| Inspector | `inspector.tsx` | Nothing selected: the page (status, template, how to edit). A template part: what it is and that editing it comes with #30. A block: its card and the Content / Style / Layout tabs | #32 (Simple / Advanced) |

### Left rail panels

Listed in `RAIL_PANELS` (`layout-model.ts`). Each panel names the issue that builds it out, so nothing looks broken:

| Panel | Today | Issue |
| --- | --- | --- |
| Pages | The page list; choosing one opens it | #29: tree, add, nest, reorder, set the home page |
| Elements | WordPress's block library (blocks, patterns, media) | #35: large tiles, drag and drop |
| Sections | A note | #44: the section library |
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

Both region blocks save as self-closing comments (their `save` returns `null`), so serializing the template gives back the template unchanged, and a region's inner blocks are that entity's content. `pageBlocks()` reads the page's blocks back out; `findRegions()` lists the regions, for #30 and #31.

Inside Studio, both blocks edit as plain containers of their inner blocks (`regions.tsx`, an `editor.BlockEdit` filter active only under `StudioRegionsProvider`), with the tag and classes the public site renders: `<header class="wp-block-template-part">` for a header part, `<div class="entry-content wp-block-post-content">` for the content. The post editor keeps WordPress's components.

### Which template

`templateCandidates()` (`site-model.ts`) follows core's template hierarchy for the page (`apps/core/src/frontend/hierarchy.ts`): `front-page` for the home page, then the page's chosen template, `page-{slug}` (URL-encoded first), `page-{id}`, `page`, `singular`, `index`. The latest posts use `front-page`, `home`, `index`. `pickTemplate()` takes the first one `/wp/v2/templates` lists, customised copies included. WordPress's editor makes the same choice in the browser.

Template-part blocks get the template's `theme` attribute when the canvas is built, as WordPress adds it when reading a template, so the block editor's labels find the part.

### What can be edited

`editingModes()` sets the block editing modes (`setBlockEditingMode()`):

| Where | Mode | Why |
| --- | --- | --- |
| The template (root) | `disabled` | The template's own blocks (the page title, the featured image, the layout groups) are shown, not edited |
| The page's content (`core/post-content`) | `default` | Everything in the page is editable inline |
| A template part | `default` for the part, `disabled` for its blocks | The header and footer can be selected as a whole ("Header · every page") but not changed until #30 makes them editable (`partsEditable`) |

Locked blocks without anything to show on the site (no featured image, no site logo) are hidden in the canvas (`canvas.css`). Sections from unsynced patterns stay fully editable (`disableContentOnlyForUnsyncedPatterns`).

### Styles

The iframe gets WordPress's content styles (`STUDIO_CANVAS_STYLESHEETS`: the post editor's list without `canvas.css` and the classic `block-library-theme.css`), then the active theme from `GET /wp-block-editor/v1/settings`:

- `styles`: the global stylesheet (preset variables, preset classes, theme styles, custom CSS), passed to `BlockCanvas`, which scopes it to the canvas as WordPress does;
- `__unstableResolvedAssets.styles`: the theme's `@font-face` rules, block style CSS and stylesheets;
- `__experimentalFeatures` and the derived settings: the theme's palette, font sizes and spacing in the inspector.

The block list has the `wp-site-blocks` class, so the theme's root layout rules apply as on the site. `studio-canvas.css` adds only the admin's focus colour and the template part outline and label.

### Devices

Desktop, Tablet and Mobile set the canvas frame's width (`DEVICES` in `layout-model.ts`: 100%, 768px, 390px, under WordPress 7.1's `tablet` and `mobile` breakpoints). The iframe is that wide, so the theme's media queries apply. Per-device styles are #49.

## Saving: Preview and Publish

Studio never saves to the live site on its own. Until #31 saves every edit to a changeset as it happens:

- **Publish** is available once the page's content differs from what was loaded (compared after a parse/serialize pass, so opening a page is never a change). It writes `page:{id}: { content }` to the user's open changeset (`POST /pressbase/v1/changesets`) and publishes it. If the draft also holds changes made elsewhere, a dialog says how many before publishing them all.
- **Preview** writes the same entry and opens the page with `?changeset_uuid=` in a new tab. Without changes it opens the live page.
- **Leaving** with unpublished changes: the browser asks (`beforeunload`), and switching pages asks to discard them.

#31 replaces this with debounced saving, *Publish N* with the list of changes, Discard, and resuming the open changeset.

## Keyboard and accessibility

- The first Tab stop is *Skip to the page*, then the top bar, the rail, the canvas, the breadcrumb and the inspector, in that order.
- In the canvas, WordPress's keyboard model applies: Tab enters at the first selectable block (the header), the arrow keys move between blocks, Enter starts editing, Escape returns to selecting. Ctrl/⌘+Z and Ctrl/⌘+Shift+Z (or Ctrl+Y) undo and redo from anywhere.
- The device switch is a fieldset of toggle buttons (`aria-pressed`); the rail buttons have `aria-expanded`; the inspector tabs are a WAI-ARIA tablist (arrow keys, Home, End); the breadcrumb is a `nav` with `aria-current="location"` on the last step, and each step says its level to screen readers ("Section: Hero").
- Landmarks: the top bar (`header`, with a visually hidden `h1`), `nav` *Studio panels*, the open panel (`aside`, labelled by its heading), `main` (the canvas and breadcrumb), `aside` *Settings*.
- Under 900px the inspector becomes a drawer opened by *Settings* in the top bar (Escape closes it), panels slide over the canvas, and the device switch and Ask AI are hidden. Under 600px the rail shows icons only and the canvas uses the whole width.
- Animations stop under `prefers-reduced-motion`.

## Where the next issues plug in

| Issue | Where |
| --- | --- |
| #29 Pages panel | `PagesList` in `rail.tsx`; `site-model.ts` (`pageTree()`); `initialTarget()` for *Edit with Studio* links (`/admin/studio?page={id}`) |
| #30 Header and footer | `editingModes(blocks, { partsEditable: true })`; `findRegions()` to save each part; the part summary in `inspector.tsx`; `regions.tsx` for the outline and label |
| #31 Changesets | `saveDraft()` / `publish()` in `studio.tsx`; split the tree with `pageBlocks()` and `findRegions()` |
| #32 Simple / Advanced | `INSPECTOR_TABS` in `layout-model.ts` |
| #33 Command palette | inside `ShortcutProvider` in `studio.tsx` |
| #34 History | `useStateWithHistory` in `StudioEditor` |
| #35 Elements | the `elements` panel in `rail.tsx` |
| #36 Context menu, #37 handles | the canvas in `StudioEditor` |
| #44 Sections, #50 Layers | their panels in `rail.tsx` |
| #49 Responsive editing | `DEVICES` and the `device` state |
| #62, #63 AI | the `ai` panel; `onAskAi` in the top bar |

## Tests

- `components/studio/canvas-model.test.ts`: composing the canvas, regions, editing modes, the breadcrumb.
- `components/studio/site-model.test.ts`: which page opens, template candidates, the page tree.
- `components/studio/layout-model.test.ts`: the tabs cover every inspector group; the rail's panels each name their issue; device widths.
- `apps/core/src/block-editor-settings.test.ts`: `/wp-block-editor/v1/settings`.
- `e2e/tests/studio.spec.ts`: opening a page with its header and footer, inline editing, undo and redo, the locked header, Publish through a changeset, and the keyboard path.

## Not yet

- Editing the page title, featured image and template in Studio (page details stay in Pages for now; #29).
- Saving header, footer and template edits (#30, #31).
- Resuming an open changeset when Studio opens (#31).
