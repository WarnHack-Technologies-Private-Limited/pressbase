# Hooks: actions and filters

`@pressbase/hooks` is the backbone of extensibility, as `WP_Hook` is in WordPress. The kernel owns one `HookBus`: `kernel.hooks`.

## The API

```ts
import { HookBus } from '@pressbase/hooks';
const hooks = new HookBus();

// Filters change a value and return it.
const off = hooks.addFilter('the_title', (title, postId) => title.trim(), 10);
const title = await hooks.applyFilters('the_title', rawTitle, 42);
off(); // remove this callback

// Actions run side effects.
hooks.addAction(
  'save_post',
  async (postId) => {
    /* … */
  },
  20,
);
await hooks.doAction('save_post', 42);
hooks.didAction('save_post'); // → 1
```

| WordPress                                           | Pressbase                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `add_filter($name, $cb, $priority)`                 | `hooks.addFilter(name, cb, priority = 10)`. Returns an unsubscribe function.                    |
| `apply_filters($name, $value, ...$args)`            | `await hooks.applyFilters(name, value, ...args)`                                                |
| —                                                   | `hooks.applyFiltersSync(...)`: throws if a callback is async                                    |
| `remove_filter`, `remove_all_filters`, `has_filter` | `removeFilter`, `removeAllFilters`, `hasFilter`                                                 |
| `add_action`, `do_action`, `did_action`             | `addAction`, `await doAction`, `didAction` (plus `doActionSync`)                                |
| `$accepted_args`                                    | Not needed; JavaScript ignores extra arguments.                                                 |
| `current_filter()`, `doing_filter()`                | Not provided: unreliable with concurrent async requests. Pass context in the arguments instead. |

## Semantics

- **Order:** ascending priority, then the order callbacks were added.
- **Async:** each callback is awaited before the next one runs.
- **Snapshot:** callbacks added or removed while a hook is running take effect from the next run.
- **Errors:** propagate to the caller. Core will isolate plugin failures when the plugin loader lands (v0.5).

## Typing hook names

Declare a hook's arguments once and every `addFilter` and `applyFilters` call is type-checked:

```ts
declare module '@pressbase/hooks' {
  interface FilterRegistry {
    the_title: [title: string, postId: number];
  }
  interface ActionRegistry {
    save_post: [postId: number];
  }
}
```

Undeclared names still work, with `unknown` arguments.

## Hooks core fires today

| Hook             | Type   | Arguments                  | Fired by                                           |
| ---------------- | ------ | -------------------------- | -------------------------------------------------- |
| `init`           | action | —                          | `Kernel.refreshState`, once the site becomes ready |
| `option_{name}`  | filter | `value, name`              | `Options.get`                                      |
| `updated_option` | action | `name, oldValue, newValue` | `Options.set`                                      |
| `deleted_option` | action | `name`                     | `Options.delete`                                   |
| `wp_login`       | action | `userId`                   | successful login                                   |
| `transition_post_status` | action | `newStatus, oldStatus, post` | any status change (save, trash, restore, scheduled publish) |
| `save_post`, `save_post_{type}` | action | `postId, post, update` | after a post is created or updated |
| `wp_insert_post` | action | `postId, post, update`     | after `save_post`                                  |
| `wp_trash_post` / `trashed_post` | action | `postId`         | before / after moving to the Trash                 |
| `untrashed_post` | action | `postId`                   | after restoring from the Trash                     |
| `before_delete_post` / `deleted_post` | action | `postId, post` | around permanent deletion                    |
| `post_updated`   | action | `postId, postAfter, postBefore` | after an existing post is updated, before `save_post` |
| `set_object_terms` | action | `objectId, termIds, ttIds, taxonomy, append, oldTtIds` | after a post's terms in one taxonomy are set |
| `created_term`, `edited_term` | action | `termId, taxonomy` | after a term is created / updated              |
| `delete_term`    | action | `termId, taxonomy, term`   | after a term is deleted                            |
| `content_query_args` | filter | `args`                 | before every `ContentQuery` runs (like `pre_get_posts`) |
| `rest_prepare_{type}` | filter | `item, post, context`  | each post or page in a REST response               |
| `rest_insert_{type}` | action | `post, body, creating`   | after a post is created or updated through the REST API, before the response is prepared |
| `pre_render_block` | filter | `preRender, parsedBlock, parentBlock` | before each block renders; return a string to short-circuit (see [Blocks](blocks.md)) |
| `render_block_data` | filter | `parsedBlock, sourceBlock, parentBlock` | before each block renders; change its attributes or inner blocks |
| `render_block_context` | filter | `context, parsedBlock, parentBlock` | the context a block receives |
| `render_block`   | filter | `content, parsedBlock, block` | each block's rendered HTML                         |
| `render_block_{name}` | filter | `content, parsedBlock, block` | after `render_block`, for one block type, e.g. `render_block_core/paragraph` |
| `wp_creating_autosave` | action | `autosave, isUpdate` | before an existing autosave revision is overwritten |
| `rest_prepare_autosave` | filter | `item, revision`     | each autosave in a REST response                   |
| `user_register`  | action | `userId`                   | after a user is created (`wp_insert_user`)         |
| `profile_update` | action | `userId, oldUser`          | after a user is updated                            |
| `set_user_role`  | action | `userId, role, oldRoles`   | when a user's roles change                         |
| `delete_user` / `deleted_user` | action | `userId, reassign, user` | around deleting a user (`reassign` is a user ID or null) |
| `illegal_user_logins` | filter | `logins`              | usernames that can't be registered                 |
| `rest_prepare_user` | filter | `item, user, context`   | each user in a REST response                       |
| `rest_insert_user`, `rest_after_insert_user` | action | `user, body, creating` | after a user is created or updated through the REST API |
| `rest_delete_user` | action | `user, response`         | after a user is deleted through the REST API       |
| `wp_create_application_password` | action | `userId, item, plainPassword, args` | after an application password is created |
| `wp_update_application_password` | action | `userId, item, update` | after one is renamed                            |
| `wp_delete_application_password` | action | `userId, item` | after one is revoked                                    |
| `wp_authenticate_application_password_errors` | action | `errors, user, item, password` | a valid application password is about to be accepted; `errors.add(code, message)` refuses it |
| `application_password_did_authenticate` | action | `user, item` | after a request authenticates with one              |
| `application_password_failed_authentication` | action | `{ code, message }` | after a failed attempt                       |
| `wp_is_application_passwords_available`, `wp_is_application_passwords_available_for_user` | filter | `available[, userId]` | turn application passwords off for the site or a user |
| `pre_wp_mail`    | filter | `null, message`            | before sending; return a boolean to short-circuit  |
| `wp_mail`        | filter | `message`                  | the message `kernel.mail.send()` is about to send  |
| `wp_mail_from`, `wp_mail_from_name` | filter | `address` / `name` | the sender                                      |
| `wp_mail_succeeded` / `wp_mail_failed` | action | `message` / `error` | after a message is sent or fails              |
| `lostpassword_post` | action | `user or null`          | a lost-password request, before anything is sent   |
| `retrieve_password`, `retrieve_password_key` | action | `login[, key]` | a reset key is being created / was created       |
| `retrieve_password_title`, `retrieve_password_message` | filter | `title, login, user` / `message, key, login, user` | the reset email |
| `password_reset_expiration` | filter | `seconds`        | how long reset links last (default 24 hours)       |
| `password_reset` / `after_password_reset` | action | `user` | before / after a reset sets the password (the password itself is not passed) |
| `preprocess_comment` | filter | `commentData` | first step of every new comment (`wp_new_comment()`) |
| `duplicate_comment_id`, `wp_is_comment_flood` | filter | `id, data` / `isFlood, ip, email, date` | the duplicate and flood checks |
| `comment_duplicate_trigger` | action | `data` | before a duplicate is refused |
| `comment_max_links_url` / `wp_check_comment_disallowed_list` | filter / action | `count, url, content` / the comment's fields | inside the moderation checks |
| `pre_comment_approved` | filter | `approved, data` | the new comment's status: `'1'`, `'0'`, `'spam'`, `'trash'` |
| `wp_insert_comment` | action | `id, comment` | after the row is stored |
| `comment_post` | action | `id, approved, comment` | after a new comment is saved |
| `edit_comment` | action | `id, comment` | after `kernel.comments.update()` |
| `wp_set_comment_status` | action | `id, status` | after any status change |
| `transition_comment_status` | action | `new, old, comment` | when the status changes (`approved`, `unapproved`, `spam`, `trash`, `delete`); also `comment_{old}_to_{new}` and `comment_{new}_{type}` |
| `trash_comment` / `trashed_comment`, `untrash_comment` / `untrashed_comment`, `spam_comment` / `spammed_comment`, `unspam_comment` / `unspammed_comment` | action | `id, comment` | around each move |
| `delete_comment` / `deleted_comment` | action | `id, comment` | around permanent deletion |
| `wp_update_comment_count` | action | `postId, new, old` | after a post's approved count is recalculated |
| `comments_open` | filter | `open, postId` | whether a post takes comments |
| `comment_text` | filter | `html, comment` | rendered comment content (REST and blocks) |
| `comment_form_default_fields` / `comment_form_comments_closed` | filter / action | `fields` / `postId` | the comment form block |
| `widget_comments_args` | filter | `args` | the latest-comments block's query |
| `comment_post_redirect` / `set_comment_cookies` | filter / action | `location, comment` / `comment, user` | the `/wp-comments-post` endpoint |
| `rest_allow_anonymous_comments` | filter | `allowed, body` | anonymous REST comments (true by default) |
| `rest_comment_query`, `rest_preprocess_comment`, `rest_pre_insert_comment` | filter | `args` / `data` / `data` | the comments REST controller |
| `rest_prepare_comment` | filter | `item, comment, context` | each comment in a REST response |
| `rest_insert_comment`, `rest_after_insert_comment` | action | `comment, body, creating` | after a REST create or update |
| `rest_delete_comment` | action | `comment, response` | after a REST delete |
| `pressbase_cache_purge` | action | `tags, reason` | a change made public pages stale; `tags` are cache tags (`post:12`, `site`…). Core forwards them to `apps/web`; a CDN integration can listen too. See [The public site](public-site.md#page-caching) |
| `do_robotstxt` / `robots_txt` | action / filter | — / `output, public` | before / after `/robots.txt` is built |
| `wp_title_rss`, `the_title_rss`, `the_permalink_rss`, `the_excerpt_rss`, `the_content_feed` | filter | `title, format` / `title` / `link` / `excerpt` / `html, format` | feed channel title and items |
| `comment_author_rss`, `comment_text_rss` | filter | `author` / `text` | comment feed items |
| `wp_sitemaps_enabled` | filter | `enabled` | whether sitemaps are served (default: the site is public) |
| `wp_sitemaps_max_urls` | filter | `max, objectType` | URLs per sitemap page (2,000) |
| `wp_sitemaps_post_types`, `wp_sitemaps_taxonomies` | filter | `names` | which post types and taxonomies get sitemaps |
| `wp_sitemaps_posts_query_args` | filter | `args, postType` | the query of a posts sitemap |

**When you add a hook to core,** use WordPress's name if WordPress has an equivalent. Add it to this table and declare its types.
