# 0011: Plugin admin extensions: declarative settings, runtime ES modules into slots

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

[ADR 0009](0009-plugin-runtime.md) made plugins load into core at runtime. The admin is different: it's a prebuilt Next.js app, and an administrator who uploads a plugin must not have to rebuild it. Yet WordPress plugins live in the admin as much as on the server: `add_menu_page()` and `add_options_page()` add screens, the Settings API (`register_setting()`, `add_settings_section()`, `add_settings_field()`) draws settings forms, and Gutenberg's SlotFill (`registerPlugin()`, `<Fill>`, `PluginDocumentSettingPanel`) puts plugin React into the editor.

Forces:

- **Most plugins only need settings.** In WordPress the Settings API covers them with no JavaScript at all. Asking every plugin to ship and build a React bundle for a form would be a step backwards.
- **Some plugins need real UI** (reports, a dashboard widget, an editor panel), and that has to run in the admin's React tree to look and behave like the rest of the admin.
- **No rebuild.** Next.js bundles at build time; code that arrives later can only be loaded from a URL in the browser.
- **One broken extension must not break a screen,** as one broken plugin must not break the site.
- **Honesty about trust.** JavaScript in the admin runs with the logged-in administrator's session.

## Decision

**Settings are declared on the server and drawn by the admin from a schema; everything else is a browser ES module the admin `import()`s at runtime from core, rendering into named slots through a stable host API on `window.pressbase`.**

- **Settings API.** `api.settings.register(name, args)` (or `admin.settings` in `plugin.json`) is `register_setting()` and `add_settings_field()` in one: a `control` (`text`, `textarea`, `number`, `toggle`, `select`, `radio`, `url`, `email`, `color`), its `type`, default, validation (`min`, `max`, `maxLength`, `required`, `options`), `section`, `page`, `capability`, `showInRest` and a `sanitize` callback. Arguments are checked on registration, so a mistake fails activation with a message, not a broken page later. Values are stored as options with the plugin's prefix (`daily_tips_accent`); another option name needs the `options` permission, as `api.siteOptions` does. Saving runs the `update_option()` chain: validation, `sanitize`, `sanitize_option_{option}`, `pre_update_option_{option}`, `pre_update_option` — also for core settings through `/wp/v2/settings`, which didn't run those filters before. `showInRest` settings join `/wp/v2/settings`; `SettingsRegistry.unregister()` takes them back on deactivation.
- **Pages.** `api.admin.addPage()` or `admin.pages`: top level (`add_menu_page`), under Settings (`add_options_page`) or under Tools (`add_management_page`). Other parents are refused; each place had to be designed (the Settings sub-navigation, a Tools index that replaces "coming soon" once it has pages, the sidebar's Extend group). A plugin with settings and no page gets one under Settings, titled after it. Capabilities are checked by core: `/pressbase/v1/admin-extensions` lists only the pages the user may open, and the page endpoint answers 403.
- **Generic settings page.** `/pressbase/v1/plugin-pages/{plugin}/{page}` returns sections, fields and values; the admin renders them with the same cards, save bar, toast and per-field errors as core's settings screens. Saves are all or nothing.
- **UI modules.** `admin.module` (imported on every admin screen) and a page's `entry` (imported on that page; its default export is the page component) are compiled ESM files in the plugin folder. Core serves them at `/wp-content/plugins/{plugin}/{file}?ver={version}` only while the plugin is active, only from the declared modules' folders and never `main`, with the theme-asset path checks, `nosniff`, and `immutable` caching when `ver` matches. The admin proxies the path, so module URLs are same-origin.
- **Host API.** `window.pressbase` (`apiVersion: 1`) gives modules the admin's React, ReactDOM and JSX runtime, `@wordpress/element`'s `createElement` and hooks, `api()` (CSRF header included), the UI kit, `registerPlugin`, `Fill`/`Slot`, `DashboardWidget`, `PluginDocumentSettingPanel`, `useToast` and `useCurrentUser`. Modules must not bundle React.
- **SlotFill of our own.** A small registry (`apps/admin/src/lib/extensions/registry.ts`) with Gutenberg's shapes: `registerPlugin(name, { render })`, a `PluginArea` that renders every plugin, `Fill`s that register their children, `Slot`s that render them. Slots today: `dashboard`, `editor.document-settings`, `plugin-page/{plugin}/{page}`. Modules are imported one at a time, so each registration is attributed to its plugin; deactivated plugins' fills are hidden at once (modules can't be unloaded).
- **Containment.** Every fill, page component and plugin `render` runs in an error boundary; a throw shows a message naming the plugin in place, and import failures show a warning above the screen.

## Consequences

- Most plugins get a full settings screen from a few lines of JSON, with validation on the server where it can't be bypassed, and no build step. Settings stay WordPress-shaped: options, `/wp/v2/settings`, the same filters.
- Plugins with real UI can add pages, dashboard widgets and editor panels without a rebuild, using the admin's React and components, so they look native and share its state (toasts, the current user).
- **A UI module is fully trusted**, as the plugin's server code is: it runs with the session of whoever views the admin and can do anything that person can through the REST API. The docs say so plainly; only administrators install plugins.
- `window.pressbase` becomes a public, versioned contract alongside `PluginApi`. Adding to it is cheap; removing from it bumps `apiVersion`.
- The admin can adopt a `script-src 'self'` Content-Security-Policy later without changes for plugins: modules are same-origin files, loaded without inline scripts or `eval`.
- Gutenberg plugins that expect `window.wp.*` won't run unchanged. The shapes match, so porting is mostly renaming.
- A fill's state lives in the slot's tree, so fills from one `render` can't share React context with each other through the plugin's tree; use module-level state or the REST API.

## Alternatives considered

- **Rebuild the admin on plugin install** (plugins as workspace packages). Exact, but it needs a toolchain on the server and minutes of downtime, and defeats the point of runtime plugins.
- **Iframes per plugin page.** Real isolation, but no shared React tree, so no dashboard widgets or editor panels, no shared styles or toasts, and a sizing and focus-management problem on every page. Isolation that doesn't fit the trust model (the plugin's server code already has full access) isn't worth that.
- **Module Federation / import maps for React.** Federation ties plugins to our bundler's runtime; an import map for `react` would need every plugin built against exactly our React version, and Next doesn't emit one. A global host object is simpler and versionable.
- **`@wordpress/plugins` and `@wordpress/edit-post`.** `registerPlugin` and SlotFill exist there, but the admin embeds the block editor, not the edit-post screen, so its slots (`PluginDocumentSettingPanel`) have nowhere to render, and pulling `@wordpress/components`' SlotFill onto the dashboard and every page would load Gutenberg's runtime everywhere. A ~200-line registry with the same names keeps the dashboard light.
- **Settings drawn by each plugin's own JavaScript.** Flexible, but it moves validation to the client, costs every plugin a build, and loses consistency. Schema-driven forms cover the common case; a page can still add a module for the rest.
