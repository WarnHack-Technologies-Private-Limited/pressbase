# People: users, roles, application passwords, mail and password reset

Everything about the people who use a site: their accounts and roles, how API clients log in without a browser, how Pressbase sends email, and how someone gets back in after forgetting their password. The code lives in `apps/core/src/people/`, `apps/core/src/mail/` and the routes listed below.

| Piece | WordPress | Pressbase |
|---|---|---|
| Create, update, delete users | `wp_insert_user()`, `wp_update_user()`, `wp_delete_user()` | `people/users.ts` |
| Users REST controller | `WP_REST_Users_Controller` | `routes/users.ts` |
| Application passwords | `WP_Application_Passwords`, `wp_authenticate_application_password()` | `people/application-passwords.ts` |
| Application passwords REST controller | `WP_REST_Application_Passwords_Controller` | `routes/application-passwords.ts` |
| Mail | `wp_mail()` (PHPMailer) | `kernel.mail` (`mail/mailer.ts`, nodemailer) |
| Lost / reset password | `retrieve_password()`, `check_password_reset_key()`, `reset_password()`, `wp-login.php` | `people/password-reset.ts`, `routes/password-reset.ts` |

## Users

A user is a row in `users` plus `usermeta` entries under WordPress's keys:

| Key | Holds |
|---|---|
| `first_name`, `last_name`, `nickname`, `description`, `locale` | Profile fields. The nickname defaults to the username. |
| `capabilities` | Roles and directly granted capabilities: `{ "editor": true }`. WordPress calls it `wp_capabilities`. |
| `_application_passwords` | The user's application passwords (below). |

`display_name` (`name` in the REST API) defaults to "First Last", then the first or last name, then the username, as `wp_insert_user()` does. The nicename (`slug`) comes from the username and is made unique with `-2`, `-3`… Usernames can't be changed.

### Checks on input

- **Usernames** follow `validate_username()`: letters, numbers, spaces and `. - _ @`, at most 60 characters. Plugins can forbid names with the `illegal_user_logins` filter.
- **Emails** follow `is_email()`, WordPress's deliberately simple check.
- **Uniqueness:** usernames and emails are unique regardless of case (enforced by the database too).
- **Passwords** can't be empty or contain `\`, as in WordPress. They're hashed with scrypt ([ADR 0005](../adr/0005-password-hashing.md)) Accounts imported from WordPress keep their WordPress hash (`$wp$2y$…`, `$2y$…`, `$P$…` or MD5) until the person's next login, which checks it as `wp_check_password()` does and replaces it with scrypt.
- **Websites** keep only `http` and `https` addresses.
- **Bios** are stored as plain text; HTML is kept as typed but never rendered by the admin.

Errors carry WordPress's codes (`rest_user_invalid_username`, `existing_user_login`, `existing_user_email`, `rest_user_invalid_email`, `rest_user_invalid_password`, `rest_user_invalid_role`) and a `data.params` map, so the admin shows each message next to its field.

### Who may do what

| Action | Needs | Error |
|---|---|---|
| List everyone, filter by role, `context=edit` | `list_users` | `rest_forbidden_context`, `rest_user_cannot_view` |
| Create a user | `create_users` (and `promote_users` to choose roles) | `rest_cannot_create_user`, `rest_cannot_edit_roles` |
| Edit a user | `edit_user`: yourself, or `edit_users` | `rest_cannot_edit` |
| Change roles | `promote_user`. A request that changes only roles needs nothing else. | `rest_cannot_edit_roles` |
| Delete a user | `delete_users` | `rest_user_cannot_delete` |

Two rules protect a site from locking itself out:

1. **Nobody can give themselves a role without `edit_users`** (WordPress's `check_role_update()`). An administrator can't demote themselves, even when other administrators exist.
2. **The last administrator can't be demoted or deleted** (Pressbase's addition). Make someone else an administrator first.

### Deleting

`DELETE /wp/v2/users/{id}?force=true&reassign={id|false}`. As in WordPress, users have no Trash (`rest_trash_not_supported` without `force`) and `reassign` is required:

- a user ID moves **all** of the user's posts, pages, media and revisions to that person;
- `false` deletes them, media files included.

The user's meta and sessions go with them. `reassign` can't be the user being deleted (`rest_user_invalid_reassign`).

### Changing a password or email

- A new password logs the user out of every other session (the session making the change survives), clears any reset link in flight, and emails the account a notice (`send_password_change_email`).
- A new email address notifies the old one (`send_email_change_email`).

### The Users screen

`/admin/users` lists people with role tabs (from `GET /pressbase/v1/user-counts`, which ports `count_users()` and `count_many_users_posts()`), search, and bulk role changes. `/admin/users/new` adds someone, with a generated password and an optional welcome email. `/admin/users/{id}` and `/admin/profile` edit a user; your own account always opens on the Profile screen, as in WordPress.

## Application passwords

Long random passwords that let scripts and apps call the REST API as a user, without their main password, each revocable on its own. Ported from WordPress 5.6+.

- **Format:** 24 letters and digits, shown once, grouped in fours for reading (`abcd EFGH 1234 …`). Spaces are ignored when they're used.
- **Storage:** the `_application_passwords` usermeta entry, a list of `{ uuid, app_id, name, password, created, last_used, last_ip }`, times in Unix seconds. `password` is a SHA-256 digest (`$generic$…`), not scrypt: like WordPress 6.8's `wp_fast_hash()`, a slow hash adds nothing to a secret with ~142 bits of entropy, and every API request has to check it.
- **Usage tracking:** `last_used` and `last_ip` are written at most once a day per password and address.
- **Names** must be unique per user (`application_password_duplicate_name`).

### Authenticating

API clients send `Authorization: Basic base64(username:application-password)`. The username may also be the email address. The middleware (`applicationPasswordAuth`, mounted right after the cookie middleware in `app.ts`) works like this:

- A request **with an Authorization header is authenticated by that header alone**; a session cookie it also carries is ignored. That's what makes it safe for such requests to skip the CSRF header.
- Bad credentials answer `401` with WordPress's codes, rather than continuing as a visitor: `invalid_username`, `invalid_email` or `incorrect_password`. Plugins can refuse a valid password by adding to the errors object in `wp_authenticate_application_password_errors`.
- Failures are throttled: 50 per address every 15 minutes, then `429`.
- Other schemes (`Bearer` and so on) are left for plugins; Pressbase treats the request as logged out.
- Application passwords **never work on the login form**: `auth/login` checks only the account password.
- `GET /wp/v2/users/me/application-passwords/introspect` returns the password the current request used.

Plugins can switch the feature off with `wp_is_application_passwords_available` (whole site) or `wp_is_application_passwords_available_for_user`.

## Mail

`kernel.mail.send({ to, subject, text, html?, replyTo?, headers? })` is `wp_mail()`. It resolves to `true` or `false` and never throws, so a broken mail server can't break the request that sent the message.

**Transports**

| When | Transport |
|---|---|
| `PRESSBASE_SMTP_URL` or `PRESSBASE_SMTP_HOST` is set | SMTP through nodemailer. See [Getting started](../development/getting-started.md#email). |
| Otherwise | The **outbox**: each message is written to `<dataDir>/outbox/<time>-<id>.eml` plus a `.json` summary (mode `0600`), and a one-line notice is logged. Good for development and trials; nothing leaves the machine. |

The sender is `PRESSBASE_MAIL_FROM`, else the site title and `pressbase@<site host>` (WordPress uses `wordpress@<host>`).

**Template:** `kernel.mail.compose({ siteName, heading, paragraphs, action?, footnote? })` renders the same content as plain text and as simple, inline-styled HTML in the admin's light colours, with the link written out under the button for clients that hide buttons. Every value is escaped.

**Hooks:** `pre_wp_mail` (return a boolean to short-circuit), `wp_mail` (change the message), `wp_mail_from`, `wp_mail_from_name`, `wp_mail_succeeded`, `wp_mail_failed`.

**Emails core sends:** password reset link, welcome email with a "set your password" link (when the admin ticks the box), password changed, email changed.

## Password reset

1. `/login` → **Forgot your password?** → `/lost-password` posts `{ login }` (username or email) to `POST /pressbase/v1/auth/lost-password`.
2. Core always answers with the same message, whether or not the account exists. If it does, core stores a new key and emails a link to `<siteurl>/reset-password?key=…&login=…`. The email is sent without being awaited, so a slow mail server can't reveal that the account exists.
3. `/reset-password` checks the link first (`POST /pressbase/v1/auth/check-reset-key`), so an expired or used link says so before anyone types a password.
4. `POST /pressbase/v1/auth/reset-password` `{ login, key, password }` sets the password, clears the key, logs the user out of **every** session, and fires `password_reset` and `after_password_reset`.

**Keys** are 20 random letters and digits. Only `<issued unix time>:<SHA-256 digest>` is stored in `users.activation_key`, as WordPress stores `user_activation_key`, so a database leak doesn't leak working links. They're compared in constant time, work once, are replaced by any newer request, and expire after 24 hours (`password_reset_expiration` filter). Errors: `invalid_key`, `expired_key`.

**Throttling:** lost-password requests are limited to 10 per address every 15 minutes (`429`), and to 3 emails per account every 15 minutes, silently, so the form can't flood an inbox or reveal anything. Key checks are limited to 20 failures per address every 15 minutes.

## Hooks

See the full table in [Hooks](hooks.md). Users: `user_register`, `profile_update`, `set_user_role`, `delete_user`, `deleted_user`, `illegal_user_logins`, `rest_prepare_user`, `rest_insert_user`, `rest_after_insert_user`, `rest_delete_user`. Application passwords: `wp_create_application_password`, `wp_update_application_password`, `wp_delete_application_password`, `wp_authenticate_application_password_errors`, `application_password_did_authenticate`, `application_password_failed_authentication`. Password reset: `lostpassword_post`, `retrieve_password`, `retrieve_password_key`, `retrieve_password_title`, `retrieve_password_message`, `password_reset`, `after_password_reset`.

Unlike WordPress, `password_reset` doesn't receive the new password: core never hands plain passwords to hooks.

## Not yet

- **Avatars:** `avatar_urls` is empty; the admin shows initials. Gravatar or uploaded avatars come later.
- **Self-registration** (`users_can_register`) and email confirmation for email changes.
- **Sessions screen:** logging out other sessions by hand ("Log out everywhere else").
- **Multisite** user management.
- **Per-user admin colour scheme and language** (the `locale` field is stored, but the admin is English only).
