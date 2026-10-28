import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test boots an embedded PostgreSQL (PGlite), which takes a few seconds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
