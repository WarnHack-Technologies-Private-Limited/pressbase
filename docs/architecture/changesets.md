# Changesets

A changeset is one draft across the global styles, templates and parts, pages, menus and a few options. Studio saves every edit into it; Preview shows the real site with the changes; Publish writes them all at once; Discard drops them. The decision is [ADR 0022](../adr/0022-changesets.md).

| Piece | Location | WordPress equivalent |
|---|---|---|
| The post type, publishing, discarding, previews | `apps/core/src/changesets/service.ts` (`kernel.changesets`) | `customize_changeset`, `WP_Customize_Manager::save_changeset_post()`, `_wp_customize_publish_changeset()`, `trash_changeset_post()` |
| Entity handlers | `apps/core/src/changesets/entities.ts` (`kernel.changesets.entities`) | `WP_Customize_Setting` and its subclasses |
| The preview overlay | `apps/core/src/changesets/preview.ts` | `WP_Customize_Setting::preview()`, `customize_changeset_uuid` |
| Transactions | `apps/core/src/transaction.ts` (`kernel.transaction()`) | — |
| REST | `apps/core/src/routes/changesets.ts` | admin-ajax `customize_save`, `customize_trash` |

## The changeset

A `customize_changeset` post, as in WordPress:

- **Slug:** a v4 UUID, the changeset's public name (`?changeset_uuid=…`).
- **Status:** `auto-draft` when started, `draft` once saved as a draft, `future` when scheduled, `publish` once published, `trash` when discarded. Only `auto-draft`, `draft` and `future` changesets can change.
- **Author:** who started it. One open changeset per user: starting another gives back the open one, unless the `customize_changeset_branching` filter returns `true`.
- **Content:** JSON, one entry per pending entity, as `save_changeset_post()` stores settings:

```json
{
  "wp_global_styles:pressbase": {
    "value": { "version": 3, "isGlobalStylesUserThemeJSON": true, "styles": { "color": { "background": "#3a5a40" } } },
    "type": "wp_global_styles", "user_id": 1, "date_modified_gmt": "2026-11-03T10:00:00.000Z"
  },
  "page:12": { "value": { "content": "<!-- wp:paragraph -->…" }, "type": "page", "user_id": 1, "date_modified_gmt": "…" },
  "wp_navigation:5": { "value": { "content": "<!-- wp:navigation-link {…} /-->" }, "type": "wp_navigation", … },
  "option:blogname": { "value": "Corner Bakery", "type": "option", … }
}
```

A published changeset is kept as a record of what went live together (WordPress trashes it, because its type has no revisions). The entities themselves get their usual revisions.

## Entries and entity handlers

An entry key is `{type}:{id}`. The handler registered for `type` does four things:

| Operation | When | Does |
|---|---|---|
| `validate(kernel, id, value, user)` | the entry is written | checks the value and prepares it for the user writing it (sanitised without `unfiltered_html`); throws `ChangesetEntryError` |
| `canEdit(kernel, id, value, user)` | written, and again when published, for the publisher | the per-entry permission |
| `apply(kernel, id, value, author)` | publishing, inside the transaction | writes it through the ordinary service |
| `preview(kernel, id, value, preview)` | a preview render | lays it over the `ChangesetPreview` |

Handlers apply in `order`: posts (10), global styles (20), options (30).

| Type | ID | Value | Permission |
|---|---|---|---|
| `page`, `wp_navigation` (and any post type registered with `postEntityHandler()`) | post ID, or slug | REST fields: `title`, `content`, `excerpt`, `status` (`publish`, `draft`, `pending`, `private`), `slug`, `parent`, `menu_order` | `edit_post` on the post; `publish_post` to publish it |
| `wp_global_styles` | theme stylesheet | `{ styles?, settings? }`, as `POST /wp/v2/global-styles/{id}` takes, prepared the same way (missing keys keep the stored value) | `edit_theme_options` |
| `option` | option name | the setting's value, checked by its schema | the setting's capability (`manage_options`; `edit_theme_options` for the header menu) |

Options a changeset may change: `blogname`, `blogdescription`, `show_on_front`, `page_on_front`, `page_for_posts`, `site_logo`, `site_icon`, `pressbase_navigation_fallback`. `kernel.changesets.allowOption(name)` adds one with a registered setting.

### Registering a post type

```ts
import { postEntityHandler } from './changesets/entities';

kernel.changesets.entities.register(postEntityHandler('wp_template_part'));
```

That is enough for posts that exist. For entries that name, by slug, a post that doesn't exist yet — a template part customised from a theme file — pass `create`, with the terms the new post gets, and optionally `find`, to look it up as the type does:

```ts
kernel.changesets.entities.register(
  postEntityHandler('wp_template_part', {
    create: { terms: async (kernel) => ({ wp_theme: [await kernel.themes.activeStylesheet()] }) },
    find: (kernel, id, type) => findTemplatePost(kernel, id, type), // e.g. `theme//slug`
  }),
);
```

Publishing then creates the post (status `publish`, the slug as its ID) and its terms. Creating needs the type's `create_posts` and `publish_posts`.

## Publishing

`POST /pressbase/v1/changesets/{uuid}/publish`, or `kernel.changesets.publish(changeset, user)`:

1. Every entry is checked against the publisher's rights (whoever wrote it). Any refusal: `400 transaction_fail`, nothing written.
2. In one database transaction (`kernel.transaction()`), the changeset becomes `publish`. Its `transition_post_status` listener (WordPress's `_wp_customize_publish_changeset()`) fires `customize_save`, then applies every entry through `kernel.posts`, `saveGlobalStyles()` and `kernel.options.set()`, so revisions, `save_post` and the other hooks run as for any save.
3. Anything that throws rolls the whole publish back: no post, revision, option or style changes. The options cache and the active theme's styles are reloaded, and the changeset stays open. An entry that no longer applies (a deleted page) answers `400 transaction_fail` with that entry; anything else `500 changeset_post_save_failure`.
4. Cache purges announced during the transaction are held (`holdCachePurges()` in `cache/invalidation.ts`) and sent once after commit. `customize_save_after` fires last.

Scheduling: saving with `date_gmt` in the future makes the changeset `future`; the `publish_future_post` event (or `publishDue()`) publishes it at that time through the same listener, in its own transaction. If that fails, the changeset goes back to `draft`.

### `kernel.transaction(fn)`

Runs `fn` in a database transaction that every service joins: while it runs, `kernel.db` is the transaction (AsyncLocalStorage), and the options store reads the database through the kernel. A nested call opens a savepoint. Inside it, always reach the database through `kernel.db`: on PGlite, a query on the connection itself would wait for the transaction to end. Hooks that send mail or HTTP requests during a transaction are not undone by a rollback.

## Preview

`?changeset_uuid={uuid}` on any public URL (WordPress's `customize_changeset_uuid` works too):

- For a **logged-in user who may manage the changeset** (its author, or anyone with `edit_theme_options`) while it's open, the page renders with the entries applied.
- For anyone else, or a published, discarded or unknown changeset, the live page renders.
- Either way the answer is `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`, and apps/web never caches a URL with the parameter (`cache-policy.ts`). A preview fires no purge and changes no cache.

The entries are laid over the content layer for that render only, in a `ChangesetPreview` held in AsyncLocalStorage:

| Read | Sees |
|---|---|
| `kernel.posts.get(id)` | the changed post; negative IDs are posts the changeset creates |
| `queryPosts()` | changed posts in place of their rows; dropped when they no longer match (status, slug, parent), added when they now do; created posts added to lookups by type, status, ID, slug, parent and term slug (`tax_query` with `field: 'slug'`) |
| The main query's page and post lookups by path or slug, the fallback menu | the changed post |
| `kernel.options.get()` for allow-listed options | the changeset's value (`pre_option_{name}`) |
| Global styles | `RenderRequest.theme`: the active theme with the changeset's user styles |

What it doesn't cover: a search, a meta query, or a page of results a changed post would move into, is answered by the database. New code that reads posts should use `kernel.posts.get()` or `queryPosts()` to be previewable.

The page also gets:

- `noindex` in the robots meta tag (`wp_robots_no_robots()`, as `WP_Customize_Manager::customize_preview_init()` adds it);
- a **Preview banner** first in the body (`wp_body_open`): how many changes are shown, **Back to Studio** (`/admin/studio?changeset_uuid=…`) and **Exit preview** (the same page without the parameter);
- same-site links that keep `changeset_uuid`, so browsing stays in the preview (redirects too).

## REST

All under `/wp-json/pressbase/v1/changesets`, for logged-in users who can edit content (`edit_posts`) or the theme:

| Route | Does |
|---|---|
| `GET /` | your open changesets, newest first |
| `POST /` `{ title?, entries? }` | starts a changeset (`201`), or returns your open one (`200`), then sets the entries |
| `GET /{uuid}` | one changeset |
| `POST /{uuid}` `{ entries?, title?, status?, date_gmt? }` | sets entries (`null` removes one); `status` is `auto-draft`, `draft` or `future`; `date_gmt` schedules |
| `POST /{uuid}/publish` | publishes |
| `DELETE /{uuid}` | discards (trashes, keeping the UUID) |

A changeset item: `id`, `uuid`, `status`, `date_gmt`, `modified_gmt`, `author`, `title`, `entries`, `count`, `preview_link`.

Errors use WordPress's codes: `transaction_fail` (400, with `data.entries`: per key `{ code, message }`; nothing is saved), `changeset_already_published` (409), `not_future_date`, `cannot_supply_date_for_auto_draft_changeset`, `changeset_invalid_uuid` (404), `rest_cannot_edit` (401/403), `changeset_post_save_failure` (500). Entry codes include `unrecognized`, `changeset_entry_forbidden`, `changeset_option_not_allowed`, `rest_post_invalid_id` and `rest_invalid_param`.

## Hooks

| Hook | Arguments | When |
|---|---|---|
| `customize_save` (action) | changeset, data | before the entries are written, inside the transaction |
| `customize_save_after` (action) | changeset, data | after commit |
| `customize_changeset_branching` (filter) | `false` | `true` allows more than one open changeset per user |
| `pre_option_{name}` (filter) | `false`, name, fallback | any option read; how previews answer allow-listed options |

## Not yet

- Sharing a preview link with someone who can't log in (v2 in the plan), locking a changeset while someone else edits it, and autosave revisions of changesets.
- Deleting old auto-draft changesets (WordPress's `wp_delete_auto_drafts()`).
- Previews of listings that need the database to decide membership (search, meta queries, other pages of results).
