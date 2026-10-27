# Pressbase

[![CI](https://github.com/WarnHack-Technologies-Private-Limited/pressbase/actions/workflows/ci.yml/badge.svg)](https://github.com/WarnHack-Technologies-Private-Limited/pressbase/actions/workflows/ci.yml)
[![License: GPL v2+](https://img.shields.io/badge/license-GPL--2.0--or--later-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**The open-source WordPress alternative built on TypeScript, Next.js and PostgreSQL.**

Pressbase keeps what made WordPress win — posts and pages, custom post types, taxonomies, meta, roles, actions and filters, themes, plugins, a five-minute install — and rebuilds it for today: typed end to end, PostgreSQL-native, and with plugins that install at runtime without a rebuild.

> **Status: developer preview (v0.1 "Foundation").** You can install Pressbase, log in, see the dashboard and edit general settings. Content editing arrives in v0.2. See the [roadmap](docs/roadmap.md).
>
> Pressbase is an independent project. It isn't affiliated with or endorsed by the WordPress Foundation or Automattic; "WordPress" is their trademark.

## Quick start

You need **Node.js 22.12+** and **pnpm** (run `corepack enable` once to get it).

```bash
git clone https://github.com/WarnHack-Technologies-Private-Limited/pressbase.git
cd pressbase
pnpm install
pnpm dev
```

Open <http://localhost:3000>. The installer walks you through the rest. If you have no PostgreSQL server, choose **Built-in database** to try Pressbase straight away.

To use PostgreSQL from Docker instead:

```bash
pnpm db:up                       # starts postgres:17 on localhost:5432 (user/pass/db: pressbase)
cp .env.example .env             # then set DATABASE_URL=postgres://pressbase:pressbase@localhost:5432/pressbase
pnpm dev
```

More detail is in [Getting started](docs/development/getting-started.md).

## What's in the box

| Path             | What it is                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/core`      | The core server (Hono on Node.js): kernel, REST API at `/wp-json`, installer, authentication, roles, options. |
| `apps/admin`     | The admin app (Next.js): installer, login, dashboard, settings.                                               |
| `packages/db`    | PostgreSQL schema (Drizzle ORM), migrations and the connection factory. Also runs on embedded PGlite.         |
| `packages/hooks` | Actions and filters: the extension system, modelled on `WP_Hook`.                                             |
| `docs/`          | Vision, roadmap, architecture, design system, decision records and contributor guides.                        |

## Documentation

Start at the **[documentation index](docs/README.md)**. Highlights:

- [Vision and principles](docs/vision.md): why Pressbase exists and what it will not do.
- [Architecture overview](docs/architecture/overview.md): how the pieces fit.
- [WordPress → Pressbase map](docs/architecture/wordpress-mapping.md): where each WordPress concept lives here.
- [Design system](docs/design/principles.md): UX principles, tokens and components.
- [Decision records](docs/adr/README.md): the reasoning behind the big choices.

## Contributing

Contributions of every size are welcome: code, design, docs, translations and testing. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and follow the [Code of Conduct](CODE_OF_CONDUCT.md) when you take part. To report a security problem, follow [SECURITY.md](SECURITY.md) and don't open a public issue.

## License

Copyright © 2026 WarnHack Technologies Private Limited and the Pressbase contributors.

Pressbase is free software under the [GNU General Public License v2.0 or later](LICENSE), the same license as WordPress. That keeps us compatible with the WordPress ecosystem, including the Gutenberg packages we plan to build on. See [ADR 0004](docs/adr/0004-gpl-license.md).

---

Pressbase is built and maintained in the open by [WarnHack Technologies](https://github.com/WarnHack-Technologies-Private-Limited) and contributors like you.
