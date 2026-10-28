import { expect, test } from '@playwright/test';
import { ADMIN, logInAsAdmin } from './helpers';

test('the user menu switches between system, light and dark, by keyboard too', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await logInAsAdmin(page);
  const html = page.locator('html');
  await expect(html).not.toHaveAttribute('data-theme', /./);

  // Open the menu from the keyboard and pick Dark with the arrow keys.
  const menuButton = page.getByRole('button', { name: ADMIN.username });
  await menuButton.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(menu.getByRole('menuitem', { name: 'Profile' })).toBeFocused();
  await expect(menu.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('ArrowDown'); // System
  await page.keyboard.press('ArrowDown'); // Light
  await page.keyboard.press('ArrowDown'); // Dark
  await expect(menu.getByRole('menuitemradio', { name: 'Dark' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(menu.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Log out' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(menuButton).toBeFocused();

  // Saved to the account: it survives a reload, in this browser and in a new one.
  await expect
    .poll(async () => {
      const res = await page.request.get('/wp-json/wp/v2/users/me');
      return (await res.json()).meta?.pressbase_admin_color_scheme;
    })
    .toBe('dark');
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('pressbase-admin-color-scheme'))).toBe(
    'dark',
  );

  const other = await page.context().browser()?.newContext({ colorScheme: 'light' });
  if (!other) throw new Error('No browser');
  const fresh = await other.newPage();
  await logInAsAdmin(fresh);
  await expect(fresh.locator('html')).toHaveAttribute('data-theme', 'dark');
  // The login screen of that browser now remembers it before anything loads.
  await fresh.goto('/login');
  await expect(fresh.locator('html')).toHaveAttribute('data-theme', 'dark');
  await other.close();

  // Back to System: the attribute goes, the OS decides.
  await menuButton.click();
  await menu.getByRole('menuitemradio', { name: 'System' }).click();
  await expect(html).not.toHaveAttribute('data-theme', /./);
  await expect
    .poll(async () => {
      const res = await page.request.get('/wp-json/wp/v2/users/me');
      return (await res.json()).meta?.pressbase_admin_color_scheme;
    })
    .toBe('system');
  await page.reload();
  await expect(html).not.toHaveAttribute('data-theme', /./);
});
