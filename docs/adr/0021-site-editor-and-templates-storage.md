# 0021: The site editor shell and templates storage

- **Status:** Accepted
- **Date:** 2026-11-03

## Context

Studio, the visual site builder planned for v0.8 ([plan](../plans/visual-site-builder.md)), edits a theme's templates and template parts, such as the header and footer. Until now Pressbase read them only from the active theme's `templates/*.html` and `parts/*.html`, cached in memory with the theme (`kernel.themes.active()`). Nothing a site owner changed could be stored.

The constraints:

- **WordPress compatibility.** WordPress stores an edited template as a `wp_template` or `wp_template_part` post, tagged with a `wp_theme` term that names the theme's stylesheet (and, for a part, a `wp_template_part_area` term). The theme's file is never touched. `get_block_templates()` puts a published post in front of the file with the same slug, and `/wp/v2/templates` and `/wp/v2/template-parts` expose both, with `source: theme | custom`. The block editor's data layer, WXR exports and headless tools all expect this shape.
- **No migrations if we can help it.** Posts, terms and meta already have everything this needs.
- **Changesets come next** ([ADR 0022](../plans/visual-site-builder.md#new-adrs), #26/#27). A changeset previews unsaved templates, styles and pages together. It will do that as an overlay on content reads, so template lookups must go through the ordinary content queries, not a separate cache.
- **The page cache** ([ADR 0008](0008-public-page-caching.md)) must drop pages when a template or part changes. Every page carries the `site` tag, and saving a non-public post type already purges it.

## Decision

### Templates storage

- **WordPress's model, unchanged.** `wp_template` and `wp_template_part` are registered as `create_initial_post_types()` registers them: not public, in REST at `templates` and `template-parts`, every capability mapped to `edit_theme_options`, supporting `title`, `excerpt`, `editor`, `revisions` and `author`. `wp_theme` (on templates, parts and `wp_global_styles`) and `wp_template_part_area` are registered as `create_initial_taxonomies()` registers them: not public and not in REST. A customised copy is a published post whose slug is the template's slug, whose `wp_theme` term's **name** is the stylesheet, and which has the meta `origin: theme`. Its description is the post excerpt. No migration.
- **One module, `apps/core/src/themes/templates.ts`,** ports `get_block_templates()`, `get_block_template()`, `get_block_file_template()`, `_build_block_template_result_from_post()` (with the titles WordPress gives untitled templates for one page, post, term or author), `_get_block_templates_files()`, `resolve_block_template()`, `locate_block_template()`, `get_default_block_template_types()` and `get_allowed_block_template_part_areas()`, with WordPress's filters. Templates come back as `BlockTemplate` objects (`WP_Block_Template`'s fields).
- **Reads go through `queryPosts()`.** Custom copies are found with a `tax_query` on `wp_theme` by name (a small addition to `content/query.ts`: `field: 'name'`), exactly as WordPress uses `WP_Query`. Nothing is cached apart from the theme files, which `kernel.themes` already holds. A changeset overlay on content queries therefore applies to templates with no extra work, and the queries record cache tags like any other.
- **The renderer and `core/template-part` resolve custom copies first.** `renderPage()` asks `locateBlockTemplate()` for the view's hierarchy, so a custom template with no file (`single-post-opening-hours`, made in Studio) takes part, and an empty customised template shows visitors the theme's file. `core/template-part` looks for the active theme's published copy and then the file, and fires `render_block_core_template_part_post`, `_file` or `_none`.
- **Writes are functions too.** `saveBlockTemplate()` and `deleteBlockTemplate()` hold the logic of the REST controller's `prepare_item_for_database()`, `update_item()`, `create_item()` and `delete_item()`, so Studio's server code and changeset publishing can save templates without making HTTP calls. They save through `kernel.posts`, so `save_post`, revisions and cache purges happen as for any post.
- **Slugs are unique per theme**, through a new `pre_wp_unique_post_slug` filter in `PostsService.uniqueSlug()` (WordPress's `wp_filter_wp_template_unique_post_slug()`). Template slugs also keep their theme file's name: `sanitizeSlug()` lowercases and turns `_` into `-`, which would stop `taxonomy-post_format-…` from matching its file, so the save writes the template's own slug afterwards.
- **REST.** `apps/core/src/routes/templates.ts` ports `WP_REST_Templates_Controller` and its revisions and autosaves controllers: list (`area`, `post_type`, `wp_id`), create, read (`?source=theme`), update (a theme file becomes a copy; `source: "theme"` resets), delete (trash, or `force`), revisions with pagination and forced deletion, and autosaves. IDs are `theme//slug`; `theme/slug` and URL-encoded IDs are accepted, as `_sanitize_template_id()` accepts them. Responses carry WordPress's fields in WordPress's order, with `core/pattern` blocks resolved (`resolve_pattern_blocks()`). Reading needs `edit_posts` (or any REST post type's `edit_posts`), and writing needs `edit_theme_options`.
- **Cache purges come from the existing rules.** The two post types are not public, so saving, trashing or deleting a published template or part purges `site` (`cache/invalidation.ts`). No new hook was needed.

### Studio shell

Built in [#28](https://github.com/WarnHack-Technologies-Private-Limited/pressbase/issues/28). Details: [Studio](../architecture/studio.md).

- **Our own editor around `@wordpress/block-editor`, not `@wordpress/edit-site`.** Edit-site expects WordPress's full core-data entity layer, PHP-printed settings and its own routing; the post editor already shows the lower-level packages work well in our admin. Studio is a screen at `/admin/studio` (`edit_theme_options`, as `site-editor.php`), full-screen, with its own admin menu item; *Appearance → Editor* leads there.
- **One kit for both editors.** The pieces the post editor had (setup, canvas assets, feature probes, plugin blocks, settings, undo shortcuts, notices, the inserter's Media tab) moved to `components/block-editor/kit.tsx`; the post editor and Studio both compose them, so they don't drift apart.
- **The canvas is one block tree.** The page's template is parsed, and its `core/template-part` and `core/post-content` blocks get the part's and the page's blocks as inner blocks. Both save as self-closing comments, so the template serializes back unchanged and each region's inner blocks are that entity's content. One `BlockEditorProvider` value and one undo history cover the whole screen; changesets (ADR 0022) are where edits split per entity. Inside Studio, those two blocks edit as plain containers (an `editor.BlockEdit` filter), instead of WordPress's components, which load each region as its own core-data entity with its own undo stack.
- **The template is locked, the page is editable.** Block editing modes: the root `disabled`, `core/post-content` `default`, each template part selectable as a whole with its blocks `disabled` until header and footer editing (#30) turns them on.
- **The theme's styles come from core.** A new `GET /wp-block-editor/v1/settings` (a port of Gutenberg's block editor settings controller, limited to what depends on the theme) returns the global styles split as `get_block_editor_settings()` splits them, the theme.json features, and the theme's fonts and stylesheets for the iframe. WordPress prints these into the editor page with PHP; Pressbase's admin is a separate app, so it asks.
- **The template follows core's hierarchy,** chosen in the browser from `/wp/v2/templates`, as WordPress's editor does; `/wp/v2/templates/lookup` stays unported.
- **Nothing is saved behind the user's back.** Preview and Publish write the page's content to the user's changeset only when asked; continuous saving to the changeset is #31.

## Consequences

- Sites, plugins and headless tools see WordPress's template data and API. Customised templates are stored as WordPress stores them, so the importer and exporter can carry them across without converting them. That hasn't been tested end to end yet.
- Each public page now makes one more posts query to resolve its template, and one more per template part (usually header and footer). These are indexed lookups by slug and type. WordPress does the same work, and the page cache absorbs it for visitors.
- Only the active theme's templates are listed and rendered, as in WordPress. Copies for other themes stay in the database and come back when their theme is active again. Deleting a theme leaves them, as with `wp_global_styles`.
- A plugin's `pre_get_block_templates` / `get_block_templates` filters (and the other lookup filters) can add or replace templates, as in WordPress. WordPress's plugin template registry (`register_block_template()`) and block hooks inside templates are not ported yet.
- Deferred: `/wp/v2/templates/lookup` (`get_template_hierarchy()`), `rest_pre_insert_{type}`, and the `plugin` field.
- Studio's canvas edits a copy of each region's content inside one tree. Anything that edits the same entities through core-data at the same time (the Navigation block's menus, the site title) is outside that tree and its undo history; #30 decides how those join it.

## Alternatives considered

- **A `templates` table, or one JSON option per theme.** Simpler queries, but it would differ from WordPress's data model, so imports, exports, revisions and the REST API would each need translation. Revisions and autosaves come free with posts.
- **Keep custom copies in memory with the theme** (like the theme files) and refresh on save. Faster, but it would bypass the content layer that changeset previews hook into, and add one more cache to invalidate across processes.
- **Find the theme by post slug, as `wp_global_styles` does** (`wp-global-styles-{stylesheet}`). That works for one post per theme but not for many templates per theme, and WordPress data (and WXR files) carry the `wp_theme` term.
- **`@wordpress/edit-site` for Studio.** WordPress's own site editor, ready-made, but built on core-data entities for everything (templates, parts, global styles, settings), PHP-printed editor settings and its own routing and layout. Adapting it would mean emulating much of wp-admin, and the Elementor-style interactions the plan asks for would fight its UI.
- **WordPress's template-part and post-content components in Studio, each region a core-data entity.** Closer to WordPress, but every region gets its own undo history and save path, and undo across "the footer, then the page" would need a coordinator. One tree with one history is simpler; the split happens once, when saving to the changeset.
