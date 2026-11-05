import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * Studio's right-click menu (#36): Copy and Paste across sections (a
 * block, then a whole section), Paste style as one undo step, the menu
 * from the keyboard (Shift+F10, arrow keys, Escape back to the block), and
 * Save as section, which lists the section in the Sections panel.
 */

const writeHeaders = { 'x-pressbase-request': '1' };

type Changeset = { uuid: string; entries: Record<string, { value: Record<string, unknown> }> };

async function drafts(page: Page): Promise<Changeset[]> {
  return (await page.request.get('/wp-json/pressbase/v1/changesets')).json();
}

async function discardDrafts(page: Page) {
  for (const { uuid } of await drafts(page)) {
    await page.request.delete(`/wp-json/pressbase/v1/changesets/${uuid}`, {
      headers: writeHeaders,
    });
  }
}

async function draftContent(page: Page, id: number): Promise<string> {
  const [open] = await drafts(page);
  return String(open?.entries[`page:${id}`]?.value.content ?? '');
}

const section = (name: string, inner: string) =>
  `<!-- wp:group {"metadata":{"name":"${name}"},"layout":{"type":"constrained"}} -->\n` +
  `<div class="wp-block-group">${inner}</div>\n<!-- /wp:group -->`;
const paragraph = (text: string, attrs = '', classes = '') =>
  `<!-- wp:paragraph ${attrs ? `${attrs} ` : ''}-->\n<p${classes ? ` class="${classes}"` : ''}>${text}</p>\n<!-- /wp:paragraph -->`;

async function createPage(page: Page) {
  const content = [
    section(
      'Bakery',
      paragraph('Fresh bread every morning', '{"fontSize":"large"}', 'has-large-font-size'),
    ),
    section('Cafe', paragraph('Coffee and cake')),
  ].join('\n\n');
  const res = await page.request.post('/wp-json/wp/v2/pages', {
    headers: writeHeaders,
    data: { title: unique('Menu page'), status: 'publish', content },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as number;
}

async function openStudio(page: Page, id: number): Promise<FrameLocator> {
  await page.goto(`/admin/studio?page=${id}`);
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  await expect(canvas.locator('header.wp-block-template-part')).toBeVisible({ timeout: 60_000 });
  return canvas;
}

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await logInAsAdmin(page);
  await discardDrafts(page);
});

test.afterEach(async ({ page }) => {
  await discardDrafts(page);
});

test('copy and paste across sections, paste style as one step, and the menu from the keyboard', async ({
  page,
}) => {
  const id = await createPage(page);
  const canvas = await openStudio(page, id);
  const sections = canvas.locator('.entry-content > .wp-block-group');
  await expect(sections).toHaveCount(2);
  const bread = sections.nth(0).getByText('Fresh bread every morning', { exact: true });
  const coffee = sections.nth(1).getByText('Coffee and cake', { exact: true });

  // Right-click a block: the menu, focus on its first item.
  await bread.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Actions for Paragraph' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeFocused();
  for (const item of ['Paste', 'Paste style', 'Duplicate', 'Save as section…', 'Delete']) {
    await expect(menu.getByRole('menuitem', { name: item, exact: true })).toBeVisible();
  }
  await expect(menu.getByRole('menuitem', { name: 'Ask AI about this text…' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Copy' }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByText('Copied “Paragraph”.')).toBeVisible();

  // Paste in the other section: just after the block there.
  await coffee.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  await expect(sections.nth(1).getByText('Fresh bread every morning')).toBeVisible();
  await expect(sections.nth(1).locator('p')).toHaveText([
    'Coffee and cake',
    'Fresh bread every morning',
  ]);
  await expect(sections).toHaveCount(2);

  // Paste style: the copied paragraph's large size onto "Coffee and cake", one undo step.
  await expect(coffee).not.toHaveClass(/has-large-font-size/);
  // The pasted block's toolbar sits over "Coffee and cake": right-click it where it is.
  await coffee.dispatchEvent('contextmenu', { button: 2 });
  await page.getByRole('menuitem', { name: 'Paste style' }).click();
  await expect(coffee).toHaveClass(/has-large-font-size/);
  await expect(coffee).toHaveText('Coffee and cake');
  await expect
    .poll(() => draftContent(page, id), { timeout: 15_000 })
    .toContain(
      '<!-- wp:paragraph {"fontSize":"large"} -->\n<p class="has-large-font-size">Coffee and cake</p>',
    );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(coffee).not.toHaveClass(/has-large-font-size/);
  await expect(sections.nth(1).getByText('Fresh bread every morning')).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(coffee).toHaveClass(/has-large-font-size/);

  // The keyboard: Shift+F10 on the selected block, arrows, Escape back to the block.
  await coffee.click();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(coffee).toBeFocused();

  // A whole section: copied from the breadcrumb's selection, pasted after the first section.
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('button', { name: 'Section: Cafe' })
    .click();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: 'Actions for Cafe' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Copied “Cafe”.')).toBeVisible();
  await bread.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
  // A section never goes inside another: it's the second section now.
  await expect(sections).toHaveCount(3);
  await expect(sections.nth(1).locator('p').first()).toHaveText('Coffee and cake');
  await expect(sections.nth(0).locator('p')).toHaveText(['Fresh bread every morning']);

  await expect
    .poll(async () => (await draftContent(page, id)).split('"name":"Cafe"').length - 1, {
      timeout: 15_000,
    })
    .toBe(2);
});

test('save a block as a section, then find it in the Sections panel', async ({ page }) => {
  const id = await createPage(page);
  const canvas = await openStudio(page, id);
  const name = unique('Our bakery');

  await canvas.getByText('Fresh bread every morning', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Save as section…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save as section' });
  await expect(dialog).toBeVisible();
  const field = dialog.getByRole('textbox', { name: 'Name' });
  await expect(field).toHaveValue('Paragraph');
  await field.fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`Saved “${name}”.`, { exact: false })).toBeVisible();

  // Unsynced: the block stays as it was, and the section is in the panel.
  await expect(canvas.getByText('Fresh bread every morning', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Sections' });
  await expect(panel.getByRole('region', { name: 'Saved sections' })).toBeVisible();
  await expect(panel.getByRole('button', { name: `Add section: ${name}` })).toBeVisible();

  // Cleaned up through REST, as the pattern was saved straight away.
  const saved = await (
    await page.request.get('/wp-json/wp/v2/blocks?per_page=100&context=edit')
  ).json();
  const post = (saved as { id: number; title: { raw: string } }[]).find(
    (p) => p.title.raw === name,
  );
  expect(post).toBeTruthy();
  await page.request.delete(`/wp-json/wp/v2/blocks/${post?.id}?force=true`, {
    headers: writeHeaders,
  });
});
