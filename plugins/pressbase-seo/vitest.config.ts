import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests boot an embedded PostgreSQL (PGlite) per test.
    testTimeout: 60_000,
  },
});
