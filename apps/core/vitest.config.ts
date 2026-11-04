import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Its own cache: Turborepo runs packages in parallel, and a shared
  // node_modules/.vitest-cache makes them race to clear it.
  cacheDir: 'node_modules/.vite',
  test: {
    // Each test boots an embedded PostgreSQL (PGlite), which takes a few seconds.
    // The CLI package runs similar tests alongside under turbo, so leave room for load.
    testTimeout: 60_000,
  },
});
