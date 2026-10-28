import { expect, test } from '@playwright/test';
import { ADMIN } from './helpers';

test('installs Pressbase on the built-in database and lands on the dashboard', async ({ page }) => {
  // Every admin and public URL leads to the installer while the site isn't installed.
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/install$/);
  await expect(page.getByRole('heading', { name: 'Welcome to Pressbase' })).toBeVisible();
  await page.getByRole('button', { name: 'Let’s go' }).click();

  // Database step: a broken connection is explained, not just refused.
  await expect(page.getByRole('heading', { name: 'Connect a database' })).toBeVisible();
  await page.getByRole('button', { name: 'Connection URL' }).click();
  await page.getByLabel('Connection URL').fill('mysql://root@localhost/wordpress');
  await page.getByRole('button', { name: 'Connect and continue' }).click();
  await expect(page.getByText('The URL must start with postgres://')).toBeVisible();

  // Nothing listens on port 9: the server reports a database error.
  await page.getByLabel('Connection URL').fill('postgres://pressbase:wrong@127.0.0.1:9/pressbase');
  await page.getByRole('button', { name: 'Connect and continue' }).click();
  const problem = page.getByRole('alert').filter({ hasText: /\S/ }).first();
  await expect(problem).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect a database' })).toBeVisible();

  await page.getByLabel('Built-in database').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  // Site step: client-side validation first.
  await expect(page.getByRole('heading', { name: 'About your site' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByLabel('Email').fill('not-an-email');
  await page.getByRole('button', { name: 'Install Pressbase' }).click();
  await expect(page.getByText('Give your site a name. You can change it later.')).toBeVisible();
  await expect(page.getByText('Choose a username.')).toBeVisible();
  await expect(page.getByText('Use at least 8 characters.')).toBeVisible();
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
  // Focus goes to the first invalid field.
  await expect(page.getByLabel('Site title')).toBeFocused();

  await page.getByLabel('Site title').fill(ADMIN.title);
  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByRole('button', { name: 'Install Pressbase' }).click();

  await expect(page.getByRole('heading', { name: 'Your site is ready' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('You’re using the built-in database')).toBeVisible();
  await page.getByRole('link', { name: 'Go to your dashboard' }).click();
  await expect(page).toHaveURL(/\/admin\/?$/);
  await expect(page.getByRole('heading', { name: /^Welcome/ })).toBeVisible();

  // The installer is closed now.
  await page.goto('/install');
  await expect(page).toHaveURL(/\/admin\/?$/);
});
