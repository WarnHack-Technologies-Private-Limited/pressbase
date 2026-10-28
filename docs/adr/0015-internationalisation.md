# 0015: Internationalisation with WordPress's translation files and @wordpress/i18n

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Pressbase had no internationalisation: every string was English. v0.6 makes it translatable and able to run in another language. The forces:

- WordPress has translations for over a hundred languages, maintained by thousands of volunteers: core (`de_DE.mo`), the admin, every default theme, and, as JSON files, the block editor's scripts. Pressbase runs WordPress's block editor and themes unchanged, so their translations apply unchanged too, if Pressbase can read them.
- Pressbase never runs PHP. Language packs now ship `.l10n.php` files (PHP arrays) next to the `.mo` and `.po` they come from.
- WordPress translates per PHP request, with globals. Pressbase's core serves many requests at once, for people who chose different languages, and the admin renders on a shared Next.js server.
- Gutenberg's packages translate with `@wordpress/i18n`'s shared instance and the `default` domain; `registerCoreBlocks()` translates block titles as it registers them.
- Other admin screens were being changed in parallel during v0.6, so converting every screen at once would conflict.

## Decision

**Port WordPress's translation layer to core, read its file formats, and use `@wordpress/i18n` in the admin, as WordPress's scripts do.**

1. **Formats.** Core reads `.mo` (both byte orders), `.po` (as gettext does: fuzzy and untranslated entries skipped) and Jed JSON. It never reads `.l10n.php`. `.po` files work wherever `.mo` files do, so contributors don't need a compile step.
2. **Plural forms** are parsed and evaluated as WordPress's `Plural_Forms` does (shunting-yard, a stack machine), never with `eval`.
3. **Per-request locales.** Loaded translations are keyed by locale (as `WP_Translation_Controller` already is), and the current locale travels with each request in `AsyncLocalStorage`, set by a REST middleware from `_locale=user` (`determine_locale()`). Translating stays synchronous: files load just in time with synchronous reads, and the translation filters run with `applyFiltersSync`.
4. **The site's language** is the existing `locale` option (WordPress's `WPLANG`, the `language` REST setting); a user's is their `locale` meta. No migration.
5. **Text domains.** WordPress's `default`, themes' and plugins' as in WordPress; Pressbase's own `pressbase` (server) and `pressbase-admin` (admin). Pressbase's domains fall back to WordPress's `default` domain for identical strings, so a WordPress language pack already translates much of Pressbase.
6. **Language packs** come from WordPress.org's translations API, as an explicit action of a user with `install_languages`: the core pack and the installed themes' packs, into `<dataDir>/languages/` in WordPress's layout. Only `.mo`, `.po` and `.json` files are written.
7. **The admin** gets its strings from core as Jed data and translates with a per-request `createI18n()` instance (server components) and a context provider (client components). **The block editor** gets the core pack's editor script translations, merged into one `default` domain, set into `@wordpress/i18n`'s shared instance before Gutenberg loads.
8. **Theme patterns** are translated when they register, in the site's language. **Plugins** get `api.i18n`, with their `languages/` folder registered automatically.
9. **Templates** (`languages/*.pot`) are generated from the source with TypeScript's parser (`pnpm i18n:extract`); a test keeps them current.

## Consequences

- Installing WordPress's German pack translates the block editor, block titles, Twenty Twenty-Five's patterns, dates, and Pressbase's strings that WordPress shares. Pressbase's own translations ship in `languages/` as `.po` files.
- Translation filters can't be `async`; a plugin's async `gettext` callback is skipped with a warning.
- Patterns are in the site's language even for a user who chose another (WordPress would use theirs). Changing the site's language reloads the theme.
- Borrowed WordPress strings only match when Pressbase's wording is identical; Pressbase's sentence case ("Visit site") doesn't match WordPress's title case ("Visit Site"). That is a deliberate trade-off: Pressbase keeps its voice.
- The block editor gets one merged `default` domain instead of one file per script handle: if two scripts translate the same string differently, the first file wins.
- Most admin screens are still English; `docs/architecture/i18n.md` lists them. Converting one is mechanical: `useI18n()` and `__(…, 'pressbase-admin')`, then `pnpm i18n:extract`.
- `WORDPRESS_TRANSLATIONS_VERSION` must move with the `@wordpress/*` packages, or the editor's strings drift from its translations.

## Alternatives considered

- **Running the `.l10n.php` files.** Faster to load in PHP, but Pressbase doesn't run PHP, and evaluating PHP arrays safely means writing a PHP parser. The `.mo` beside them has the same strings.
- **A JavaScript i18n library (i18next, FormatJS/ICU messages).** Better plural and gender handling, but no WordPress translation would apply, and Gutenberg already uses `@wordpress/i18n`; two systems in one admin would split translators' work.
- **Compiling `.po` to `.mo` at build time.** WordPress requires `.mo`; reading `.po` directly removes a tool from contributors' path, and parsing is fast enough.
- **A global current locale.** Simple, but wrong for a server answering people in different languages at the same time.
- **Downloading packs automatically** (WordPress updates translations in the background). Pressbase makes no outbound requests unless an administrator asks; automatic updates can come later as a cron event.
- **Translating patterns per request.** Faithful to WordPress, but the pattern registry is shared; keeping per-locale copies is possible later if users ask.
