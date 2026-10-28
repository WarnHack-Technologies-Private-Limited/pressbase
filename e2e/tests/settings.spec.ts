import { expect, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

test('Settings → General: the save bar, saving and the toast', async ({ page }) => {
  await logInAsAdmin(page);
  await page.goto('/admin/settings/general');

  const title = page.getByLabel('Site title');
  const saveBar = page.getByRole('region', { name: 'Unsaved changes' });
  await expect(title).toBeVisible();
  await expect(saveBar).toBeHidden();

  // Editing shows the save bar; Discard puts the old value back.
  const original = await title.inputValue();
  await title.fill('Something else');
  await expect(saveBar).toBeVisible();
  await saveBar.getByRole('button', { name: 'Discard' }).click();
  await expect(title).toHaveValue(original);
  await expect(saveBar).toBeHidden();

  const tagline = unique('Notes from');
  await title.fill('The Morning Paper');
  await page.getByLabel('Tagline').fill(tagline);
  await saveBar.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await expect(saveBar).toBeHidden();

  await page.reload();
  await expect(page.getByLabel('Site title')).toHaveValue('The Morning Paper');
  await expect(page.getByLabel('Tagline')).toHaveValue(tagline);
  // The admin's sidebar shows the new name too.
  await expect(page.getByRole('complementary', { name: 'Admin' })).toContainText(
    'The Morning Paper',
  );
});

test('Settings → Permalinks: a new structure, and old addresses redirect', async ({ page }) => {
  await logInAsAdmin(page);
  await page.goto('/admin/settings/permalinks');
  const saveBar = page.getByRole('region', { name: 'Unsaved changes' });
  await expect(page.getByRole('radio', { name: 'Day and name' })).toBeChecked();

  // The sample post's address under the installer's structure.
  await page.goto('/?p=1');
  const dated = new URL(page.url()).pathname;
  expect(dated).toMatch(/^\/\d{4}\/\d{2}\/\d{2}\/hello-world\/$/);

  await page.goto('/admin/settings/permalinks');
  // A custom structure without a post tag is refused, next to the field.
  await page.getByRole('radio', { name: 'Custom structure' }).check();
  await page.getByRole('textbox', { name: 'Custom structure' }).fill('/posts/%year%/');
  await saveBar.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Include %postname% or %post_id%')).toBeVisible();

  await page.getByRole('radio', { name: 'Post name' }).check();
  await saveBar.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Post name' })).toBeChecked();

  await page.goto(dated);
  await expect(page).toHaveURL(/\/hello-world\/$/);
  expect(new URL(page.url()).pathname).toBe('/hello-world/');
  await expect(page.getByRole('heading', { level: 1, name: 'Hello world!' })).toBeVisible();

  // Back to the installer's structure for the tests that follow.
  await page.goto('/admin/settings/permalinks');
  await page.getByRole('radio', { name: 'Day and name' }).check();
  await saveBar.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
});
