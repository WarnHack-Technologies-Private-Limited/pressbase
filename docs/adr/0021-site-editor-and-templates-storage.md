# 0021: The site editor shell and templates storage

- **Status:** Accepted (templates storage); the Studio shell is pending [#28](https://github.com/WarnHack-Technologies-Private-Limited/pressbase/issues/28)
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

*Pending [#28](https://github.com/WarnHack-Technologies-Private-Limited/pressbase/issues/28).* The plan's direction is our own editor around `@wordpress/block-editor` at `/admin/studio`, not `@wordpress/edit-site`, editing the templates and parts stored as described above through the REST routes. This section will record that decision when the shell is built.

## Consequences

- Sites, plugins and headless tools see WordPress's template data and API. Customised templates are stored as WordPress stores them, so the importer and exporter can carry them across without converting them. That hasn't been tested end to end yet.
- Each public page now makes one more posts query to resolve its template, and one more per template part (usually header and footer). These are indexed lookups by slug and type. WordPress does the same work, and the page cache absorbs it for visitors.
- Only the active theme's templates are listed and rendered, as in WordPress. Copies for other themes stay in the database and come back when their theme is active again. Deleting a theme leaves them, as with `wp_global_styles`.
- A plugin's `pre_get_block_templates` / `get_block_templates` filters (and the other lookup filters) can add or replace templates, as in WordPress. WordPress's plugin template registry (`register_block_template()`) and block hooks inside templates are not ported yet.
- Deferred: `/wp/v2/templates/lookup` (`get_template_hierarchy()`), `rest_pre_insert_{type}`, and the `plugin` field.

## Alternatives considered

- **A `templates` table, or one JSON option per theme.** Simpler queries, but it would differ from WordPress's data model, so imports, exports, revisions and the REST API would each need translation. Revisions and autosaves come free with posts.
- **Keep custom copies in memory with the theme** (like the theme files) and refresh on save. Faster, but it would bypass the content layer that changeset previews hook into, and add one more cache to invalidate across processes.
- **Find the theme by post slug, as `wp_global_styles` does** (`wp-global-styles-{stylesheet}`). That works for one post per theme but not for many templates per theme, and WordPress data (and WXR files) carry the `wp_theme` term.
