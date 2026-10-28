import { expect, test } from '@playwright/test';
import { logInAsAdmin } from './helpers';

test('Tools → Site Health: the status, the passed tests and the Dashboard rating', async ({
  page,
}) => {
  await logInAsAdmin(page);
  await page.goto('/admin/tools');
  await page.getByRole('link', { name: /Site health/ }).click();
  await expect(page).toHaveURL(/\/admin\/tools\/site-health$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Site health' })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Site health' });
  await expect(tabs.getByRole('link', { name: 'Status' })).toHaveAttribute('aria-current', 'page');

  // The async tests finish, then the overall rating appears.
  await expect(page.getByText(/^(Good|Should be improved)$/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/All site health tests have finished running/)).toBeAttached();

  // The e2e site runs on the built-in database: a recommended improvement.
  const improvements = page.locator('section').filter({
    has: page.getByRole('heading', { name: /recommended improvements?$/ }),
  });
  const builtIn = page.getByRole('button', { name: /Your site uses the built-in database/ });
  await expect(builtIn).toHaveAttribute('aria-expanded', 'false');
  // Keyboard: Enter opens the item.
  await builtIn.focus();
  await page.keyboard.press('Enter');
  await expect(builtIn).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(/The built-in database is for trying Pressbase/)).toBeVisible();
  await expect(improvements.first()).toBeVisible();

  // Passed tests are collapsed until asked for.
  const passed = page.getByRole('button', { name: 'Passed tests' });
  await expect(passed).toHaveAttribute('aria-expanded', 'false');
  await passed.click();
  await expect(passed).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('heading', { name: /items? with no issues detected$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Your site can perform loopback requests/ }),
  ).toBeVisible();

  // The Dashboard shows the rating the screen just saved.
  await page.goto('/admin');
  const card = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Site health', exact: true }),
  });
  await expect(card.getByText(/^(Good|Should be improved)$/)).toBeVisible();
  await expect(card.getByText(/Checked/)).toBeVisible();
  await card.getByRole('link', { name: /Site Health/ }).click();
  await expect(page).toHaveURL(/\/admin\/tools\/site-health$/);
});

test('Tools → Site Health → Info: sections, sizes and copying without private values', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await logInAsAdmin(page);
  await page.goto('/admin/tools/site-health');
  await page
    .getByRole('navigation', { name: 'Site health' })
    .getByRole('link', { name: 'Info' })
    .click();
  await expect(page).toHaveURL(/\/admin\/tools\/site-health\/info$/);

  const core = page.getByRole('button', { name: 'Pressbase', exact: true });
  await core.click();
  await expect(core).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('rowheader', { name: 'Version', exact: true }).first()).toBeVisible();
  // The site's address is shown, marked as left out of the copy.
  const homeRow = page.getByRole('row').filter({ hasText: 'Home URL' });
  await expect(homeRow.getByText('Not copied')).toBeVisible();

  // Directory sizes load after the page.
  await page.getByRole('button', { name: 'Directories and Sizes' }).click();
  const uploads = page.getByRole('row').filter({ hasText: 'Uploads directory size' });
  await expect(uploads).not.toContainText('Loading');

  // Environment variables: names only.
  await page.getByRole('button', { name: 'Environment Variables' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'DATABASE_URL' })).toContainText(
    /Set|Not set/,
  );

  await page.getByRole('button', { name: 'Copy site info to clipboard' }).click();
  await expect(page.getByText('Site information has been copied to your clipboard.')).toBeVisible();
  // A string, because the e2e project has no DOM types.
  const copied = String(await page.evaluate('navigator.clipboard.readText()'));
  expect(copied).toContain('### wp-core ###');
  expect(copied).toContain('### wp-paths-sizes ###');
  expect(copied).not.toContain('uploads_size: loading...');
  const home = new URL(page.url()).origin;
  expect(copied).not.toContain(home);
});
