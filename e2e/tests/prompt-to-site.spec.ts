import { expect, type Page, test } from '@playwright/test';
import { logInAsAdmin } from './helpers';

/**
 * Prompt to site (#60): from a description to a published site, through
 * the guided flow's seven steps, with Back, a reload while it builds, and
 * Review in Studio, then Publish. The AI is the recorded provider
 * (`PRESSBASE_AI_TEST_PROVIDER=recorded`, set in playwright.config.ts):
 * no request leaves the machine.
 *
 * It builds and publishes a whole site (home page, menu, styles), so it
 * runs after every other test, in its own project.
 */

const writeHeaders = { 'x-pressbase-request': '1' };

async function discardDrafts(page: Page) {
  const res = await page.request.get('/wp-json/pressbase/v1/changesets');
  for (const { uuid } of (await res.json()) as { uuid: string }[]) {
    await page.request.delete(`/wp-json/pressbase/v1/changesets/${uuid}`, {
      headers: writeHeaders,
    });
  }
}

async function setAi(page: Page, enabled: boolean) {
  const res = await page.request.post('/wp-json/pressbase/v1/ai/settings', {
    headers: writeHeaders,
    data: enabled
      ? { enabled: true, provider: 'recorded', api_key: 'recorded-e2e-not-a-key', daily_limit: 200 }
      : { enabled: false },
  });
  expect(res.status()).toBe(200);
}

test('builds a site from a description, then publishes it from Studio', async ({ page }) => {
  test.setTimeout(240_000);
  const outgoing: string[] = [];
  page.on('request', (request) => {
    // Blob and data URLs are the editor's own; anything on the network but this site is not.
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://localhost')) {
      outgoing.push(request.url());
    }
  });
  await logInAsAdmin(page);
  await discardDrafts(page);

  // With AI off, Studio's AI panel says where to turn it on.
  await setAi(page, false);
  await page.goto('/admin/studio');
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const panel = page.locator('#studio-panel');
  await expect(panel.getByRole('link', { name: 'Turn on AI in Settings → AI' })).toBeVisible();

  // With AI on, it offers to build the site.
  await setAi(page, true);
  await page.reload();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await panel.getByRole('link', { name: 'Build my site' }).click();
  await expect(page).toHaveURL(/\/admin\/studio\/build$/);

  // 1. Describe: the description is needed.
  await expect(page.getByRole('heading', { name: 'What’s your site for?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Tell us a little about the site first')).toBeVisible();
  await expect(page.getByLabel('Describe your site')).toBeFocused();
  await page
    .getByLabel('Describe your site')
    .fill('A neighbourhood bakery selling sourdough, pastries and coffee.');
  await page.getByText('Add your details (optional)').click();
  await page.getByLabel('Business or site name').fill('Crumb & Co');
  await page.getByLabel('Phone').fill('0113 496 0000');
  await page.getByRole('button', { name: 'Continue' }).click();

  // 2. Questions: at most three; Back keeps what was typed, and asks nothing again.
  await expect(page.getByRole('heading', { name: 'A few quick questions' })).toBeVisible();
  const questions = page.locator('main textarea');
  await expect(questions).toHaveCount(3);
  await page.getByLabel('What are you best known for?').fill('Our rye sourdough.');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByLabel('Describe your site')).toHaveValue(/neighbourhood bakery/);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('What are you best known for?')).toHaveValue('Our rye sourdough.');
  await page.getByRole('button', { name: 'Continue' }).click();

  // 3. The brief, editable: facts are the person's own.
  await expect(page.getByRole('heading', { name: 'Is this right?' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue('Crumb & Co');
  const facts = page.getByLabel('Facts the site can state');
  await expect(facts).toHaveValue(/Phone: 0113 496 0000/);
  await facts.fill(`${await facts.inputValue()}\nOpen Tuesday to Saturday, 7am to 3pm`);
  await page.getByRole('button', { name: 'Continue' }).click();

  // 4. A look: three live previews, three more on request, then adjust.
  await expect(page.getByRole('heading', { name: 'Choose a look' })).toBeVisible();
  const looks = page.locator('input[name="design"]');
  await expect(looks).toHaveCount(3);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Choose a look first.')).toBeVisible();
  await page.getByRole('button', { name: 'Show three more' }).click();
  await expect(looks).toHaveCount(6);
  await expect(looks.nth(3)).toBeFocused();
  await page.getByText('Bold and playful').click();
  await expect(looks.nth(3)).toBeChecked();
  await page.getByLabel('Corners').selectOption('square');
  await expect(page.getByText('Adjusted')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // 5. Pages: remove one, move one with the keyboard way, add one.
  await expect(page.getByRole('heading', { name: 'Choose your pages' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Our bakes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Our bakes removed.' })).toBeAttached();
  await page.getByRole('button', { name: 'Move Visit up' }).click();
  await expect(page.locator('[data-page-title]').nth(1)).toHaveValue('Visit');
  await page.getByLabel('Add a page').fill('Gallery');
  await page.getByRole('button', { name: 'Add page' }).click();
  await expect(page.locator('[data-page-title]')).toHaveCount(4);
  await page.getByRole('button', { name: 'Build my site' }).click();

  // 6. Build: closing the tab (here, a reload) loses nothing.
  await expect(page).toHaveURL(/\?run=\d+/);
  await page.reload();
  // 7. Review.
  await expect(page.getByRole('heading', { name: 'Your site is ready to review' })).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText('4 pages built', { exact: true })).toBeVisible();
  await expect(page.getByText(/\d+ things? to fill in before you publish/)).toBeVisible();
  await expect(
    page.getByText(/Building it used \d+ AI requests?, about [\d,]+ tokens/),
  ).toBeVisible();
  for (const title of ['Home', 'Visit', 'About us', 'Gallery']) {
    await expect(page.getByRole('link', { name: `Preview ${title}` })).toBeVisible();
  }

  // Studio opens on the draft's home page, with what's left to fill in.
  await page.getByRole('link', { name: 'Review in Studio' }).click();
  await expect(page).toHaveURL(/\/admin\/studio/);
  const note = page.locator('[data-site-builder-note]');
  await expect(note).toContainText('things to fill in before you publish');
  await expect(page.getByLabel('Page', { exact: true })).toHaveValue('new:home');
  await note.getByRole('button', { name: /^Visit \(\d+\)$/ }).click();
  await expect(page.getByLabel('Page', { exact: true })).toHaveValue('new:visit');

  // Publish: the site goes live.
  await page.getByRole('button', { name: /^Publish, \d+ changes?$/ }).click();
  await page.getByRole('button', { name: /^Publish \d+ changes?$/ }).click();
  await expect(page.getByText('Published. Your changes are live.')).toBeVisible();

  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Bread baked fresh every morning' }).first(),
  ).toBeVisible();
  const menu = page.getByRole('navigation').first();
  for (const title of ['Visit', 'About us', 'Gallery']) {
    await expect(menu.getByRole('link', { name: title, exact: true })).toBeVisible();
  }
  await page.goto('/visit/');
  // Opening hours the person didn't give are a gap, not invented.
  await expect(page.getByText('[Add', { exact: false }).first()).toBeVisible();

  expect(outgoing).toEqual([]);
});
