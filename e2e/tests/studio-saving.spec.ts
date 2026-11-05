import {
  type APIRequestContext,
  expect,
  type FrameLocator,
  type Page,
  test,
} from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * Studio saves every edit to the user's draft (a changeset, #31) and edits
 * the header and footer in place (#30): Preview shows the draft, Publish
 * makes it live on every page, Discard all throws it away, and Reset to
 * theme brings back the theme's footer. Nothing reaches the live site
 * before Publish.
 */

const writeHeaders = { 'x-pressbase-request': '1' };

async function createPage(page: Page, title: string, text: string) {
  const res = await page.request.post('/wp-json/wp/v2/pages', {
    headers: writeHeaders,
    data: {
      title,
      status: 'publish',
      content: `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`,
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { id: body.id as number, path: new URL(body.link as string).pathname };
}

/** What visitors get at a path: `request` is Playwright's own client, without the login cookie. */
async function live(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.get(path);
  return res.text();
}

/** The draft's entries, as core stores them. */
async function draftEntries(page: Page): Promise<Record<string, { value: unknown }>> {
  const res = await page.request.get('/wp-json/pressbase/v1/changesets');
  const [open] = await res.json();
  return open?.entries ?? {};
}

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
  await discardDrafts(page);
  await page.goto(`/admin/studio?page=${id}`);
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  await expect(canvas.locator('header.wp-block-template-part')).toBeVisible({ timeout: 60_000 });
  return canvas;
}

async function typeAtEnd(page: Page, canvas: FrameLocator, text: string, typed: string) {
  await canvas.getByText(text, { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(typed);
}

async function publishAll(page: Page, count: number) {
  const label = count === 1 ? '1 change' : `${count} changes`;
  await page.getByRole('button', { name: `Publish, ${label}` }).click();
  await page.getByRole('button', { name: `Publish ${label}` }).click();
  // With things left on the checklist (#61), Publish asks first: say yes.
  const done = page.getByText('Published. Your changes are live.');
  const ask = page.getByRole('dialog', { name: /^Publish with \d+ things? left to fill in\?$/ });
  await expect(done.or(ask)).toBeVisible({ timeout: 30_000 });
  if (await ask.isVisible()) await ask.getByRole('button', { name: 'Publish anyway' }).click();
  await expect(done).toBeVisible();
}

test('edits are saved to a draft: previewed, then published, and kept when Studio reopens', async ({
  page,
  context,
  request,
}) => {
  await logInAsAdmin(page);
  const title = unique('Menu');
  const { id, path } = await createPage(page, title, 'Sourdough on Saturdays.');
  try {
    const canvas = await openStudio(page, id);
    await typeAtEnd(page, canvas, 'Sourdough on Saturdays.', ' Rye on Sundays.');
    await expect(page.getByText('Draft saved')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish, 1 change' })).toBeVisible();
    await expect.poll(() => draftEntries(page)).toHaveProperty(`page:${id}`);
    // Saved, but not live.
    expect(await live(request, path)).not.toContain('Rye on Sundays');

    // Reopening Studio picks up the draft.
    await page.reload();
    await expect(canvas.getByText('Sourdough on Saturdays. Rye on Sundays.')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('Your draft is back: 1 change isn’t published yet.')).toBeVisible();

    // Preview: the real page with the draft over it.
    const [preview] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: 'Preview (opens in a new tab)' }).click(),
    ]);
    await expect(preview).toHaveURL(/changeset_uuid=/);
    await expect(preview.getByText('Sourdough on Saturdays. Rye on Sundays.')).toBeVisible();
    await expect(preview.getByRole('link', { name: 'Back to Studio' })).toBeVisible();
    await preview.close();

    // The Publish list names the page; publishing makes it live.
    await page.getByRole('button', { name: 'Publish, 1 change' }).click();
    const panel = page.getByRole('dialog', { name: '1 change ready to publish' });
    await expect(panel).toContainText(title);
    await panel.getByRole('button', { name: 'Publish 1 change' }).click();
    await expect(page.getByText('Published. Your changes are live.')).toBeVisible();
    expect(await live(request, path)).toContain('Rye on Sundays');
    expect(await draftEntries(page)).toEqual({});
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  } finally {
    await page.request.delete(`/wp-json/wp/v2/pages/${id}?force=true`, { headers: writeHeaders });
  }
});

test('one change can be undone from the Publish list, and Discard all drops the rest', async ({
  page,
  request,
}) => {
  await logInAsAdmin(page);
  const first = await createPage(page, unique('Prices'), 'Loaves from four euros.');
  const second = await createPage(page, unique('Hours'), 'Open at seven.');
  try {
    let canvas = await openStudio(page, first.id);
    await typeAtEnd(page, canvas, 'Loaves from four euros.', ' Rolls from one.');
    await expect(page.getByText('Draft saved')).toBeVisible();

    // Another page: the first stays in the draft.
    await page.getByRole('combobox', { name: 'Page' }).selectOption(String(second.id));
    canvas = page.frameLocator('iframe[name="editor-canvas"]');
    await expect(canvas.getByText('Open at seven.')).toBeVisible({ timeout: 60_000 });
    await typeAtEnd(page, canvas, 'Open at seven.', ' Closed at two.');
    await expect(page.getByRole('button', { name: 'Publish, 2 changes' })).toBeVisible();

    // Undo one change from the list: the page on the canvas goes back.
    await page.getByRole('button', { name: 'Publish, 2 changes' }).click();
    const panel = page.getByRole('dialog', { name: '2 changes ready to publish' });
    await panel.getByRole('button', { name: /^Undo changes to Hours/ }).click();
    await expect(canvas.getByText('Open at seven.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish, 1 change' })).toBeVisible();
    await expect
      .poll(async () => Object.keys(await draftEntries(page)))
      .toEqual([`page:${first.id}`]);

    // Discard all (the list is still open) asks first, then empties the draft; the live site never changed.
    await page
      .getByRole('dialog', { name: '1 change ready to publish' })
      .getByRole('button', { name: 'Discard all' })
      .click();
    const confirm = page.getByRole('dialog', { name: 'Discard all your changes?' });
    await confirm.getByRole('button', { name: 'Discard all' }).click();
    await expect(page.getByText('Your changes were discarded.')).toBeVisible();
    expect(await draftEntries(page)).toEqual({});
    expect(await live(request, first.path)).not.toContain('Rolls from one');
    await page.getByRole('combobox', { name: 'Page' }).selectOption(String(first.id));
    await expect(canvas.getByText('Loaves from four euros.', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    for (const { id } of [first, second]) {
      await page.request.delete(`/wp-json/wp/v2/pages/${id}?force=true`, { headers: writeHeaders });
    }
  }
});

test('the footer is edited in place: every page shows it once published, and Reset to theme brings the theme’s back', async ({
  page,
  request,
}) => {
  await logInAsAdmin(page);
  const one = await createPage(page, unique('Story'), 'Since 1987.');
  const two = await createPage(page, unique('Visit'), 'Find us by the market.');
  const footerText = 'Set up a site in minutes. Bring your words, we will handle the rest.';
  try {
    const canvas = await openStudio(page, one.id);
    const footer = canvas.locator('footer.wp-block-template-part');
    await footer.getByText(footerText).click();
    // Before the first keystroke, Studio says the footer is on every page.
    await expect(page.getByText(/You’re editing the Footer\. It’s on every page/)).toBeVisible();
    await expect(footer).toHaveClass(/has-child-selected/);
    await page.keyboard.press('End');
    await page.keyboard.type(' Baked fresh daily.');
    await expect(page.getByRole('button', { name: 'Publish, 1 change' })).toBeVisible();
    await expect.poll(() => draftEntries(page)).toHaveProperty('wp_template_part:footer');
    expect(await live(request, two.path)).not.toContain('Baked fresh daily');

    await publishAll(page, 1);
    for (const path of [one.path, two.path, '/']) {
      expect(await live(request, path), path).toContain('Baked fresh daily');
    }

    // Select the whole footer: it's customised now, so it can go back to the theme's.
    await footer.hover({ position: { x: 300, y: 20 } });
    await canvas.locator('footer .pressbase-studio-part__label').click();
    const settings = page.getByRole('complementary', { name: 'Settings' });
    await expect(settings).toContainText('You’ve changed this from the theme’s design.');
    await settings.getByRole('button', { name: 'Reset to theme' }).click();
    await expect(footer.getByText(footerText, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish, 1 change' })).toBeVisible();
    await expect
      .poll(async () => (await draftEntries(page))['wp_template_part:footer']?.value)
      .toEqual({ source: 'theme' });

    await publishAll(page, 1);
    expect(await live(request, two.path)).not.toContain('Baked fresh daily');
    const part = await page.request.get('/wp-json/wp/v2/template-parts/pressbase//footer');
    expect((await part.json()).source).toBe('theme');
  } finally {
    for (const { id } of [one, two]) {
      await page.request.delete(`/wp-json/wp/v2/pages/${id}?force=true`, { headers: writeHeaders });
    }
  }
});
