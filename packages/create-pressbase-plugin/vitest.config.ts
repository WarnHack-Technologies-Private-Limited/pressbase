import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The end-to-end test builds a plugin with esbuild and boots an embedded PostgreSQL.
    testTimeout: 120_000,
  },
});
