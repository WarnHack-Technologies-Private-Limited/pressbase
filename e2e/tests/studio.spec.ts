import { expect, type Page, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * Studio, the site editor (#28): the page in the theme with its header and
 * footer, inline editing with undo and redo, the keyboard, and Publish
 * through a changeset. Saving, Preview, Discard and the header and footer
 * are in studio-saving.spec.ts (#30, #31).
 */

const writeHeaders = { 'x-pressbase-request': '1' };

async function createPage(page: Page, title: string, text: string): Promise<number> {
  const res = await page.request.post('/wp-json/wp/v2/pages', {
    headers: writeHeaders,
    data: {
      title,
      status: 'publish',
      content: `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`,
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as number;
}

test('Studio shows a page in the theme and edits it inline, with undo, redo and Publish', async ({
  page,
}) => {
  await logInAsAdmin(page);
  const title = unique('Opening hours');
  const id = await createPage(page, title, 'Open from seven every morning.');

  // No draft left over from other tests: Publish counts this one's change only.
  const open = await page.request.get('/wp-json/pressbase/v1/changesets');
  for (const { uuid } of (await open.json()) as { uuid: string }[]) {
    await page.request.delete(`/wp-json/pressbase/v1/changesets/${uuid}`, {
      headers: writeHeaders,
    });
  }

  try {
    // Appearance → Editor, as in WordPress, leads to Studio.
    await page.goto('/admin/appearance/editor');
    await expect(page).toHaveURL(/\/admin\/studio/);
    await expect(page.getByRole('navigation', { name: 'Studio panels' })).toBeVisible();

    await page.goto(`/admin/studio?page=${id}`);
    const canvas = page.frameLocator('iframe[name="editor-canvas"]');
    // The theme's header and footer, around the page.
    await expect(canvas.locator('header.wp-block-template-part')).toBeVisible({ timeout: 60_000 });
    await expect(canvas.locator('footer.wp-block-template-part')).toBeAttached();
    const text = canvas.getByText('Open from seven every morning.');
    await expect(text).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Page' })).toHaveValue(String(id));

    // Panels that aren't built yet say which issue brings them.
    await page.getByRole('button', { name: 'Media' }).click();
    await expect(page.getByText('arrives with #58')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Media' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Media' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    // Edit inline; the breadcrumb follows the selection.
    await text.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Closed on Mondays.');
    await expect(
      canvas.getByText('Open from seven every morning. Closed on Mondays.'),
    ).toBeVisible();
    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(breadcrumb).toContainText(title);
    await expect(breadcrumb).toContainText('Paragraph');
    // The edit is saved to the draft: Publish counts it.
    const publish = page.getByRole('button', { name: 'Publish, 1 change' });
    await expect(publish).toBeVisible();

    // Undo and redo, from the top bar and the keyboard. Back to the start: nothing to publish.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(canvas.getByText('Open from seven every morning.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(
      canvas.getByText('Open from seven every morning. Closed on Mondays.'),
    ).toBeVisible();

    // The header can be selected as a whole, and says it's on every page.
    await canvas.locator('header.wp-block-template-part').hover({ position: { x: 300, y: 10 } });
    await canvas.locator('header .pressbase-studio-part__label').click();
    await expect(page.getByRole('complementary', { name: 'Settings' })).toContainText(
      'On all pages',
    );
    await expect(breadcrumb).toContainText('Header');

    // Publish goes through a changeset; nothing was saved to the page before.
    await expect(page.getByText('Draft saved')).toBeVisible();
    const before = await page.request.get(`/wp-json/wp/v2/pages/${id}?context=edit`);
    expect((await before.json()).content.raw).not.toContain('Closed on Mondays');
    await publish.click();
    await page.getByRole('button', { name: 'Publish 1 change' }).click();
    await expect(page.getByText('Published. Your changes are live.')).toBeVisible();
    const after = await page.request.get(`/wp-json/wp/v2/pages/${id}?context=edit`);
    expect((await after.json()).content.raw).toContain('Closed on Mondays.');
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  } finally {
    await page.request.delete(`/wp-json/wp/v2/pages/${id}?force=true`, { headers: writeHeaders });
  }
});

test('Studio works from the keyboard: skip to the page, move with arrows, type', async ({
  page,
}) => {
  await logInAsAdmin(page);
  const id = await createPage(page, unique('Keyboard'), 'First line.');
  try {
    await page.goto(`/admin/studio?page=${id}`);
    const canvas = page.frameLocator('iframe[name="editor-canvas"]');
    await expect(canvas.getByText('First line.')).toBeVisible({ timeout: 60_000 });

    // The skip link is the first stop and leads into the canvas.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to the page' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    // The header is the first block; the page's paragraph is reached with the arrow keys.
    for (let i = 0; i < 40; i++) {
      const crumbs = await page.getByRole('navigation', { name: 'Breadcrumb' }).textContent();
      if (crumbs?.includes('Paragraph')) break;
      await page.keyboard.press('ArrowDown');
    }
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Paragraph');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Typed by keyboard. ');
    await expect(canvas.getByText(/Typed by keyboard\./)).toBeVisible();
  } finally {
    await page.request.delete(`/wp-json/wp/v2/pages/${id}?force=true`, { headers: writeHeaders });
  }
});
