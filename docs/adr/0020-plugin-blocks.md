# 0020: Plugin blocks: server registration through api.blocks, editor modules through window.pressbase.blocks

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Pressbase SEO needs a Breadcrumbs block and an FAQ block, and the Forms plugin needs a form block ([plan](../plans/first-party-plugins.md#platform-work-first-plugin-api-gaps), gap 4). In WordPress a plugin calls `register_block_type()` (often with a `block.json`) in PHP, and an editor script calls `registerBlockType()` from `wp.blocks`, loaded as a `<script>` the block editor page enqueues.

Pressbase has the pieces separately: core's block registry and `render_block()` pipeline ([Blocks](../architecture/blocks.md)), plugins' runtime modules in the admin ([ADR 0011](0011-plugin-admin-extensions.md)), and Gutenberg embedded in the admin's lazily loaded editor chunk ([Block editor](../architecture/block-editor.md)). What was missing:

- **A plugin API.** `kernel.blocks` isn't reachable from plugins, and nothing took a plugin's blocks back on deactivation.
- **Editor code at runtime.** Plugins can't bundle Gutenberg (a second copy of `@wordpress/blocks` would have its own registry and its own React tree), and Gutenberg loads only on the editor screens, while plugin modules load on every screen.
- **Order.** The editor parsed the post before it learned the server's block types, so a saved plugin block parsed as `core/missing` and showed as unsupported.

## Decision

**On the server, `api.blocks.register()` (and `registerFromMetadata()` for a `block.json`) on top of core's registry, scoped to the plugin. In the editor, `window.pressbase.blocks.registerBlockType()` through a framework-free bridge that the editor connects to Gutenberg before it parses the post.**

- **Names** are `{plugin-slug}/{block}`. Arguments are block.json's keys; they're validated on registration (attribute types, defaults against their schema, `providesContext` naming an attribute…), so a mistake fails activation with a message.
- **Rendering** goes through `render_block()` unchanged: attributes are prepared against the schema (invalid values dropped, defaults filled), every filter runs. The render callback's output is **trusted HTML**, as WordPress trusts a `render_callback`; plugins escape what they print (`api.blocks.escHtml/escAttr/escUrl`, `getBlockWrapperAttributes`), as core's dynamic blocks do. A callback that throws is recorded against the plugin and renders nothing.
- **Deactivation** unregisters the block. Its saved markup stays in posts; on the public site it renders as WordPress renders an unregistered block: its saved HTML, which is nothing for a dynamic block. The editor shows `core/missing` for it with "This block’s plugin is inactive", keeping the markup.
- **Assets** use WordPress's handles (`generate_block_asset_handle()`: `daily-tips-tip-style`). `style` files (in `public/`) are registered site-wide and enqueued by a core `render_block` filter only during a public page render that shows the block, as `WP_Block::render()` enqueues `style_handles`. `/wp/v2/block-types` reports the handles.
- **The editor module** (`editorScript`, a `.js` file served like a UI module) is listed with the canvas styles in `/pressbase/v1/admin-extensions` under `blocks`. Before the editor parses the post, it imports these modules (attributed to their plugins), reads `/wp/v2/block-types` and registers each plugin block once, with the server's metadata and the module's `edit`/`save`. Dynamic blocks without a module get a ServerSideRender preview.
- **`window.pressbase.blocks`** has `registerBlockType` and the pieces an edit function needs (`useBlockProps`, `useInnerBlocksProps`, `InspectorControls`, `BlockControls`, `RichText`, `InnerBlocks`, `ServerSideRender`, and `components.PanelBody`, `TextControl`, `ToggleControl`, `SelectControl`, `Placeholder`). They're stable delegates resolved when called, so modules may destructure them at load time on any screen. `apiVersion` stays 1.
- **The page cache** is purged (`site`) once per tick when a plugin registers or unregisters a block.

## Consequences

- A WordPress block plugin ports by moving its PHP `register_block_type()` to `api.blocks.register()` (or keeping its `block.json`, with `render: "file:./render.js"`), and its editor script from `wp.blocks`/`wp.blockEditor`/`wp.components` to `window.pressbase.blocks`.
- Saved plugin blocks always parse as themselves, at the cost of the editor waiting for the block types and the modules (requests that ran anyway, now before the first paint of the canvas).
- Block attributes and context come from the server only: a module can't diverge from what the server validates and renders.
- Only five `@wordpress/components` are exposed. More can be added without changing `apiVersion`; each one is a public contract.
- Custom block categories (`block_categories_all`), view scripts, `viewScriptModule`, variations callbacks and block bindings aren't supported yet. A block in an unknown category shows in the inserter's uncategorised group.
- Static blocks keep their saved HTML after deactivation, unstyled, as in WordPress.

## Alternatives considered

- **Expose `window.wp`.** Familiar to WordPress developers, but it hands plugins every Gutenberg package as a public contract, on every screen, before Gutenberg has loaded. The delegates expose a small, versioned subset with the same names.
- **Let plugins bundle `@wordpress/blocks`.** A second registry and a second React: blocks registered there never reach the editor.
- **Render nothing for every unregistered plugin block, including static ones.** Simpler to explain, but it would hide content a writer typed, and it differs from WordPress, where content survives a deactivated plugin.
- **Sanitise render output with an allow-list (`wp_kses_post`).** WordPress doesn't for `render_callback`; it would break forms (the Forms plugin's block prints `<form>` and `<input>`), and the plugin's server code is already fully trusted.
