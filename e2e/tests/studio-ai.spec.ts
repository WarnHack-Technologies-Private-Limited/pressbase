import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * Studio's AI panel (#62) and AI edits (#57), with the recorded provider
 * (`PRESSBASE_AI_TEST_PROVIDER=recorded`, playwright.config.ts): no real
 * provider, no key. A set of several changes goes on the page as one step,
 * highlighted, and Undo takes it all back; "make the buttons rounder" and
 * "add an FAQ" are kept into the draft; a request that can't be done says
 * so; the daily cap shows once it's reached.
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

const HERO = `<!-- wp:group {"align":"full","layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull"><!-- wp:heading {"level":1} -->
<h1 class="wp-block-heading">Fresh bread, every morning</h1>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Sourdough, rye and croissants, baked in the night on Mill Street.</p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->`;

const ABOUT = `<!-- wp:group {"layout":{"type":"constrained"}} -->
<div class="wp-block-group"><!-- wp:heading -->
<h2 class="wp-block-heading">About the bakery</h2>
<!-- /wp:heading --></div>
<!-- /wp:group -->`;

async function ask(page: Page, text: string) {
  const panel = page.locator('#studio-panel');
  await panel.getByLabel('Ask AI for a change').fill(text);
  await panel.getByRole('button', { name: 'Ask', exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await logInAsAdmin(page);
  await setAi(page, { enabled: false });
  await discardDrafts(page);
  await page.close();
});

test('applies a set of AI changes as one step, highlighted, and undoes it all', async ({
  page,
}) => {
  await logInAsAdmin(page);
  await setAi(page, AI_ON);
  const id = await createPage(page, unique('AI bakery'), `${HERO}\n\n${ABOUT}`);
  await discardDrafts(page);
  const canvas = await openStudio(page, id);
  const content = canvas.locator('.wp-block-post-content');
  const sections = content.locator(':scope > .wp-block-group');
  const pageText = async () => ((await content.textContent()) ?? '').replace(/﻿/g, '');
  const original = await pageText();
  await expect(sections).toHaveCount(2);

  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const panel = page.locator('#studio-panel');
  await expect(panel.getByText('Ask for a change in your own words.')).toBeVisible();
  await ask(page, 'Tidy up this page');

  // The reply, and its changes on the page: a call to action first, the hero last and tinted.
  await expect(panel.getByText(/Done\. Puts a call to action first/)).toBeVisible({
    timeout: 30_000,
  });
  const proposal = panel.locator('[data-message]').last();
  await expect(proposal.getByRole('button', { name: 'Keep' })).toBeVisible();
  await expect(sections).toHaveCount(3);
  await expect(sections.first()).toContainText('Come and say hello');
  await expect(sections.last()).toContainText('Fresh bread, every morning');
  await expect(sections.last()).toHaveClass(/has-accent-soft-background-color/);
  // Highlighted in the canvas.
  await expect(canvas.locator('style#pressbase-ai-highlight')).toHaveCount(1);

  // One step in History, named after the set.
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(
    page.locator('#studio-panel').getByText(/Changes from AI: Puts a call to action first/),
  ).toBeVisible();
  // With the panel closed, Keep and Undo wait over the canvas.
  const bar = page.getByRole('region', { name: 'Changes from AI' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Undo' }).click();

  // Everything back as it was, the highlight gone.
  await expect(sections).toHaveCount(2);
  expect(await pageText()).toBe(original);
  await expect(sections.first()).not.toHaveClass(/has-accent-soft-background-color/);
  await expect(canvas.locator('style#pressbase-ai-highlight')).toHaveCount(0);
  await expect(bar).toBeHidden();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await expect(panel.locator('[data-message]').last().getByText('Undone')).toBeVisible();
});

test('makes the buttons rounder and adds an FAQ, says what it can’t do, and shows the daily cap', async ({
  page,
}) => {
  await logInAsAdmin(page);
  await setAi(page, AI_ON);
  const id = await createPage(page, unique('AI café'), HERO);
  await discardDrafts(page);
  const canvas = await openStudio(page, id);
  const sections = canvas.locator('.wp-block-post-content > .wp-block-group');
  await expect(sections).toHaveCount(1);

  // AI commands in the command palette.
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox').fill('Ask AI');
  await palette.getByRole('option', { name: /Ask AI for a change/ }).click();
  const panel = page.locator('#studio-panel');
  await expect(panel.getByLabel('Ask AI for a change')).toBeFocused();

  // A style change: kept into the draft as the site's styles.
  await ask(page, 'Make the buttons rounder');
  await expect(panel.getByText(/Gives every button fully rounded corners/).first()).toBeVisible({
    timeout: 30_000,
  });
  await panel.locator('[data-message]').last().getByRole('button', { name: 'Keep' }).click();
  await expect(panel.locator('[data-message]').last().getByText('Kept')).toBeVisible();
  await expect
    .poll(async () => JSON.stringify(await draftEntries(page)), { timeout: 15_000 })
    .toContain('var:preset|border-radius|full');

  // A new section: an FAQ at the end of the page.
  await ask(page, 'Add an FAQ to this page');
  await expect(panel.getByText(/Adds a questions and answers section/).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(sections).toHaveCount(2);
  await expect(sections.last()).toContainText('Questions people ask');
  await panel.locator('[data-message]').last().getByRole('button', { name: 'Keep' }).click();
  await expect
    .poll(async () => JSON.stringify((await draftEntries(page))[`page:${id}`] ?? null), {
      timeout: 15_000,
    })
    .toContain('Questions people ask');

  // Something it can't do: said plainly, nothing proposed, nothing published.
  await ask(page, 'Publish everything now');
  await expect(panel.getByText(/I can’t do that from here/)).toBeVisible({ timeout: 30_000 });
  await expect(
    panel.locator('[data-message]').last().getByRole('button', { name: 'Keep' }),
  ).toHaveCount(0);
  const live = await page.request.get(`/wp-json/wp/v2/pages/${id}?context=edit`);
  expect(((await live.json()) as { content: { raw: string } }).content.raw).not.toContain(
    'Questions people ask',
  );

  // The daily cap, once it's reached.
  await setAi(page, { ...AI_ON, api_key: undefined, daily_limit: 1 });
  await page.reload();
  await expect(canvas.locator('header.wp-block-template-part')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await expect(panel.getByText(/used all 1 of its AI requests for today/)).toBeVisible();
  await expect(panel.getByLabel('Ask AI for a change')).toHaveCount(0);
});
