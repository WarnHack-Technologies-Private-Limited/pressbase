# 0025: Installing and deleting themes from a .zip

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

Until now themes could only be activated. A site owner who wanted another block theme had to copy a folder into `<dataDir>/themes` on the server, and couldn't remove one at all without shell access. WordPress lets administrators upload a theme `.zip` (`wp-admin/update.php?action=upload-theme`, `Theme_Upgrader::install()`) and delete inactive themes (`delete_theme()`), and offers "Replace current with uploaded" when the theme is already installed.

Forces:

- Themes, like plugins, arrive as archives from strangers. Pressbase already has a strict ZIP reader for plugin uploads and language packs ([ADR 0009](0009-plugin-runtime.md)); a second reader would be a second place for zip-slip bugs.
- Pressbase renders **block themes** only and never runs PHP. A WordPress theme directory is mostly classic themes, which would install and then fail to activate.
- Bundled themes live in the repository's `themes/` folder, read-only in the Docker image and shared by every site using the checkout. Uploaded themes live in `<dataDir>/themes`, which wins on a name clash.
- The active theme is cached in memory with its templates, styles and patterns, and the public site's pages are cached by tag ([ADR 0008](0008-public-page-caching.md)).

## Decision

- **One ZIP reader.** `plugins/zip.ts` moves to `files/zip.ts`, with a shared `writeEntries()` that writes into a staging folder (path re-checked, `wx` so nothing is overwritten). Plugins, themes and language packs use it.
- **`kernel.themes.install(zip, { overwrite, filename })`** ports `Theme_Upgrader::install()` and `check_package()`, with WordPress's error codes (`incompatible_archive_theme_no_style`, `_no_name`, `_no_index`, `folder_exists`). The theme sits at the archive root or in one top-level folder, as `WP_Upgrader::install_package()` decides. A classic theme (`index.php`, no `templates/index.html`) is refused with `pressbase_theme_not_block_theme` and a message that says why, rather than installed and left unusable. The folder name is sanitised as `sanitize_file_name()` does and limited to `[A-Za-z0-9_-]`, the names Pressbase discovers.
- **Atomic replacement.** Files are unpacked into a hidden staging folder and renamed into place; with `overwrite` the old folder is renamed aside and removed only after the new one is in place. Replacing the active theme (or its parent) keeps it active, reloads it, and purges the whole page cache through a `upgrader_process_complete` listener in `cache/invalidation.ts`. A bundled theme is never modified: an overwrite installs the upload in the data directory, which shadows it.
- **`kernel.themes.delete(stylesheet)`** ports `delete_theme()` with `wp-admin/themes.php`'s checks: not the active theme, not the active child theme's parent, and not a bundled theme. It fires `delete_theme` / `deleted_theme`, removes the theme's translations, and keeps its `theme_mods_{stylesheet}` option and `wp_global_styles` post, as WordPress does.
- **REST.** `POST /pressbase/v1/themes` (multipart `file`, `overwrite=true`) checks `upload_themes`, which `mapMetaCap()` now maps to `install_themes` as `map_meta_cap()` does; `DELETE /pressbase/v1/themes/{stylesheet}` checks `delete_themes`. WordPress's REST API has neither, so they live under `pressbase/v1` next to the existing activation route. `/wp/v2/themes` items gain `pressbase_source` and `pressbase_deletable` so clients don't have to repeat the rules. A `folder_exists` error carries both versions of the theme for the "Replace the installed theme?" step.
- **Admin and CLI.** Appearance → Themes gets an **Upload theme** dialog (drop zone, progress, plain-language errors, the replace step) and **Delete** in each deletable card's menu. The CLI gets `pressbase theme install <zip> [--force] [--activate]` and `pressbase theme delete <theme>...`, matching wp-cli's flags.

## Consequences

- Administrators manage themes without server access, with the same safety checks as plugin uploads, and the same code paths from the admin, the API and the CLI.
- Installing a theme is lower risk than installing a plugin, because no theme code runs on the server. It is not risk-free: templates, patterns, CSS and JavaScript reach visitors. The capabilities stay administrator-only, and the docs say so.
- Child themes must include their own `templates/index.html` to install, which WordPress doesn't require. That matches what Pressbase can activate today; if `isBlockTheme` learns to look at the parent, the check can relax.
- Theme installs run one at a time per process. With several core processes, the others keep their cached active theme until they reload, as with activation today.
- Replacing a theme shadows a bundled one silently; the admin explains it in the replace step, and deleting the upload brings the bundled copy back.

## Alternatives considered

- **Install classic themes and refuse them at activation.** That's what WordPress would do, but the theme could never be used in Pressbase; refusing at upload saves a confusing dead end.
- **Put the endpoints on `/wp/v2/themes`.** WordPress's themes controller is read-only; adding `POST` and `DELETE` there would make clients think they were talking to WordPress semantics that don't exist.
- **Replace in place (delete, then unpack).** Simpler, but a failure halfway would leave the active theme missing and the site falling back to the default theme. Rename-aside costs one extra rename.
- **Let administrators delete bundled themes.** The folder is part of the checkout and read-only in Docker; deleting it on one site would affect every site sharing the code, and the next update would bring it back.
