# REST API

Everything is served under `/wp-json`, as in WordPress:

- `wp/v2/*` routes match WordPress's names, fields and behaviour, so existing clients work.
- `pressbase/v1/*` routes are Pressbase's own.

## Endpoints

| Method                   | Route                              | Access           | Purpose                                                           |
| ------------------------ | ---------------------------------- | ---------------- | ----------------------------------------------------------------- |
| GET                      | `/wp-json`                         | public           | Site name, description, URL, namespaces, Pressbase version and state. |
| GET                      | `/pressbase/v1/install`                | public           | Install state, system checks, whether a setup code is needed.     |
| POST                     | `/pressbase/v1/install/database-check` | before install   | Test database details.                                            |
| POST                     | `/pressbase/v1/install`                | before install   | Install the site and sign in the administrator.                   |
| POST                     | `/pressbase/v1/auth/login`             | public           | `{ login, password, remember }` → session cookie.                 |
| POST                     | `/pressbase/v1/auth/logout`            | public           | End the current session.                                          |
| GET                      | `/wp/v2/users/me`                  | logged in        | The current user, with roles and capabilities.                    |
| GET / POST / PUT / PATCH | `/wp/v2/settings`                  | `manage_options` | Read or update registered settings.                               |
| GET                      | `/pressbase/v1/dashboard`              | `read`           | Counts, recent content and system facts for the dashboard.        |
| GET                      | `/pressbase/v1/post-counts/{type}`     | `edit_{type}s`   | Items per status, for the admin's status tabs (`wp_count_posts`). |
| GET / POST               | `/wp/v2/posts`, `/wp/v2/pages`         | read: public · write: see below | List and create. Supports WordPress's collection parameters. |
| GET / POST / PUT / PATCH / DELETE | `/wp/v2/{posts\|pages}/{id}`  | `read_post` / `edit_post` / `delete_post` | One item. `DELETE` trashes; `?force=true` deletes permanently. |
| GET                      | `/wp/v2/{posts\|pages}/{id}/revisions` | `edit_post`     | Revision history, newest first.                                   |
| GET / POST               | `/wp/v2/categories`, `/wp/v2/tags`     | read: public · create: see below | Terms. `DELETE ?force=true` only (terms have no trash). |
| GET / POST / PUT / PATCH / DELETE | `/wp/v2/{categories\|tags}/{id}` | `edit_term` / `delete_term` | One term.                                           |
| GET                      | `/wp/v2/types`, `/wp/v2/taxonomies`, `/wp/v2/statuses` | public | Registered post types, taxonomies and statuses (labels, capabilities with `context=edit`). |
| GET                      | `/wp/v2/users`, `/wp/v2/users/{id}`    | public: published authors only · `list_users`: everyone | People. `context=edit` adds username, email and roles. |
| GET / POST               | `/wp/v2/media`                     | read: public (as the parent post) · upload: `upload_files` | List or upload media. See *Media* below. |
| GET / POST / PUT / PATCH / DELETE | `/wp/v2/media/{id}`       | `read_post` / `edit_post` / `delete_post` | One attachment. `DELETE` needs `?force=true` (no Trash). |
| GET / HEAD               | `/wp-content/uploads/{path}`       | public           | The uploaded files themselves (outside `/wp-json`). See [Media](media.md#serving-files). |

Routes other than the index and installer return `503 pressbase_not_installed` until the site is installed.

### Collections: posts and pages

The same parameters as WordPress: `context`, `page`, `per_page` (max 100), `search`, `after`, `before`, `modified_after`, `modified_before`, `author`, `author_exclude`, `include`, `exclude`, `offset`, `order`, `orderby` (`date`, `modified`, `title`, `slug`, `id`, `include`, `author`, `parent`, `relevance`, plus `menu_order` for pages), `slug`, `status`, `sticky`, `parent`, `parent_exclude`, `menu_order`, and one filter per taxonomy (`categories`, `categories_exclude`, `tags`, `tags_exclude`). List parameters accept `a,b`, `a[]=x&a[]=y` or repeated keys.

Responses carry `X-WP-Total`, `X-WP-TotalPages` and a `Link` header with `prev` and `next`.

### Media

`/wp/v2/media` ports `WP_REST_Attachments_Controller`. Details are in [Media](media.md).

- **Upload** as `multipart/form-data` (field `file`, plus optional `title`, `alt_text`, `caption`, `description`, `post`), or as a raw body with `Content-Type` and `Content-Disposition: attachment; filename="photo.jpg"` (other fields in the query string). An optional `Content-MD5` header is checked. Responds `201` with a `Location` header.
- **Fields:** WordPress's, including `alt_text`, `caption`, `description`, `media_type` (`image` or `file`), `mime_type`, `media_details` (with `sizes`, each with `source_url`, and a `full` entry), `post`, `source_url` and, in the edit context, `missing_image_sizes`.
- **Collection parameters:** as posts, plus `media_type` (`image`, `video`, `audio`, `application`, `text`), `mime_type` and `parent` (`0` for unattached). `status` is `inherit` by default.
- **Update:** `title`, `alt_text`, `caption`, `description`, `post`, `author`, `slug`, `comment_status`, `ping_status`.
- **Featured images:** posts and pages accept and return `featured_media`.

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
| `rest_post_invalid_page_number`    | 400       | `page` is past the last page.                                              |
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
| `pressbase_db_*`                   | 400       | Installer database problems. `data.hint` holds the next step for the user. |
| `pressbase_already_installed`      | 409       | Installer called on an installed site.                                     |

## Authentication

- **Browser:** a session cookie (`pressbase_session`) from `auth/login` or the installer. Every unsafe request also needs the `X-Pressbase-Request: 1` header.
- **API clients:** application passwords over `Authorization: Basic` are planned for v0.2. Requests with an `Authorization` header are exempt from the CSRF header rule.

## Adding a route

1. Create or extend a file in `apps/core/src/routes/`. Mount it in `app.ts`, inside `installed` unless it must work before install.
2. Validate input with zod. On failure, return `invalidParams(c, error)`.
3. Guard it with `requireCapability('...')`.
4. For a `wp/v2` route, match WordPress's field names and status codes. Check the controller in `wp-includes/rest-api/endpoints/`.
5. Add API tests to `apps/core/src/*.test.ts` and a row to the table above.
