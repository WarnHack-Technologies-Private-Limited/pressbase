# Testing

We use **Vitest** everywhere. Tests sit next to the code (`*.test.ts`) and run with `pnpm test`.

## What to test where

| Layer                                               | Style                                                                    | Example                            |
| --------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| Pure logic (hooks, password strength, date formats) | Unit tests                                                               | `packages/hooks/src/index.test.ts` |
| Core features                                       | **API tests** through the real Hono app and a real (embedded) PostgreSQL | `apps/core/src/app.test.ts`        |
| Schema and migrations                               | Migrate an empty database                                                | `packages/db/src/index.test.ts`    |
| Admin UI                                            | Unit tests for helpers now; browser tests planned (Playwright)           | `apps/admin/src/lib/*.test.ts`     |

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

## Rules of thumb

- Every bug fix comes with a test that fails without the fix.
- Name tests by behaviour: `refuses a second installation`, not `test install 2`.
- No network and no fixed ports in tests. Use `app.request()` and `pglite:memory`.
- Security behaviour (CSRF, throttling, permissions) always gets a test.
