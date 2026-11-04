import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Its own cache: Turborepo runs packages in parallel, and a shared
  // node_modules/.vitest-cache makes them race to clear it.
  cacheDir: 'node_modules/.vite',
  test: {
    // The end-to-end test builds a plugin with esbuild and boots an embedded PostgreSQL.
    testTimeout: 120_000,
  },
});
