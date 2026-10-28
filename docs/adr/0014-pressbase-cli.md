# 0014: The pressbase CLI

- Status: Accepted
- Date: 2026-10-28

## Context

WordPress sites are run from the terminal with wp-cli: installs in CI, migrations, bulk fixes, moving a site to a new address. Pressbase needs the same (roadmap v0.6). Its business logic lives in `apps/core`, mostly in services (`kernel.posts`, `people/users.ts`…) with some rules in REST route handlers. It has two databases: PostgreSQL and the built-in PGlite, which only one process may open.

## Decision

**Boot the kernel in-process, as wp-cli loads WordPress.** `packages/cli` (bin `pressbase`) resolves configuration with core's own `loadConfig()`, boots a `Kernel` (migrations, options, active plugins, `init`) without the HTTP server or job worker, runs one command and shuts down. It runs from TypeScript through tsx, like core.

**A thin layer over kernel services, not over HTTP.** Commands call the services WordPress functions map to (`kernel.posts.insert()` ≈ `wp_insert_post()`), as wp-cli calls WordPress's functions. Where a rule lived only in a route handler, it moved into core and both use it: `installPressbase()`, `savePermalinkSettings()`, `checkRoleChange()`, `checkUserDeletion()`; route zod schemas are exported (`postBodySchema()`, `userWriteBody`, `permalinkSettingsInput`) and validate CLI input. New core pieces the CLI needed are core functions too: `Cron.runNow()`, `regenerateImageSizes()`, `tools/search-replace.ts`, `migrationStatus()`.

**Trust, and `--user`.** Without `--user` the command line is trusted and skips capability checks, as wp-cli. With `--user` the REST API's checks apply through core's `currentUserCan()` (map_meta_cap).

**A lock for the built-in database.** PGlite doesn't lock its directory; a second process corrupts it. `@pressbase/db`'s `connect()` now holds `<dir>.lock` (pid, host, process name; touched every 15 s) for PGlite directories, in the server and the CLI alike, and refuses others with `DatabaseLockedError`: "Stop the Pressbase server first, or use PostgreSQL." Stale locks are taken over: a dead pid on the same host at once, an untouched lock from another host after 60 s.

**Argument parser: `node:util` `parseArgs`.** wp-cli's grammar is positionals plus `--key=value` / `--flag` / `--no-flag`, with arbitrary keys (`post list --<field>=<value>`). `parseArgs` in non-strict mode with `tokens` tokenises exactly that, ships with Node (no dependency, maintained by Node core, stable since 20), and leaves subcommand routing to us. Command trees and option schemas come from wp-cli-style synopsis strings (`<id>... [--force]`), parsed in `args.ts`, which drive validation and `--help`. Commander, yargs and cac each bring their own subcommand model and help format that would have to be bent to wp-cli's; mri/minimist are tiny but add a dependency for what `parseArgs` does.

**Plugins add commands** with `api.cli.addCommand(name, handler, { shortdesc, synopsis, longdesc })` (`WP_CLI::add_command`). The registry is `kernel.cli`; names start with the plugin's slug and can't take core command names; registrations are tracked and removed on deactivation like hooks.

## Consequences

- One codebase of rules: REST and CLI can't drift on installation, permalinks, roles or deletion.
- The CLI is as slow to start as core's boot (about a second on PGlite), acceptable for wp-cli-style use.
- With the built-in database the server must be stopped to use the CLI; this is the honest answer for a database that isn't meant for live sites. In Docker that means running the image once with the volume.
- A server on PostgreSQL keeps options, plugins and the theme in memory per process; the CLI warns to restart it after changing them, until multi-process invalidation exists.
- Without `--user`, posts created have no author (as wp-cli's user 0).
- Import and export are left to the WXR work; they plug in as commands over `importWxr()`/`exportWxr()`.
