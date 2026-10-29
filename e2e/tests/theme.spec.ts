import { crc32 } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';
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

/**
 * Appearance → Themes: upload a block theme .zip, replace it, activate it,
 * switch back to the original theme and delete the upload. The site is left
 * as it was found, even when a step fails.
 */

const headers = { 'x-pressbase-request': '1' };
const SLUG = 'pressbase-e2e-fixture';
const NAME = 'E2E Fixture';

/** A stored (uncompressed) ZIP: enough for a fixture, without a zip library. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const fileName = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += 30 + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const fixture = (version: string) => ({
  name: `${SLUG}.zip`,
  mimeType: 'application/zip',
  buffer: zip({
    [`${SLUG}/style.css`]: `/*\nTheme Name: ${NAME}\nVersion: ${version}\nAuthor: Pressbase tests\nDescription: A one-template block theme for the end-to-end tests.\n*/\n`,
    [`${SLUG}/theme.json`]: JSON.stringify({ version: 3 }),
    [`${SLUG}/templates/index.html`]:
      '<!-- wp:paragraph --><p>Hello from the e2e fixture theme</p><!-- /wp:paragraph -->',
  }),
});

async function activeTheme(page: Page): Promise<{ stylesheet: string; name: string }> {
  const res = await page.request.get('/wp-json/wp/v2/themes?status=active');
  const [theme] = await res.json();
  return { stylesheet: theme.stylesheet, name: theme.name.raw };
}

test('uploading, replacing, activating and deleting a theme', async ({ page }) => {
  await logInAsAdmin(page);
  const original = await activeTheme(page);
  expect(original.stylesheet).not.toBe(SLUG);

  try {
    await page.goto('/admin/appearance');
    await expect(page.getByRole('heading', { name: 'Themes', level: 1 })).toBeVisible();

    // Upload: the dialog opens on the file input; a non-zip is refused before uploading.
    const open = page.getByRole('button', { name: 'Upload theme' });
    await open.click();
    const dialog = page.getByRole('dialog', { name: 'Upload a theme' });
    const input = dialog.getByLabel('Theme .zip file');
    await expect(input).toBeFocused();
    await input.setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    });
    await expect(dialog.getByRole('alert')).toContainText('isn’t a .zip file');
    await input.setInputFiles(fixture('1.0'));
    await expect(dialog.getByText(`${SLUG}.zip`)).toBeVisible();
    await dialog.getByRole('button', { name: 'Install theme' }).click();
    await expect(page.getByText(`${NAME} was installed.`)).toBeVisible();
    await expect(dialog).toBeHidden();

    // The new theme is in the list, marked New, with Activate focused.
    const card = page.getByRole('listitem', { name: NAME });
    await expect(card.getByText('New', { exact: true })).toBeVisible();
    const activate = card.getByRole('button', { name: `Activate ${NAME}` });
    await expect(activate).toBeFocused();

    // The same theme again: "Replace the installed theme?" with both versions.
    await open.click();
    await dialog.getByLabel('Theme .zip file').setInputFiles(fixture('1.1'));
    await dialog.getByRole('button', { name: 'Install theme' }).click();
    const replace = page.getByRole('dialog', { name: 'Replace the installed theme?' });
    await expect(replace.getByRole('button', { name: 'Choose another file' })).toBeFocused();
    await expect(replace.getByRole('row', { name: /Version/ })).toContainText('1.0');
    await expect(replace.getByRole('row', { name: /Version/ })).toContainText('1.1');
    await replace.getByRole('button', { name: 'Replace the installed theme' }).click();
    await expect(page.getByText(`${NAME} was replaced with version 1.1.`)).toBeVisible();
    await expect(card).toContainText('Version 1.1');

    // Activate it: the public site renders with it.
    await card.getByRole('button', { name: `Activate ${NAME}` }).click();
    await expect(page.getByText(`${NAME} is now your site’s theme.`)).toBeVisible();
    const rendered = await page.request.get('/wp-json/pressbase/v1/render?url=%2F');
    expect((await rendered.json()).html).toContain('Hello from the e2e fixture theme');
    // The active theme can't be deleted, so it has no menu.
    await expect(card.getByRole('button', { name: `More actions for ${NAME}` })).toHaveCount(0);

    // Back to the original theme.
    const back = page.getByRole('listitem', { name: original.name });
    await back.getByRole('button', { name: `Activate ${original.name}` }).click();
    await expect(page.getByText(`${original.name} is now your site’s theme.`)).toBeVisible();
    // Bundled themes can't be deleted either.
    await expect(back.getByRole('button', { name: /More actions/ })).toHaveCount(0);

    // Delete from the card's menu, by keyboard.
    const more = card.getByRole('button', { name: `More actions for ${NAME}` });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('dialog', { name: `Delete ${NAME}?` });
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Delete theme' }).click();
    await expect(page.getByText(`${NAME} was deleted.`)).toBeVisible();
    await expect(card).toHaveCount(0);
  } finally {
    // Leave the site as it was.
    if ((await activeTheme(page)).stylesheet !== original.stylesheet) {
      await page.request.post(`/wp-json/pressbase/v1/themes/${original.stylesheet}/activate`, {
        headers,
      });
    }
    await page.request.delete(`/wp-json/pressbase/v1/themes/${SLUG}`, { headers });
  }
  expect((await page.request.get(`/wp-json/wp/v2/themes/${SLUG}`)).status()).toBe(404);
  expect((await activeTheme(page)).stylesheet).toBe(original.stylesheet);
});
