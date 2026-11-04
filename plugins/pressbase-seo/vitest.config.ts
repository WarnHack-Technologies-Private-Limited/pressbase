import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest's module cache, per package: by default every package shares the
    // workspace's node_modules/.vitest-cache, and Turborepo's parallel runs race
    // to clear it (ENOTEMPTY).
    fsModuleCachePath: fileURLToPath(new URL('./node_modules/.vitest-cache', import.meta.url)),
    // Integration tests boot an embedded PostgreSQL (PGlite) per test.
    testTimeout: 60_000,
  },
});
