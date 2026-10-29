# 0018: Live editor data for plugins: a small store on window.pressbase, not a @wordpress/data store

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Pressbase SEO's editor panel needs the post being edited, live: the search preview shows the title and description as they're typed, and the checks read the content, slug and featured image. It also writes post meta (`_yoast_wpseo_metadesc`…) that must save with the post. In Gutenberg a plugin does this with `@wordpress/data`: `useSelect((select) => select('core/editor').getEditedPostAttribute('title'))` and `useDispatch('core/editor').editPost({ meta })`.

Pressbase's admin embeds `@wordpress/block-editor`, not `@wordpress/editor`, so there is no `core/editor` store. The post lives in React state in `PostEditor` (`components/content/post-editor.tsx`): the sidebar's fields in a `form` object, the content as serialised markup that `BlockEditor` reports (debounced), dirty tracking by comparing with the last save, a local backup and a server autosave. Plugin modules load on every admin screen ([ADR 0011](0011-plugin-admin-extensions.md)), and `@wordpress/data` is only in the editor's lazily loaded chunk.

## Decision

**`window.pressbase.editor`: a framework-free store that `PostEditor` publishes a snapshot to and applies edits from, with Gutenberg's names.**

- `usePost()` / `usePost(selector)`: the snapshot, or one part of it, through `useSyncExternalStore`; a component re-renders only when its part changes.
- `getPost()`, `getEditedPostAttribute(name)`, `subscribe(listener)`: for code outside React.
- `editPost({ meta, slug, excerpt })`: merged into `PostEditor`'s form state, so edits are ordinary unsaved changes: the post shows "Unsaved changes", the browser backup keeps them, and the next save sends them (only the meta keys that changed, as Gutenberg sends edits).
- The snapshot uses REST field names (`title`, `content`, `slug`, `excerpt`, `status`, `featured_media`, `categories`, `tags`, `meta`, `link`) plus `blocks` (parsed on first read), `terms` with names, `permalink` (with the edited slug), `isDirty` and `isSaving`. It's frozen and replaced on every change.
- Only `meta`, `slug` and `excerpt` are writable. Other keys throw a `TypeError` naming the key; the title and content belong to the writer.

The store is in `lib/extensions/editor.ts` (tested in `editor.test.ts`), the hook in `components/extensions/host.tsx`.

## Consequences

- A Gutenberg plugin ports by renaming: `select('core/editor').getEditedPostAttribute('meta')` becomes `pressbase.editor.getEditedPostAttribute('meta')`, `editPost({ meta })` stays `editPost({ meta })`, and `useSelect` becomes `usePost(selector)`.
- `PostEditor` stays the one owner of the post; saving, autosave, backups and restore offers didn't change shape. Meta edits are part of the dirty check and the local backup. The server autosave still sends only the title, content and excerpt (as `WP_REST_Autosaves_Controller` stores), so meta edits stay unsaved after an autosave until the next save, and the browser copy protects them meanwhile.
- No `@wordpress/data` on the dashboard or the posts list; the store is about 150 lines.
- `content` follows typing with the editor's 300 ms debounce, so a preview lags slightly behind the keyboard; `blocks` are parsed from that content when first read, at most once per change.
- An inline selector that returns a new array or object on every call would re-render without end; return primitives or stable references, as with `useSelect`.
- Adding writable fields later (title, featured image) is backwards compatible; `apiVersion` stays 1.

## Alternatives considered

- **Register a `core/editor`-shaped `@wordpress/data` store** and expose `data.useSelect` / `data.useDispatch`. Closest to Gutenberg, but either `PostEditor` moves all its state into the store (a rewrite of saving, autosave and restore for one feature) or the two are synced both ways (two sources of truth, and loops). It would also put `@wordpress/data` on every admin screen, because modules load everywhere.
- **Pass the post as fill props** (`{ post, editPost }` to `PluginDocumentSettingPanel`'s function child). Small, but only works inside slots, re-renders every fill on every keystroke, and can't be read from a plugin's own sidebar logic or outside React.
- **Use `@wordpress/editor`.** It brings its own sidebar, header and saving, which Pressbase replaced with its own screen ([block editor](../architecture/block-editor.md)).
