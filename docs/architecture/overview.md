# Architecture overview

## The pieces

```
 Browser
    │  same origin (http://localhost:3000)
    ▼
┌───────────────────────────────┐   /wp-json/*    ┌──────────────────────────────────┐
│ apps/admin  (Next.js)         │ ──────────────▶ │ apps/core  (Hono on Node.js)     │
│ • installer, login, dashboard │   proxied by    │ • Kernel: config, hooks, options │
│ • server components fetch     │   next.config   │ • REST API: wp/v2 + pressbase/v1     │
│   core with the user's cookie │   rewrites      │ • installer, auth, capabilities  │
└───────────────────────────────┘                 └───────────────┬──────────────────┘
                                                                  │ @pressbase/db (Drizzle)
                                                                  ▼
                                                   PostgreSQL ─ or ─ PGlite (embedded)
```

| Process             | Port | Responsibility                                                     |
| ------------------- | ---- | ------------------------------------------------------------------ |
| `apps/core`         | 4000 | Owns all data and all rules. Everything goes through its REST API. |
| `apps/admin`        | 3000 | The admin interface. Holds no business logic; it calls core.       |
| `apps/web`          | 3001 | The public site: forwards each page to core's renderer ([ADR 0007](../adr/0007-public-rendering.md)) and caches anonymous pages until core purges them ([ADR 0008](../adr/0008-public-page-caching.md)). |

### Why core is separate from Next.js

WordPress lets an administrator upload a plugin and use it immediately. A Next.js app is compiled at build time, so code that arrives later can't join the build. Keeping plugins' server code in a plain Node process, which can `import()` code at runtime, keeps that WordPress promise. Next.js does what it's best at: routing, rendering and caching the admin and, later, the public site. The full reasoning is in [ADR 0003](../adr/0003-core-separate-from-next.md).

## Request flow

### The public site

Any path the admin doesn't own (`/`, `/2026/10/27/hello/`, `/category/news/`) is rewritten to `apps/web`, which asks core to render it (`GET /wp-json/pressbase/v1/render?url=…`) and returns the HTML with core's status and headers. Core runs the main query, picks a template from the active block theme and renders it. See [Themes and the public site](themes.md). Feeds, sitemaps and `robots.txt` take the same path, and `apps/web` answers repeat anonymous views from its page cache; see [The public site](public-site.md).

### The admin and the API

1. The browser calls `/wp-json/...` on the admin origin.
2. `next.config.ts` rewrites the request to core (`CORE_URL`, default `http://localhost:4000`). The browser only ever sees one origin, so cookies are first-party and no CORS is needed.
3. In core, middleware runs in this order:
   1. `requireRequestHeader` (CSRF);
   2. `loadSessionUser` (cookie → user and capabilities);
   3. `applicationPasswordAuth` (`Authorization: Basic` → user; replaces any cookie user, see [People](people.md#application-passwords));
   4. for routes that need an installed site, `requireInstalled`;
   5. per route, `requireCapability(...)`.
4. Errors come back in WordPress's shape: `{ code, message, data: { status } }`.

Admin **server components** call core directly through `coreGet()` (`apps/admin/src/lib/core.ts`), forwarding the visitor's cookies. **Client components** use `api()` (`apps/admin/src/lib/api.ts`), which adds the CSRF header.

## Boot sequence

`apps/core/src/server.ts` → `Kernel.boot()`. This is Pressbase's version of `wp-settings.php`.

```
loadConfig()          env vars, then <dataDir>/config.json
  └─ Kernel()
       └─ registerCoreSettings()
  └─ boot()
       └─ useDatabase(url)       if a database is configured
            ├─ connect()         postgres-js or PGlite
            ├─ migrate()         pending SQL migrations, every boot
            └─ refreshState()
                 ├─ options.load()            autoloaded options
                 ├─ state = needs-install | ready
                 └─ if ready: data upgrades, then the `init` action
                                (schedules missing cron events)
  └─ jobs.start()        the job queue worker, unless PRESSBASE_WORKER=off
```

The kernel's `state` drives the whole product: `needs-database` → `needs-install` → `ready`. See [Installer](installer.md).

## Repository layout

```
apps/
  core/src/
    server.ts            process entry
    app.ts               routes and middleware wiring
    kernel.ts            life cycle, state, shared services
    config.ts            env + config.json
    http.ts              middleware, error helpers
    auth/                passwords, sessions, users, capabilities, rate limiting
    install/             installer logic and database helpers
    jobs/                kernel.jobs (job queue, worker) and kernel.cron (WP-Cron)
    people/              users, application passwords, password reset
    mail/                kernel.mail (wp_mail): SMTP or the development outbox
    options/             Options API and the settings registry
    routes/              one file per REST resource
    themes/              theme discovery, PHP pattern loader, theme block supports, assets
    frontend/            request routing, main query, template hierarchy, page rendering
  admin/src/
    app/                 Next.js routes (install, login, admin/…)
    components/ui/       design-system components
    components/shell/    admin chrome: sidebar, top bar, page header
    lib/                 API clients, sections (IA), helpers
packages/
  db/                    schema.ts, migrations/, connect()
  hooks/                 HookBus
  blocks/                block parser, registry, renderer, block supports
  theme-json/            theme.json engine: merging, global stylesheet, layout styles
themes/                  bundled block themes (Twenty Twenty-Five)
apps/web/                the public site (Next.js route handler)
docs/                    you are here
```

## Where things will go next

| Coming in                                     | Location                                 |
| --------------------------------------------- | ---------------------------------------- |
| Post types, taxonomies, `ContentQuery` (v0.2) | `apps/core/src/content/`                 |
| Block parsing and rendering (v0.3)            | `packages/blocks`                        |
| Plugin loader and SDK (v0.5)                  | `apps/core/src/plugins/`, `packages/sdk` |
