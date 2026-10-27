# 0003: Core server separate from the Next.js apps

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

WordPress's defining experience is "upload a plugin, activate it, it works". Next.js compiles the app at build time, so code installed later can't join that build. Every Node CMS built inside its framework (Strapi, Payload) asks users to rebuild after installing plugins.

## Decision

- All data, rules and extension points live in **`apps/core`**, a plain Node.js server (Hono). It can `import()` plugin code at runtime.
- The **Next.js apps** (`admin` now, `web` later) are clients of core's REST API. They hold no business logic.
- The admin proxies `/wp-json/*` to core, so the browser sees one origin.
- Plugin UI will load at runtime as ES modules, as WordPress's script modules do.
- Plugin blocks will render on the server inside core.

## Consequences

- Plugins can be installed without a rebuild. This was the main goal.
- The REST API is complete by construction, which makes headless use first-class.
- There are two processes to run and deploy; the Docker image will run both.
- Server components pay one HTTP hop to core. On localhost this is negligible, and it can be cached later.

## Alternatives considered

- **Everything inside Next.js** (route handlers plus a custom server): simpler deployment, but plugins would need a rebuild.
- **A separate SPA (Vite) for the admin:** loses server rendering of the admin and redirects without a flash.
