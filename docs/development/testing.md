# Testing

We use **Vitest** for unit and API tests. They sit next to the code (`*.test.ts`) and run with `pnpm test`. Browser tests use **Playwright** and live in `e2e/` (`pnpm e2e`).

## What to test where

| Layer                                               | Style                                                                    | Example                            |
| --------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| Pure logic (hooks, password strength, date formats) | Unit tests                                                               | `packages/hooks/src/index.test.ts` |
| Core features                                       | **API tests** through the real Hono app and a real (embedded) PostgreSQL | `apps/core/src/app.test.ts`        |
| Schema and migrations                               | Migrate an empty database                                                | `packages/db/src/index.test.ts`    |
| Admin UI                                            | Unit tests for helpers                                                   | `apps/admin/src/lib/*.test.ts`     |
| Whole product, in a browser                         | **End-to-end tests** (Playwright) against production builds              | `e2e/tests/*.spec.ts`              |

## API tests

`setup()` in `apps/core/src/app.test.ts` gives you a fresh kernel on an in-memory PGlite database, plus a `request()` helper. The helper keeps the session cookie and sends the CSRF header:

```ts
const { request } = await setup();
await request('POST', '/pressbase/v1/install', { site: SITE });
const me = await request('GET', '/wp/v2/users/me');
expect(me.body.roles).toEqual(['administrator']);
```

Test behaviour through HTTP, the way clients see it: status codes, error codes and response shapes. That way the tests double as the API contract.

PGlite takes a few seconds to boot, so database-backed packages set `testTimeout` to 30s (`vitest.config.ts`).

## End-to-end tests

`e2e/` drives the real product in Chromium: core, the admin and the public site, all from **production builds**, on a fresh data directory with the built-in database. The specs build on each other, like someone setting up a site:

| Spec | Covers |
| --- | --- |
| `install.spec.ts` | Installer: validation messages, a bad database URL and an unreachable server, the built-in database, landing on the dashboard, the installer closing afterwards |
| `login.spec.ts` | Redirect to login, the wrong-password message, logging in and out |
| `publish-and-comment.spec.ts` | Writing a post in the block editor, publishing it, reading it on the public site, a visitor's comment held for moderation (preview only for its author), approving it |
| `settings.spec.ts` | Settings → General: the save bar, Discard, saving, the toast, values surviving a reload |
| `theme.spec.ts` | The user menu's System / Light / Dark switch, by keyboard, saved to the account |

The `install` project runs first; every other spec depends on it and logs in as the administrator it created (`tests/helpers.ts`). Tests run one at a time. `prompt-to-site.spec.ts` (the guided site builder, #60) builds and publishes a whole site, so it's a project of its own (`site-builder`) that runs after all the others.

**AI in e2e:** core starts with `PRESSBASE_AI_TEST_PROVIDER=recorded`, which adds a provider that answers from a recording and never reaches the network ([AI: testing without a provider](../architecture/ai.md#testing-without-a-provider)). A spec that needs AI chooses it in Settings → AI with any key. No spec calls a real provider or uses a real key.

### Running them

```bash
pnpm build                                    # production builds of admin and web
pnpm --filter @pressbase/e2e exec playwright install chromium   # once
pnpm e2e
```

Playwright starts the three servers itself (`webServer` in `e2e/playwright.config.ts`): core with tsx on a new temporary `PRESSBASE_DATA_DIR` (deleted afterwards; set `E2E_KEEP_DATA=1` to keep it), and `next start` for the admin and the public site. It never reuses a server that's already running, so stop `pnpm dev` first or use other ports.

| Variable | Default | Purpose |
| --- | --- | --- |
| `E2E_CHROME` | — | Use an installed browser instead of Playwright's Chromium, e.g. `/usr/bin/google-chrome`. Skips the install step. |
| `E2E_CORE_PORT`, `E2E_ADMIN_PORT`, `E2E_WEB_PORT` | `4000`, `3000`, `3001` | Ports for the three servers |
| `PRESSBASE_E2E_DATA_DIR` | a new temporary folder | Run against an existing data directory |

**Other ports need a matching build.** Next.js bakes the admin's and the public site's rewrites (`CORE_URL`, `WEB_URL`) in at build time, so the config checks the build and stops with a clear message if they don't match:

```bash
CORE_URL=http://localhost:4124 WEB_URL=http://localhost:3224 pnpm build
E2E_CORE_PORT=4124 E2E_ADMIN_PORT=3124 E2E_WEB_PORT=3224 E2E_CHROME=/usr/bin/google-chrome pnpm e2e
```

After a failure, `e2e/playwright-report/` has the HTML report and `e2e/test-results/` the traces and screenshots (`pnpm --filter @pressbase/e2e exec playwright show-trace <trace.zip>`).

### Before a pull request

There's no CI workflow that runs these checks on GitHub, so run them locally before opening a pull request: `pnpm lint`, `pnpm typecheck`, `pnpm test`, then `pnpm build` and `pnpm e2e`. Chromium for the browser tests comes from `npx playwright install chromium` (in `e2e/`) or an installed Chrome via `E2E_CHROME`.

### Writing one

- Find things the way people do: `getByRole`, `getByLabel`, `getByText`. If a test can't find a control by its role and name, the control probably has an accessibility bug.
- Use `unique()` from `tests/helpers.ts` for titles and text, so a test never matches something an earlier one left behind.
- The block editor's canvas is an iframe: `page.frameLocator('iframe[name="editor-canvas"]')`.
- Keep each spec's setup in the spec. Only the installation is shared.

## Rules of thumb

- Every bug fix comes with a test that fails without the fix.
- Name tests by behaviour: `refuses a second installation`, not `test install 2`.
- No network and no fixed ports in unit and API tests. Use `app.request()` and `pglite:memory`. (End-to-end tests are the exception.)
- Security behaviour (CSRF, throttling, permissions) always gets a test.
