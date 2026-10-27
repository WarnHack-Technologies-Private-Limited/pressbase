# Content

How posts, pages, taxonomies and queries work in core. The code lives in `apps/core/src/content/`.

## The model

Everything a site publishes is a **post** row with a `type`. WordPress works the same way.

| Type | Registered by | Notes |
|---|---|---|
| `post` | core | Blog posts. Categories and tags. Revisions. |
| `page` | core | Hierarchical (`parent_id`), ordered (`menu_order`). Revisions. |
| `attachment` | core | Media library items. See [Media](media.md). |
| `revision` | core | Snapshots of a post's title, content and excerpt. |
| `wp_block` | core | Synced patterns (with the block editor). |

Each post type turns into a set of capabilities, e.g. `page` → `edit_pages`, `publish_pages`. That's `get_post_type_capabilities()` in WordPress. Roles grant those capabilities (see `auth/capabilities.ts`), and **meta capabilities** decide per object (see below).

### Registering a type or taxonomy

```ts
kernel.postTypes.register('book', {
  label: 'Books',
  singularLabel: 'Book',
  public: true,
  showInRest: true,
  restBase: 'books',
  supports: ['title', 'editor', 'author', 'revisions'],
});

kernel.taxonomies.register('genre', ['book'], {
  label: 'Genres',
  singularLabel: 'Genre',
  hierarchical: true,
  showInRest: true,
});
```

REST controllers are mounted when the app is built. Today only `post` and `page` get controllers; the plugin loader (v0.5) will register plugin types before routing.

### Statuses

| Status | Visible to | Notes |
|---|---|---|
| `publish` | everyone | |
| `future` | editors of the type | Becomes `publish` when its date arrives (see *Scheduling*). |
| `draft`, `pending` | editors of the type | `pending` means waiting for review. Contributors can't publish. |
| `private` | authors and people with `read_private_posts` | |
| `trash` | editors | Previous status kept in `_wp_trash_meta_status`. The slug gets a `__trashed` suffix. |

## Writing posts: `kernel.posts`

```ts
const post = await kernel.posts.insert('post', {
  title: 'Hello',
  content: '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->',
  status: 'publish',
  authorId: user.id,
  terms: { category: [3], post_tag: [7, 8] },
  filterHtml: !userCan(user, 'unfiltered_html'),
});
await kernel.posts.update(post.id, { status: 'draft' });
await kernel.posts.trash(post.id);   // restorable
await kernel.posts.untrash(post.id); // comes back as a draft (WordPress 5.6+)
await kernel.posts.delete(post.id);  // permanent: revisions, meta and term links too
```

What the service does for you, as WordPress does:
- **Slugs.** Generated from the title, sanitised (`sanitize_title`) and made unique per type, and per parent for hierarchical types (`about/team` and `careers/team` can coexist).
- **Default category.** Posts saved without a category get `default_category`.
- **Status from date.** `publish` with a future date becomes `future`, and vice versa.
- **Revisions.** A revision is stored whenever the title, content or excerpt changes.
- **Term counts.** These count published posts only, and are recalculated on every status change.
- **Hooks.** `transition_post_status`, `save_post`, `wp_insert_post`, trash and delete hooks. See [Hooks](hooks.md).

### Scheduling

Until the job queue arrives (v0.5), due `future` posts are published lazily: `kernel.posts.publishDue()` runs before every content query and post-count request. A scheduled post therefore appears the first time anyone asks for content after its date. That's indistinguishable for readers, but plugin `transition_post_status` callbacks run at that moment rather than at the exact minute.

## Reading posts: `queryPosts`

`queryPosts(kernel, args)` is Pressbase's `WP_Query`. It uses the same argument names:

```ts
const { posts, found, maxPages } = await queryPosts(kernel, {
  post_type: 'post',
  post_status: 'publish',
  s: 'launch',
  tax_query: [{ taxonomy: 'category', terms: [3] }],   // includes child categories
  meta_query: [{ key: 'rating', value: 4, compare: '>=' }],
  orderby: 'date',
  order: 'DESC',
  posts_per_page: 10,
  paged: 2,
});
```

- Search matches every word in the title, excerpt or content. Ordering by `relevance` puts title matches first.
- `tax_query` operators are `IN` (with children by default), `NOT IN` and `AND`.
- `meta_query` compares JSONB values as text, or as numbers when the value is a number.
- The `content_query_args` filter can change the arguments before every query, like `pre_get_posts`.

## Permissions: meta capabilities

`currentUserCan(kernel, user, cap, objectId)` ports `map_meta_cap()`:

| Meta capability | Maps to |
|---|---|
| `edit_post` / `delete_post` | Own draft: `edit_posts`. Own published post: `edit_published_posts`. Someone else's: `edit_others_posts`, plus `edit_published_posts` or `edit_private_posts` by status. Delete follows the same pattern with `delete_*`. The front page and posts page need `manage_options` to delete. |
| `read_post` | Public status: `read`. Own post: `read`. Private: `read_private_posts`. Otherwise: as `edit_post`. |
| `publish_post` | `publish_posts` of the type. |
| `edit_term`, `delete_term`, `assign_term` | The taxonomy's `edit_terms`, `delete_terms` and `assign_terms`. The default category can never be deleted. |
| `edit_user` | Yourself: always. Others: `edit_users`. |

## Sanitising

`content/sanitize.ts` is the counterpart of WordPress's kses:

- `sanitizePostContent()` allows WordPress's post HTML (`$allowedposttags`, abridged) and removes scripts, event handlers, styles and unsafe URL schemes.
- **Block delimiters** (`<!-- wp:name {json} -->`) are kept. Each one is validated, its JSON is re-encoded, and `--` is escaped so the comment can't be closed early.
- `sanitizePostTitle()` allows a few inline tags; `stripTags()` removes all of them.
- These run only for users without `unfiltered_html`. Administrators and editors keep raw HTML, as in WordPress.

## Rendering

`content.rendered` in the REST API is the content run through the block renderer (`kernel.blocks.render()`, WordPress's `do_blocks()`): static blocks give their saved HTML, dynamic blocks (latest posts, categories, post title…) render on the server with the post as their context. See [Blocks](blocks.md).

## The admin's writing view

The interim editor (`apps/admin/src/lib/simple-blocks.ts`) converts lightweight text into Gutenberg block markup:

- paragraphs;
- `##` headings;
- `-` and `1.` lists;
- `>` quotes;
- `---` separators;
- `**bold**`, `*italic*`, `` `code` `` and `[links](https://…)`.

It's lossless: content it can't represent exactly opens in **code view** instead, so nothing is silently changed.
