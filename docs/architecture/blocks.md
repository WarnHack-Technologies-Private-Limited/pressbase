# Blocks

How Pressbase parses, renders and serves blocks. Content is stored as WordPress block markup, so posts move between WordPress and Pressbase unchanged:

```html
<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">Hello</h3>
<!-- /wp:heading -->

<!-- wp:latest-posts {"postsToShow":3} /-->
```

There are two layers:

| Layer | Location | What it does |
|---|---|---|
| `@pressbase/blocks` | `packages/blocks` | Parser, serialiser, block type registry, renderer, escaping. No database, no kernel: the host injects a hook bus and services. |
| Core integration | `apps/core/src/blocks/` | `kernel.blocks`: the server-rendered core blocks, patterns, and do_blocks() wired to the kernel's data and hooks. REST routes in `apps/core/src/routes/blocks.ts`. |

## Static and dynamic blocks

- A **static** block (paragraph, heading, group, image…) is rendered by the editor when the post is saved. Its saved HTML is its output; the server only removes the delimiters and puts inner blocks in place. Static blocks need no registration on the server.
- A **dynamic** block has a `render` callback. Its output is produced on every view, from attributes and data: latest posts, categories, the post title of the post being shown. In the editor, dynamic blocks preview through `/wp/v2/block-renderer` (ServerSideRender).

## The pipeline

`kernel.blocks.render(content, { context, user, rest })` is WordPress's `do_blocks()`:

1. **Parse.** `parseBlocks(content)` returns WordPress's exact tree: `{ blockName, attrs, innerBlocks, innerHTML, innerContent }`. HTML outside blocks becomes freeform blocks (`blockName: null`); `innerContent` has a `null` wherever an inner block sits.
2. **Render each top-level block** (`render_block()`):
   1. `pre_render_block` filter: return a string to short-circuit.
   2. `render_block_data` filter: change the parsed block (attributes, inner blocks).
   3. `render_block_context` filter: change the context the block starts with. Top-level blocks start with `{ postId, postType }` of the post being rendered.
3. **WP_Block::render()** for every block, recursively:
   1. Attributes are prepared: values that don't match their schema are dropped, then defaults fill the gaps (`prepare_attributes_for_render()`).
   2. Inner blocks render first, each through the same three filters with its parent block as the last argument. Context flows down: a block passes everything it received, plus its `providesContext` attributes, and each block sees only the names in its `usesContext`.
   3. Dynamic blocks call `render(attributes, innerContent, block)`.
   4. `render_block`, then `render_block_{name}` filter the output.

`content.rendered` in `/wp/v2/posts`, `/wp/v2/pages` and revisions comes from this pipeline. Rendering is async: callbacks query the database.

### Safety

- **Escaping.** Render callbacks escape every value they print with `escHtml`, `escAttr` and `escUrl` (WordPress's `esc_html`, `esc_attr`, `esc_url`). `escUrl` rejects `javascript:`, `data:` and other schemes outside `wp_allowed_protocols()`.
- **Titles and excerpts** printed by dynamic blocks go through the title allow-list again, so `<script>` in a title saved by an administrator can't run inside a block. WordPress prints such titles raw; this is a deliberate hardening.
- **Recursion.** `block.withRecursionGuard(key, fn, fallback)` refuses to enter a render that is already in progress further up the tree. `core/block` uses it per pattern ID (a synced pattern that contains itself renders as nothing at the repeat), and `core/latest-posts` per post when showing full content. A depth cap (100) is the last line of defence.
- **Attribute JSON** is serialised with `--`, `<`, `>`, `&`, quotes and backslashes as unicode escapes, so it can never close the comment early.

## Registering a block

```ts
kernel.blocks.registerBlockType('my-plugin/notice', {
  title: 'Notice',
  category: 'widgets',
  attributes: {
    tone: { type: 'string', enum: ['info', 'warning'], default: 'info' },
  },
  usesContext: ['postId'],
  supports: { align: true, color: { background: true } },
  render: async (attributes, content, block) => {
    const { kernel } = block.services;
    const post = await kernel.posts.get(Number(block.context.postId));
    return `<div ${getBlockWrapperAttributes(block, { class: `is-${attributes.tone}` })}>
      ${escHtml(post?.title ?? '')}${content}
    </div>`;
  },
});
```

- Names are `namespace/name`, lowercase. Keys follow `block.json`, so a `block.json` file can be spread into the arguments.
- Every block gets the `lock` and `metadata` attributes; supports add theirs (`align`, `anchor`, `className`, `style`, `textColor`, `backgroundColor`, `gradient`, `fontSize`, `fontFamily`, `borderColor`, `layout`), as WordPress's block supports do.
- `block.services` in core is `{ kernel, user, rest }`. `block.context`, `block.innerBlocks`, `block.parent`, `block.renderContent()`, `block.renderInnerBlocks()`, `block.uniqueId()` and `block.withRecursionGuard()` are available too.
- `getBlockWrapperAttributes(block, extra)` builds the outer element's attributes: your classes first, then the block supports' classes and inline styles in WordPress's order — align, colours (text, background, gradient, link), custom class, the generated `wp-block-{name}` class, typography (preset or custom size, family, style, weight, line height, columns, decoration, transform, letter spacing, writing mode, text align), border (radius, colour, style, width, per side), spacing (padding, margin), dimensions (min height, height, width), shadow, `aria-label` and the anchor `id`. `__experimentalSkipSerialization` (whole feature or a list of sub-features) is honoured.
- Supports that depend on the active theme — layout (`is-layout-*`, `wp-container-*` classes and their CSS), elements, position, fluid font sizes and per-instance style variations — are applied by core's render filters. See [Themes](themes.md#block-supports-at-render-time).

The package works without core too:

```ts
import { BlockTypeRegistry, renderBlocks } from '@pressbase/blocks';
const registry = new BlockTypeRegistry<{ db: Db }>();
registry.register('demo/now', { render: () => `<time>${new Date().toISOString()}</time>` });
const html = await renderBlocks(content, { registry, hooks, services: { db }, context: { postId: 1 } });
```

## Server-rendered core blocks

Ported from `wp-includes/blocks/*.php`, with the same markup and class names so themes style them. Their attributes, context and supports come from WordPress's `block.json` files (`apps/core/src/blocks/metadata.ts`).

| Block | Data | Notes |
|---|---|---|
| `core/latest-posts` | `queryPosts` | Title, author, date, excerpt or full content, grid classes. Featured images arrive with Media. |
| `core/categories` | `kernel.terms` | List (with hierarchy and counts) or dropdown; any taxonomy. |
| `core/archives` | posts by month | Monthly or yearly, list or dropdown, with counts. |
| `core/tag-cloud` | `kernel.terms` | Sizes scaled as `wp_generate_tag_cloud()` does. |
| `core/page-list` | published pages | Nested; navigation classes when inside a Navigation block. |
| `core/search` | — | The search form; width, radius and custom colours. |
| `core/site-title`, `core/site-tagline` | options | Escaped on output. |
| `core/loginout` | current user | Links to the admin's login screen; "login as form" shows the link. |
| `core/block` | `wp_block` post | Synced pattern reference, with the recursion guard. |
| `core/post-title`, `core/post-date`, `core/post-excerpt`, `core/post-author-name`, `core/post-terms` | `postId` from context | Render nothing without a post. |
| `core/comments` | `postId` | Its saved wrapper with inner blocks; nothing when comments are closed and there are none. `legacy` renders a built-in classic layout. |
| `core/comment-template` | `kernel.comments.thread()` | The threaded list; renders its inner blocks once per comment with `commentId` in context. Paging from the `cpage` query variable. |
| `core/comment-author-name`, `core/comment-content`, `core/comment-date`, `core/comment-edit-link`, `core/comment-reply-link` | `commentId` from context | The edit link needs `edit_comment`; the reply link stops at `thread_comments_depth`. |
| `core/comments-title` | the post's `comment_count` | "4 responses to “Title”" and variants. |
| `core/comments-pagination`, `-previous`, `-next`, `-numbers` | comment pages | Only with `page_comments` on. |
| `core/post-comments-form` | Discussion settings | WordPress's `#respond` form, posting to `/wp-comments-post`. |
| `core/latest-comments` | approved comments on published posts | Avatars, dates, excerpts. |

| `core/template-part`, `core/pattern`, `core/post-content` | the active theme, patterns, the post | Theme templates. See [Themes](themes.md#template-blocks). |
| `core/query`, `core/post-template`, `core/query-pagination` (+ `-previous`, `-next`, `-numbers`), `core/query-title`, `core/query-no-results`, `core/term-description` | the main query or `queryPosts` | `inherit` uses the page's main query. |
| `core/navigation`, `core/navigation-link`, `core/navigation-submenu`, `core/home-link` | pages, `wp_navigation` | Page-list fallback, responsive overlay with a tiny script and a no-JS fallback. |
| `core/post-featured-image`, `core/post-navigation-link`, `core/read-more`, `core/post-author`, `core/avatar`, `core/site-logo` | media, adjacent posts, users | Avatars are initials, never Gravatar. |

Comment block metadata lives in `apps/core/src/blocks/comment-metadata.ts`. Render calls can pass `query` (the page's query variables) for the comment blocks; see [Comments](comments.md#showing-comments-blocks).

Every other WordPress core block (Group, Columns, Buttons, Image…) is registered on the server with its `block.json` (`apps/core/src/blocks/wordpress-blocks.ts`, generated by `scripts/generate-wordpress-data.mjs`), so block supports apply to it. Core blocks WordPress renders only on the server that Pressbase doesn't implement yet stay unregistered and render nothing in templates.

## Patterns

- **Registered patterns**: `kernel.blocks.registerBlockPattern(name, { title, content, categories, … })` and `registerBlockPatternCategory(name, { label, description })`. Core registers WordPress's pattern categories and six built-in patterns (hero, two columns of text, call to action, quote, about me, image and text) made of core blocks in exactly the markup the editor saves. Served by `/wp/v2/block-patterns/patterns` and `/categories`; `core/pattern` references inside are resolved before they're sent.
- **Synced patterns** are `wp_block` posts at `/wp/v2/blocks`. A post shows one with `<!-- wp:block {"ref":12} /-->`. Responses carry `title.raw` and `content.raw` in every context and no rendered fields, and `wp_pattern_sync_status` (`''` synced, `unsynced`, `partial`) as a top-level field; it is written through `meta.wp_pattern_sync_status`. Reading needs `edit_posts`, creating `publish_posts`.

## How it maps to WordPress

| WordPress | Pressbase |
|---|---|
| `class-wp-block-parser.php` (`parse_blocks()`) | `packages/blocks/src/parser.ts` |
| `serialize_block()`, `serialize_blocks()`, `serialize_block_attributes()` in `blocks.php` | `packages/blocks/src/serializer.ts` |
| `class-wp-block-type.php`, `class-wp-block-type-registry.php` | `packages/blocks/src/registry.ts` |
| `class-wp-block.php`, `render_block()`, `do_blocks()` | `packages/blocks/src/block.ts` |
| `get_block_wrapper_attributes()`, `block-supports/*.php` | `packages/blocks/src/supports.ts` |
| `rest_validate_value_from_schema()` (attribute subset) | `packages/blocks/src/schema.ts` |
| `esc_html()`, `esc_attr()`, `esc_url()`, `wp_strip_all_tags()` | `packages/blocks/src/escape.ts` |
| `wp-includes/blocks/*.php` | `apps/core/src/blocks/library/` |
| `WP_Block_Patterns_Registry`, `block-patterns.php` | `apps/core/src/blocks/patterns.ts`, `kernel.blocks` |
| REST block types, renderer, patterns, pattern categories, blocks controllers | `apps/core/src/routes/blocks.ts` |

## Not yet

- Block bindings, the Interactivity API directives and hooked blocks (Block Hooks API).
- Style variations registry, `variations` callbacks (`post-terms` taxonomy variations), `wp_pattern_category`.
- Asset handles (`editor_script_handles` and friends are empty: the admin bundles the editor).
- Duotone and responsive (per-viewport) block styles.
- `wpautop`, `wptexturize` and shortcodes in `the_content`.
