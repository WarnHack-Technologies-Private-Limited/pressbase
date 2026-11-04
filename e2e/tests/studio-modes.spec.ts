import { expect, type Page, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * Studio's Simple and Advanced modes (#32), the command palette (#33) and
 * the History panel (#34).
 */

const writeHeaders = { 'x-pressbase-request': '1' };
const MODE_META = 'pressbase_studio_mode';

const paragraphs = (...texts: string[]) =>
  texts.map((t) => `<!-- wp:paragraph -->\n<p>${t}</p>\n<!-- /wp:paragraph -->`).join('\n\n');

async function createPage(page: Page, title: string, content: string): Promise<number> {
  const res = await page.request.post('/wp-json/wp/v2/pages', {
    headers: writeHeaders,
    data: { title, status: 'publish', content },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as number;
}

/** No draft left over from other tests. */
async function discardDrafts(page: Page) {
  const open = await page.request.get('/wp-json/pressbase/v1/changesets');
  for (const { uuid } of (await open.json()) as { uuid: string }[]) {
    await page.request.delete(`/wp-json/pressbase/v1/changesets/${uuid}`, {
      headers: writeHeaders,
    });
  }
}

async function setMode(page: Page, mode: 'simple' | 'advanced') {
  const res = await page.request.post('/wp-json/wp/v2/users/me', {
    headers: writeHeaders,
    data: { meta: { [MODE_META]: mode } },
  });
  expect(res.status()).toBe(200);
}

async function openStudio(page: Page, id: number, text: string) {
  await page.goto(`/admin/studio?page=${id}`);
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  await expect(canvas.getByText(text)).toBeVisible({ timeout: 60_000 });
  return canvas;
}

test('Simple shows presets; Advanced adds borders and more, remembered per person (#32)', async ({
  page,
}) => {
  await logInAsAdmin(page);
  await discardDrafts(page);
  await setMode(page, 'simple');
  const id = await createPage(
    page,
    unique('Modes'),
    `<!-- wp:group {"layout":{"type":"constrained"}} -->\n<div class="wp-block-group">${paragraphs('Inside a group.')}</div>\n<!-- /wp:group -->`,
  );
  try {
    const canvas = await openStudio(page, id, 'Inside a group.');
    const settings = page.getByRole('complementary', { name: 'Settings' });
    const simple = settings.getByRole('button', { name: 'Simple', exact: true });
    const advanced = settings.getByRole('button', { name: 'Advanced', exact: true });
    await expect(simple).toHaveAttribute('aria-pressed', 'true');

    // The group: select the paragraph, then its parent from the breadcrumb.
    await canvas.getByText('Inside a group.').click();
    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('button', { name: /Group/ })
      .click();
    await settings.getByRole('tab', { name: 'Style' }).click();
    const panel = settings.getByRole('tabpanel');
    await expect(panel.getByText('Color', { exact: true }).first()).toBeVisible();
    await expect(panel.getByText('Borders', { exact: true })).toHaveCount(0);

    await advanced.click();
    await expect(advanced).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByText('Borders', { exact: true })).toBeVisible();
    // Saved for this person.
    await expect
      .poll(async () => {
        const me = await page.request.get('/wp-json/wp/v2/users/me?context=edit');
        return (await me.json()).meta[MODE_META];
      })
      .toBe('advanced');

    // Reopened, Studio remembers.
    await openStudio(page, id, 'Inside a group.');
    await expect(
      page
        .getByRole('complementary', { name: 'Settings' })
        .getByRole('button', { name: 'Advanced', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await setMode(page, 'simple');
    await page.request.delete(`/wp-json/wp/v2/pages/${id}?force=true`, { headers: writeHeaders });
  }
});

test('the command palette opens with Ctrl+K and goes to pages, devices, panels and sections (#33)', async ({
  page,
}) => {
  await logInAsAdmin(page);
  await discardDrafts(page);
  const first = unique('Palette start');
  const second = unique('Palette target');
  const id = await createPage(page, first, paragraphs('Where the palette starts.'));
  const other = await createPage(page, second, paragraphs('Where the palette goes.'));
  try {
    const canvas = await openStudio(page, id, 'Where the palette starts.');
    const search = page.getByRole('combobox', { name: 'Search commands' });

    // From the top bar's Find button, and back with Escape.
    const find = page.getByRole('button', { name: 'Find a page, section or action' });
    await find.click();
    await expect(search).toBeFocused();
    await expect(search).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(search).toBeHidden();
    await expect(find).toBeFocused();

    // Ctrl+K from inside the canvas, then a page by name.
    await canvas.getByText('Where the palette starts.').click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(search).toBeFocused();
    await page.keyboard.type(second);
    const listbox = page.getByRole('listbox', { name: 'Commands' });
    await expect(listbox.getByRole('option', { name: second })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(search).toHaveAttribute(
      'aria-activedescendant',
      (await listbox.getByRole('option', { name: second }).getAttribute('id')) ?? '',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByRole('combobox', { name: 'Page' })).toHaveValue(String(other));
    await expect(canvas.getByText('Where the palette goes.')).toBeVisible({ timeout: 60_000 });

    // A device, with the arrow keys.
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('device');
    await expect(listbox.getByRole('option')).toHaveCount(3);
    await page.keyboard.press('ArrowDown');
    await expect(listbox.getByRole('option', { name: 'Switch to Tablet view' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Tablet' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // A panel.
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('pages panel');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Pages', exact: true })).toBeVisible();

    // A section by name: added to the page, in the draft.
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('pricing');
    await expect(
      listbox.getByRole('option', { name: /^Add section: Pricing/ }).first(),
    ).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/^Section added: Pricing/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish, 1 change' })).toBeVisible();

    // Nothing matches: said plainly, and announced.
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('zzqx');
    await expect(page.getByText('Nothing matches “zzqx”. Try another word.')).toBeVisible();
    await page.keyboard.press('Escape');

    // Leave nothing behind: discard the draft (it asks first).
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('discard');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Discard all' }).click();
    await expect(page.getByText('Your changes were discarded.', { exact: false })).toBeVisible();
  } finally {
    await page.request.delete(`/wp-json/wp/v2/pages/${id}?force=true`, { headers: writeHeaders });
    await page.request.delete(`/wp-json/wp/v2/pages/${other}?force=true`, {
      headers: writeHeaders,
    });
  }
});

test('History names each step, steps back, and restores an older published version (#34)', async ({
  page,
}) => {
  await logInAsAdmin(page);
  await discardDrafts(page);
  const title = unique('Breakfast');
  const id = await createPage(page, title, paragraphs('Toast and jam.'));
  // Two more published versions: the oldest kept text is "Porridge with honey."
  for (const text of ['Porridge with honey.', 'Pancakes all day.']) {
    const res = await page.request.post(`/wp-json/wp/v2/pages/${id}`, {
      headers: writeHeaders,
      data: { content: paragraphs(text) },
    });
    expect(res.status()).toBe(200);
  }
  try {
    const canvas = await openStudio(page, id, 'Pancakes all day.');
    await canvas.getByText('Pancakes all day.').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Every day.');
    await expect(canvas.getByText('Pancakes all day. Every day.')).toBeVisible();

    await page.getByRole('button', { name: 'History' }).click();
    const history = page.getByRole('complementary', { name: 'History' });
    const steps = history.getByRole('region', { name: 'This session' });
    await expect(steps.getByRole('button', { name: 'Changed paragraph text (now)' })).toBeVisible();

    // Step back to the start: the text goes back, the step stays listed as undone.
    await steps.getByRole('button', { name: 'Go back to: Opened the page' }).click();
    await expect(canvas.getByText('Pancakes all day.', { exact: true })).toBeVisible();
    await expect(
      steps.getByRole('button', { name: 'Changed paragraph text (undone)' }),
    ).toBeVisible();
    // And forward again.
    await steps.getByRole('button', { name: 'Changed paragraph text (undone)' }).click();
    await expect(canvas.getByText('Pancakes all day. Every day.')).toBeVisible();

    // Published versions: the newest is live; restore the one with porridge.
    const versions = history.getByRole('region', { name: `Versions of ${title}` });
    await expect(versions.getByText('Live now')).toBeVisible();
    const rows = versions.getByRole('listitem');
    await expect(rows).toHaveCount(3);
    // Newest first: live, porridge, toast.
    await rows
      .nth(1)
      .getByRole('button', { name: /^Preview/ })
      .click();
    const preview = page.getByRole('dialog', { name: new RegExp(`^${title}, as published`) });
    await expect(preview).toBeVisible();
    await expect(preview.frameLocator('iframe').getByText('Porridge with honey.')).toBeVisible();
    await preview.getByRole('button', { name: 'Restore this version' }).click();
    await expect(page.getByText(/is on the page and in your draft/)).toBeVisible();
    await expect(canvas.getByText('Porridge with honey.')).toBeVisible();
    await expect(
      steps.getByRole('button', { name: /^Restored the version from .* \(now\)$/ }),
    ).toBeVisible();

    // It's a draft change until Publish.
    const live = await page.request.get(`/wp-json/wp/v2/pages/${id}?context=edit`);
    expect((await live.json()).content.raw).toContain('Pancakes all day.');
    await page.getByRole('button', { name: 'Publish, 1 change' }).click();
    await page.getByRole('button', { name: 'Publish 1 change' }).click();
    await expect(page.getByText('Published. Your changes are live.')).toBeVisible();
    const after = await page.request.get(`/wp-json/wp/v2/pages/${id}?context=edit`);
    const content = (await after.json()).content.raw as string;
    expect(content).toContain('Porridge with honey.');
    expect(content).not.toContain('Pancakes');
  } finally {
    await page.request.delete(`/wp-json/wp/v2/pages/${id}?force=true`, { headers: writeHeaders });
  }
});
