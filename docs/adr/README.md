# Architecture Decision Records

An ADR captures one significant decision: its context, the choice, and the consequences. ADRs are never rewritten. To change a decision, write a new ADR that supersedes the old one.

**Write one when** you add a major dependency, change the schema design, the plugin or theme API, the security model, or anything that would be expensive to reverse.

To write one, copy [template.md](template.md) to `NNNN-short-title.md` and open it in your pull request with the status _Proposed_.

| #                                         | Decision                                                  | Status   |
| ----------------------------------------- | --------------------------------------------------------- | -------- |
| [0001](0001-monorepo.md)                  | pnpm + Turborepo monorepo                                 | Accepted |
| [0002](0002-postgres-drizzle-pglite.md)   | PostgreSQL only, Drizzle ORM, PGlite for trials and tests | Accepted |
| [0003](0003-core-separate-from-next.md)   | Core server separate from the Next.js apps                | Accepted |
| [0004](0004-gpl-license.md)               | GPL-2.0-or-later                                          | Accepted |
| [0005](0005-password-hashing.md)          | scrypt from the Node standard library                     | Accepted |
| [0006](0006-wordpress-compatible-rest.md) | WordPress-compatible REST surface under /wp-json          | Accepted |
| [0007](0007-public-rendering.md)          | Core renders the public site; apps/web serves it          | Accepted |
| [0008](0008-public-page-caching.md)       | Tag-indexed page cache in apps/web, purged by core        | Accepted |
| [0009](0009-plugin-runtime.md)            | In-process ESM plugins, tracked registrations, per-request routing | Accepted |
