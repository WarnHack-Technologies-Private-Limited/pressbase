import { expect, test } from '@playwright/test';
import { logInAsAdmin } from './helpers';

/**
 * Settings → AI (v0.7): turn AI on and save a provider key, which then only
 * ever shows as its last four characters. No request reaches a provider:
 * saving checks nothing with the network, and Test connection isn't pressed.
 */
test('Settings → AI saves a key and shows it masked', async ({ page }) => {
  const key = 'sk-ant-e2e-not-a-real-key-7f3a';
  const outgoing: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://localhost')) outgoing.push(request.url());
  });

  await logInAsAdmin(page);
  await page.goto('/admin/settings');
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'AI' })
    .click();
  await expect(page).toHaveURL(/\/admin\/settings\/ai$/);
  await expect(page.getByText('No key saved.')).toBeVisible();
  const test = page.getByRole('button', { name: 'Test connection' });
  await expect(test).toBeDisabled();

  await page.getByRole('checkbox', { name: 'Turn on AI features' }).check();
  await page.getByLabel('Model').selectOption('claude-sonnet-5-5');
  await page.getByLabel('API key', { exact: true }).fill(key);
  await page.getByLabel('Requests per day').fill('25');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('AI settings saved.')).toBeVisible();

  await expect(page.getByText('Saved, ends in …7f3a')).toBeVisible();
  await expect(page.getByLabel('Replace the key')).toHaveValue('');
  await expect(test).toBeEnabled();

  // After a reload the settings are kept, and the key is nowhere in the page.
  await page.reload();
  await expect(page.getByText('Saved, ends in …7f3a')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Turn on AI features' })).toBeChecked();
  await expect(page.getByLabel('Model')).toHaveValue('claude-sonnet-5-5');
  await expect(page.getByLabel('Requests per day')).toHaveValue('25');
  expect(await page.content()).not.toContain(key);
  const api = await page.request.get('/wp-json/pressbase/v1/ai/settings');
  expect(await api.text()).not.toContain(key);

  // Removing the key asks first.
  await page.getByRole('button', { name: 'Remove key' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove the API key?' });
  await dialog.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.getByText('API key removed.')).toBeVisible();
  await expect(page.getByText('No key saved.')).toBeVisible();

  expect(outgoing).toEqual([]);
});
