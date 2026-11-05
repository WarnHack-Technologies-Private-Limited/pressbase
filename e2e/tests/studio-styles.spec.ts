import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { logInAsAdmin } from './helpers';

/**
 * Studio's Styles panel (#46) and style book (#47): the site's design
 * system edited in the draft and shown live on the canvas, per-block
 * styles, borders and Additional CSS in Advanced, and the style book, all
 * from the keyboard too. Nothing here is published: each test throws its
 * draft away.
 */

const writeHeaders = { 'x-pressbase-request': '1' };
const STYLES_KEY = 'wp_global_styles:pressbase';

type Entries = Record<string, { value: Record<string, unknown> }>;

async function draftEntries(page: Page): Promise<Entries> {
  const res = await page.request.get('/wp-json/pressbase/v1/changesets');
  const [open] = await res.json();
  return open?.entries ?? {};
}

async function discardDrafts(page: Page) {
  const res = await page.request.get('/wp-json/pressbase/v1/changesets');
  for (const { uuid } of (await res.json()) as { uuid: string }[]) {
    await page.request.delete(`/wp-json/pressbase/v1/changesets/${uuid}`, {
      headers: writeHeaders,
    });
  }
}

/** Studio on the home page; the header (with its button) is on the canvas. */
async function openStudio(page: Page): Promise<FrameLocator> {
  await page.goto('/admin/studio');
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  await expect(canvas.locator('header.wp-block-template-part')).toBeVisible({ timeout: 60_000 });
  return canvas;
}

async function setMode(page: Page, mode: 'simple' | 'advanced') {
  await page.request.post('/wp-json/wp/v2/users/me', {
    headers: writeHeaders,
    data: { meta: { pressbase_studio_mode: mode } },
  });
}

/** A colour variable on the canvas (computed values may keep a leading space). */
const ACCENT = '--wp--preset--color--accent';
const value = (css: string) => new RegExp(`^\\s*${css}\\s*$`, 'i');
const canvasRoot = (canvas: FrameLocator) => canvas.locator('.editor-styles-wrapper').first();
const headerButton = (canvas: FrameLocator) =>
  canvas.locator('header .wp-block-button__link').first();

/** The theme's palette with one colour changed, as the Colours screen stores it. */
async function paletteWith(page: Page, slug: string, color: string) {
  const res = await page.request.get('/wp-json/wp/v2/global-styles/themes/pressbase');
  const theme = await res.json();
  // Keyed by origin ({ theme: […] }) or a plain list.
  const palette = theme.settings.color.palette;
  const colors: { slug: string; color: string }[] = Array.isArray(palette)
    ? palette
    : palette.theme;
  return colors.map((c) => (c.slug === slug ? { ...c, color } : c));
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

test('changing the primary colour changes every use on the canvas, and goes into the draft', async ({
  page,
}) => {
  const canvas = await openStudio(page);
  await expect(canvasRoot(canvas)).toHaveCSS(ACCENT, value('#3b4cca'));
  await expect(headerButton(canvas)).toHaveCSS('background-color', 'rgb(59, 76, 202)');

  await page.getByRole('button', { name: 'Styles', exact: true }).click();
  await page.getByRole('button', { name: /^Colours/ }).click();
  await expect(page.getByRole('heading', { name: 'Colours', level: 3 })).toBeFocused();
  await page.getByLabel('Indigo colour', { exact: true }).fill('#b4232a');

  // The variable, and so every block that uses the colour: the header's button too.
  await expect(canvasRoot(canvas)).toHaveCSS(ACCENT, value('#b4232a'));
  await expect(headerButton(canvas)).toHaveCSS('background-color', 'rgb(180, 35, 42)');
  await expect
    .poll(async () => JSON.stringify((await draftEntries(page))[STYLES_KEY]?.value ?? null))
    .toContain('#b4232a');
  await expect(page.getByRole('button', { name: 'Publish, 1 change' })).toBeVisible();

  // Back to the theme's colour: the draft has nothing left to publish.
  await page.getByRole('button', { name: 'Back to Styles' }).click();
  await expect(page.getByRole('button', { name: /^Colours/ })).toBeFocused();
  await page.getByRole('button', { name: 'Use the theme’s styles' }).click();
  await expect(canvasRoot(canvas)).toHaveCSS(ACCENT, value('#3b4cca'));
  await expect.poll(async () => (await draftEntries(page))[STYLES_KEY]?.value ?? null).toBeNull();
});

test('a draft’s styles made elsewhere, such as by the site builder, show on the canvas', async ({
  page,
}) => {
  const palette = await paletteWith(page, 'accent', '#0f7b5a');
  const res = await page.request.post('/wp-json/pressbase/v1/changesets', {
    headers: writeHeaders,
    data: { entries: { [STYLES_KEY]: { settings: { color: { palette: { theme: palette } } } } } },
  });
  expect(res.status()).toBe(201);

  const canvas = await openStudio(page);
  await expect(canvasRoot(canvas)).toHaveCSS(ACCENT, value('#0f7b5a'));
  await expect(headerButton(canvas)).toHaveCSS('background-color', 'rgb(15, 123, 90)');
  // The panel starts from the draft's styles too.
  await page.getByRole('button', { name: 'Styles', exact: true }).click();
  await page.getByRole('button', { name: /^Colours/ }).click();
  await expect(page.getByLabel('Indigo colour', { exact: true })).toHaveValue('#0f7b5a');
});

test('Advanced adds borders and Additional CSS, which is checked before it reaches the draft', async ({
  page,
}) => {
  const canvas = await openStudio(page);
  await page.getByRole('button', { name: 'Styles', exact: true }).click();
  const panel = page.locator('#studio-panel');

  // Simple: the design system, and a way to Advanced.
  await expect(panel.getByRole('button', { name: /^Additional CSS/ })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Switch to Advanced' }).click();

  // The site's Additional CSS, on the canvas as it's typed.
  await panel.getByRole('button', { name: /^Additional CSS/ }).click();
  const css = panel.getByLabel('Additional CSS for the whole site');
  await css.fill('.wp-block-site-title { text-transform: uppercase; }');
  await expect(canvas.locator('.wp-block-site-title').first()).toHaveCSS(
    'text-transform',
    'uppercase',
  );
  await expect
    .poll(async () => (await draftEntries(page))[STYLES_KEY]?.value?.styles)
    .toMatchObject({ css: '.wp-block-site-title { text-transform: uppercase; }' });

  // CSS that could close the style element is refused, and the draft keeps the last good CSS.
  await css.fill('.note { color: red; } </style>');
  await expect(panel.getByRole('alert')).toContainText('Remove it to save your styles.');
  await expect(css).toHaveAttribute('aria-invalid', 'true');
  expect((await draftEntries(page))[STYLES_KEY]?.value?.styles).toMatchObject({
    css: '.wp-block-site-title { text-transform: uppercase; }',
  });
  await css.fill('');
  await expect(panel.getByRole('alert')).toHaveCount(0);

  // A block's border: Styles → Blocks → Quote.
  await panel.getByRole('button', { name: 'Back to Styles' }).click();
  await panel.getByRole('button', { name: /^Blocks/ }).click();
  await panel.getByPlaceholder('Search blocks').fill('quote');
  await panel.getByRole('button', { name: /^Quote/ }).click();
  await expect(panel.getByRole('heading', { name: 'Quote', level: 3 })).toBeFocused();
  await panel.getByRole('region', { name: 'Border' }).getByLabel('Width').fill('3');
  await expect
    .poll(async () => JSON.stringify((await draftEntries(page))[STYLES_KEY]?.value ?? null))
    .toContain('"core/quote":{"border":{"width":"3px"}}');
  await panel.getByRole('button', { name: 'Back to Blocks' }).click();
  await expect(panel.getByRole('button', { name: /^Quote.*Changed/ })).toBeVisible();
});

test('the style book shows every kind of block in the draft’s styles, and works from the keyboard', async ({
  page,
}) => {
  await openStudio(page);
  await page.getByRole('button', { name: 'Styles', exact: true }).click();
  const toggle = page.getByRole('button', { name: 'Open the style book' });
  await toggle.click();
  const book = page.locator('[data-style-book]');
  await expect(book.getByRole('heading', { name: 'Style book', level: 2 })).toBeFocused();
  for (const title of ['Colours', 'Text', 'Buttons and forms', 'Images and media', 'Layout']) {
    await expect(book.getByRole('heading', { name: title, level: 3 })).toBeVisible();
  }
  // The examples are drawn in the site's styles.
  await expect(book.locator('[data-example="core/quote"]')).toBeVisible();

  // Filter to Buttons and forms, then open the Button's styles from the keyboard.
  await book.getByRole('button', { name: 'Buttons and forms' }).click();
  await expect(book.getByRole('heading', { name: 'Text', level: 3 })).toHaveCount(0);
  const example = book.getByRole('button', { name: 'Buttons, change how it looks everywhere' });
  await example.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.locator('#studio-panel').getByRole('heading', { name: 'Button' }),
  ).toBeVisible();
  await expect(example).toHaveAttribute('aria-pressed', 'true');

  // Escape closes the book and returns to the page.
  await example.focus();
  await page.keyboard.press('Escape');
  await expect(book).toHaveCount(0);
  await expect(page.locator('iframe[name="editor-canvas"]')).toBeVisible();
});
