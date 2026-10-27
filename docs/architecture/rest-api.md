# REST API

Everything is served under `/wp-json`, as in WordPress:

- `wp/v2/*` routes match WordPress's names, fields and behaviour, so existing clients work.
- `pressbase/v1/*` routes are Pressbase's own.

## Endpoints (v0.1)

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

Routes other than the index and installer return `503 pressbase_not_installed` until the site is installed.

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
