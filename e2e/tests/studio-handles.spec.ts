import { expect, type FrameLocator, type Locator, type Page, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * Handles on Studio's canvas (#37): a section's padding dragged and moved
 * with the keyboard, snapping to the theme's spacing presets in Simple and
 * taking pixels in Advanced, one undo step per drag, a Mobile-only value;
 * the gap between two columns, snapping to fractions; no animation under
 * prefers-reduced-motion.
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

async function setMode(page: Page, mode: 'simple' | 'advanced') {
  const res = await page.request.post('/wp-json/wp/v2/users/me', {
    headers: writeHeaders,
    data: { meta: { pressbase_studio_mode: mode } },
  });
  expect(res.ok()).toBe(true);
}

const CONTENT = [
  '<!-- wp:group {"metadata":{"name":"Hours"},"style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40"}}},"layout":{"type":"constrained"}} -->',
  '<div class="wp-block-group" style="padding-top:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40)"><!-- wp:paragraph -->',
  '<p>We open at eight</p>',
  '<!-- /wp:paragraph --></div>',
  '<!-- /wp:group -->',
  '',
  '<!-- wp:columns -->',
  '<div class="wp-block-columns"><!-- wp:column -->',
  '<div class="wp-block-column"><!-- wp:paragraph -->',
  '<p>Left column</p>',
  '<!-- /wp:paragraph --></div>',
  '<!-- /wp:column -->',
  '',
  '<!-- wp:column -->',
  '<div class="wp-block-column"><!-- wp:paragraph -->',
  '<p>Right column</p>',
  '<!-- /wp:paragraph --></div>',
  '<!-- /wp:column --></div>',
  '<!-- /wp:columns -->',
].join('\n');

async function openStudio(page: Page): Promise<{ id: number; canvas: FrameLocator }> {
  const res = await page.request.post('/wp-json/wp/v2/pages', {
    headers: writeHeaders,
    data: { title: unique('Hours page'), status: 'publish', content: CONTENT },
  });
  expect(res.status()).toBe(201);
  const id = (await res.json()).id as number;
  await page.goto(`/admin/studio?page=${id}`);
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  await expect(canvas.locator('header.wp-block-template-part')).toBeVisible({ timeout: 60_000 });
  return { id, canvas };
}

/** Drags a handle from its centre by (dx, dy), in steps, checking the label on the way. */
async function drag(page: Page, handle: Locator, dx: number, dy: number, label?: RegExp | string) {
  const box = await handle.boundingBox();
  if (!box) throw new Error('No handle');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  if (label) await expect(page.locator('[data-studio-handles]').getByText(label)).toBeVisible();
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await logInAsAdmin(page);
  await discardDrafts(page);
  await setMode(page, 'simple');
});

test.afterEach(async ({ page }) => {
  await discardDrafts(page);
  await setMode(page, 'simple');
});

test('padding handles snap to presets, take pixels in Advanced, and keep a Mobile value apart', async ({
  page,
}) => {
  const { id, canvas } = await openStudio(page);
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
  /** The paragraph, then its section from the breadcrumb (undo also brings back the selection). */
  const selectHours = async () => {
    await canvas.getByText('We open at eight', { exact: true }).click();
    await breadcrumb.getByRole('button', { name: 'Section: Hours' }).click();
  };
  await canvas.getByText('We open at eight', { exact: true }).click();
  // A paragraph alone gets no handles: they'd crowd its text.
  await expect(page.getByRole('slider', { name: 'Padding (top)' })).toHaveCount(0);
  await breadcrumb.getByRole('button', { name: 'Section: Hours' }).click();

  const top = page.getByRole('slider', { name: 'Padding (top)' });
  await expect(top).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Margin (top)' })).toBeVisible();
  await expect(top).toHaveAttribute('aria-valuetext', 'Small · 24px');

  // The keyboard: the next preset up.
  await top.focus();
  await page.keyboard.press('ArrowUp');
  await expect(top).toHaveAttribute('aria-valuetext', /^Regular · \d+px$/);
  await expect
    .poll(() => draftContent(page, id), { timeout: 15_000 })
    .toContain('"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|40"}');
  // Undo brings back the selection of that moment too: select the section again.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await selectHours();
  await expect(top).toHaveAttribute('aria-valuetext', 'Small · 24px');

  // A drag down grows the top padding to a larger preset, with the value shown while dragging.
  await drag(page, top, 0, 70, /^Padding \(top\): /);
  await expect(top).toHaveAttribute('aria-valuetext', /^(Large|X-Large|XX-Large) · \d+px$/);
  await expect
    .poll(() => draftContent(page, id), { timeout: 15_000 })
    .toMatch(/"padding":\{"top":"var:preset\|spacing\|(60|70|80)"/);
  // The whole drag is one step.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  // Back where the page started (the draft has nothing for it again).
  await expect
    .poll(() => draftContent(page, id), { timeout: 15_000 })
    .not.toMatch(/spacing\|(60|70|80)/);
  await selectHours();
  await expect(top).toHaveAttribute('aria-valuetext', 'Small · 24px');

  // Advanced: exact pixels, ten with Shift.
  const settings = page.getByRole('complementary', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Advanced', exact: true }).click();
  await top.focus();
  await page.keyboard.press('ArrowUp');
  await expect(top).toHaveAttribute('aria-valuetext', '25px');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(top).toHaveAttribute('aria-valuetext', '35px');
  await expect
    .poll(() => draftContent(page, id), { timeout: 15_000 })
    .toContain('"padding":{"top":"35px"');
  await settings.getByRole('button', { name: 'Simple', exact: true }).click();

  // Mobile: the value is the phone's own; Desktop keeps 35px.
  await page.getByRole('button', { name: 'Mobile', exact: true }).click();
  await selectHours();
  await top.focus();
  await page.keyboard.press('ArrowDown');
  await expect(top).toHaveAttribute('aria-valuetext', 'Small · 24px');
  await expect
    .poll(() => draftContent(page, id), { timeout: 15_000 })
    .toContain('"@mobile":{"spacing":{"padding":{"top":"var:preset|spacing|40"}}}');
  expect(await draftContent(page, id)).toContain('"padding":{"top":"35px"');
});

test('the gap between columns snaps to fractions, from the keyboard and by dragging; no animation with reduced motion', async ({
  page,
}) => {
  const { id, canvas } = await openStudio(page);
  await canvas.getByText('Left column', { exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('button', { name: 'Section: Columns' })
    .click();

  const gap = page.getByRole('separator', { name: 'Width of columns 1 and 2' });
  await expect(gap).toBeVisible();
  await expect(gap).toHaveAttribute('aria-valuetext', '1/2 · 1/2');

  await gap.focus();
  await page.keyboard.press('ArrowRight');
  await expect(gap).toHaveAttribute('aria-valuetext', '3/5 · 2/5');
  await expect
    .poll(() => draftContent(page, id), { timeout: 15_000 })
    .toContain('<!-- wp:column {"width":"60%"} -->');

  // Dragged to about a third: it snaps to 1/3 and 2/3.
  const row = await canvas.locator('.wp-block-columns', { hasText: 'Left column' }).boundingBox();
  if (!row) throw new Error('No columns');
  await drag(page, gap, -0.26 * row.width, 0, '1/3 · 2/3');
  await expect(gap).toHaveAttribute('aria-valuetext', '1/3 · 2/3');
  await expect
    .poll(() => draftContent(page, id), { timeout: 15_000 })
    .toContain('<!-- wp:column {"width":"33.33%"} -->');
  expect(await draftContent(page, id)).toContain('<!-- wp:column {"width":"66.67%"} -->');

  // prefers-reduced-motion: the handles don't animate.
  const duration = () => gap.evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(await duration()).not.toBe('0s');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await duration()).toBe('0s');
});
