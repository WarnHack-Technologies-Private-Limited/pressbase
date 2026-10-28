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

`pnpm dev` starts the three apps through Turborepo:

| App      | URL                             | Logs prefix        |
| -------- | ------------------------------- | ------------------ |
| Core API | <http://localhost:4000/wp-json> | `@pressbase/core:dev`  |
| Admin    | <http://localhost:3000>         | `@pressbase/admin:dev` |
| Public site | <http://localhost:3001>      | `@pressbase/web:dev`   |

Open <http://localhost:3000> and follow the installer. Afterwards <http://localhost:3000> shows the public site (the admin forwards every path it doesn't own to the public app, so the site and `/admin` share the address you installed with, as in WordPress), and <http://localhost:3001> shows the same site directly. The site uses the bundled Twenty Twenty-Five theme; switch themes in **Appearance**.

## Using PostgreSQL

With Docker:

```bash
pnpm db:up
cp .env.example .env
# in .env: DATABASE_URL=postgres://pressbase:pressbase@localhost:5432/pressbase
pnpm dev
```

With `DATABASE_URL` set, the installer skips the database step. Without it, you can enter the same details in the installer, which saves them to `apps/core/.pressbase/config.json`.

## Run with Docker

The official image runs core, the admin and the public site in one container. Only port 3000 needs publishing: the admin forwards the API and the public pages internally.

```bash
docker run -d --name pressbase -p 3000:3000 -v pressbase:/data \
  ghcr.io/warnhack-technologies-private-limited/pressbase:latest
```

Open <http://localhost:3000> and follow the installer. Without `DATABASE_URL` it offers the built-in database (kept in the `/data` volume, good for trying Pressbase) or the details of your PostgreSQL server (saved to `/data/config.json`). For a real site, use PostgreSQL and a setup code:

```bash
docker compose up -d     # Pressbase + postgres:17 from docker-compose.yml, on http://localhost:3000
```

`docker exec pressbase pressbase plugin list` runs the [CLI](cli.md) inside the container when the site uses PostgreSQL. The server holds the built-in database, so then stop the container and run `docker run --rm -v pressbase:/data pressbase pressbase plugin list`. `docker compose up --build` builds the image from your checkout instead of pulling it; `docker build -t pressbase .` builds it on its own.

| Variable | Default in the image | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL URL. Without it, the installer asks. |
| `PRESSBASE_SETUP_TOKEN` | — | The installer asks for this code. Set it on any server reachable from the internet. |
| `PRESSBASE_DATA_DIR` | `/data` | `config.json`, the built-in database, uploads, themes, the mail outbox. Mount a volume here. |
| `PRESSBASE_SMTP_URL`, `PRESSBASE_SMTP_*`, `PRESSBASE_MAIL_FROM` | — | Outgoing email, as [above](#environment-variables). Without SMTP, mail goes to `/data/outbox`. |
| `PORT` | `3000` | The admin's port inside the container (the one to publish). |
| `PRESSBASE_CORE_PORT`, `PRESSBASE_WEB_PORT` | `4000`, `3001` | Internal ports for core and the public site. They're fixed in the image's build (see below), so leave them alone. |

How the image is put together (`Dockerfile`, `docker/`):

- **Multi-stage build** on `node:24-bookworm-slim` (Debian, so the prebuilt `sharp` and `esbuild` binaries work on amd64 and arm64). The build stage installs the workspace and builds the admin and the public site with Next.js's `output: 'standalone'` (switched on by `PRESSBASE_STANDALONE=1`). Next.js fixes its rewrites at build time, so the image is built with `CORE_URL=http://127.0.0.1:4000` and `WEB_URL=http://127.0.0.1:3001`.
- **Core runs from its TypeScript source with tsx**, as `pnpm --filter @pressbase/core start` does, with production dependencies only (`pnpm install --prod --filter "@pressbase/core..."`). Bundling it was the alternative, but core finds bundled themes, its static files and the database migrations relative to its source files, and plugins will be `import()`ed at runtime ([ADR 0003](../adr/0003-core-separate-from-next.md)); a bundle would break both and save little.
- **`docker/start.mjs`** (plain Node.js) starts the three servers, prefixes their logs (`[core]`, `[web]`, `[admin]`), forwards `SIGTERM`/`SIGINT`, and exits when any of them stops, so Docker's restart policy takes over. It also turns on the public page cache: unless you set `PRESSBASE_REVALIDATE_SECRET`, it generates a random one for the container and gives it, with `WEB_URL`, to core and the public site. **`docker/healthcheck.mjs`** is the `HEALTHCHECK`: core directly, plus the public site and the admin through their proxies.
- Runs as the unprivileged `node` user. Core's code is owned by root and read-only to it; `/data` belongs to `node`.

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
| `pnpm e2e`                       | Browser tests against production builds (run `pnpm build` first; see [Testing](testing.md#end-to-end-tests)) |
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
| `CORE_URL`          | `http://localhost:4000`       | Where the admin and public apps reach core       |
| `WEB_URL`           | `http://localhost:3001`       | Where the admin forwards public pages            |
| `ADMIN_URL`         | `http://localhost:3000`       | Where the public app sends visitors to install   |
| `PRESSBASE_REVALIDATE_SECRET` | — | Turns on the public page cache: a secret (16+ characters) shared by core and `apps/web`, which core uses to purge cached pages at `WEB_URL` (comma-separated for several instances). Without it, nothing is cached. See [ADR 0008](../adr/0008-public-page-caching.md). |
| `PRESSBASE_PAGE_CACHE_MB` | `64` | Memory `apps/web`'s page cache may use |
| `PRESSBASE_SMTP_URL` | —                            | SMTP server as a URL, e.g. `smtps://user:pass@smtp.example.com:465`. Wins over the fields below. |
| `PRESSBASE_SMTP_HOST`, `PRESSBASE_SMTP_PORT`, `PRESSBASE_SMTP_USER`, `PRESSBASE_SMTP_PASS`, `PRESSBASE_SMTP_SECURE` | — · `587` (`465` when secure) | SMTP server as separate settings. `SECURE=true` uses TLS from the start. |
| `PRESSBASE_MAIL_FROM` | site title + `pressbase@<site host>` | Sender, e.g. `"The Morning Paper <hello@example.com>"` |
| `PRESSBASE_WORKER` | on | `off` stops this core process from running background jobs and cron events, when another process sharing the database runs them. See [Jobs and cron](../architecture/jobs.md#the-worker). |

## Email

Without SMTP settings, Pressbase doesn't send email. It writes each message to `<data dir>/outbox/` instead (`apps/core/.pressbase/outbox/` by default) as an `.eml` file you can open in a mail app, plus a `.json` summary, and logs a line like:

```
[mail] SMTP isn’t set up; saved “[My Site] Password reset” to …/outbox/2026-10-27T09-30-00-000Z-1a2b3c.eml
```

That's enough to finish password resets and welcome emails locally: open the newest file and follow the link. Set `PRESSBASE_SMTP_URL` (or the separate `PRESSBASE_SMTP_*` variables) for a real site. Outbox files contain working reset links, so they're readable only by the server's user; delete them when you're done. See [People](../architecture/people.md#mail).

## Troubleshooting

- **"Something went wrong" page in the admin.** Core isn't running or isn't reachable at `CORE_URL`. Check the `@pressbase/core:dev` logs.
- **Port in use.** Set `PORT` for core (and `CORE_URL` to match), or run `next dev --port` for the admin or the public site (and set `WEB_URL` / `ADMIN_URL` to match).
- **"The site can't be reached right now" from the public site.** Core isn't reachable at `CORE_URL`.
- **An edit doesn't show on the public site.** Check the `x-pressbase-cache` response header. If core logs `[cache] … refused the purge`, `PRESSBASE_REVALIDATE_SECRET` differs between core and `apps/web`; if `[cache] Couldn't reach …`, core's `WEB_URL` doesn't point at `apps/web`. Logged-in visitors always bypass the cache.
- **Theme files changed but the site didn't.** The active theme is cached; restart core (or call `kernel.themes.reload()`).
- **`Unable to find package manager binary`** from Turborepo. Run `corepack enable` so `pnpm` is on your `PATH`.
