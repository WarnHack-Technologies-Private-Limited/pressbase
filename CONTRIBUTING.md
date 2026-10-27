# Contributing to Pressbase

Thank you for helping build Pressbase. This guide covers how to set up, how we work, and what a good pull request looks like. Everyone who takes part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Try it and report what breaks.** A clear bug report with steps to reproduce is a real contribution.
- **Pick up an issue.** Issues labelled `good first issue` are scoped for newcomers; `help wanted` ones are open to anyone.
- **Design.** Read the [design system](docs/design/principles.md), then critique a screen or propose a flow in an issue labelled `design`.
- **Docs.** If something confused you, fix the doc that should have explained it.

## Set up

```bash
corepack enable          # once, gives you the pinned pnpm version
pnpm install
pnpm dev                 # core on :4000, admin on :3000
```

Full instructions, including PostgreSQL and resetting a site, are in [Getting started](docs/development/getting-started.md).

## Before you write code

- **Small fix?** Open a pull request directly.
- **New feature or behaviour change?** Open an issue first, so we agree on the approach before you invest time.
- **Architectural change** (new dependency, schema design, plugin API, security model)? Write an [Architecture Decision Record](docs/adr/README.md) in your pull request.

## Workflow

1. Fork, then branch from `main`: `feat/posts-list`, `fix/login-rate-limit`, `docs/hooks-guide`.
2. Make the change, with tests (see below).
3. Run the checks:

   ```bash
   pnpm lint          # Biome: formatting and lint (pnpm format fixes most issues)
   pnpm typecheck
   pnpm test
   ```
4. Commit with [Conventional Commits](https://www.conventionalcommits.org/): `feat(core): add posts endpoint`, `fix(admin): keep focus on error`, `docs: explain hook priorities`.
5. Open a pull request and fill in the template.

## What a good pull request includes

- **Tests.** Core features get API tests in `apps/core/src/*.test.ts`. They run against embedded PostgreSQL, so you don't need a database server. Pure logic gets unit tests next to the code.
- **Docs.** If behaviour, an API, a hook or a setting changes, update the matching page in `docs/` in the same pull request. Docs that drift are worse than no docs.
- **Migrations.** If you changed `packages/db/src/schema.ts`, run `pnpm db:generate` and commit the generated SQL. Never edit a migration that has been released.
- **UI changes:**
  - Screenshots in light and dark mode, plus a narrow (mobile) width.
  - Keyboard-only and screen-reader checks against the [accessibility checklist](docs/design/accessibility.md).
  - Tokens and existing components, not new one-off styles. See [components](docs/design/components.md).
- **WordPress parity.** When you port WordPress behaviour, name the WordPress source file or function in a comment, as the existing code does.

## Coding conventions

See [conventions](docs/development/conventions.md). The short version:

- Strict TypeScript.
- No `any` outside tests.
- Name things by what they are.
- Write comments that explain _why_.
- Match the style of the code around you.
- REST errors use the WordPress shape: `{ code, message, data: { status } }`.

## Review

- A maintainer reviews within a few working days.
- Expect questions; they're about the code, not you.
- A pull request needs one approving review and green checks to merge, and is squash-merged.

## License of contributions

Pressbase is licensed GPL-2.0-or-later. By contributing, you agree that your contribution is licensed the same way.
