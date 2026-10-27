# 0004: GPL-2.0-or-later

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

Pressbase ports behaviour from WordPress (GPL-2.0-or-later) and plans to build on Gutenberg's npm packages (`@wordpress/*`, also GPL-2.0-or-later). Porting WordPress code into TypeScript produces a derivative work.

## Decision

License Pressbase under **GPL-2.0-or-later**, as WordPress is.

## Consequences

- We can port WordPress logic and use Gutenberg packages freely.
- Distributed plugins and themes that build on Pressbase's internals are expected to be GPL-compatible, as in the WordPress ecosystem.
- SaaS use is permitted (the GPL is not the AGPL).
- The name must not use the "WordPress" trademark.

## Alternatives considered

- **MIT:** incompatible with porting GPL code or bundling GPL packages.
- **AGPL:** stronger copyleft, but it would split the WordPress-compatible plugin ecosystem.
