# 0022: Changesets: one draft across styles, templates, pages, menus and options

- **Status:** Accepted
- **Date:** 2026-11-03

## Context

Studio, the visual site builder ([plan](../plans/visual-site-builder.md)), never edits the live site directly. A person (or the AI, through abilities) changes the global styles, the header and footer parts, a few pages, the menu and the site title together, previews the result on the real site, and then publishes or discards the whole set. Until now each of those saves went live on its own: `POST /wp/v2/global-styles/{id}`, `POST /wp/v2/pages/{id}`, `POST /wp/v2/navigation/{id}`, `POST /wp/v2/settings`.

WordPress solved the same problem for the Customizer with **changesets** (4.7): a `customize_changeset` post whose slug is a UUID and whose content is a JSON map of pending setting values (`WP_Customize_Manager::save_changeset_post()`); `?customize_changeset_uuid=` previews it; moving the post to `publish` (now, or by `publish_future_post` when scheduled) writes every value (`_wp_customize_publish_changeset()` → `_publish_changeset_values()`). Its settings are saved one by one, though, so a failure halfway leaves the site half changed.

Forces:

- Studio's pending entities are not Customizer settings. Pages, menus, templates and template parts are posts; global styles are a post per theme; only a few things are options.
- Another track builds `wp_template` / `wp_template_part` storage at the same time. Changesets must cover them without knowing their code, and without special cases in the renderer.
- Previews must use the real renderer, theme and blocks, and must not touch the page cache ([ADR 0008](0008-public-page-caching.md)).
- No database migrations if posts and meta can carry it.

## Decision

- **WordPress's model, WordPress's names.** The `customize_changeset` post type (not public, `title` and `author`, every capability mapped to `edit_theme_options` as `customize` maps there, `edit_published_posts` → `do_not_allow`), a v4 UUID slug, the statuses `auto-draft` → `draft` → `future` → `publish`, content as `{ "<key>": { value, type, user_id, date_modified_gmt } }`, hooks `customize_save` and `customize_save_after`, filter `customize_changeset_branching`, and the `transition_post_status` listener that publishes. Discarding trashes the post the way `trash_changeset_post()` does, keeping the UUID slug. A published changeset is kept (WordPress trashes it because its type has no revisions); it records what was published together.
- **Entries are entities, not settings.** An entry key is `{type}:{id}` — `page:12`, `wp_navigation:5`, `wp_global_styles:pressbase`, `option:blogname` — and a small **registry of entity handlers** (`kernel.changesets.entities`) gives each type four operations: `validate` (prepare and sanitise the value for the user writing it), `canEdit` (permission, per entry), `apply` (write it, inside the publish transaction) and `preview` (lay it over a preview). `postEntityHandler(type, options)` is generic over post types: core registers it for `page` and `wp_navigation`; templates and parts register with one line, and with `create` an entry can name by slug a post that doesn't exist yet (a part customised from a theme file), created on publish with its terms. Options are an allow-list (`blogname`, `blogdescription`, `show_on_front`, `page_on_front`, `page_for_posts`, `site_logo`, `site_icon`, `pressbase_navigation_fallback`), validated by their settings' schemas.
- **Permissions per entry.** Global styles need `edit_theme_options`; a page needs `edit_post` on it (and `publish_post` to publish it); options need their setting's capability. Anyone who can edit content may start a changeset, so an editor can stage page edits; entries they can't change are refused when written, and every entry is checked again against whoever publishes. A changeset is managed by its author or anyone with `edit_theme_options`. One open changeset per user, unless `customize_changeset_branching` says otherwise.
- **One transaction.** `kernel.transaction(fn)` runs `fn` in a database transaction that every service joins: `kernel.db` returns the transaction while it is open (AsyncLocalStorage), and the options store reads the database through the kernel. Publishing marks the changeset published inside the transaction; the `transition_post_status` listener writes the entries through the ordinary services (`kernel.posts.update()`, `saveGlobalStyles()`, `kernel.options.set()`), so revisions, hooks and validation behave as for any save. Any failure rolls everything back; the in-memory options and active theme styles are then reloaded.
- **One purge.** Cache purges announced while publishing are held (`holdCachePurges()`) and sent once after commit — none if it rolls back.
- **Preview as a request-scoped overlay.** `?changeset_uuid=` (or WordPress's `customize_changeset_uuid`) on any public URL, for a logged-in user who may manage the open changeset, renders inside a `ChangesetPreview` held in AsyncLocalStorage. The content layer consults it: `kernel.posts.get()`, `queryPosts()` (changed posts replace their rows, leave when they stop matching, join when they start; created posts join lookups by type, status, slug, ID, parent and term slug), the main query's singular lookups, the fallback menu, `pre_option_{name}` for allow-listed options, and the global styles through `RenderRequest.theme`. `renderPublicPage()` has one block for it; template resolution needs nothing of its own as long as it reads posts through those functions. Previews answer `private, no-store` with `X-Robots-Tag: noindex` and `wp_robots_no_robots()`, apps/web never caches a URL with the parameter, and a Preview banner offers Back to Studio and Exit. Same-site links carry the UUID, as the Customizer's preview script makes them do.

## Consequences

- Studio and the AI work on one draft and publish it atomically, through REST under `pressbase/v1/changesets` and the same services as every other save.
- A new entity type is one registration. The templates track only has to keep its lookups on `kernel.posts.get()` / `queryPosts()`.
- `kernel.transaction()` is now available to any feature that must change several things at once. Code inside it must reach the database through `kernel.db` (a captured `connection.db` would wait on PGlite's single connection forever). On PGlite, other requests wait while a publish runs.
- The overlay is precise for what Studio changes (content, titles, status, slugs of existing rows, new posts found by slug) but not for every query: a search, a meta query or a paginated listing that a changed post would move into is answered from the database. Those cases show the live site until publish.
- Side effects of hooks that run during a publish and talk to the outside world (mail, HTTP) are not rolled back. Core's own (cache purges) are held.
- Scheduled publishing works through the existing `publish_future_post` path; a scheduled changeset that fails goes back to `draft`.

## Alternatives considered

- **Port the Customizer settings API** (`WP_Customize_Setting` per value). Studio's entities are whole posts and theme.json documents; wrapping them in settings would add a layer without adding anything.
- **Preview by applying the changeset in a transaction and rolling it back after the render.** Perfect fidelity with no overlay code, but every preview would hold a transaction (and on PGlite the only connection) for the whole render, run save hooks, and leak through in-memory caches (options, theme styles) to concurrent requests.
- **Drafts on each entity** (a draft revision per page, a pending global styles post). No single thing to preview, publish or discard, and no atomic publish.
- **A changesets table.** Posts and meta already carry status, author, dates, trash and scheduling; a table would need a migration and its own versions of all of that.
