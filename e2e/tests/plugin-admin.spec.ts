import { expect, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

test('a plugin’s settings page and dashboard widget appear on activation, without a rebuild', async ({
  page,
}) => {
  await logInAsAdmin(page);
  await page.goto('/admin/plugins');
  const tips = page.getByRole('listitem').filter({ hasText: 'Daily Tips' });
  await tips.getByRole('button', { name: 'Activate Daily Tips' }).click();
  await expect(tips.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByText('Daily Tips is active.')).toBeVisible();

  // Its settings page joins the Settings navigation.
  await page.goto('/admin/settings/general');
  const settingsNav = page.getByRole('navigation', { name: 'Settings' });
  await settingsNav.getByRole('link', { name: 'Daily Tips' }).click();
  await expect(page).toHaveURL(/\/admin\/settings\/daily-tips$/);
  await expect(page.getByRole('heading', { name: 'Where tips appear' })).toBeVisible();

  // Fields drawn from the schema; save with the shared save bar.
  const own = unique('Lead with the verdict');
  await page.getByRole('radio', { name: 'Only your tips' }).check();
  await page.getByRole('textbox', { name: /^Your tips/ }).fill(own);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();

  // Validation errors show on the field.
  await page.getByRole('textbox', { name: /^Widget colour(?!:)/ }).fill('blue');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Enter a colour like #3858e9.')).toBeVisible();
  await page.getByRole('button', { name: 'Discard' }).click();

  // The dashboard widget, rendered by the plugin's browser module.
  await page.goto('/admin');
  const widget = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Writing tip' }) });
  await expect(widget.locator('[data-daily-tip]')).toHaveText(own);

  // Deactivated: the page and the widget are gone.
  await page.goto('/admin/plugins');
  await tips.getByRole('button', { name: 'Deactivate Daily Tips' }).click();
  await expect(tips.getByRole('button', { name: 'Activate Daily Tips' })).toBeVisible();
  // The toast follows the request; the list can re-render a moment earlier.
  await expect(page.getByText('Daily Tips is deactivated.')).toBeVisible();
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Writing tip' })).toHaveCount(0);
  expect((await page.request.get('/wp-content/plugins/daily-tips/admin/index.js')).status()).toBe(
    404,
  );
  const gone = await page.goto('/admin/settings/daily-tips');
  expect(gone?.status()).toBe(404);
});
