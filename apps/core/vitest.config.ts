import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test boots an embedded PostgreSQL (PGlite), which takes a few seconds.
    // The CLI package runs similar tests alongside under turbo, so leave room for load.
    testTimeout: 60_000,
  },
});
