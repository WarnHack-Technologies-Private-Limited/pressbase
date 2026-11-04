import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Its own cache: Turborepo runs packages in parallel, and a shared
  // node_modules/.vitest-cache makes them race to clear it.
  cacheDir: 'node_modules/.vite',
  test: {
    // Integration tests boot an embedded PostgreSQL (PGlite) per test.
    testTimeout: 60_000,
  },
});
