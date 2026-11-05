import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * Studio's Pages panel (#29) and Sections panel with the section toolbar
 * (#44): adding, nesting and ordering pages and choosing the home page, all
 * through the draft; Edit with Studio from Pages and the editor; editors
 * without design rights; and adding a section between two others.
 */

const writeHeaders = { 'x-pressbase-request': '1' };

async function createPage(page: Page, title: string, content: string) {
  const res = await page.request.post('/wp-json/wp/v2/pages', {
    headers: writeHeaders,
    data: { title, status: 'publish', content },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { id: body.id as number, slug: body.slug as string };
}

const paragraph = (text: string) => `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;

/** A section: a named group (its name shows in Layers and on the section toolbar). */
const section = (name: string, text: string) =>
  `<!-- wp:group {"metadata":{"name":"${name}"},"layout":{"type":"constrained"}} -->\n<div class="wp-block-group">${paragraph(text)}</div>\n<!-- /wp:group -->`;

/** Each test starts without a draft (a failed one may leave its draft open). */
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

async function publishAll(page: Page) {
  await page.getByRole('button', { name: /^Publish, \d+ changes?$/ }).click();
  await page.getByRole('button', { name: /^Publish \d+ changes?$/ }).click();
  await confirmPublish(page);
}

/** With things left on the checklist (#61), Publish asks first: say yes. */
async function confirmPublish(page: Page) {
  // Published: the button has nothing left to count.
  const done = page.getByRole('button', { name: 'Publish', exact: true });
  const ask = page.getByRole('dialog', { name: /^Publish with \d+ things? left to fill in\?$/ });
  await expect(done.or(ask)).toBeVisible({ timeout: 30_000 });
  if (await ask.isVisible()) await ask.getByRole('button', { name: 'Publish anyway' }).click();
  await expect(done).toBeVisible();
  await expect(page.getByText('Published. Your changes are live.').first()).toBeVisible();
}

/** The reading settings, to put back after a test changes the home page. */
async function readingSettings(page: Page) {
  const index = await (await page.request.get('/wp-json/')).json();
  return {
    show_on_front: index.show_on_front as string,
    page_on_front: index.page_on_front as number,
  };
}

test('the Pages panel adds a page, nests it, sets the home page, and publishes it all at once', async ({
  page,
}) => {
  await logInAsAdmin(page);
  const before = await readingSettings(page);
  const visit = await createPage(page, unique('Visit us'), paragraph('Find us on the corner.'));
  const welcome = await createPage(page, unique('Welcome'), paragraph('Fresh bread daily.'));
  const visitTitle = (await (await page.request.get(`/wp-json/wp/v2/pages/${visit.id}`)).json())
    .title.rendered as string;
  const welcomeTitle = (await (await page.request.get(`/wp-json/wp/v2/pages/${welcome.id}`)).json())
    .title.rendered as string;
  const newTitle = unique('Opening times');
  await discardDrafts(page);

  try {
    await openStudio(page, welcome.id);
    await page.getByRole('button', { name: 'Pages', exact: true }).click();
    const panel = page.locator('#studio-panel');

    // Add a page: it opens on the canvas, as a new page in the draft.
    await panel.getByRole('button', { name: 'Add page' }).click();
    await panel.getByLabel('Page title').fill(newTitle);
    await panel.getByRole('button', { name: 'Add page' }).click();
    const added = panel.getByRole('button', { name: new RegExp(`^${newTitle}`) });
    await expect(added).toHaveAttribute('aria-current', 'page');
    await expect(added).toContainText('New');
    await expect(page.getByRole('combobox', { name: 'Page' })).toHaveValue(/^new:/);
    await expect(page.getByText('Draft saved')).toBeVisible();

    // Nest it under Visit us by dragging it onto that page.
    const row = (title: string) =>
      panel
        .locator('li')
        .filter({ has: page.getByRole('button', { name: new RegExp(`^${title}`) }) });
    await row(newTitle).dragTo(row(visitTitle));
    await expect(panel.getByRole('status')).toHaveText(
      `${newTitle} moved. It’s now under ${visitTitle}.`,
    );

    // The keyboard does the same: Alt+← takes it out, the ⋯ menu puts it back.
    await added.focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(panel.getByRole('status')).toHaveText(`${newTitle} moved. It’s now a main page.`);
    await row(newTitle).dragTo(row(visitTitle));
    await expect(panel.getByRole('status')).toHaveText(
      `${newTitle} moved. It’s now under ${visitTitle}.`,
    );

    // Make Welcome the home page.
    await panel.getByRole('button', { name: `Actions for ${welcomeTitle}` }).click();
    await page.getByRole('menuitem', { name: 'Make this the home page' }).click();
    await expect(row(welcomeTitle)).toContainText('Home');

    // Nothing is live yet: the new page doesn't exist and the home page hasn't changed.
    await expect(page.getByText('Draft saved')).toBeVisible();
    const draft = await (await page.request.get('/wp-json/pressbase/v1/changesets')).json();
    const entries = draft[0].entries as Record<string, { value: Record<string, unknown> }>;
    const newKey = Object.keys(entries).find((key) => /^page:[a-z]/.test(key)) ?? '';
    expect(entries[newKey]?.value).toMatchObject({ title: newTitle, parent: visit.id });
    expect(entries['option:page_on_front']?.value).toBe(welcome.id);
    expect(await readingSettings(page)).toEqual(before);

    await publishAll(page);

    // Live: the new page under Visit us, and Welcome as the home page.
    const slug = newKey.slice('page:'.length);
    const live = await (await page.request.get(`/wp-json/wp/v2/pages?slug=${slug}`)).json();
    expect(live[0]).toMatchObject({ parent: visit.id, status: 'publish' });
    expect(await readingSettings(page)).toEqual({
      show_on_front: 'page',
      page_on_front: welcome.id,
    });
    const visitor = await page.request.get(new URL(live[0].link).pathname);
    expect(visitor.status()).toBe(200);
    // Studio now opens the page it added by its ID.
    await expect(page.getByRole('combobox', { name: 'Page' })).toHaveValue(String(live[0].id));
  } finally {
    await discardDrafts(page);
    await page.request.post('/wp-json/wp/v2/settings', { headers: writeHeaders, data: before });
  }
});

test('Edit with Studio opens a page from Pages and from the editor', async ({ page }) => {
  await logInAsAdmin(page);
  const title = unique('Our story');
  const { id } = await createPage(page, title, paragraph('Since 1998.'));

  await page.goto(`/admin/pages?search=${encodeURIComponent(title)}`);
  const row = page.getByRole('row').filter({ hasText: title });
  await row.hover();
  await row.getByRole('link', { name: 'Edit with Studio' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/studio\\?page=${id}$`));

  await page.goto(`/admin/pages/${id}`);
  await page.getByRole('button', { name: 'Edit with Studio' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/studio\\?page=${id}$`));
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  await expect(canvas.getByText('Since 1998.')).toBeVisible({ timeout: 60_000 });
});

test('people without design rights edit their pages in Studio; the header, footer and styles are read-only', async ({
  page,
  browser,
}) => {
  await logInAsAdmin(page);
  const username = unique('editor').replace(/\s+/g, '-');
  const password = 'rye-loaf-crust-77-harbour';
  const res = await page.request.post('/wp-json/wp/v2/users', {
    headers: writeHeaders,
    data: { username, email: `${username}@example.com`, password, roles: ['editor'] },
  });
  expect(res.status()).toBe(201);
  const user = await res.json();
  const { id } = await createPage(page, unique('Prices'), paragraph('A loaf is four euros.'));

  const context = await browser.newContext();
  const editor = await context.newPage();
  try {
    await editor.goto('/login');
    await editor.getByLabel('Username or email').fill(username);
    await editor.getByLabel('Password', { exact: true }).fill(password);
    await editor.getByRole('button', { name: 'Log in' }).click();
    await expect(editor).toHaveURL(/\/admin\/?$/);

    const canvas = await openStudio(editor, id);
    await expect(canvas.getByText('A loaf is four euros.')).toBeVisible();
    await canvas.locator('header.wp-block-template-part').click({ position: { x: 4, y: 4 } });
    await expect(
      editor
        .getByRole('complementary', { name: 'Settings' })
        .getByText(/only people who can change the site’s design can edit it/),
    ).toBeVisible();
    await editor.getByRole('button', { name: 'Styles', exact: true }).click();
    await expect(
      editor.getByText('Only people who can change the site’s design can change its styles.'),
    ).toBeVisible();
    // Editors can't choose the home page (manage_options).
    await editor.getByRole('button', { name: 'Pages', exact: true }).click();
    await editor
      .locator('#studio-panel')
      .getByRole('button', { name: /^Actions for Prices/ })
      .click();
    await expect(editor.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect(editor.getByRole('menuitem', { name: 'Make this the home page' })).toHaveCount(0);
  } finally {
    await context.close();
    await page.request.delete(`/wp-json/wp/v2/users/${user.id}?force=true&reassign=1`, {
      headers: writeHeaders,
    });
  }
});

test('the Sections panel adds a pricing section between two others; the section toolbar moves it', async ({
  page,
}) => {
  await logInAsAdmin(page);
  const { id } = await createPage(
    page,
    unique('Menu'),
    `${section('Breads', 'Sourdough and rye, baked at dawn.')}\n\n${section('Cakes', 'Carrot cake on Fridays.')}`,
  );
  await discardDrafts(page);
  try {
    const canvas = await openStudio(page, id);
    const sections = () =>
      canvas
        .locator('.wp-block-post-content > [data-block]')
        .evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim().slice(0, 12)));

    // Hovering a section outlines it and shows its toolbar and ＋ Add section.
    await canvas.getByText('Sourdough and rye, baked at dawn.').hover();
    const toolbar = page.getByRole('toolbar', { name: 'Section 1 of 2: Breads' });
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Move section up' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(toolbar.getByRole('button', { name: 'Ask AI about this section' })).toBeVisible();
    await page.getByRole('button', { name: 'Add a section below Breads' }).click();

    // The panel opens at that place, with the search field ready.
    const panel = page.locator('#studio-panel');
    await expect(panel.getByRole('status')).toHaveText('Adding after “Breads”.');
    const search = panel.getByRole('searchbox', { name: 'Search sections' });
    await expect(search).toBeFocused();
    await search.fill('pricing');
    const pricing = panel.getByRole('button', { name: /^Add section: Pricing/ }).first();
    await expect(pricing).toBeVisible();
    await pricing.press('Enter');
    await expect(page.getByText(/^Section added: Pricing/)).toBeVisible();
    await expect.poll(sections).toEqual(['Sourdough an', 'Simple plans', 'Carrot cake ']);

    // The toolbar moves it up; undo puts it back.
    await canvas.getByText('Simple plans', { exact: false }).first().hover();
    await page
      .getByRole('toolbar', { name: /^Section 2 of 3/ })
      .getByRole('button', { name: 'Move section up' })
      .click();
    await expect.poll(sections).toEqual(['Simple plans', 'Sourdough an', 'Carrot cake ']);
    await page.keyboard.press('Control+z');
    await expect.poll(sections).toEqual(['Sourdough an', 'Simple plans', 'Carrot cake ']);

    // Published: visitors get the three sections in that order.
    await expect(page.getByText('Draft saved')).toBeVisible();
    await publishAll(page);
    const live = await (await page.request.get(`/wp-json/wp/v2/pages/${id}?context=edit`)).json();
    const content = live.content.raw as string;
    const at = (text: string) => content.indexOf(text);
    expect(at('Sourdough')).toBeGreaterThan(-1);
    expect(at('Sourdough')).toBeLessThan(at('Simple plans'));
    expect(at('Simple plans')).toBeLessThan(at('Carrot cake'));
  } finally {
    await discardDrafts(page);
  }
});
