# Getting started

## Requirements

- **Node.js 22.12 or newer** (24 recommended; see `.nvmrc`).
- **pnpm.** Run `corepack enable` once; the pinned version in `package.json` is then used automatically.
- **PostgreSQL 14+** (optional for development). Without it, use the built-in database.

## First run

```bash
git clone https://github.com/WarnHack-Technologies-Private-Limited/pressbase.git && cd pressbase
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` starts both apps through Turborepo:

| App      | URL                             | Logs prefix        |
| -------- | ------------------------------- | ------------------ |
| Core API | <http://localhost:4000/wp-json> | `@pressbase/core:dev`  |
| Admin    | <http://localhost:3000>         | `@pressbase/admin:dev` |

Open <http://localhost:3000> and follow the installer.

## Using PostgreSQL

With Docker:

```bash
pnpm db:up
cp .env.example .env
# in .env: DATABASE_URL=postgres://pressbase:pressbase@localhost:5432/pressbase
pnpm dev
```

With `DATABASE_URL` set, the installer skips the database step. Without it, you can enter the same details in the installer, which saves them to `apps/core/.pressbase/config.json`.

## Resetting your local site

| Setup                         | Reset with                                                             |
| ----------------------------- | ---------------------------------------------------------------------- |
| Built-in database             | Stop `pnpm dev`, then `rm -rf apps/core/.pressbase`                        |
| Docker PostgreSQL             | `docker compose down -v && pnpm db:up`                                 |
| PostgreSQL from the installer | Drop and recreate the database, then `rm apps/core/.pressbase/config.json` |

## Everyday commands

| Command                          | What it does                                                 |
| -------------------------------- | ------------------------------------------------------------ |
| `pnpm dev`                       | Run everything in watch mode                                 |
| `pnpm test`                      | All test suites                                              |
| `pnpm typecheck`                 | TypeScript across the workspace                              |
| `pnpm lint` / `pnpm format`      | Check / fix formatting and lint (Biome)                      |
| `pnpm db:generate`               | Create a migration after editing `packages/db/src/schema.ts` |
| `pnpm --filter @pressbase/core test` | One package's tests                                          |

## Environment variables

See `.env.example`. Core reads the repo-root `.env` in development.

| Variable            | Default                       | Purpose                                          |
| ------------------- | ----------------------------- | ------------------------------------------------ |
| `DATABASE_URL`      | —                             | PostgreSQL URL, or `pglite:<dir>`                |
| `PRESSBASE_DATA_DIR`    | `./.pressbase` (relative to core) | `config.json`, built-in database, `uploads/` |
| `PRESSBASE_MAX_UPLOAD_MB` | `64`                        | Largest file the media library accepts           |
| `PRESSBASE_SETUP_TOKEN` | —                             | Require this code in the installer               |
| `PORT`              | `4000`                        | Core's port                                      |
| `CORE_URL`          | `http://localhost:4000`       | Where the admin app reaches core                 |
| `PRESSBASE_SMTP_URL` | —                            | SMTP server as a URL, e.g. `smtps://user:pass@smtp.example.com:465`. Wins over the fields below. |
| `PRESSBASE_SMTP_HOST`, `PRESSBASE_SMTP_PORT`, `PRESSBASE_SMTP_USER`, `PRESSBASE_SMTP_PASS`, `PRESSBASE_SMTP_SECURE` | — · `587` (`465` when secure) | SMTP server as separate settings. `SECURE=true` uses TLS from the start. |
| `PRESSBASE_MAIL_FROM` | site title + `pressbase@<site host>` | Sender, e.g. `"The Morning Paper <hello@example.com>"` |

## Email

Without SMTP settings, Pressbase doesn't send email. It writes each message to `<data dir>/outbox/` instead (`apps/core/.pressbase/outbox/` by default) as an `.eml` file you can open in a mail app, plus a `.json` summary, and logs a line like:

```
[mail] SMTP isn’t set up; saved “[My Site] Password reset” to …/outbox/2026-10-27T09-30-00-000Z-1a2b3c.eml
```

That's enough to finish password resets and welcome emails locally: open the newest file and follow the link. Set `PRESSBASE_SMTP_URL` (or the separate `PRESSBASE_SMTP_*` variables) for a real site. Outbox files contain working reset links, so they're readable only by the server's user; delete them when you're done. See [People](../architecture/people.md#mail).

## Troubleshooting

- **"Something went wrong" page in the admin.** Core isn't running or isn't reachable at `CORE_URL`. Check the `@pressbase/core:dev` logs.
- **Port in use.** Set `PORT` for core (and `CORE_URL` to match), or run `next dev --port` for the admin.
- **`Unable to find package manager binary`** from Turborepo. Run `corepack enable` so `pnpm` is on your `PATH`.
