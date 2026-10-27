# Block editor

The post and page editor is WordPress's block editor (Gutenberg), running inside Pressbase's admin. Content is saved as standard block markup (`<!-- wp:paragraph -->…`), so it moves between WordPress and Pressbase unchanged.

Code: `apps/admin/src/components/block-editor/` (the editor) and `apps/admin/src/components/content/post-editor.tsx` (the screen around it). Design notes: [Components](../design/components.md#block-editor-componentsblock-editor).

## Packages

| Package | Version | Used for |
|---|---|---|
| `@wordpress/block-editor` | 19.0.0 | Provider, iframed canvas, block toolbar, inserter, list view, inspector |
| `@wordpress/block-library` | 12.0.0 | `registerCoreBlocks()` |
| `@wordpress/blocks` | 17.0.0 | `parse()`, `serialize()`, registration |
| `@wordpress/components` | 43.0.0 | `Popover.Slot`, and the UI the editor is built from |
| `@wordpress/format-library` | 6.0.0 | Bold, italic, links… in rich text (imported for its side effect) |
| `@wordpress/api-fetch` | 8.0.0 | Every REST call the WordPress packages make |
| `@wordpress/data`, `@wordpress/compose` | 11.0.0, 9.0.0 | Stores; `useStateWithHistory` for undo/redo |
| `@wordpress/keyboard-shortcuts` | 6.0.0 | Shortcut provider, undo/redo shortcuts |
| `@wordpress/media-utils` | 6.0.0 | `uploadMedia()` against `/wp/v2/media` |
| `@wordpress/server-side-render` | 7.0.0 | Previews of server-only dynamic blocks |
| `@wordpress/notices`, `@wordpress/hooks`, `@wordpress/element` | 6.0.0, 5.0.0, 10.0.0 | Notices bridge; filters for later work |

All are GPL-2.0-or-later and declare `react ^18 || ^19`, so they run on React 19.3 directly. (The `wp-7.0` dist-tag releases still require React 18; the current majors don't.) Versions are pinned exactly. Upgrade them together, then bump `EDITOR_ASSETS_VERSION` in `assets.ts`.

## How it's loaded

- `components/block-editor/index.tsx` exports `BlockEditor` through `next/dynamic` with `ssr: false`. Gutenberg needs `window`, and the dynamic import keeps it out of every other admin page. Only the post and page editors download it (about 5.6 MB of JavaScript, 1.3 MB gzipped; the posts list is unchanged at ~0.5 MB). A skeleton with the canvas's shape shows while it loads.
- `@wordpress/vips/worker` is aliased to `vips-stub.ts` in `next.config.ts`. It's a 22 MB WebAssembly image processor that `@wordpress/upload-media` would only load for client-side media processing, which Pressbase leaves off.
- On first import, `block-editor.tsx` configures api-fetch, calls `registerCoreBlocks()` and makes **Custom HTML** (`core/html`) the handler for content that isn't block markup. WordPress uses the Classic block, which needs TinyMCE; Custom HTML keeps such content exactly as it was.

### Stylesheets

WordPress's CSS is served by `app/editor-assets/[name]/route.ts`, which reads the files from `node_modules` and is prerendered at build time. The list lives in `assets.ts`:

- **Admin page** (`UI_STYLESHEETS`): components, block-editor UI, block-library editor styles, format-library. They're rendered as React 19 `<link rel="stylesheet" precedence>` elements, so they load with the editor and never on other pages.
- **Canvas iframe** (`CANVAS_STYLESHEETS`): components, block-library front-end and theme styles, block-editor content styles, block-library editor styles, and `canvas.css`. They're passed as `__unstableResolvedAssets`, as WordPress does in `_wp_get_iframed_editor_assets()`.

`canvas.css` stands in for a theme until themes arrive in v0.4. It provides serif typography, a 680px content column (1000px wide), the title field, and the layout rules WordPress's global stylesheet would emit (`is-layout-flow`, `-constrained`, `-flex`, `-grid`).

## The editor component

```
ShortcutProvider (.root)
  BlockEditorProvider        value / onInput / onChange ← useStateWithHistory (undo, redo)
    toolbar                  Add block · Undo · Redo · List view · word count · Visual/Code
    SidePanel                Inserter library or list view
    BlockCanvas (iframe)     TitleField + BlockList
    portal → Block tab       BlockInspector, rendered into the sidebar's Block tab
    Popover.Slot             in a light scope
```

`PostEditor` owns the post. It gives `BlockEditor` the initial markup and gets back:

- `onReady(handle)`: `handle.getContent()` serializes the blocks on demand (saving, autosave, switching to Code); `handle.baseline` is the first parse/serialize pass, so opening a post never counts as a change.
- `onContentChange(markup)`: debounced (300 ms). It drives the "Unsaved changes" state, the word count and the browser copy.
- `onSelectionChange`: selecting a block opens the Block tab, and clearing the selection returns to the Post tab, as in WordPress.

To replace the content (loading a revision, restoring an autosave), `PostEditor` remounts the editor with a new `key`. **Code** view is a textarea over the raw markup; switching back parses it again.

## api-fetch

`api-fetch.ts` configures `@wordpress/api-fetch` once:

1. Root URL: `/wp-json/` on the admin origin, which `next.config.ts` proxies to core.
2. A middleware adds `X-Pressbase-Request: 1` (core's CSRF guard, see [Security](security.md)) and `credentials: 'same-origin'`.
3. The fetch handler turns `X-HTTP-Method-Override` back into the real method. api-fetch's built-in `httpV1Middleware` rewrites `PUT`/`PATCH`/`DELETE` as `POST` plus that header for old servers. Core uses real methods.

Covered by `api-fetch.test.ts`.

## Settings the editor receives

| Setting | Value |
|---|---|
| `allowedBlockTypes` | Every registered block except the unavailable ones (below) |
| `__experimentalBlockPatterns`, `…Categories` | From `/wp/v2/block-patterns/patterns` and `/categories`, mapped to camelCase as core-data does |
| `__experimentalReusableBlocks` | Synced patterns from `/wp/v2/blocks` |
| `mediaUpload` | `media-upload.ts`: `uploadMedia()` to `/wp/v2/media`, with `post` set to the current post |
| `imageEditing` | Only when `/wp/v2/media` exists |
| `__experimentalFetchLinkSuggestions` | `link-suggestions.ts`: searches posts and pages (WordPress uses `/wp/v2/search`) |
| `__experimentalCanUserUseUnfilteredHTML` | The user's `unfiltered_html` capability |
| `alignWide`, `bodyPlaceholder` | `true`, "Type / to choose a block" |

## Features that arrive separately

`features.ts` probes once per page load, in parallel. A route counts as present unless core answers `rest_no_route`. (A 401 or 403 means it exists.) The 404s of absent routes show in the browser console; they're expected.

| Probe | When it's missing |
|---|---|
| `/wp/v2/media` | Upload says "Uploading needs the media library, which isn’t available yet. Use “Insert from URL” instead." Image editing is off. |
| `/wp/v2/block-renderer/…` | Dynamic blocks (`DYNAMIC_BLOCKS` in `blocks.ts`: latest posts, archives, query loop, search…) are left out of the inserter. Existing ones still show, with ServerSideRender's error message. |
| `/wp/v2/block-types` | No server-only blocks. When present, dynamic blocks the browser doesn't know (plugins' blocks) are registered with a ServerSideRender preview (`server-blocks.tsx`). |
| `/wp/v2/block-patterns/*` | The Patterns tab says "No results found." |
| `/wp/v2/blocks` | Synced patterns (`core/block`) are left out of the inserter. |
| `/oembed/1.0/proxy` | Embeds (`core/embed`) are left out of the inserter. |

`UNSUPPORTED_BLOCKS` are never offered in v0.3. They are the Classic block (TinyMCE), footnotes (post meta through core-data), navigation and site-editing blocks (v0.4), and comment blocks (no endpoints yet).

### Adding or hiding a block

- Every core block is **registered**, so existing content always parses and renders. Hiding means leaving a block out of `allowedBlockTypes`.
- To hide a block for good, add it to `UNSUPPORTED_BLOCKS`. To tie it to a server feature, add a probe to `features.ts` and a rule to `unavailableReason()` in `blocks.ts`. Test the rule in `blocks.test.ts`.
- New dynamic core blocks (no `save`) go in `DYNAMIC_BLOCKS`.
- Plugin blocks that are only registered on the server appear automatically once `/wp/v2/block-types` reports them with `is_dynamic: true`.

### For the Media work

- `mediaUpload` already posts to `/wp/v2/media`; nothing changes once the route exists.
- A **Media Library** button in image, gallery, cover and other placeholders comes from the `editor.MediaUpload` filter: `addFilter('editor.MediaUpload', 'pressbase/media-upload', () => MediaPicker)` from `@wordpress/hooks`, before the editor mounts.
- The inserter's Media tab lists categories from the `inserterMediaCategories` setting.
- The Featured image panel goes in the Post tab of `post-editor.tsx`, after Publishing (the spot is marked).

## Autosave

Server side: `apps/core/src/routes/autosaves.ts` (route) and `content/autosaves.ts` (service), ported from `WP_REST_Autosaves_Controller` and `wp_get_post_autosave()`. See [REST API](rest-api.md).

- `POST /wp/v2/{posts|pages}/{id}/autosaves` with `title`, `content`, `excerpt`.
  - **The author's own draft** (`draft`, `auto-draft`): the post itself is updated, and no revision is stored (`saveRevision: false`, WordPress's `DOING_AUTOSAVE`). The response is the post, shaped as a revision.
  - **Anything else** (published, pending, someone else's draft): the user's autosave revision, slug `{id}-autosave-v1`. There's one per user per post, updated in place. If nothing differs from the post (`normalize_whitespace`) and an autosave exists, it's returned untouched. `wp_creating_autosave` fires before an update.
  - Pressbase has no post locks yet, so the lock check WordPress makes always passes.
- `GET …/autosaves` lists every autosave of the post. Autosaves are revisions, so `…/revisions` lists them too, as in WordPress; the editor's Revisions panel leaves them out.
- Deleting a post deletes its autosaves with its revisions.

In the admin (`post-editor.tsx`, helpers in `lib/autosave.ts`, tested in `lib/autosave.test.ts`):

1. Every 60 seconds, while there are unsaved changes, the editor posts an autosave. Drafts then show "All changes saved"; other posts show "Unsaved changes · autosaved 3:04 PM".
2. On every change (500 ms debounce) a copy goes to `localStorage` under `pressbase:editor-backup:{type}:{id|new}`. Saving clears it. New, never-saved posts are protected this way only, since they have no ID to autosave against.
3. On opening a post, `newerAutosave()` checks for an autosave by the current user that's newer than the post and different from it. If there is one, an info notice offers **Restore the autosave** or **Dismiss**. Otherwise a newer, different browser copy is offered (**Restore the changes** / **Dismiss**). Restoring loads the content, title and excerpt; nothing is saved until the writer saves.

## Keyboard

- ⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z (or Ctrl+Y): undo and redo, registered as `pressbase/editor/undo|redo`.
- ⌘/Ctrl+S saves. Key presses inside the canvas iframe are forwarded to the admin window by the block editor, so this works from inside the content too.
- Enter in the title moves to the first paragraph, adding one if needed.
- Gutenberg's own shortcuts work as in WordPress (`/` for the block menu, ⌘/Ctrl+Shift+D to duplicate, Shift+Alt+Z to remove, and so on).
- Add block → type to search → Tab twice to reach the results → Enter inserts the block and focuses it.

## Known limits

- The canvas, the inserter, the list view, the Block tab and popovers stay light in dark mode (WordPress's UI has no dark theme). See [Components](../design/components.md#block-editor-componentsblock-editor).
- Undo history is per editor session. It resets when the content is replaced (revision, autosave restore) or after switching from Code back to Visual.
- Blocks that edit other entities through core-data (footnotes, site title, navigation) are hidden until those entities have endpoints.
