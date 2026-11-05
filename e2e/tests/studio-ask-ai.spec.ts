import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * Studio's "Before you publish" checklist (#61) and Ask AI (#63), with the
 * recorded provider (`PRESSBASE_AI_TEST_PROVIDER=recorded`): no real
 * provider, no key.
 *
 * - A placeholder is marked on the canvas, listed on the checklist (which
 *   selects its block), and stops a one-click publish until confirmed.
 * - Ask AI on a section (Shorten, undone; Translate, kept), on selected text
 *   (Fix spelling), "Add a section with AI…" and "New page with AI…": each
 *   arrives as changes with Keep and Undo.
 */

const writeHeaders = { 'x-pressbase-request': '1' };

async function setAi(page: Page, settings: Record<string, unknown>) {
  const res = await page.request.post('/wp-json/pressbase/v1/ai/settings', {
    headers: writeHeaders,
    data: settings,
  });
  expect(res.status()).toBe(200);
}

const AI_ON = {
  enabled: true,
  provider: 'recorded',
  api_key: 'recorded-e2e-not-a-key',
  daily_limit: 200,
};

/** Pages this file creates, removed when it's done. */
const created: number[] = [];

async function createPage(page: Page, title: string, content: string) {
  const res = await page.request.post('/wp-json/wp/v2/pages', {
    headers: writeHeaders,
    data: { title, status: 'publish', content },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).id as number;
  created.push(id);
  return id;
}

async function discardDrafts(page: Page) {
  const res = await page.request.get('/wp-json/pressbase/v1/changesets');
  for (const { uuid } of (await res.json()) as { uuid: string }[]) {
    await page.request.delete(`/wp-json/pressbase/v1/changesets/${uuid}`, {
      headers: writeHeaders,
    });
  }
}

async function draftEntries(page: Page): Promise<Record<string, { value: unknown }>> {
  const res = await page.request.get('/wp-json/pressbase/v1/changesets');
  const [open] = (await res.json()) as { entries: Record<string, { value: unknown }> }[];
  return open?.entries ?? {};
}

async function openStudio(page: Page, id: number): Promise<FrameLocator> {
  await page.goto(`/admin/studio?page=${id}`);
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  await expect(canvas.locator('header.wp-block-template-part')).toBeVisible({ timeout: 60_000 });
  return canvas;
}

const paragraph = (text: string) => `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;

const section = (name: string, inner: string) =>
  `<!-- wp:group {"metadata":{"name":"${name}"},"layout":{"type":"constrained"}} -->
<div class="wp-block-group">${inner}</div>
<!-- /wp:group -->`;

const heading = (text: string) =>
  `<!-- wp:heading -->\n<h2 class="wp-block-heading">${text}</h2>\n<!-- /wp:heading -->`;

test.describe.configure({ mode: 'serial' });

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await logInAsAdmin(page);
  await setAi(page, { enabled: false });
  await discardDrafts(page);
  // The pages go too: each is a link in the header's menu, which later tests click around.
  for (const id of created) {
    await page.request.delete(`/wp-json/wp/v2/pages/${id}?force=true`, { headers: writeHeaders });
  }
  await page.close();
});

test('a placeholder is marked, listed on the checklist, and stops a one-click publish until confirmed', async ({
  page,
}) => {
  await logInAsAdmin(page);
  await discardDrafts(page);
  const title = unique('Checklist bakery');
  const id = await createPage(
    page,
    title,
    [
      section('Welcome', `${heading('Welcome in')}\n\n${paragraph('Warm bread, good coffee.')}`),
      section('Kind words', paragraph('[Add a customer quote]')),
    ].join('\n\n'),
  );
  const canvas = await openStudio(page, id);

  // Marked on the canvas (editor only).
  const gap = canvas.getByText('[Add a customer quote]');
  await expect(gap).toBeVisible();
  await expect(gap).toHaveCSS('outline-style', 'dashed');

  // An edit, so there's something to publish.
  await canvas.getByText('Welcome in').click();
  await page.keyboard.press('End');
  await page.keyboard.type(', neighbours');
  const publishButton = page.getByRole('button', { name: 'Publish, 1 change' });
  await expect(publishButton).toBeVisible({ timeout: 15_000 });

  // The checklist lists the gap; choosing it selects its block.
  await page.getByRole('button', { name: 'Checklist', exact: true }).click();
  const panel = page.locator('#studio-panel');
  await expect(panel.getByText('1 placeholder to fill in')).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('button', { name: /\[Add a customer quote\]/ }).click();
  await expect(canvas.locator('p.is-selected')).toHaveText('[Add a customer quote]');

  // One click on Publish asks first, naming what's left; nothing goes live.
  await publishButton.click();
  await expect(page.getByText('1 thing to fill in before you publish.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish 1 change' }).click();
  const confirm = page.getByRole('dialog', { name: 'Publish with 1 thing left to fill in?' });
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await expect(confirm.locator('[data-publish-checklist]')).toContainText(
    `[Add a customer quote] ${title}`,
  );
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  const live = await page.request.get(`/wp-json/wp/v2/pages/${id}?context=edit`);
  expect(((await live.json()) as { content: { raw: string } }).content.raw).not.toContain(
    'neighbours',
  );
  expect(Object.keys(await draftEntries(page))).toContain(`page:${id}`);

  // Confirmed: published.
  await publishButton.click();
  await page.getByRole('button', { name: 'Publish 1 change' }).click();
  await confirm.getByRole('button', { name: 'Publish anyway' }).click();
  await expect(page.getByText('Published. Your changes are live.')).toBeVisible();
  const after = await page.request.get(`/wp-json/wp/v2/pages/${id}?context=edit`);
  expect(((await after.json()) as { content: { raw: string } }).content.raw).toContain(
    'neighbours',
  );

  // The public page shows the gap as text, without the editor's marking.
  const pageLink = ((await after.json()) as { link: string }).link;
  await page.goto(pageLink);
  await expect(page.getByText('[Add a customer quote]')).toBeVisible();
  await expect(page.getByText('[Add a customer quote]')).not.toHaveCSS('outline-style', 'dashed');
});

test('Ask AI on a section: shorten (undone), then translate (kept)', async ({ page }) => {
  await logInAsAdmin(page);
  await setAi(page, AI_ON);
  await discardDrafts(page);
  const id = await createPage(
    page,
    unique('Ask AI bakery'),
    section(
      'Hero',
      `${heading('Bread baked fresh every morning')}\n\n${paragraph('Come in, say hello and take something warm home. We open early.')}`,
    ),
  );
  const canvas = await openStudio(page, id);
  const hero = canvas.locator('.wp-block-post-content > .wp-block-group').first();

  await canvas.getByText('Bread baked fresh every morning').hover();
  const toolbar = page.getByRole('toolbar', { name: 'Section 1 of 1: Hero' });
  await toolbar.getByRole('button', { name: 'Ask AI about this section' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask AI about “Hero”' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Shorten' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(hero).toContainText('Come in, say hello and take something warm home.');
  await expect(hero).not.toContainText('We open early.');

  // Keep or Undo, over the canvas; Undo puts it back.
  const bar = page.getByRole('region', { name: 'Changes from AI' });
  await expect(bar).toContainText('Shortens the text in “Hero”.');
  await bar.getByRole('button', { name: 'Undo' }).click();
  await expect(hero).toContainText('We open early.');

  // Translate: kept, and in the draft.
  await canvas.getByText('Bread baked fresh every morning').hover();
  await toolbar.getByRole('button', { name: 'Ask AI about this section' }).click();
  await dialog.getByLabel('Language').fill('French');
  await dialog.getByRole('button', { name: 'Translate' }).click();
  await expect(hero.locator('h2')).toHaveText('Du pain frais, cuit chaque matin', {
    timeout: 30_000,
  });
  await bar.getByRole('button', { name: 'Keep' }).click();
  await expect(bar).toBeHidden();
  await expect
    .poll(async () => JSON.stringify(await draftEntries(page)), { timeout: 15_000 })
    .toContain('Du pain frais, cuit chaque matin');
});

test('Ask AI on selected text fixes its spelling', async ({ page }) => {
  await logInAsAdmin(page);
  await setAi(page, AI_ON);
  await discardDrafts(page);
  const id = await createPage(
    page,
    unique('Spelling bakery'),
    section('Intro', `${heading('Hello')}\n\n${paragraph('Fresh bread evry mornig, all year.')}`),
  );
  const canvas = await openStudio(page, id);
  const text = canvas.getByText('Fresh bread evry mornig, all year.');
  // Select the words "evry mornig" (12 characters in, 11 long).
  await text.click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 11; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.getByRole('button', { name: 'Ask AI about this text' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask AI about this text' });
  await expect(dialog.locator('blockquote')).toHaveText('evry mornig');
  await dialog.getByRole('button', { name: 'Fix spelling' }).click();
  await expect(canvas.getByText('Fresh bread every morning, all year.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('region', { name: 'Changes from AI' })).toContainText(
    'Fixes the spelling in “Intro”.',
  );
});

test('a prompt adds a section, and another makes a new page, each with Keep and Undo', async ({
  page,
}) => {
  await logInAsAdmin(page);
  await setAi(page, AI_ON);
  await discardDrafts(page);
  const id = await createPage(
    page,
    unique('Prompt bakery'),
    section('Hero', `${heading('Our bakery')}\n\n${paragraph('Warm bread.')}`),
  );
  const canvas = await openStudio(page, id);
  const sections = canvas.locator('.wp-block-post-content > *');
  await expect(sections).toHaveCount(1);

  // From the command palette: a section from a prompt.
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox').fill('Add a section with AI');
  await palette.getByRole('option', { name: /Add a section with AI/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a section with AI' });
  await dialog.getByLabel('What should the section be?').fill('Pricing with three tiers');
  await dialog.getByRole('button', { name: 'Add the section' }).click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(sections).toHaveCount(2);
  const bar = page.getByRole('region', { name: 'Changes from AI' });
  await expect(bar).toContainText('Adds a section: Pricing, three plans.');
  // Prices nobody gave are gaps, marked on the canvas.
  await expect(sections.last()).toContainText('[Add');
  await bar.getByRole('button', { name: 'Keep' }).click();
  await expect
    .poll(async () => JSON.stringify((await draftEntries(page))[`page:${id}`] ?? null), {
      timeout: 15_000,
    })
    .toContain('pressbase/pricing');

  // A new page from a prompt: it opens, waiting for Keep or Undo; Undo takes it away.
  await page.keyboard.press('ControlOrMeta+k');
  await palette.getByRole('combobox').fill('New page with AI');
  await palette.getByRole('option', { name: /New page with AI/ }).click();
  const pageDialog = page.getByRole('dialog', { name: 'New page with AI' });
  await pageDialog
    .getByLabel('What’s the page for?')
    .fill('Catering with services and a call to action');
  await pageDialog.getByRole('button', { name: 'Create the page' }).click();
  await expect(pageDialog).toBeHidden({ timeout: 60_000 });
  await expect(page.getByLabel('Page', { exact: true })).toHaveValue('new:catering', {
    timeout: 30_000,
  });
  await expect(bar).toContainText('Adds a new page, “Catering”');
  await expect
    .poll(async () => Object.keys(await draftEntries(page)), { timeout: 15_000 })
    .toContain('page:catering');
  await bar.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => Object.keys(await draftEntries(page)), { timeout: 15_000 })
    .not.toContain('page:catering');
  await expect(page.getByLabel('Page', { exact: true })).not.toHaveValue('new:catering');
});
