# Pressbase

[![CI](https://github.com/WarnHack-Technologies-Private-Limited/pressbase/actions/workflows/ci.yml/badge.svg)](https://github.com/WarnHack-Technologies-Private-Limited/pressbase/actions/workflows/ci.yml)
[![License: GPL v2+](https://img.shields.io/badge/license-GPL--2.0--or--later-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**The open-source WordPress alternative built on TypeScript, Next.js and PostgreSQL.**

Pressbase keeps what made WordPress win — posts and pages, custom post types, taxonomies, meta, roles, actions and filters, themes, plugins, a five-minute install — and rebuilds it for today: typed end to end, PostgreSQL-native, and with plugins that install at runtime without a rebuild.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/dashboard-dark.png">
  <img alt="The Pressbase dashboard: post, draft, page and comment counts, a setup checklist and site health" src="docs/assets/screenshots/dashboard.png">
</picture>

> **Status: developer preview (v0.4).** Write in the Gutenberg block editor, manage media, comments and users, and publish a real site with the Twenty Twenty-Five theme, global styles, menus, feeds and sitemaps. Plugins arrive in v0.5. See the [roadmap](docs/roadmap.md).
>
> Pressbase is an independent project. It isn't affiliated with or endorsed by the WordPress Foundation or Automattic; "WordPress" is their trademark.

## See it in action

### The block editor you already know

Gutenberg runs inside Pressbase: slash commands, the inserter, patterns, list view, a code view, autosave and revisions. Posts are stored as WordPress block markup, and the server parses and renders it.

![Writing a post in the Pressbase block editor: a title, a paragraph, a heading and a quote, then publishing](docs/assets/screenshots/editor.gif)

### WordPress block themes, unchanged

Twenty Twenty-Five ships in the box and renders without changes, using its own `theme.json`, templates, parts and patterns. No PHP runs: Pressbase reads the theme files directly. Pick a style variation, change colours and type, and see the result in a live preview before you save.

![Switching between Twenty Twenty-Five style variations in Appearance → Styles, with a live preview of the home page](docs/assets/screenshots/styles.gif)

### A fast public site

The public site has WordPress permalinks, archives, search, threaded comments, RSS and Atom feeds, `wp-sitemap.xml` and `robots.txt`. Pages are cached and purged the moment their content changes.

<table>
  <tr>
    <td><img alt="The public home page of a Pressbase site using Twenty Twenty-Five" src="docs/assets/screenshots/home.png"></td>
    <td><img alt="A single post on the public site, with author, category, tags and post navigation" src="docs/assets/screenshots/post.png"></td>
  </tr>
</table>

### An admin that stays out of your way

A calm, accessible admin with light and dark modes and a mobile layout. It has the screens you expect: posts and pages, media, comment moderation with inline reply and Undo, users and roles, and settings.

<table>
  <tr>
    <td><img alt="The block inserter open in the post editor, showing paragraph, image, heading, gallery, list and quote blocks" src="docs/assets/screenshots/editor-inserter.png"></td>
    <td><img alt="The Comments screen with filters for pending, approved, spam and trash" src="docs/assets/screenshots/comments.png"></td>
  </tr>
</table>

## Why Pressbase

- **WordPress-compatible where it counts.** Same data model, hook names, REST routes (`/wp-json/wp/v2`), roles and capabilities, and block markup. Logins with existing WordPress password hashes work too. If you know WordPress, you already know your way around.
- **TypeScript end to end.** Hono core, Next.js admin and Drizzle ORM, all typed, from the database schema to the REST response.
- **PostgreSQL-native.** Or try it with no database server at all: the built-in database runs PostgreSQL in-process.
- **One command to run.** `pnpm dev` or one Docker image. No PHP, no MySQL, no web server config.
- **Plugins without a rebuild** (v0.5). Install and activate them at runtime, as in WordPress.
- **GPL, in the open.** The same license as WordPress, so Gutenberg packages and the theme ecosystem stay compatible.

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

Or install from the terminal, without the browser, with the `pressbase` CLI:

```bash
pnpm pressbase core install --builtin-database --url=http://localhost:3000 \
  --title="My site" --admin_user=admin --admin_email=you@example.com
pnpm pressbase post list
```

More detail is in [Getting started](docs/development/getting-started.md) and the [CLI reference](docs/development/cli.md).

### Run with Docker

One image runs everything. With the built-in database, to try it:

```bash
docker run -p 3000:3000 -v pressbase:/data ghcr.io/warnhack-technologies-private-limited/pressbase
```

With PostgreSQL 17, for a real site:

```bash
git clone https://github.com/WarnHack-Technologies-Private-Limited/pressbase.git && cd pressbase
echo "PRESSBASE_SETUP_TOKEN=$(openssl rand -hex 16)" > .env   # the installer will ask for it
docker compose up -d
```

Open <http://localhost:3000> and follow the installer. Configuration, SMTP and how the image is built are in [Getting started](docs/development/getting-started.md#run-with-docker).

## What's in the box

| Path                  | What it is                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/core`           | The core server (Hono on Node.js): REST API at `/wp-json`, content, media, people, comments, themes and rendering.   |
| `apps/admin`          | The admin app (Next.js): installer, dashboard, block editor, media, comments, users, appearance, tools (Site Health) and settings. |
| `apps/web`            | The public site (Next.js): serves pages rendered by core, with a tagged page cache.                                 |
| `packages/db`         | PostgreSQL schema (Drizzle ORM), migrations and the connection factory. Also runs on the built-in database (PGlite). |
| `packages/hooks`      | Actions and filters: the extension system, modelled on `WP_Hook`.                                                   |
| `packages/blocks`     | Block parsing and serialising, a port of `WP_Block_Parser`.                                                         |
| `packages/theme-json` | The `theme.json` engine: presets, global styles, layout and fonts.                                                  |
| `themes/`             | Bundled block themes (Twenty Twenty-Five).                                                                          |
| `docs/`               | Vision, roadmap, architecture, design system, decision records and contributor guides.                              |

## Documentation

Start at the **[documentation index](docs/README.md)**. Highlights:

- [Vision and principles](docs/vision.md): why Pressbase exists and what it will not do.
- [Architecture overview](docs/architecture/overview.md): how the pieces fit.
- [WordPress → Pressbase map](docs/architecture/wordpress-mapping.md): where each WordPress concept lives here.
- [Design system](docs/design/principles.md): UX principles, tokens and components.
- [Decision records](docs/adr/README.md): the reasoning behind the big choices.

## Contributing

Contributions of every size are welcome: code, design, docs, translations and testing. Pressbase is early, so your work shapes what it becomes.

Good places to start:

- **Issues labelled [`good first issue`](https://github.com/WarnHack-Technologies-Private-Limited/pressbase/labels/good%20first%20issue)**: small, well-scoped tasks.
- **The [v0.5 plugins milestone](docs/roadmap.md#v05-plugins)**: the plugin loader, admin extension points, cron and the plugin SDK.
- **Port a WordPress feature.** The [WordPress → Pressbase map](docs/architecture/wordpress-mapping.md) shows where each piece goes.
- **Try it and tell us what broke.** Install it, write a post, switch styles, then [open an issue](https://github.com/WarnHack-Technologies-Private-Limited/pressbase/issues/new).

Read [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and follow the [Code of Conduct](CODE_OF_CONDUCT.md) when you take part. To report a security problem, follow [SECURITY.md](SECURITY.md) and don't open a public issue.

## License

Copyright © 2026 WarnHack Technologies Private Limited and the Pressbase contributors.

Pressbase is free software under the [GNU General Public License v2.0 or later](LICENSE), the same license as WordPress. That keeps us compatible with the WordPress ecosystem, including the Gutenberg packages we plan to build on. See [ADR 0004](docs/adr/0004-gpl-license.md).

---

Pressbase is built and maintained in the open by [WarnHack Technologies](https://github.com/WarnHack-Technologies-Private-Limited) and contributors like you.
