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
