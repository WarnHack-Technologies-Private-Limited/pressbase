# Security

How Pressbase protects a site today, and what's still missing. Update this page with any change to authentication, sessions, input handling or the installer.

## Threats we design for

| Threat                     | Protection                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen database dump       | Passwords are scrypt hashes. The sessions table holds only SHA-256 digests of tokens, so it can't be replayed.                                                                                 |
| Password guessing          | Login throttling: 5 failures per (address, login) and 20 per login, every 15 minutes. "Unknown user" and "wrong password" get the same message and take the same time.                         |
| Cross-site request forgery | Unsafe requests must carry `X-Pressbase-Request`. Browsers can't add custom headers to cross-site requests without a CORS preflight, and core never approves one. Cookies are also `SameSite=Lax`. |
| Application passwords sniffed in transit | Accepted only over HTTPS, or from a local development host (`localhost`, `*.localhost`, `*.test`), as WordPress's `wp_is_application_passwords_supported()` does. The host is read from `X-Forwarded-Host` because requests arrive through the admin proxy. `PRESSBASE_ALLOW_HTTP_APP_PASSWORDS=1` lifts the rule on trusted private networks. |
| Session theft through XSS  | Session cookies are `HttpOnly` and `Secure` on HTTPS. React escapes output by default.                                                                                                         |
| Install hijacking          | The installer is closed once installed (`409`), and can be gated with `PRESSBASE_SETUP_TOKEN`. The setup code is compared in constant time.                                                        |
| Credentials on disk        | `config.json` is written `0600`. Production should prefer `DATABASE_URL` from the environment.                                                                                                 |
| Open redirects             | Login only redirects to `/admin…` paths.                                                                                                                                                       |
| Stored XSS through content | Users without `unfiltered_html` (Authors, Contributors) have titles, content and excerpts sanitised to WordPress's allowed post HTML. Scripts, event handlers and `javascript:` URLs are removed. Block delimiters are validated and re-encoded so their JSON can't close the comment early. |
| Account enumeration through the API | `/wp/v2/users` lists only people with published content unless the viewer has `list_users`; emails only appear with `context=edit`. |
| Stolen API credentials     | Application passwords are random (24 characters, ~142 bits), stored only as SHA-256 digests, shown once, revocable one by one, and record when and from where they were last used. They work only on the REST API, never on the login form. Failed Basic-auth attempts are throttled per address. |
| CSRF through API credentials | A request with an `Authorization` header skips the CSRF header check, so core authenticates it by that header alone and ignores any session cookie it carries. |
| Account takeover by reset link | Reset keys are 20 random characters; the database holds only `time:sha256`. They're compared in constant time, work once, are replaced by a newer request, expire after 24 hours, and are cleared by any password change. A successful reset logs the user out everywhere. |
| Account enumeration through password reset | `lost-password` gives the same answer whether or not the account exists, and sends the email without waiting for it, so response times don't differ. Per-account email limits are silent. |
| Inbox flooding             | At most 10 reset requests per address and 3 reset emails per account every 15 minutes. |
| Locking the site out       | Nobody can give themselves a role without `edit_users`, and the last administrator can't be demoted or deleted. |
| Unnoticed account changes  | A password change logs out the account's other sessions and emails the account; an email change notifies the old address. |
| Mail on disk               | Without SMTP, outgoing mail (including reset links) goes to `<dataDir>/outbox` with mode `0600`. Configure SMTP for any real site. |
| Mass assignment            | Settings updates accept only registered settings. Each is validated, and nothing is saved if any field fails.                                                                                  |

## Known gaps (tracked for upcoming releases)

- **Shared throttle store.** Throttle counters are in memory, per process. They need a shared store once Pressbase runs on several processes (v0.5, with the job queue).
- **Client IP behind proxies.** It's read from `X-Forwarded-For`, which a client can spoof. That's acceptable only because the per-login limit doesn't depend on IP. A trusted-proxy setting is planned.
- **Login lockout.** An attacker can deliberately trigger the per-login limit (20 attempts per 15 minutes) to lock out a known username.
- **Security headers.** CSP and similar headers on the admin app.
- **Basic auth reveals unknown usernames.** As in WordPress, a wrong username answers `invalid_username` and a wrong password `incorrect_password`. Throttling limits how fast this can be probed.
