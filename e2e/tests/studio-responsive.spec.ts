import { expect, type FrameLocator, type Locator, type Page, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * Responsive editing (#49) and Layers (#50) in Studio. On Mobile, a style
 * change applies to phones only (WordPress 7.1's `style["@mobile"]`), and
 * the published page shows it at a phone's width only; a block can be
 * hidden on a size. Layers selects with the canvas, moves blocks with the
 * keyboard and renames them.
 *
 * The draft is published through the REST API, so these tests don't
 * depend on the Publish list's own steps (studio-saving.spec.ts covers them).
 */

const writeHeaders = { 'x-pressbase-request': '1' };
const WEB_URL = `http://localhost:${process.env.E2E_WEB_PORT ?? 3001}`;

async function createPage(page: Page, title: string, content: string) {
  const res = await page.request.post('/wp-json/wp/v2/pages', {
    headers: writeHeaders,
    data: { title, status: 'publish', content },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { id: body.id as number, path: new URL(body.link as string).pathname };
}

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

/** The page's content in the draft ('' until there is one). */
async function draftContent(page: Page, id: number): Promise<string> {
  const [open] = await drafts(page);
  return String(open?.entries[`page:${id}`]?.value.content ?? '');
}

async function publishDraft(page: Page) {
  const [open] = await drafts(page);
  expect(open).toBeTruthy();
  const res = await page.request.post(
    `/wp-json/pressbase/v1/changesets/${(open as Changeset).uuid}/publish`,
    { headers: writeHeaders },
  );
  expect(res.ok()).toBe(true);
}

async function openStudio(page: Page, id: number): Promise<FrameLocator> {
  await page.goto(`/admin/studio?page=${id}`);
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  await expect(canvas.locator('header.wp-block-template-part')).toBeVisible({ timeout: 60_000 });
  return canvas;
}

/** A computed style on the public page at a given width, as a visitor's browser sees it. */
async function publicStyle(
  page: Page,
  path: string,
  width: number,
  selector: string,
  property: string,
): Promise<string> {
  const context = await page
    .context()
    .browser()
    ?.newContext({
      viewport: { width, height: 900 },
    });
  if (!context) throw new Error('No browser');
  try {
    const visitor = await context.newPage();
    await visitor.goto(`${WEB_URL}${path}`);
    return await visitor
      .locator(selector)
      .first()
      .evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
  } finally {
    await context.close();
  }
}

/**
 * Picks the first size after Default in WordPress's font size list (a
 * listbox), with the keyboard as people can.
 */
async function chooseFirstFontSize(page: Page, fontSize: Locator, name: string) {
  await fontSize.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox', { name: 'Font size' })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(fontSize).toContainText(name);
}

test.beforeEach(async ({ page }) => {
  await logInAsAdmin(page);
  await discardDrafts(page);
});

test.afterEach(async ({ page }) => {
  await discardDrafts(page);
});

test('a heading made smaller on Mobile is smaller on phones only, and a block can be hidden on desktop', async ({
  page,
}) => {
  const title = unique('Opening hours');
  const { id, path } = await createPage(
    page,
    title,
    '<!-- wp:heading -->\n<h2 class="wp-block-heading">Fresh bread daily</h2>\n<!-- /wp:heading -->\n\n' +
      '<!-- wp:paragraph -->\n<p>Only on small screens.</p>\n<!-- /wp:paragraph -->',
  );
  try {
    const canvas = await openStudio(page, id);
    await canvas.getByText('Fresh bread daily', { exact: true }).click();
    const settings = page.getByRole('complementary', { name: 'Settings' });

    // Mobile: the canvas is a phone's width, and the inspector says which size it edits.
    await page.getByRole('button', { name: 'Mobile', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mobile', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(settings.getByRole('heading', { name: 'Editing for Mobile' })).toBeVisible();
    await expect
      .poll(() => page.locator('iframe[name="editor-canvas"]').evaluate((f) => f.clientWidth))
      .toBeLessThanOrEqual(390);

    // The font size, for phones only.
    await settings.getByRole('tab', { name: 'Style' }).click();
    const fontSize = settings.getByRole('combobox', { name: 'Font size' });
    await chooseFirstFontSize(page, fontSize, 'Small');
    const changed = settings.locator('[data-device-changes="mobile"]');
    await expect(changed.getByText('Changed for mobile')).toBeVisible();
    await expect(changed.getByText('Font size')).toBeVisible();
    await expect
      .poll(() => draftContent(page, id))
      .toContain('"@mobile":{"typography":{"fontSize":"var:preset|font-size|small"}}');

    // The reset puts it back; choosing again brings it back (one change in the draft either way).
    await changed.getByRole('button', { name: 'Reset Font size for mobile' }).click();
    await expect(changed.getByText('Changed for mobile')).toHaveCount(0);
    await expect.poll(() => draftContent(page, id)).not.toContain('@mobile');
    await chooseFirstFontSize(page, fontSize, 'Small');
    await expect.poll(() => draftContent(page, id)).toContain('"@mobile"');

    // Desktop: the base size is untouched, and no per-device box.
    await page.getByRole('button', { name: 'Desktop', exact: true }).click();
    await expect(settings.getByRole('heading', { name: 'Editing for Mobile' })).toHaveCount(0);

    // Show the paragraph on phones and tablets only.
    await canvas.getByText('Only on small screens.', { exact: true }).click();
    const showOn = settings.getByRole('group', { name: 'Show on' });
    await showOn.getByRole('checkbox', { name: 'Desktop' }).uncheck();
    await expect(showOn.getByText('It shows here while it’s selected.')).toBeVisible();
    await expect
      .poll(() => draftContent(page, id))
      .toContain('"blockVisibility":{"viewport":{"desktop":false}}');

    await publishDraft(page);

    // Visitors: smaller on a phone, as before on a computer.
    const small = await publicStyle(page, path, 390, 'h2.wp-block-heading', 'font-size');
    const large = await publicStyle(page, path, 1280, 'h2.wp-block-heading', 'font-size');
    expect(small).toBe('14px');
    expect(Number.parseFloat(large)).toBeGreaterThan(20);
    // The paragraph is on phones, not on computers.
    expect(await publicStyle(page, path, 390, '.entry-content p', 'display')).not.toBe('none');
    expect(await publicStyle(page, path, 1280, '.entry-content p', 'display')).toBe('none');
  } finally {
    await page.request.delete(`/wp-json/wp/v2/pages/${id}?force=true`, { headers: writeHeaders });
  }
});

test('Layers follows the selection, moves blocks with the keyboard and renames them', async ({
  page,
}) => {
  const title = unique('Menu');
  const { id } = await createPage(
    page,
    title,
    '<!-- wp:heading -->\n<h2 class="wp-block-heading">Our breads</h2>\n<!-- /wp:heading -->\n\n' +
      '<!-- wp:paragraph -->\n<p>Rye, spelt and sourdough.</p>\n<!-- /wp:paragraph -->',
  );
  try {
    const canvas = await openStudio(page, id);
    await page.getByRole('button', { name: 'Layers' }).click();
    const panel = page.locator('#studio-panel[data-panel="layers"]');
    const tree = panel.getByRole('treegrid');
    await expect(tree).toBeVisible();

    // Selecting on the canvas selects the row; the row selects on the canvas.
    await canvas.getByText('Our breads', { exact: true }).click();
    await expect(tree.getByRole('gridcell', { name: 'Our breads', selected: true })).toBeVisible();
    // The page's paragraph (the footer has one too, deeper down).
    await tree
      .locator('[role="row"][aria-level="2"]', {
        has: page.getByRole('link', { name: 'Paragraph' }),
      })
      .getByRole('link', { name: 'Paragraph' })
      .click();
    await expect(canvas.locator('p.is-selected')).toHaveText('Rye, spelt and sourdough.');

    // Alt and the arrow keys move the focused row's block.
    const headingLink = tree.getByRole('link', { name: 'Our breads' });
    await headingLink.focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(panel.getByText('Heading moved down.')).toBeAttached();
    await expect
      .poll(async () => {
        const content = await draftContent(page, id);
        return content.indexOf('Our breads') > content.indexOf('Rye, spelt');
      })
      .toBe(true);
    // Focus stays on the moved block's row.
    await expect(headingLink).toBeFocused();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(panel.getByText('Heading moved up.')).toBeAttached();

    // Renaming: the name shows in Layers and is saved as metadata.name.
    await headingLink.click();
    await panel.getByLabel('Name in Layers').fill('Bread list title');
    await panel.getByRole('button', { name: 'Rename' }).click();
    await expect(tree.getByRole('link', { name: 'Bread list title' })).toBeVisible();
    await expect.poll(() => draftContent(page, id)).toContain('"name":"Bread list title"');

    // Hiding on mobile from Layers: saved, and the row shows the hidden icon.
    await panel
      .getByRole('group', { name: 'Show on' })
      .getByRole('checkbox', { name: 'Mobile' })
      .uncheck();
    await expect
      .poll(() => draftContent(page, id))
      .toContain('"blockVisibility":{"viewport":{"mobile":false}}');
    await expect(
      tree
        .getByRole('row', { name: /^Bread list title/ })
        .locator('.block-editor-list-view-block-select-button__block-visibility'),
    ).toBeVisible();
  } finally {
    await page.request.delete(`/wp-json/wp/v2/pages/${id}?force=true`, { headers: writeHeaders });
  }
});

test('a value set for Tablet carries down to Mobile, which shows it as inherited', async ({
  page,
}) => {
  const title = unique('Tablet');
  const { id } = await createPage(
    page,
    title,
    '<!-- wp:heading -->\n<h2 class="wp-block-heading">Weekend bakes</h2>\n<!-- /wp:heading -->',
  );
  try {
    const canvas = await openStudio(page, id);
    await canvas.getByText('Weekend bakes', { exact: true }).click();
    const settings = page.getByRole('complementary', { name: 'Settings' });
    await page.getByRole('button', { name: 'Tablet', exact: true }).click();
    await expect(settings.getByRole('heading', { name: 'Editing for Tablet' })).toBeVisible();
    await settings.getByRole('tab', { name: 'Style' }).click();
    await chooseFirstFontSize(page, settings.getByRole('combobox', { name: 'Font size' }), 'Small');
    await expect(settings.getByText('Changed for tablet')).toBeVisible();
    // Stored for both sizes: WordPress's ranges don't overlap, so Studio copies the value down.
    const small = '{"typography":{"fontSize":"var:preset|font-size|small"}}';
    await expect.poll(() => draftContent(page, id)).toContain(`"@tablet":${small}`);
    await expect.poll(() => draftContent(page, id)).toContain(`"@mobile":${small}`);

    // On Mobile it's Tablet's value, not a change of its own.
    await page.getByRole('button', { name: 'Mobile', exact: true }).click();
    await expect(settings.getByText('From Tablet: Font size small')).toBeVisible();
    await expect(settings.getByText('Changed for mobile')).toHaveCount(0);
  } finally {
    await page.request.delete(`/wp-json/wp/v2/pages/${id}?force=true`, { headers: writeHeaders });
  }
});
