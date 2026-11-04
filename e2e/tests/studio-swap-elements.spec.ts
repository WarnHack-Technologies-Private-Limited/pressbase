import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * Studio's Swap layout (#45) and Elements panel (#35): a hero swapped
 * through three layouts and back with the same text, one undo step per
 * swap; an Image dragged into a column, and a block added with the
 * keyboard.
 */

const writeHeaders = { 'x-pressbase-request': '1' };

async function createPage(page: Page, title: string, content: string) {
  const res = await page.request.post('/wp-json/wp/v2/pages', {
    headers: writeHeaders,
    data: { title, status: 'publish', content },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as number;
}

async function discardDrafts(page: Page) {
  const res = await page.request.get('/wp-json/pressbase/v1/changesets');
  for (const { uuid } of (await res.json()) as { uuid: string }[]) {
    await page.request.delete(`/wp-json/pressbase/v1/changesets/${uuid}`, {
      headers: writeHeaders,
    });
  }
}

async function openStudio(page: Page, id: number): Promise<FrameLocator> {
  await page.goto(`/admin/studio?page=${id}`);
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  await expect(canvas.locator('header.wp-block-template-part')).toBeVisible({ timeout: 60_000 });
  return canvas;
}

const paragraph = (text: string) => `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;
const button = (text: string) =>
  `<!-- wp:button -->\n<div class="wp-block-button"><a class="wp-block-button__link wp-element-button">${text}</a></div>\n<!-- /wp:button -->`;

/** A hero laid out as the library's "Hero with heading, text and buttons", with a bakery's words. */
const HERO = `<!-- wp:group {"align":"full","layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull"><!-- wp:heading {"level":1} -->
<h1 class="wp-block-heading">Fresh bread, every morning</h1>
<!-- /wp:heading -->

${paragraph('Sourdough, rye and croissants, baked in the night on Mill Street.')}

<!-- wp:buttons -->
<div class="wp-block-buttons">${button('See the menu')}

${button('Find us')}</div>
<!-- /wp:buttons --></div>
<!-- /wp:group -->`;

const HERO_TEXT = [
  'Fresh bread, every morning',
  'Sourdough, rye and croissants, baked in the night on Mill Street.',
  'See the menu',
  'Find us',
];

test('Swap layout moves a hero through three layouts and back, keeping its text', async ({
  page,
}) => {
  await logInAsAdmin(page);
  const id = await createPage(page, unique('Bakery home'), HERO);
  await discardDrafts(page);
  try {
    const canvas = await openStudio(page, id);
    const content = canvas.locator('.wp-block-post-content');
    // The text on the page, without the zero-width characters the editor puts by a caret.
    const pageText = async () => ((await content.textContent()) ?? '').replace(/\uFEFF/g, '');
    const original = await pageText();
    for (const text of HERO_TEXT) expect(original).toContain(text);

    // The section toolbar has ‹ 1/N ›: the hero's pattern and the others of its kind.
    await canvas.getByText('Sourdough, rye and croissants').hover();
    const toolbar = page.getByRole('toolbar', { name: /^Section 1 of 1/ });
    await expect(toolbar).toBeVisible();
    const position = page.locator('[data-swap-position]').first();
    await expect(position).toHaveText(/^1\/\d+$/);
    const total = Number((await position.textContent())?.split('/')[1]);
    expect(total).toBeGreaterThanOrEqual(4);

    // Next: layout 2, with the same words, and the section selected with Swap layout in the inspector.
    const next = toolbar.getByRole('button', { name: /^Next layout/ });
    await next.click();
    await expect(position).toHaveText(`2/${total}`);
    await expect(page.getByText(new RegExp(`^Layout 2 of ${total}:`))).toBeVisible();
    for (const text of HERO_TEXT) await expect(content).toContainText(text);
    const inspector = page.getByRole('complementary', { name: 'Settings' });
    await expect(inspector.getByRole('heading', { name: 'Swap layout' })).toBeVisible();

    // One undo step per swap: undo puts the first layout back, redo the second.
    await page.keyboard.press('Control+z');
    await expect(position).toHaveText(`1/${total}`);
    await expect.poll(pageText).toBe(original);
    await page.keyboard.press('Control+Shift+z');
    await expect(position).toHaveText(`2/${total}`);

    // Two more layouts, from the inspector's arrows and the toolbar's.
    await inspector.getByRole('button', { name: /^Next layout/ }).click();
    await expect(position).toHaveText(`3/${total}`);
    await expect(content).toContainText('Fresh bread, every morning');
    await page
      .getByRole('toolbar', { name: /^Section 1 of 1/ })
      .getByRole('button', { name: /^Next layout/ })
      .click();
    await expect(position).toHaveText(`4/${total}`);

    // And back to the first: the same text as before, nothing from the other layouts.
    for (let at = 4; at > 1; at--) {
      await inspector.getByRole('button', { name: /^Previous layout/ }).click();
      await expect(position).toHaveText(`${at - 1}/${total}`);
    }
    await expect.poll(pageText).toBe(original);

    // History names the steps.
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(
      page
        .locator('#studio-panel')
        .getByText(/^Swapped layout of “/)
        .first(),
    ).toBeVisible();

    // The palette swaps the selected section too.
    await page.getByRole('button', { name: /^Find/ }).click();
    await page.getByRole('combobox', { name: 'Search commands' }).fill('swap layout next');
    await page.keyboard.press('Enter');
    await expect(position).toHaveText(`2/${total}`);
    await expect(content).toContainText('Fresh bread, every morning');
  } finally {
    await discardDrafts(page);
  }
});

const COLUMNS = `<!-- wp:heading -->
<h2 class="wp-block-heading">Our bakers</h2>
<!-- /wp:heading -->

<!-- wp:columns -->
<div class="wp-block-columns"><!-- wp:column -->
<div class="wp-block-column"></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column">${paragraph('Anna starts the ovens at four.')}</div>
<!-- /wp:column --></div>
<!-- /wp:columns -->`;

test('the Elements panel drags an Image into a column, and adds a block with the keyboard', async ({
  page,
}) => {
  await logInAsAdmin(page);
  const id = await createPage(page, unique('Our bakers'), COLUMNS);
  await discardDrafts(page);
  try {
    const canvas = await openStudio(page, id);
    await page.getByRole('button', { name: 'Elements', exact: true }).click();
    const panel = page.locator('#studio-panel');
    const search = panel.getByRole('searchbox', { name: 'Search blocks' });
    await expect(search).toBeFocused();
    for (const group of ['Text', 'Media', 'Layout', 'Site']) {
      await expect(panel.getByRole('heading', { name: group, exact: true })).toBeVisible();
    }

    // Drag Image into the empty column: the column lights up while it's over it.
    const tile = panel.getByRole('button', { name: 'Add block: Image' });
    const column = canvas.locator('.wp-block-column').first();
    const from = await tile.boundingBox();
    const to = await column.boundingBox();
    if (!from || !to) throw new Error('No tile or column on screen');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 20, to.y + 10, { steps: 5 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
    await expect(column).toHaveAttribute('data-studio-drop-target', '');
    await page.mouse.up();
    await expect(column.locator('[data-type="core/image"]')).toHaveCount(1);
    await expect(canvas.locator('[data-studio-drop-target]')).toHaveCount(0);

    // One undo step takes it out again.
    const pageContent = canvas.locator('.wp-block-post-content');
    await page.keyboard.press('Control+z');
    await expect(pageContent.locator('[data-type="core/image"]')).toHaveCount(0);

    // Keyboard: with the paragraph selected, search and press Enter on the tile.
    await canvas.getByText('Anna starts the ovens at four.').click();
    await search.fill('photo');
    await expect(panel.getByRole('status').first()).toHaveText(
      'Click a block to add it after “Paragraph”.',
    );
    await search.press('Tab');
    await expect(tile).toBeFocused();
    await page.keyboard.press('Enter');
    const second = canvas.locator('.wp-block-column').nth(1);
    await expect
      .poll(() =>
        second
          .locator(':scope > [data-type], :scope > .block-editor-inner-blocks [data-type]')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-type'))),
      )
      .toEqual(['core/paragraph', 'core/image']);

    // The palette adds blocks too.
    await page.getByRole('button', { name: /^Find/ }).click();
    await page.getByRole('combobox', { name: 'Search commands' }).fill('add block heading');
    await page.keyboard.press('Enter');
    await expect(pageContent.locator('[data-type="core/heading"]')).toHaveCount(2);
  } finally {
    await discardDrafts(page);
  }
});
