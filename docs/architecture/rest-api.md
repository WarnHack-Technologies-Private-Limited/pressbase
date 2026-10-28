# REST API

Everything is served under `/wp-json`, as in WordPress:

- `wp/v2/*` routes match WordPress's names, fields and behaviour, so existing clients work.
- `pressbase/v1/*` routes are Pressbase's own.

## Endpoints

| Method                   | Route                              | Access           | Purpose                                                           |
| ------------------------ | ---------------------------------- | ---------------- | ----------------------------------------------------------------- |
| GET                      | `/wp-json`                         | public           | Site name, description, URL, namespaces, Pressbase version and state; once installed, `site_logo`, `site_icon` and `site_icon_url`, as WordPress's index has them. |
| GET                      | `/pressbase/v1/install`                | public           | Install state, system checks, whether a setup code is needed.     |
| POST                     | `/pressbase/v1/install/database-check` | before install   | Test database details.                                            |
| POST                     | `/pressbase/v1/install`                | before install   | Install the site and sign in the administrator.                   |
| POST                     | `/pressbase/v1/auth/login`             | public           | `{ login, password, remember }` → session cookie.                 |
| POST                     | `/pressbase/v1/auth/logout`            | public           | End the current session.                                          |
| GET                      | `/wp/v2/users/me`                  | logged in        | The current user, with the edit fields (roles, capabilities, profile). |
| POST                     | `/pressbase/v1/auth/lost-password` | public           | `{ login }` → emails a reset link. Same answer whether or not the account exists. See [People](people.md#password-reset). |
| POST                     | `/pressbase/v1/auth/check-reset-key` | public         | `{ login, key }` → `200`, or `400 invalid_key` / `expired_key`.   |
| POST                     | `/pressbase/v1/auth/reset-password` | public          | `{ login, key, password }` → sets the password and logs the user out everywhere. |
| GET / POST / PUT / PATCH | `/wp/v2/settings`                  | `manage_options` | Read or update registered settings, including `site_logo` and `site_icon` (attachment IDs, `0` for none). |
| GET                      | `/pressbase/v1/dashboard`              | `read`           | Counts, recent content and system facts for the dashboard.        |
| GET                      | `/pressbase/v1/post-counts/{type}`     | `edit_{type}s`   | Items per status, for the admin's status tabs (`wp_count_posts`). |
| GET / POST               | `/wp/v2/posts`, `/wp/v2/pages`         | read: public · write: see below | List and create. Supports WordPress's collection parameters. |
| GET / POST / PUT / PATCH / DELETE | `/wp/v2/{posts\|pages}/{id}`  | `read_post` / `edit_post` / `delete_post` | One item. `DELETE` trashes; `?force=true` deletes permanently. |
| GET                      | `/wp/v2/{posts\|pages}/{id}/revisions` | `edit_post`     | Revision history, newest first. Includes autosaves, as in WordPress. |
| GET / POST               | `/wp/v2/{posts\|pages}/{id}/autosaves` | `edit_post`     | Autosaves (`WP_REST_Autosaves_Controller`). `POST` takes `title`, `content`, `excerpt`: the author's own draft is updated in place, without a revision; anything else gets the user's single autosave revision (`{id}-autosave-v1`), updated in place. See [Block editor](block-editor.md#autosave). |
| GET                      | `/wp/v2/{posts\|pages}/{parent}/autosaves/{id}` | `edit_post` | The newest autosave of the post (WordPress ignores `{id}` here too). |
| GET / POST               | `/wp/v2/categories`, `/wp/v2/tags`     | read: public · create: see below | Terms. `DELETE ?force=true` only (terms have no trash). |
| GET / POST / PUT / PATCH / DELETE | `/wp/v2/{categories\|tags}/{id}` | `edit_term` / `delete_term` | One term.                                           |
| GET                      | `/wp/v2/types`, `/wp/v2/taxonomies`, `/wp/v2/statuses` | public | Registered post types, taxonomies and statuses (labels, capabilities with `context=edit`). |
| GET                      | `/wp/v2/users`, `/wp/v2/users/{id}`    | public: published authors only · `list_users`: everyone | People. `context=edit` adds username, email, first/last name, nickname, locale, registered date, roles and capabilities. `roles=editor,author` filters (needs `list_users`). |
| POST                     | `/wp/v2/users`                     | `create_users` (+ `promote_users` for `roles`) | Create a user: `username`, `email`, `password` required. Pressbase adds `send_user_notification` to email a "set your password" link. |
| POST / PUT / PATCH       | `/wp/v2/users/{id\|me}`            | `edit_user` (yourself, or `edit_users`); `promote_user` for `roles` | Update. Usernames can't change. See [People](people.md#who-may-do-what). |
| DELETE                   | `/wp/v2/users/{id\|me}?force=true&reassign={id\|false}` | `delete_users` | Delete; `reassign` moves the user's content, `false` deletes it. The last administrator can't be deleted. |
| GET                      | `/pressbase/v1/user-counts`        | `list_users`     | `{ total, roles: { role: n, none: n }, posts: { id: n } }` (`count_users()`; posts for `?include=1,2`). |
| GET / POST / DELETE      | `/wp/v2/users/{id\|me}/application-passwords` | `edit_user` | List, create (`{ name, app_id? }`; the response carries the password, once) or revoke all. |
| GET / POST / PUT / PATCH / DELETE | `/wp/v2/users/{id\|me}/application-passwords/{uuid}` | `edit_user` | One application password: read, rename, revoke. |
| GET                      | `/wp/v2/users/me/application-passwords/introspect` | Basic auth | The application password the request used. |
| GET                      | `/wp/v2/search`                    | public           | One search across published posts and pages, terms, and post formats (`WP_REST_Search_Controller`). See *Search* below. |
| GET / POST               | `/wp/v2/media`                     | read: public (as the parent post) · upload: `upload_files` | List or upload media. See *Media* below. |
| GET / POST / PUT / PATCH / DELETE | `/wp/v2/media/{id}`       | `read_post` / `edit_post` / `delete_post` | One attachment. `DELETE` needs `?force=true` (no Trash). |
| GET / HEAD               | `/wp-content/uploads/{path}`       | public           | The uploaded files themselves (outside `/wp-json`). See [Media](media.md#serving-files). |
| GET                      | `/wp/v2/block-types`, `/wp/v2/block-types/{namespace}`, `/wp/v2/block-types/{namespace}/{name}` | `edit_posts` (any type) | Registered block types: attributes, context, supports, `is_dynamic`. `?namespace=` filters. |
| GET / POST               | `/wp/v2/block-renderer/{namespace}/{name}` | `edit_posts`, or `edit_post` with `post_id` | Renders a dynamic block: `{ rendered }`. Takes `attributes` (query `attributes[key]=…` or JSON body), `post_id`, `context`. |
| GET                      | `/wp/v2/block-patterns/patterns`, `/wp/v2/block-patterns/categories` | `edit_posts` (any type) | Registered patterns and pattern categories. |
| GET / POST               | `/wp/v2/comments`                  | read: public (approved comments on readable posts) · create: anyone, when the post is open | Comments. See *Comments* below. |
| GET / POST / PUT / PATCH / DELETE | `/wp/v2/comments/{id}`    | read: as the post · write: `edit_comment` | One comment. `DELETE` trashes; `?force=true` deletes permanently. |
| GET                      | `/pressbase/v1/comment-counts`     | `moderate_comments` | Comments per status (`wp_count_comments()`) plus `mine`, for the admin's tabs. |
| POST                     | `/wp-comments-post` (outside `/wp-json`) | anyone | The classic comment form, `application/x-www-form-urlencoded`. Redirects back, or shows an error page. See [Comments](comments.md#the-form-endpoint-post-wp-comments-post). |
| GET                      | `/pressbase/v1/render?url=/path/`      | public (drafts and private posts need the right capability) | A page of the public site: `{ status, headers, html }`. Used by `apps/web`. See [Themes](themes.md). |
| GET                      | `/wp/v2/themes`, `/wp/v2/themes/{stylesheet}` | `switch_themes`; `edit_posts` for the active theme (`?status=active`) | Installed themes (`WP_REST_Themes_Controller` fields: `stylesheet`, `template`, `name`, `version`, `screenshot`, `status`, `is_block_theme`…). |
| POST                     | `/pressbase/v1/themes/{stylesheet}/activate` | `switch_themes` | Activates a block theme (`switch_theme()`). |
| GET                      | `/wp/v2/global-styles/themes/{stylesheet}` | `edit_posts` (any type) or `edit_theme_options` | The active theme's `settings` (presets keyed by origin) and `styles`, with `_links["wp:theme-file"]` for `file:./` URLs. Other themes: `404 rest_theme_not_found`. |
| GET                      | `/wp/v2/global-styles/themes/{stylesheet}/variations` | as above | The theme's style variations (`styles/**/*.json` without `blockTypes`): full, colour-only and typography-only, each with `title`, `settings`, `styles`. |
| GET                      | `/wp/v2/global-styles/{id}`            | `read_post` (`edit_posts`); `context=edit` needs `edit_post` | User global styles: `id`, `title`, `settings`, `styles`, `_links` (`version-history` with `count`, `wp:action-publish`, `wp:action-edit-css`). The active theme's ID is in `/wp/v2/themes?status=active` → `_links["wp:user-global-styles"]` (created on first request). |
| POST / PUT / PATCH       | `/wp/v2/global-styles/{id}`            | `edit_post` (`edit_theme_options`) | Saves `styles` and/or `settings` (a missing one keeps the stored value) and `title`. `styles.css` is checked by `validate_custom_css()`; for users without `unfiltered_html`, unsafe values are removed (`remove_insecure_properties()`) and custom CSS is dropped. Keeps a revision. |
| GET                      | `/wp/v2/global-styles/{id}/revisions`, `…/revisions/{revision}` | `edit_post` on the parent | Saved versions, newest first: `id`, `author`, `date(_gmt)`, `modified(_gmt)`, `parent`, `settings`, `styles`. `page`, `per_page`, `offset`; `X-WP-Total`, `X-WP-TotalPages`. |
| POST                     | `/pressbase/v1/global-styles/preview`  | `edit_theme_options` | Renders a public page (`url`, default `/`) with unsaved `styles` / `settings` over the stored ones, sanitised as a save would be: `{ status, headers, html }` with `cache-control: no-store`. **Never stores anything.** |
| GET / HEAD               | `/wp-content/themes/{theme}/{path}`, `/wp-includes/{path}` | public | Theme assets and WordPress's front-end CSS (outside `/wp-json`). |
| POST                     | `/wp-login.php?action=postpass` | public | The post password form: sets the `wp-postpass` cookie and redirects back. |
| GET / POST               | `/wp/v2/navigation`                    | read: public for published menus · create: `edit_theme_options` | Navigation menus (`wp_navigation`). The posts controller; same parameters as posts. `OPTIONS` answers with an `Allow` header. See [Navigation](navigation.md). |
| GET / POST / PUT / PATCH / DELETE | `/wp/v2/navigation/{id}`      | `edit_theme_options` to write | One menu; `Allow` header, revisions at `…/revisions`. |
| GET                      | `/wp-block-editor/v1/navigation-fallback` | `edit_theme_options` | The menu a Navigation block without one uses, created from the page list when there's none (`WP_REST_Navigation_Fallback_Controller`). `?_embed` embeds it. |
| GET / PUT                | `/pressbase/v1/navigation-fallback`    | `edit_theme_options` | Which menu the header (ref-less Navigation blocks) shows: `{ id, current }`; `PUT { id }`. |
| POST                     | `/pressbase/v1/navigation-preview`     | `edit_theme_options` | A public page rendered with unsaved menu markup in the header, for Appearance → Menus. |
| GET / POST               | `/wp/v2/blocks`                        | read: `edit_posts` · create: `publish_posts` | Synced patterns (`wp_block`). Same parameters as posts. |
| GET / POST / PUT / PATCH / DELETE | `/wp/v2/blocks/{id}`          | `edit_post` / `delete_post` | One synced pattern: `title.raw`, `content.raw`, `wp_pattern_sync_status`; write it with `meta.wp_pattern_sync_status`. |

Routes other than the index and installer return `503 pressbase_not_installed` until the site is installed.

### Collections: posts and pages

The same parameters as WordPress: `context`, `page`, `per_page` (max 100), `search`, `after`, `before`, `modified_after`, `modified_before`, `author`, `author_exclude`, `include`, `exclude`, `offset`, `order`, `orderby` (`date`, `modified`, `title`, `slug`, `id`, `include`, `author`, `parent`, `relevance`, plus `menu_order` for pages), `slug`, `status`, `sticky`, `parent`, `parent_exclude`, `menu_order`, and one filter per taxonomy (`categories`, `categories_exclude`, `tags`, `tags_exclude`). List parameters accept `a,b`, `a[]=x&a[]=y` or repeated keys.

Responses carry `X-WP-Total`, `X-WP-TotalPages` and a `Link` header with `prev` and `next`. `OPTIONS` on a collection or an item answers with an `Allow` header listing the methods the current user may use (`rest_send_allow_header()`); single items send it with `GET` too, and edit-context items carry it as `_links.self[0].targetHints.allow`. core-data's `canUser()` reads both. The same controller serves `/wp/v2/navigation`.

### Media

`/wp/v2/media` ports `WP_REST_Attachments_Controller`. Details are in [Media](media.md).

- **Upload** as `multipart/form-data` (field `file`, plus optional `title`, `alt_text`, `caption`, `description`, `post`), or as a raw body with `Content-Type` and `Content-Disposition: attachment; filename="photo.jpg"` (other fields in the query string). An optional `Content-MD5` header is checked. Responds `201` with a `Location` header.
- **Fields:** WordPress's, including `alt_text`, `caption`, `description`, `media_type` (`image` or `file`), `mime_type`, `media_details` (with `sizes`, each with `source_url`, and a `full` entry), `post`, `source_url` and, in the edit context, `missing_image_sizes`.
- **Collection parameters:** as posts, plus `media_type` (`image`, `video`, `audio`, `application`, `text`), `mime_type` and `parent` (`0` for unattached). `status` is `inherit` by default.
- **Update:** `title`, `alt_text`, `caption`, `description`, `post`, `author`, `slug`, `comment_status`, `ping_status`.
- **Featured images:** posts and pages accept and return `featured_media`.

### Search

`/wp/v2/search` ports `WP_REST_Search_Controller` and its post, term and post-format handlers (`wp-includes/rest-api/search/`). The block editor's link popover uses it.

- **Parameters:** `search`, `type` (`post` (default), `term`, `post-format`), `subtype` (post types or taxonomies, or `any` (default), which wins over the others; subtypes of another handler are ignored), `page`, `per_page` (max 100), `include`, `exclude`, `context` (`view` or `embed`).
- **Items:** `{ id, title, url, type, subtype, _links }`. Posts have `type: "post"` and the post type as `subtype`. Terms have the taxonomy as `type` and no `subtype`, as in WordPress. `_links` has `self` (embeddable), `about` and `collection`.
- **What's searched:** published posts of every public post type in the REST API except attachments (drafts and private posts never appear, even to their authors, as in WordPress), and terms of every public taxonomy, matched on name or slug and ordered by name. Pressbase has no post formats yet, so `type=post-format` finds nothing.
- **Pagination:** `X-WP-Total`, `X-WP-TotalPages` and `Link`; a page past the end is `400 rest_search_invalid_page_number`. An unknown `type` or `subtype` is `400 rest_invalid_param`.
- **Filters:** `rest_post_search_query`, `rest_term_search_query`, `rest_post_format_search_query` (`args, request`).

### Who may write what

These rules are ported from `WP_REST_Posts_Controller` and `map_meta_cap()`:

| Action | Needs |
|---|---|
| Create a post | `edit_posts` (pages: `edit_pages`) |
| Publish, schedule or make private | `publish_posts`, else `403 rest_cannot_publish` |
| Edit someone else's post | `edit_others_posts`, plus `edit_published_posts` once it is live |
| Write as another author | `edit_others_posts` (`rest_cannot_edit_others`) |
| Make a post sticky | `edit_others_posts` and `publish_posts` |
| Assign a term | `assign_term` for each term (`edit_posts` for the core taxonomies) |
| Create a category | `manage_categories` |
| Create a tag | `edit_posts`, so writers can add tags while editing, as in WordPress |
| Read drafts and other non-public statuses | `edit_posts` (`401/403 rest_forbidden_status`) |

Content, titles and excerpts from users without `unfiltered_html` are sanitised (see [Content](content.md#sanitising)).

`content.rendered` runs the block renderer: dynamic blocks render with the post as their context (see [Blocks](blocks.md)).

### Comments

`/wp/v2/comments` ports `WP_REST_Comments_Controller`. The pipeline behind it is in [Comments](comments.md).

- **Collection parameters:** `context`, `page`, `per_page`, `search` (name, email, URL, IP, content), `after`, `before`, `author`, `author_exclude`, `author_email`, `include`, `exclude`, `offset`, `order`, `orderby` (`date`, `date_gmt`, `id`, `include`, `post`, `parent`, `type`), `parent` (`0` for top-level), `parent_exclude`, `post`, `status` (default `approve`; also `hold`, `spam`, `trash`, `all`), `type` (default `comment`), `password`. Without `edit_posts`, `author`, `author_exclude`, a non-default `type` or `status` are refused (`rest_forbidden_param`); `author_email` needs `moderate_comments` (WordPress: `edit_posts`).
- **Fields:** `id`, `post`, `parent`, `author`, `author_name`, `author_url`, `date`, `date_gmt`, `content.rendered`, `link`, `status` (`approved`, `hold`, `spam`, `trash`), `type`, `author_avatar_urls` (24, 48, 96), `meta`. `context=edit` adds `author_email`, `author_ip`, `author_user_agent` and `content.raw`.
- **Create:** `post`, `content`, `parent`, `author_name`, `author_email`, `author_url`, `date`/`date_gmt`; moderators also `author`, `author_ip`, `author_user_agent`, `status`. Logged-in users post as themselves. The response uses the edit context for moderators.
- **Anonymous comments** work without logging in (WordPress needs the `rest_allow_anonymous_comments` filter for that; Pressbase's defaults to true), and a visitor **without a session cookie** may send this one request without `X-Pressbase-Request` (see [Security](security.md)).
- **Update:** the same fields, plus `status`: `approved`, `hold`, `spam`, `unspam`, `trash`, `untrash` (`handle_status_param()`). The stored IP isn't overwritten with the editor's.

## Errors

The shape matches WordPress:

```json
{
  "code": "rest_invalid_param",
  "message": "Invalid parameter(s): title",
  "data": { "status": 400, "params": { "title": "Give your site a name." } }
}
```

| Code                           | Status    | When                                                                       |
| ------------------------------ | --------- | -------------------------------------------------------------------------- |
| `rest_invalid_param`           | 400       | Validation failed. `data.params` maps each field path to a message.        |
| `rest_not_logged_in`           | 401       | `users/me` without a session.                                              |
| `rest_forbidden`               | 401 / 403 | Logged out / missing capability.                                           |
| `rest_no_route`                | 404       | Unknown route.                                                             |
| `pressbase_missing_request_header` | 403       | An unsafe request without `X-Pressbase-Request` (see Security).                |
| `pressbase_invalid_credentials`    | 401       | Login failed. The message is the same whether the user exists or not.      |
| `pressbase_too_many_attempts`      | 429       | Login throttled. A `Retry-After` header is set.                            |
| `rest_post_invalid_id`             | 404       | No such post or page.                                                      |
| `rest_cannot_publish`, `rest_cannot_edit`, `rest_cannot_delete` | 401 / 403 | See *Who may write what*.                    |
| `rest_already_trashed`             | 410       | `DELETE` on an item already in the Trash (use `?force=true`).              |
| `rest_post_invalid_parent`         | 404       | Revisions or autosaves of a post that doesn't exist.                       |
| `rest_post_no_autosave`            | 404       | The post has no autosave.                                                  |
| `rest_cannot_read`                 | 401 / 403 | Revisions or autosaves of a post you can't edit.                           |
| `rest_post_invalid_page_number`    | 400       | `page` is past the last page.                                              |
| `rest_search_invalid_page_number`  | 400       | `page` is past the last page of a search.                                  |
| `term_exists`                      | 400       | A term with that name or slug exists; `data.term_id` is the existing term. |
| `rest_trash_not_supported`         | 501       | `DELETE` on a term or media item without `?force=true`.                    |
| `rest_cannot_create`               | 401 / 403 | Uploading without `upload_files`.                                          |
| `rest_upload_no_data`              | 400       | No file, or an empty one.                                                  |
| `rest_upload_no_content_type`, `rest_upload_no_content_disposition`, `rest_upload_invalid_disposition` | 400 | Raw-body upload without the headers it needs. |
| `rest_upload_invalid_type`         | 400       | The file type isn't allowed, or the content doesn't match the extension.   |
| `rest_upload_invalid_image`        | 400       | An image that can't be decoded.                                            |
| `rest_upload_file_too_big`         | 413       | Larger than `PRESSBASE_MAX_UPLOAD_MB`.                                     |
| `rest_upload_hash_mismatch`        | 412       | `Content-MD5` doesn't match the body.                                      |
| `rest_invalid_featured_media`      | 400       | `featured_media` isn't an image attachment.                                |
| `rest_block_type_cannot_view`      | 401 / 403 | Block types without edit rights.                                           |
| `rest_block_type_invalid`          | 404       | No such block type.                                                        |
| `block_cannot_read`                | 401 / 403 | Block renderer without `edit_posts`, or without `edit_post` on `post_id`.  |
| `block_invalid`                    | 404       | Block renderer for an unknown or static (non-dynamic) block.               |
| `rest_cannot_view`                 | 401 / 403 | Block patterns or pattern categories without edit rights.                  |
| `rest_cannot_create_user`, `rest_cannot_edit`, `rest_cannot_edit_roles`, `rest_user_cannot_delete` | 401 / 403 | See [People](people.md#who-may-do-what). |
| `rest_user_invalid_username`, `existing_user_login`, `existing_user_email`, `rest_user_invalid_email`, `rest_user_invalid_password`, `rest_user_invalid_slug`, `rest_user_invalid_argument` | 400 | User input problems; `data.params` names the field. |
| `rest_user_invalid_role`           | 400 / 403 | Unknown role (400), giving yourself a role without `edit_users`, or removing the last administrator (403). |
| `rest_user_invalid_reassign`       | 400       | `reassign` is the user being deleted, or doesn't exist.                    |
| `rest_missing_callback_param`      | 400       | A required parameter is missing (`username`, `email`, `password`, `reassign`). |
| `invalid_username`, `invalid_email`, `incorrect_password` | 401 | `Authorization: Basic` with an unknown user or a wrong application password. |
| `application_password_empty_name`, `application_password_duplicate_name` | 400 / 409 | Application password names must be given and unique per user. |
| `rest_application_password_not_found` | 404    | No application password with that UUID.                                   |
| `rest_cannot_list_application_passwords` and the other `rest_cannot_*_application_password*` codes | 401 / 403 | Managing someone else's application passwords without `edit_users`. |
| `invalid_key`, `expired_key`       | 400       | Password reset link that is wrong, used or older than 24 hours.            |
| `rest_comment_invalid_id`          | 404       | No such comment.                                                           |
| `rest_comment_login_required`      | 401       | Commenting needs a login (`comment_registration`, or anonymous comments turned off). |
| `rest_comment_closed`              | 403       | Comments are closed on the post (its setting, or its age).                 |
| `rest_comment_invalid_post_id`, `rest_comment_draft_post`, `rest_comment_trash_post` | 403 | No post, or a draft or trashed one.        |
| `rest_comment_author_data_required` | 400      | `require_name_email` is on and the name or email is missing.               |
| `rest_comment_content_invalid`     | 400       | Empty content.                                                             |
| `comment_duplicate`                | 409       | The same comment was already posted.                                       |
| `comment_flood`                    | 400       | Another comment from the same address or person less than 15 seconds ago.  |
| `comment_*_column_length`          | 400       | A field is longer than WordPress allows.                                   |
| `rest_comment_invalid_author`, `rest_comment_invalid_author_ip`, `rest_comment_invalid_status` | 401 / 403 | Setting fields only moderators may set. |
| `rest_cannot_edit`, `rest_cannot_delete` | 401 / 403 | Changing a comment without `edit_comment`.                           |
| `rest_forbidden_param`             | 401 / 403 | A list filter you may not use.                                             |
| `rest_cannot_view_themes`          | 401 / 403 | Listing themes without `switch_themes`.                                    |
| `rest_cannot_manage_themes`        | 401 / 403 | Activating a theme without `switch_themes`.                                |
| `rest_theme_not_found`             | 404       | No installed theme with that folder name.                                  |
| `pressbase_theme_not_block_theme`  | 400       | Activating a theme without `templates/index.html`.                        |
| `rest_cannot_read_global_styles`   | 401 / 403 | Theme global styles or variations without `edit_posts` / `edit_theme_options`. |
| `rest_global_styles_not_found`     | 404       | No `wp_global_styles` post with that ID.                                   |
| `rest_forbidden_context`, `rest_cannot_view` | 401 / 403 | Reading user global styles (`context=edit` needs `edit_post`).    |
| `rest_custom_css_illegal_markup`, `rest_custom_css_invalid_type` | 400 | `styles.css` that could close the `<style>` element, or isn't a string. |
| `rest_revision_invalid_page_number`, `rest_revision_invalid_offset_number` | 400 | Revisions past the last page or offset. |
| `pressbase_db_*`                   | 400       | Installer database problems. `data.hint` holds the next step for the user. |
| `pressbase_already_installed`      | 409       | Installer called on an installed site.                                     |

## Authentication

- **Browser:** a session cookie (`pressbase_session`) from `auth/login` or the installer. Every unsafe request also needs the `X-Pressbase-Request: 1` header.
- **API clients:** application passwords over `Authorization: Basic base64(username:password)`, created on the Profile screen or through the API. Requests with an `Authorization` header are exempt from the CSRF header rule, and any session cookie they carry is ignored. Bad credentials answer `401` (`incorrect_password`, `invalid_username`, `invalid_email`). See [People](people.md#application-passwords).

```bash
curl -u 'admin:abcd EFGH 1234 ijkl MNOP 5678' https://example.com/wp-json/wp/v2/users/me
```

## Adding a route

1. Create or extend a file in `apps/core/src/routes/`. Mount it in `app.ts`, inside `installed` unless it must work before install.
2. Validate input with zod. On failure, return `invalidParams(c, error)`.
3. Guard it with `requireCapability('...')`.
4. For a `wp/v2` route, match WordPress's field names and status codes. Check the controller in `wp-includes/rest-api/endpoints/`.
5. Add API tests to `apps/core/src/*.test.ts` and a row to the table above.
