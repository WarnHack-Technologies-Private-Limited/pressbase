# Installer

The installer is the first thing every Pressbase user sees, so it gets product-level care. It replaces WordPress's `setup-config.php` and `install.php` with one guided flow.

## Site states

The kernel has exactly one `state` (`apps/core/src/kernel.ts`):

```
needs-database ──(database chosen)──▶ needs-install ──(install)──▶ ready
      ▲                                    ▲
  no DATABASE_URL and              DATABASE_URL set, or
  no config.json                   config.json present but no pressbase_db_version option
```

| State            | Admin shows                            | Core allows                               |
| ---------------- | -------------------------------------- | ----------------------------------------- |
| `needs-database` | Installer, including the Database step | Index and installer routes only           |
| `needs-install`  | Installer, without the Database step   | Index and installer routes only           |
| `ready`          | Login or dashboard                     | Everything; installer routes answer `409` |

## Flow

| Step          | Shown when       | Content                                                                                                                |
| ------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Welcome**   | always           | What you'll need, system checks (Node version, writable data folder), setup code if required.                          |
| **Database**  | `needs-database` | PostgreSQL (details or URL, optional SSL) or the built-in database. _Connect and continue_ tests the connection first. |
| **Your site** | always           | Site title, username, password (a strong one is generated, with a strength meter), email, search-engine visibility.    |
| **Done**      | after install    | Summary, a warning if the built-in database is in use, _Go to your dashboard_. The administrator is already signed in. |

On submit, core:
1. connects and migrates (if a database was chosen);
2. runs `installSite()` in a transaction: administrator, roles, options, the Uncategorized category, _Hello world!_, a sample comment and _Sample Page_;
3. writes `config.json`;
4. creates a session.

The browser's time zone becomes the site's `timezone_string`.

If the chosen database already contains a Pressbase site, core saves the config and answers `409 pressbase_already_installed`. The UI then offers _Log in_ instead of overwriting anything.

## Configuration

| Source                  | Keys                                                          | Notes                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Environment             | `DATABASE_URL`, `PRESSBASE_DATA_DIR`, `PRESSBASE_SETUP_TOKEN`, `PORT` | Win over config.json. Read from the repo-root `.env` in dev.                                                                              |
| `<dataDir>/config.json` | `databaseUrl`                                                 | Written by the installer, mode `0600`. `dataDir` defaults to `./.pressbase` relative to core's working directory (`apps/core/.pressbase` in dev). |

## Protecting a public install

Until installation finishes, whoever reaches the installer first can claim the site. That's true of WordPress too. On any server reachable from the internet, set `PRESSBASE_SETUP_TOKEN`. The installer then asks for that code, and core rejects install requests without it.

## UX decisions

- **One primary action per step.** Testing the database connection is part of _Connect and continue_, not a separate button.
- **Focus moves to each step's heading**, so screen readers announce the change.
- **Errors appear next to their fields**, and the first invalid field receives focus. Server-side validation messages map onto the same fields.
- **Database errors are translated** (`describeDatabaseError`) into what happened and what to do next: "The database server refused the connection. Check that PostgreSQL is running…"
- **A strong password is suggested.** A weak one is allowed only after explicit confirmation, as in WordPress.
- **The built-in database is labelled honestly** as not meant for live sites, both when chosen and on the dashboard.
