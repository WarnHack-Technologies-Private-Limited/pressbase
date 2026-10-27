# Vision

## Why Pressbase exists

WordPress runs a huge share of the web because it got the fundamentals right:
- a content model flexible enough for almost anything (posts, post types, taxonomies, meta);
- an extension system anyone can learn (actions and filters);
- an install a non-developer can finish in five minutes.

Those ideas are excellent. The platform under them is 20 years old: PHP globals, MySQL-only, serialized PHP in the database, untyped APIs, and plugins with unlimited access to everything.

**Pressbase keeps WordPress's ideas and rebuilds the foundation.** It is TypeScript end to end, PostgreSQL-native and API-first, and its extension model can be typed and, eventually, sandboxed.

## Who it's for

| Audience                         | What they need from Pressbase                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Site owners and writers**      | A calm, fast admin that feels familiar if they've used WordPress.                                                           |
| **Agencies and developers**      | Typed APIs, Git-friendly configuration, modern deployment (containers, managed Postgres), and headless use without plugins. |
| **Plugin and theme authors**     | Hooks they already understand, typed. Runtime installs, no rebuilds. A clear path to port WordPress block themes.           |
| **WordPress users who want out** | A one-step migration that keeps their content, users and URLs.                                                              |

## What "WordPress-compatible" means here

Pressbase does **not** run PHP plugins or classic PHP themes. Compatibility means:

1. **Concepts.** Posts, pages, custom post types, taxonomies, meta, roles and capabilities, options, actions and filters.
2. **REST API.** `/wp-json/wp/v2/*` routes answer with WordPress's field names and shapes, so headless frontends and mobile apps keep working.
3. **Data.** Import from a WordPress export (WXR) or straight from a WordPress database.
4. **Block themes.** `theme.json` plus HTML block templates (for example Twenty Twenty-Five) render without changes. Their PHP is limited to `functions.php` niceties.

## Product principles

1. **Familiar first, modern second.** WordPress users should find everything where they expect it. Change only what makes things clearly better.
2. **The five-minute install is sacred.** Every release is tested from a clean machine through the web installer.
3. **Calm by default.** No nag banners and no upsells in core. Notices are rare, useful and dismissible.
4. **Accessible is not optional.** WCAG 2.2 AA is the floor, checked on every UI change.
5. **Typed contracts.** Every hook, REST route and setting has a type and is documented.
6. **Your data is yours.** Plain PostgreSQL tables, documented schema, full export.
7. **Honest software.** Unbuilt features say when they're coming. Errors say what happened and what to do next.

## Non-goals

- Running WordPress PHP plugins or classic PHP themes.
- Supporting databases other than PostgreSQL. (PGlite, embedded PostgreSQL, is for trying Pressbase and for tests.)
- XML-RPC, trackbacks and pingbacks, and the Links manager.
- Shipping a page-builder ecosystem in core. The block editor is the canvas; plugins extend it.
