import { expect, test } from '@playwright/test';
import { ADMIN, logIn } from './helpers';

test('sends logged-out visitors to the login screen', async ({ page }) => {
  await page.goto('/admin/settings/general');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
});

test('explains a wrong password without saying which part was wrong', async ({ page }) => {
  await logIn(page, 'not-the-password');
  await expect(page.getByText('The username or password is incorrect.')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  // The password is cleared for the next try; the username stays.
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Username or email')).toHaveValue(ADMIN.username);
});

test('logs in and out', async ({ page }) => {
  await logIn(page);
  await expect(page).toHaveURL(/\/admin\/?$/);
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();

  await page.getByRole('button', { name: ADMIN.username }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // The session is gone, not just the page.
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login/);
});
