import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { logInAsAdmin } from './helpers';

/**
 * Switching the site's language: Settings → General → Site language, then the
 * admin, the block editor and the public site speak it. A tiny German
 * translation (e2e/fixtures/languages) stands in for the WordPress.org pack,
 * so nothing is downloaded. See docs/architecture/i18n.md.
 */

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/languages',
);

async function chooseSiteLanguage(page: Page, language: string) {
  await page.goto('/admin/settings/general');
  await page.getByLabel(/^(Site language|Sprache der Website)$/).selectOption(language);
  await page
    .getByRole('region', { name: 'Unsaved changes' })
    .getByRole('button', { name: /^(Save changes|Änderungen speichern)$/ })
    .click();
  await expect(page.getByText(/^(Settings saved|Einstellungen gespeichert)$/)).toBeVisible();
}

test('switches the site language: admin, block editor and public site', async ({ page }) => {
  // "Install" the language: languages/ in core's data directory (WP_LANG_DIR).
  const dataDir = process.env.PRESSBASE_E2E_DATA_DIR;
  if (!dataDir) throw new Error('PRESSBASE_E2E_DATA_DIR is not set (see playwright.config.ts).');
  cpSync(FIXTURES, path.join(dataDir, 'languages'), { recursive: true });

  await logInAsAdmin(page);
  await page.goto('/admin/settings/general');
  await expect(page.getByLabel('Site language')).toHaveValue('en_US');
  await expect(page.getByLabel('Site language').locator('option[value="de_DE"]')).toHaveText(
    /Deutsch/,
  );

  try {
    await chooseSiteLanguage(page, 'de_DE');

    // The admin: Pressbase's own strings, and WordPress's where Pressbase has none.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByLabel('Sprache der Website')).toHaveValue('de_DE');
    const nav = page.getByRole('navigation').first();
    await expect(nav.getByRole('link', { name: 'Beiträge' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Einstellungen' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Website ansehen/ })).toBeVisible();
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1, name: /^Willkommen, / })).toBeVisible();

    // The block editor: Gutenberg's strings and block titles.
    await page.goto('/admin/posts/new');
    const canvas = page.frameLocator('iframe[name="editor-canvas"]');
    const title = canvas.getByLabel('Titel hinzufügen');
    await expect(title).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Block hinzufügen' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rückgängig' })).toBeVisible();
    // Block titles in the inserter come from the core translation, as WordPress's server sends them.
    await page.getByRole('button', { name: 'Block hinzufügen' }).click();
    await expect(page.getByRole('option', { name: 'Absatz' }).first()).toBeVisible();

    // The public site.
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE');
    await expect(page.getByRole('link', { name: 'Zum Inhalt springen' })).toBeAttached();
  } finally {
    // Back to English for the other tests.
    await chooseSiteLanguage(page, 'en_US');
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.getByLabel('Site language')).toHaveValue('en_US');
});
