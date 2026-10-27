# Pressbase: notes for AI assistants and new contributors

Pressbase is a WordPress-inspired publishing platform: Node.js core (Hono) + Next.js admin + PostgreSQL (Drizzle; PGlite for trials and tests). Read `docs/README.md` first. `docs/architecture/overview.md` and `docs/architecture/wordpress-mapping.md` explain the structure.

## Commands

- `pnpm dev`: core on :4000, admin on :3000
- `pnpm test` / `pnpm typecheck` / `pnpm lint` (`pnpm format` to fix)
- `pnpm db:generate`: after editing `packages/db/src/schema.ts`; commit the SQL

## Rules

- All business logic lives in `apps/core`. The admin only calls the REST API (`coreGet` on the server, `api()` on the client).
- Match WordPress names for hooks, options, REST fields and error codes. Cite the WordPress source when porting. A reference copy of WordPress 7.1.3 sits at `../wordpress/`.
- REST errors use `restError()` / `invalidParams()`. Validate inputs with zod.
- UI uses the tokens in `apps/admin/src/app/globals.css` and the components in `apps/admin/src/components/ui/`. Follow `docs/design/` for principles, accessibility and voice.
- Every change ships with tests (core API tests run on `pglite:memory`) and updated docs.
- Never edit a released migration. Never commit `.pressbase/` or `.env`.
