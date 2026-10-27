# 0001: pnpm + Turborepo monorepo

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

Pressbase has several deployable apps (core, admin, later the public site) and shared packages (db, hooks, later blocks, theme-json, sdk). They change together: a schema change touches db, core and admin in one go.

## Decision

- One repository with **pnpm workspaces** (`apps/*`, `packages/*`) and **Turborepo** to run tasks.
- Internal packages export TypeScript source directly, with no build step.
- **Biome** for formatting and lint; **Vitest** for tests.

## Consequences

- One pull request can change the schema, the API and the UI together.
- pnpm's strict `node_modules` catches undeclared dependencies.
- pnpm blocks dependency install scripts by default; allowed ones are listed in `pnpm-workspace.yaml` (`allowBuilds`).
- Contributors need `corepack enable` once.

## Alternatives considered

- **npm workspaces:** slower, and a looser `node_modules` hides missing dependencies.
- **Nx:** more powerful than we need now.
- **ESLint + Prettier:** two tools and slower; Biome covers both.
