import { expect, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * A plugin's block on the real stack (ADR 0020): Daily Tips registers
 * `daily-tips/tip` with a server render and an editor module. It's inserted
 * from the inserter, published and shown on the public site; once the plugin
 * is deactivated it's gone from the page, and the editor keeps it with a notice.
 */

const WEB_URL = `http://localhost:${process.env.E2E_WEB_PORT ?? 3001}`;
const headers = { 'x-pressbase-request': '1' };

test('a plugin block is inserted, published, shown on the site, and gone when the plugin is deactivated', async ({
  page,
}) => {
  await logInAsAdmin(page);
  await page.goto('/admin/plugins');
  const tips = page.getByRole('listitem').filter({ hasText: 'Daily Tips' });
  await tips.getByRole('button', { name: 'Activate Daily Tips' }).click();
  await expect(page.getByText('Daily Tips is active.')).toBeVisible();

  try {
    await page.goto('/admin/posts/new');
    const canvas = page.frameLocator('iframe[name="editor-canvas"]');
    const titleField = canvas.getByLabel('Add title');
    await expect(titleField).toBeVisible({ timeout: 30_000 });
    const title = unique('Advice for new writers');
    await titleField.fill(title);

    // The block is in the inserter, under Widgets, and previews the server's rendering.
    await page.getByRole('button', { name: 'Add block' }).click();
    await page.getByRole('searchbox').fill('Daily tip');
    await page.getByRole('option', { name: 'Daily tip' }).click();
    const block = canvas.getByRole('document', { name: /Block: Daily tip/ });
    await expect(block).toBeVisible();
    await expect(block.getByText('Tip of the day')).toBeVisible({ timeout: 15_000 });

    // Its editor module adds a colour setting to the Block tab.
    await expect(page.getByLabel('Accent colour')).toBeVisible();

    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Post published.')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/posts\/\d+$/);
    const id = Number(new URL(page.url()).pathname.split('/').pop());
    const post = await (await page.request.get(`/wp-json/wp/v2/posts/${id}?context=edit`)).json();
    expect(post.content.raw).toContain('<!-- wp:daily-tips/tip /-->');
    const publicUrl = post.link.replace(/^https?:\/\/[^/]+/, WEB_URL);

    // On the public site, with its stylesheet (only on pages that show it).
    const shown = await (await page.request.get(publicUrl)).text();
    expect(shown).toContain('class="wp-block-daily-tips-tip"');
    expect(shown).toContain('Tip of the day');
    expect(shown).toMatch(/\/wp-content\/plugins\/daily-tips\/tip\.css\?ver=/);

    // Deactivated: gone from the public page (the cache is purged)…
    await page.goto('/admin/plugins');
    await tips.getByRole('button', { name: 'Deactivate Daily Tips' }).click();
    await expect(page.getByText('Daily Tips is deactivated.')).toBeVisible();
    const gone = await (await page.request.get(publicUrl)).text();
    expect(gone).toContain(title);
    expect(gone).not.toContain('wp-block-daily-tips-tip');
    expect(gone).not.toContain('tip.css');

    // …while the editor keeps the block, with a notice, and its markup is unchanged.
    await page.goto(`/admin/posts/${id}`);
    await expect(canvas.getByLabel('Add title')).toBeVisible({ timeout: 30_000 });
    await expect(canvas.getByText('This block’s plugin is inactive')).toBeVisible();
    await expect(
      canvas.getByText(/“daily-tips\/tip” comes from a plugin that isn’t active/),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Block markup' })).toHaveValue(
      /<!-- wp:daily-tips\/tip \/-->/,
    );
  } finally {
    await page.request.put('/wp-json/wp/v2/plugins/daily-tips', {
      headers,
      data: { status: 'inactive' },
    });
  }
});
