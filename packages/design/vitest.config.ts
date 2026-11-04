import { defineConfig } from 'vitest/config';

export default defineConfig({
  // A cache of its own: packages without a config share the workspace's
  // node_modules/.vitest-cache, and Turborepo's parallel runs race to clear it.
  cacheDir: 'node_modules/.vite',
  test: {
    // The property tests check thousands of palettes; under a parallel
    // `pnpm test` they can take longer than vitest's 5 s default.
    testTimeout: 60_000,
  },
});
