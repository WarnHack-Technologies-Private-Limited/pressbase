# Site Health

**Tools → Site Health** tells an administrator what to fix (the *Status* tab) and shows every detail of the setup for a support request (the *Info* tab). It's a port of WordPress's Site Health (`WP_Site_Health`, `WP_Debug_Data`, `wp-admin/site-health.php`, `site-health-info.php`, `site-health.js` and `WP_REST_Site_Health_Controller`), with tests rewritten for Node.js and PostgreSQL.

## Using it

- Open **Tools → Site Health** (administrators, or anyone with `view_site_health_checks`).
- **Status** runs the checks and rates the site **Good** or **Should be improved**. *Critical issues* come first, then *recommended improvements*; each opens to say why it matters and where to fix it. **Passed tests** lists everything that's fine. **Check again** runs them all once more after you've changed something.
- **Info** lists the site's configuration in sections. **Copy site info to clipboard** copies it as plain text to paste into an email or an issue. Values marked *Not copied* (the site's address, database host, name and user, the server's hostname, SMTP host and sender) stay on screen only. Secrets (passwords, the database URL, the setup code, the cache secret) are never shown at all.
- The **Dashboard**'s *Site health* card shows the rating of the last check: the Status tab saves it each time it finishes, and core runs the whole check weekly in the background.

## Pieces

| Piece | Where | WordPress |
| --- | --- | --- |
| `kernel.siteHealth` (`SiteHealth`) | `apps/core/src/site-health/service.ts` | `WP_Site_Health`: `get_tests()`, `perform_test()`, `wp_cron_scheduled_check()` |
| Core tests | `apps/core/src/site-health/tests.ts` | `get_test_*()` |
| Info sections, sizes, copy text | `apps/core/src/site-health/debug-data.ts` | `WP_Debug_Data::debug_data()`, `get_sizes()`, `format()` |
| Types and hook names | `apps/core/src/site-health/types.ts` | — |
| HTML allow-list, result checks | `apps/core/src/site-health/html.ts` | `wp_kses_post()`, `validateIssueData()` in `site-health.js` |
| REST routes | `apps/core/src/routes/site-health.ts` | `WP_REST_Site_Health_Controller`, `wp_ajax_health_check_site_status_result()` |
| Status and Info screens | `apps/admin/src/components/site-health/` | `site-health.php`, `site-health-info.php`, `site-health.js` |
| Dashboard card body | `apps/admin/src/components/site-health/site-health-summary.tsx` | `wp_dashboard_site_health()` |

## Tests

Each test returns WordPress's result shape:

```json
{
  "label": "Your site uses the built-in database",
  "status": "recommended",
  "badge": { "label": "Performance", "color": "blue" },
  "description": "<p>The built-in database is for trying Pressbase…</p>",
  "actions": "<p><a href=\"…\">Read about databases</a></p>",
  "test": "database_driver"
}
```

`status` is `good`, `recommended` or `critical`. *Direct* tests run while the Status screen loads; *async* tests are slower (they make HTTP requests) and run afterwards, one at a time, through REST.

| Test | Kind | Badge | Checks | WordPress |
| --- | --- | --- | --- | --- |
| `node_version` | direct | Performance | Node.js 22.12+ (critical below); odd-numbered, short-lived releases are recommended against | `php_version` |
| `node_env` | direct | Performance | `NODE_ENV=production` | `is_in_debug_mode` (in spirit) |
| `database_driver` | direct | Performance | The built-in database: recommended, critical when `NODE_ENV=production` | — |
| `sql_server` | direct | Performance | PostgreSQL 14+ (`show server_version`) | `sql_server` |
| `database_migrations` | direct | Performance | Schema migrations not applied (`pendingMigrations()` in `@pressbase/db`, the migrator's own rule) and a data version behind `DB_VERSION`: critical | — |
| `application_passwords` | direct | Security | `PRESSBASE_ALLOW_HTTP_APP_PASSWORDS=1` lifts the HTTPS-only rule: recommended | `wp_is_application_passwords_supported()` |
| `setup_token` | direct | Security | `PRESSBASE_SETUP_TOKEN` still set after install: recommended | — |
| `insecure_registration` | direct | Security | Open registration with an editor or administrator default role: critical | `insecure_registration` (7.0) |
| `mail` | direct | Performance | No SMTP, so mail goes to the outbox: recommended (critical in production) | — |
| `job_worker` | direct | Performance | The worker runs in this process; if not, jobs more than five minutes overdue are critical, otherwise recommended | — |
| `scheduled_events` | direct | Performance | A cron event more than a minute overdue is late, more than five minutes "didn't run" (both recommended). Events of deactivated plugins are ignored. | `scheduled_events` |
| `failed_jobs` | direct | Performance | Jobs that failed for good in the past week (the failed-job retention) | — |
| `file_uploads` | direct | Performance | The uploads folder exists or can be created, and is writable | `file_uploads` |
| `available_disk_space` | direct | Performance | Free space on the data directory's disk: below 1 GB recommended, below 100 MB critical | `available_updates_disk_space` |
| `image_processing` | direct | Performance | sharp loads and resizes a tiny image to WebP | `php_extensions` (GD, Imagick) |
| `plugin_errors` | direct | Performance | Plugins stopped by a load error (critical), plugins reporting runtime errors, folders that can't load | — |
| `inactive_plugins` | direct | Security | Inactive plugins in the data directory (bundled ones can't be deleted) | `plugin_version` |
| `inactive_themes` | direct | Security | Inactive themes in the data directory, other than the default theme and the active theme's parent | `theme_version` |
| `search_engine_visibility` | direct | Privacy | `blog_public` off | `search_engine_visibility` |
| `timezone` | direct | Performance | `timezone_string` set and known to the server | `php_default_timezone` (in spirit) |
| `autoloaded_options` | direct | Performance | Autoloaded options over 800 KB: critical | `autoloaded_options` |
| `https_status` | async | Security | `home` and `siteurl` start with `https://`: recommended otherwise (critical in production on a non-local host) | `https_status` |
| `loopback_requests` | async | Performance | `GET {home}/wp-json/` (through the admin's proxy) answers with Pressbase's index, and `GET {WEB_URL}/robots.txt` reaches core through the public site. A connection failure is critical, a wrong answer recommended. | `loopback_requests` |
| `page_cache` | async | Performance | Without `PRESSBASE_REVALIDATE_SECRET`, caching is off (recommended). With it, core sends each `WEB_URL` a purge for a tag no page has: 401 (secrets differ) and network errors are critical, 404 (the public site has no secret) recommended. | `page_cache` |
| `pressbase_version` | async | Security | The latest GitHub release is newer: recommended | `wordpress_version` |

WordPress tests that don't apply are left out: PHP extensions, sessions and timezone, opcode and object caches, background and auto-updates, communication with WordPress.org, the Authorization header (the admin's proxy forwards it; an `Authorization: Basic user:pwd` probe would be refused by application password authentication anyway) and REST availability (the admin itself runs on REST).

### The release check

`pressbase_version` asks `api.github.com` for the repository's latest release, with a five-second timeout. The answer is kept in the `_transient_pressbase_update_check` option for 12 hours; a failure for one hour. Offline, the test passes with a note that it couldn't check, so a site without internet access isn't marked down. `PRESSBASE_UPDATE_CHECK=off` turns it off: no request is made. The end-to-end tests set it off.

### Running tests safely

- **Isolation.** `perform()` (WordPress's `perform_test()`) catches a test that throws or returns a malformed result and reports *A test is unavailable* (badge *Unavailable*, red), as `site-health.js` does for a failed async request. Then every result passes `site_status_test_result`.
- **HTML.** Descriptions and actions are HTML, as in WordPress. Core sanitises them (and Info section descriptions) to `p`, `a`, `code`, `strong`, `em`, `ul`, `ol`, `li`, `br` and a hidden-text `span` before they leave the API, and the admin renders the sanitised HTML.
- **Outgoing requests** go through `kernel.siteHealth.fetch` with a timeout and never throw. API tests replace it: `test-utils.ts` makes it fail, so no test reaches the network by accident.

## The overall rating

`site-health.js`'s `recalculateProgression()`: critical issues weigh 1.5 and recommended ones 0.5 against the total; a score of 80 or more **and no critical issue** is **Good**, anything else **Should be improved**. Core (`overallStatus()` in `service.ts`) and the admin (`lib/site-health.ts`) use the same formula.

When the Status tab finishes, it `POST`s its counts to `/pressbase/v1/site-health/result` (WordPress's `health-check-site-status-result` AJAX action). They're stored in the `_transient_health-check-site-status-result` option, not autoloaded; the `_transient_` prefix keeps the save from purging the public page cache. The Dashboard reads them back with the rating and the time of the check, and words its sentence as `wp_dashboard_site_health()` does.

### The weekly check

`wp_site_health_scheduled_check` is scheduled on `init` when missing: weekly, starting a day after the site comes up (`maybe_create_scheduled_event()`). It runs every direct test and every async test that has an `async_direct_test`, skipping those marked `skip_cron`, and saves the counts. Unlike WordPress, the worker runs it on time rather than on a page view. Settings → Scheduled tasks lists it as *Check site health*.

## The Info tab

`GET /pressbase/v1/site-health/info` returns `{ info, copy }`: the sections (WordPress's shape: `label`, `description`, `show_count`, `private`, and `fields` of `{ label, value, debug?, private? }`), and the text **Copy site info to clipboard** copies: `WP_Debug_Data::format( $info, 'debug' )`, which leaves out private sections and fields.

| Section | WordPress | Holds |
| --- | --- | --- |
| `wp-core` → *Pressbase* | `wp-core` | Version, database version, language, time zone, home and site URL (private), permalinks, HTTPS, registration, search engines, comments, environment, user count |
| `wp-paths-sizes` → *Directories and Sizes* | `wp-paths-sizes` | The Pressbase, data, uploads, themes and plugins folders; their sizes, the database's and the total, loaded afterwards |
| `wp-active-theme`, `wp-themes-inactive` | same | Name, version, author, parent, block theme, folder; inactive themes with a count |
| `wp-plugins-active`, `wp-plugins-inactive` | same | Version, author, bundled or not, and any load error |
| `wp-media` → *Media Handling* | `wp-media` | sharp and libvips versions, output formats, storage, upload limit, image sizes |
| `wp-server` → *Server* | `wp-server` | OS and architecture, hostname (private), Node.js, V8, OpenSSL, ICU, CPUs, memory, uptime, time zone, whether this process runs the worker |
| `wp-database` → *Database* | `wp-database` | Driver, server version; host, name and user (private) or the built-in database's folder (private); SSL mode, max connections, encoding, time zone |
| `wp-constants` → *Pressbase Constants* | `wp-constants` | Configuration from the environment and `config.json`: data directory, port, `NODE_ENV`, worker, upload limit, whether a setup code and database are set, mail transport, SMTP host and sender (private), page cache, `WEB_URL` (private) |
| `pressbase-environment` → *Environment Variables* | — | Every variable Pressbase reads, plus any other `PRESSBASE_*`: **Set** or **Not set**, never the value |
| `wp-filesystem` → *Filesystem Permissions* | `wp-filesystem` | Whether core can write to the install, data, uploads, plugins, themes and outbox folders, and `config.json`'s mode (it should be `0600`) |

Directory sizes come from `GET /wp-site-health/v1/directory-sizes` after the page loads (WordPress's `get_directory_sizes()`). Each folder is walked without following symlinks, within a ten-second budget; past it, the size reads "The directory size calculation has timed out…", as in WordPress. The built-in database lives in the data directory, so the total counts it once. The admin puts the sizes into the copy text by replacing each `name: loading...` line, as `site-health.js` does.

## REST API

| Method | Route | Returns |
| --- | --- | --- |
| GET | `/pressbase/v1/site-health` | `{ direct: [results], async: [{ id, label, test, has_rest, headers? }] }`: the direct tests' results and the async tests to call (`test` is the REST route under `/wp-json`) |
| GET / POST | `/pressbase/v1/site-health/result` | The saved counts `{ good, recommended, critical, time, score, status }`, or `null`. `POST { counts }` saves them (`rest_invalid_param` otherwise). |
| GET | `/pressbase/v1/site-health/info` | `{ info, copy }` |
| GET | `/wp-site-health/v1/tests/{test}` | One async test's result: `https-status`, `loopback-requests`, `page-cache`, `pressbase-version`, and any plugin async test with an `async_direct_test` (underscores in its ID become dashes) |
| GET | `/wp-site-health/v1/directory-sizes` | `{ raw, data_size, uploads_size, themes_size, plugins_size, database_size, total_size }`, each `{ size, debug, raw }` |

All need `view_site_health_checks` (401 logged out, 403 without it, `rest_forbidden`). For the `wp-site-health/v1` routes, `site_health_test_rest_capability_{check}` can name another capability, as in WordPress. Unknown tests answer `404 rest_no_route`.

## Capability

`view_site_health_checks` is granted to anyone who has `install_plugins`, as `wp_maybe_grant_site_health_caps()` does on `user_has_cap`; by default that's administrators. Pressbase does it in `resolveCapabilities()` (`auth/capabilities.ts`), so the capability shows in `/wp/v2/users/me` and works with `requireCapability()`. Unlike WordPress's filter, a direct `view_site_health_checks: false` grant revokes it.

## Extending it

Plugins use three filters, typed in the hook registries and exported by the plugin SDK (`SiteStatusTests`, `SiteHealthTestResult`, `DebugInfo`…):

```ts
api.hooks.addFilter('site_status_tests', (tests) => {
  tests.direct.my_plugin_backups = {
    label: 'Backups',
    test: async () => ({
      label: 'Backups are recent',
      status: 'good',
      badge: { label: 'Security', color: 'blue' },
      description: '<p>The last backup finished today.</p>',
      actions: '',
      test: 'my_plugin_backups',
    }),
  };
  // Slow? Make it async: served at /wp-site-health/v1/tests/my-plugin-remote.
  tests.async.my_plugin_remote = { label: 'Remote service', async_direct_test: checkRemote };
  return tests;
});

api.hooks.addFilter('site_status_test_result', (result) => result);

api.hooks.addFilter('debug_information', (info) => {
  info['my-plugin'] = {
    label: 'My Plugin',
    fields: {
      mode: { label: 'Mode', value: 'live' },
      api_key: { label: 'API key', value: key, private: true }, // shown, never copied
    },
  };
  return info;
});
```

- Test IDs and section IDs should start with the plugin's slug.
- WordPress's `test` may name a method; in Pressbase it's a function.
- An async test may instead point `test` at its own REST route (`test: '/my-plugin/v1/health'`, `has_rest: true`); the Status screen calls it with `headers` if given. Give it `async_direct_test` too, or the weekly check skips it.
- Removing a core test (`delete tests.direct.mail`) is allowed, for hosts that handle something themselves.

## Not yet

- A *Site Health* count badge in the admin menu (WordPress shows the number of critical issues).
- Custom tabs (`site_health_navigation_tabs`, `site_health_tab_content`).
- Plugin and theme update checks, which arrive with a plugin and theme directory.
