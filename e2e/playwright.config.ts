import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against production builds of the whole stack: core (on a
 * fresh data directory with the built-in database), the admin and the public
 * site. Run `pnpm build` first, then `pnpm e2e`. See docs/development/testing.md.
 *
 * Ports default to the usual 4000 / 3000 / 3001. Next.js bakes CORE_URL and
 * WEB_URL into the admin's rewrites at build time, so other ports need a build
 * made with matching values (checked below).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_PORT = Number(process.env.E2E_CORE_PORT ?? 4000);
const ADMIN_PORT = Number(process.env.E2E_ADMIN_PORT ?? 3000);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3001);
const CORE_URL = `http://localhost:${CORE_PORT}`;
const ADMIN_URL = `http://localhost:${ADMIN_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

// One fresh data directory per run. Playwright loads this file again in each
// worker; the environment variable keeps them all on the first one.
if (!process.env.PRESSBASE_E2E_DATA_DIR) {
  process.env.PRESSBASE_E2E_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'pressbase-e2e-'));
  process.env.PRESSBASE_E2E_DATA_DIR_TEMP = '1';
}
const DATA_DIR = process.env.PRESSBASE_E2E_DATA_DIR;

function checkBuild(app: string, expected: string, variable: string) {
  const manifest = path.join(root, 'apps', app, '.next', 'routes-manifest.json');
  if (!existsSync(manifest)) {
    throw new Error(`No production build of apps/${app}. Run \`pnpm build\` first.`);
  }
  if (!readFileSync(manifest, 'utf8').includes(expected)) {
    throw new Error(
      `apps/${app} was built for another ${variable}. Rebuild with ${variable}=${expected} ` +
        '(Next.js bakes rewrites in at build time), or use the default ports.',
    );
  }
}
checkBuild('admin', CORE_URL, 'CORE_URL');
checkBuild('admin', WEB_URL, 'WEB_URL');
checkBuild('web', CORE_URL, 'CORE_URL');

/** A local Chrome instead of Playwright's Chromium, e.g. E2E_CHROME=/usr/bin/google-chrome. */
const executablePath = process.env.E2E_CHROME || undefined;

export default defineConfig({
  testDir: './tests',
  // The tests share one site and build on each other: install first, then the rest in order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: './test-results',
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: ADMIN_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath },
  },
  projects: [
    {
      name: 'install',
      testMatch: /install\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'site',
      testIgnore: /install\.spec\.ts/,
      dependencies: ['install'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      name: 'core',
      // tsx, as `pnpm --filter @pressbase/core start` runs it, minus the repo's .env file.
      command: 'node node_modules/tsx/dist/cli.mjs src/server.ts',
      cwd: path.join(root, 'apps/core'),
      url: `${CORE_URL}/wp-json/pressbase/v1/install`,
      env: {
        PORT: String(CORE_PORT),
        PRESSBASE_DATA_DIR: DATA_DIR,
        DATABASE_URL: '',
        PRESSBASE_SETUP_TOKEN: '',
        PRESSBASE_SMTP_URL: '',
        PRESSBASE_SMTP_HOST: '',
        // Site Health's release check stays off GitHub, so runs don't depend on the network.
        PRESSBASE_UPDATE_CHECK: 'off',
      },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
    },
    {
      name: 'web',
      command: `node node_modules/next/dist/bin/next start --port ${WEB_PORT}`,
      cwd: path.join(root, 'apps/web'),
      url: `${WEB_URL}/wp-json/pressbase/v1/install`,
      env: { CORE_URL, ADMIN_URL },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      name: 'admin',
      command: `node node_modules/next/dist/bin/next start --port ${ADMIN_PORT}`,
      cwd: path.join(root, 'apps/admin'),
      url: `${ADMIN_URL}/login`,
      env: { CORE_URL, WEB_URL },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
