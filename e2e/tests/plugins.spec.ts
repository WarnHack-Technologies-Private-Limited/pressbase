import { expect, test } from '@playwright/test';
import { logInAsAdmin } from './helpers';

test('activating and deactivating a plugin takes effect without a restart', async ({ page }) => {
  await logInAsAdmin(page);
  await page.goto('/admin/plugins');
  await expect(page.getByRole('heading', { name: 'Plugins', level: 1 })).toBeVisible();
  const tips = page.getByRole('listitem').filter({ hasText: 'Daily Tips' });
  await expect(tips.getByText('Bundled')).toBeVisible();

  await tips.getByRole('button', { name: 'Activate Daily Tips' }).click();
  await expect(tips.getByText('Active', { exact: true })).toBeVisible();
  // The toast follows the request; the list can re-render a moment earlier.
  await expect(page.getByText('Daily Tips is active.')).toBeVisible();
  const on = await page.request.get('/wp-json/daily-tips/v1/tip');
  expect(on.status()).toBe(200);
  expect(typeof (await on.json()).tip).toBe('string');

  await tips.getByRole('button', { name: 'Deactivate Daily Tips' }).click();
  await expect(tips.getByRole('button', { name: 'Activate Daily Tips' })).toBeVisible();
  await expect(page.getByText('Daily Tips is deactivated.')).toBeVisible();
  expect((await page.request.get('/wp-json/daily-tips/v1/tip')).status()).toBe(404);
});
