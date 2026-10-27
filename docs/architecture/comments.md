# Comments

How comments are stored, checked, moderated and shown. The code lives in `apps/core/src/comments/` (`kernel.comments`), `apps/core/src/routes/comments.ts` (REST), `apps/core/src/routes/comments-post.ts` (the classic form endpoint) and `apps/core/src/blocks/library/comments.ts` (blocks). The admin's screens are `/admin/comments` and `/admin/settings/discussion`.

## The model

A comment is a row in `comments` with WordPress's columns (see [Database](database.md)). `approved` holds WordPress's values:

| Stored | REST `status` | Meaning |
|---|---|---|
| `1` | `approved` | Visible on the site. |
| `0` | `hold` | Waiting for moderation ("Pending"). |
| `spam` | `spam` | Marked as spam. |
| `trash` | `trash` | In the Trash. The previous value is kept in `_wp_trash_meta_status` (commentmeta). |

`posts.comment_count` counts **approved** comments only (`wp_update_comment_count()`), and is recalculated after every insert, status change, edit and deletion. Replies point at their parent with `parent_id`; when a comment is deleted permanently its replies move up to its parent, as in WordPress.

## Writing comments: `kernel.comments`

```ts
// wp_handle_comment_submission() + wp_new_comment(): every check the public form gets.
await kernel.comments.handleSubmission({ postId, content, author, authorEmail, authorIp, agent }, user);

// wp_new_comment(): duplicate, flood and moderation checks, then insert.
await kernel.comments.newComment({ postId, parentId, content, ... }, { user });

await kernel.comments.setStatus(id, 'approve' | 'hold' | 'spam' | 'trash');
await kernel.comments.trash(id);    // remembers the status
await kernel.comments.untrash(id);  // back to that status, or pending
await kernel.comments.spam(id); await kernel.comments.unspam(id);
await kernel.comments.update(id, { content, author, ... }, { user });
await kernel.comments.delete(id);   // permanent
const { comments, found } = await kernel.comments.query({ post__in: [1], status: 'approve' });
```

### What happens to a new comment

The pipeline is WordPress's, in the same order:

1. **`preprocess_comment`** filters the incoming data.
2. **Normalising** (`wp_filter_comment()`): the name loses its tags, the URL must be `http(s)`, the IP is cleaned, and the content goes through **kses**: WordPress's `$allowedtags` (a, abbr, b, blockquote, cite, code, del, em, i, q, s, strike, strong) for users without `unfiltered_html`, and **always** for visitors and the public form. Every link gets `rel="nofollow ugc"` (`wp_rel_ugc()`). Field lengths are capped as `wp_check_comment_data_max_lengths()` does.
3. **A reply** must answer an approved or pending comment on the same post; otherwise it becomes top-level.
4. **Duplicates** (same post, parent, author or email, and content, not in the Trash) are refused: `comment_duplicate`, 409.
5. **Flood control**: a second comment from the same IP address (or user, or email) within 15 seconds is refused: `comment_flood`. Moderators are exempt. Plugins can override this through `wp_is_comment_flood`.
6. **The status** (`wp_check_comment_data()`):
   - the post's author and moderators are approved;
   - everyone else goes through `check_comment()`: held if **manual moderation** is on, if the comment has `comment_max_links` links or more, if any **moderation key** matches the name, email, URL, content, IP or user agent, or, with **"previously approved"** on, if the author has no approved comment yet;
   - any **disallowed key** match marks it as **spam** (tags are stripped first, so `<b>via</b>gra` is caught). WordPress 7.1 sends these to the Trash when `EMPTY_TRASH_DAYS` is set; Pressbase uses Spam so they stay reviewable.
   - `pre_comment_approved` has the last word.
7. **`wp_insert_comment`**, the post's count, then **`comment_post`**.

Before that, the REST API and the form endpoint check that the post exists, isn't a draft or in the Trash, can be read, and is **open** (`comments_open()`): its `comment_status`, and for posts, `close_comments_for_old_posts` / `close_comments_days_old`. With `comment_registration` on, visitors must log in; with `require_name_email` on, they must give a name and a valid email.

### Who may do what

| Action | Needs |
|---|---|
| Comment as a visitor | Nothing, when the post is open and registration isn't required. The `rest_allow_anonymous_comments` filter (true by default; false in WordPress) can turn this off for the REST API. |
| Comment as yourself | Being logged in. Posting as another user needs `moderate_comments`. |
| Set a status on create, or `author_ip` | `moderate_comments` |
| Edit, moderate or delete a comment | `edit_comment`: `moderate_comments`, or `edit_post` for the comment's post (so authors moderate comments on their own posts). |
| See emails, IPs, user agents, raw content | `context=edit`, which needs `moderate_comments` (lists) or `edit_comment` (one comment). |
| Read held, spam or trashed comments | `edit_comment`, or being the comment's logged-in author. |

## Showing comments: blocks

Themes (v0.4) show comments with WordPress's comment blocks, rendered on the server by `kernel.blocks`:

```html
<!-- wp:comments -->
<div class="wp-block-comments">
  <!-- wp:comments-title /-->
  <!-- wp:comment-template -->
    <!-- wp:comment-author-name /--> <!-- wp:comment-date /-->
    <!-- wp:comment-content /--> <!-- wp:comment-reply-link /-->
  <!-- /wp:comment-template -->
  <!-- wp:comments-pagination --> … <!-- /wp:comments-pagination -->
  <!-- wp:post-comments-form /-->
</div>
<!-- /wp:comments -->
```

- `core/comment-template` lists the post's approved comments (plus the viewer's own pending ones), oldest first or newest first (`comment_order`), as `<ol class="wp-block-comment-template">` with WordPress's `<li id="comment-N" class="comment even thread-even depth-1 parent byuser …">`. Replies nest in `<ol>` up to `thread_comments_depth`; deeper replies are listed at the deepest level. Each comment renders the template's inner blocks with `commentId` in their context.
- With `page_comments`, top-level comments are paged (`comments_per_page`); `default_comments_page` picks the page shown first. The page comes from the `cpage` query variable.
- `core/post-comments-form` prints WordPress's `#respond` form (`comment_form()`, with the block-theme submit button), posting to `/wp-comments-post`.
- `core/comment-reply-link` links to `?replytocom=N#respond`; the form then says "Leave a Reply to …" and sends `comment_parent`.
- `core/latest-comments` lists recent approved comments on published posts, with Gravatar avatars when `show_avatars` is on.

The page's query variables reach the blocks through `kernel.blocks.render(content, { query })`. The theme engine passes `cpage`, `replytocom`, `unapproved` and `moderation-hash` from the URL.

### Seeing your own pending comment

After a held comment, the form endpoint redirects to `…?unapproved=ID&moderation-hash=HASH#comment-ID`. The hash is an HMAC of the comment's ID and date with a per-site key (`pressbase_comment_hash_key`, created on first use), and it's honoured for 10 minutes, as WordPress does. The comment then shows to that visitor with "Your comment is awaiting moderation. This is a preview…", its markup stripped.

## The form endpoint: `POST /wp-comments-post`

WordPress's `wp-comments-post.php`, also at `/wp-comments-post.php`. It takes `application/x-www-form-urlencoded` (or multipart) fields `comment_post_ID`, `comment_parent`, `author`, `email`, `url`, `comment` and an optional `redirect_to`.

- **Success:** `302` to `redirect_to` when it points at the site's own host (`wp_safe_redirect()`), otherwise to the comment's link (`get_comment_link()`), with the moderation hash for held comments. The `comment_post_redirect` filter can change it.
- **Failure:** a small, escaped HTML page ("Your comment wasn't posted") with the reason and a link back, using WordPress's statuses: 400 for missing fields, 403 closed or not allowed, 404 no such post, 409 duplicate, 429 too fast.

Why it doesn't need the CSRF header is explained in [Security](security.md).

## Settings

Settings → Discussion maps to WordPress's options one to one. Only `default_comment_status` (and `default_ping_status`) are in WordPress's `/wp/v2/settings`; the rest are **Pressbase-exposed** through the same endpoint for the admin, registered in `apps/core/src/comments/options.ts`:

| Option | Default | Effect |
|---|---|---|
| `default_comment_status` | `open` | Comments on new posts (WordPress REST setting). |
| `require_name_email` | `true` | Visitors must give a name and email. |
| `comment_registration` | `false` | Only logged-in users may comment. |
| `close_comments_for_old_posts`, `close_comments_days_old` | `false`, `14` | Close comments on posts older than N days. |
| `thread_comments`, `thread_comments_depth` | `true`, `5` | Nested replies, and how deep (2–10). |
| `page_comments`, `comments_per_page`, `default_comments_page` | `false`, `50`, `newest` | Paging on the site. |
| `comment_order` | `asc` | Oldest or newest first. |
| `comment_moderation` | `false` | Hold every comment. |
| `comment_previously_approved` | `true` | Hold first-time commenters. |
| `comment_max_links` | `2` | Hold comments with this many links or more (0 = off). |
| `moderation_keys` | `''` | Hold matches (one per line, substring, case-insensitive). |
| `disallowed_keys` | `''` | Spam matches. |
| `show_avatars`, `avatar_rating`, `avatar_default` | `true`, `G`, `mystery` | Gravatar avatars in blocks and REST `author_avatar_urls`. |

WordPress stores these as `'1'`/`''` strings; Pressbase stores JSON booleans and numbers, and reads either.

## Hooks

Comment hooks use WordPress's names: `preprocess_comment`, `duplicate_comment_id`, `comment_duplicate_trigger`, `wp_is_comment_flood`, `comment_max_links_url`, `wp_check_comment_disallowed_list`, `pre_comment_approved`, `wp_insert_comment`, `comment_post`, `edit_comment`, `wp_set_comment_status`, `transition_comment_status`, `comment_{old}_to_{new}`, `comment_{status}_{type}`, `trash_comment` / `trashed_comment`, `untrash_comment` / `untrashed_comment`, `spam_comment` / `spammed_comment`, `unspam_comment` / `unspammed_comment`, `delete_comment` / `deleted_comment`, `wp_update_comment_count`, `comments_open`, `comment_text`, plus the REST ones. See [Hooks](hooks.md).

## Not yet

- **Notifications.** `comments/notify.ts` ports `wp_notify_moderator()` and `wp_notify_postauthor()` through `kernel.mail`.
  - A held comment emails the admin address, plus the post's author if they can moderate (`moderation_notify`).
  - An approved comment emails the post's author unless they wrote it (`comments_notify`).
  - The filters `notify_moderator`, `notify_post_author`, `comment_moderation_recipients` and `comment_notification_recipients` control them.
  - Emails are sent after the response, so visitors never wait on SMTP.
- **Commenter cookies.** WordPress remembers a visitor's name and email (with consent) and shows their pending comments for longer; Pressbase relies on the 10-minute moderation hash. `set_comment_cookies` fires so a plugin can add them.
- **Comments of trashed posts.** WordPress marks them `post-trashed` when the post goes to the Trash; Pressbase leaves them as they are (they're hidden with the post).
- **Password-protected posts** never show comment blocks yet (the post-password cookie arrives with the public site).
- Pingbacks and trackbacks are dropped on purpose; notes (block comments) aren't implemented; keyboard shortcuts on the Comments screen and the comment-reply.js script are not ported.
- The editor still hides the comment blocks from its inserter until themes can preview them (v0.4).
