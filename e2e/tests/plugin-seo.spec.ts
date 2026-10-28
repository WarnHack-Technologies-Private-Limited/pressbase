import { expect, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * Pressbase SEO (plugins/pressbase-seo), the first first-party plugin, on the
 * real stack: activation, the editor's SEO tab with a live search preview,
 * the public <head>, a redirect from Tools → SEO, and the posts-list column.
 */

const WEB_URL = `http://localhost:${process.env.E2E_WEB_PORT ?? 3001}`;

test('Pressbase SEO: edit the SEO tab, publish, see the head tags, redirect, see the column', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await logInAsAdmin(page);
  await page.goto('/admin/plugins');
  const seo = page.getByRole('listitem').filter({ hasText: 'Pressbase SEO' });
  await seo.getByRole('button', { name: 'Activate Pressbase SEO' }).click();
  await page.getByRole('button', { name: 'Allow and activate' }).click();
  await expect(page.getByText('Pressbase SEO is active.')).toBeVisible();

  // The SEO tab follows the post as it's written.
  await page.goto('/admin/posts/new');
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  const titleField = canvas.getByLabel('Add title');
  await expect(titleField).toBeVisible({ timeout: 30_000 });
  const title = unique('Brewing green tea');
  await titleField.fill(title);
  await titleField.press('Enter');
  await page.keyboard.type('Green tea likes water below boiling. Steep it for two minutes.');

  await page.getByRole('tab', { name: 'SEO' }).click();
  const panel = page.getByRole('tabpanel', { name: 'SEO' });
  const previewTitle = panel.locator('[data-seo-preview-title]');
  await expect(previewTitle).toContainText(title);
  await panel.getByLabel('SEO title').fill('%%title%% guide %%sep%% %%sitename%%');
  await expect(previewTitle).toContainText(`${title} guide -`);
  const description = 'How hot, how long and how much: green tea brewed calmly at home.';
  await panel.getByLabel('Meta description').fill(description);
  await expect(panel.locator('[data-seo-preview-description]')).toHaveText(description);
  await panel.getByLabel('Focus keyphrase').fill('green tea');
  await expect(panel.locator('[data-seo-check="keyphrase-title"]')).toHaveAttribute(
    'data-status',
    'good',
  );
  await panel.getByRole('button', { name: 'Mobile' }).click();
  await expect(panel.locator('[data-seo-preview="mobile"]')).toBeVisible();
  await expect(panel.locator('[data-seo-image-note]')).toHaveText(
    'No image: add a featured image or choose one here.',
  );

  // Publishing shows the SEO item in "Ready to publish?", which never blocks.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const ready = page.getByRole('dialog', { name: 'Ready to publish?' });
  await expect(
    ready.getByText('You can publish now and improve these later in the SEO tab.'),
  ).toBeAttached();
  await ready.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Post published.')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/posts\/\d+$/);
  const id = Number(/\/admin\/posts\/(\d+)$/.exec(page.url())?.[1]);
  const post = (await (await page.request.get(`/wp-json/wp/v2/posts/${id}`)).json()) as {
    link: string;
  };
  const path = new URL(post.link).pathname;

  // The public page's <head>.
  const html = await (await page.request.get(`${WEB_URL}${path}`)).text();
  expect(html).toContain(`<title>${title} guide - `);
  expect(html).toContain(`<meta name="description" content="${description}" />`);
  expect(html).toContain(`<meta property="og:title" content="${title} guide - `);
  expect(html).toMatch(/<link rel="canonical" href="[^"]+" \/>/);
  expect(html).toContain('"@type":"Article"');

  // Tools → SEO: add a redirect, then follow it.
  await page.goto('/admin/tools/pressbase-seo/seo-tools');
  const form = page.locator('[data-seo-redirect-form]');
  const from = `/${unique('old-tea')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')}/`;
  await form.getByLabel('From').fill(from);
  await form.getByLabel('To').fill(path);
  await form.getByRole('button', { name: 'Add redirect' }).click();
  await expect(page.getByText('Redirect added.')).toBeVisible();
  await expect(page.locator('[data-seo-redirects]')).toContainText(from.replace(/\/$/, ''));
  const redirect = await page.request.get(`${WEB_URL}${from}`, { maxRedirects: 0 });
  expect(redirect.status()).toBe(301);
  expect(redirect.headers().location).toContain(path);

  // The posts list: the SEO column, and the "Missing description" filter.
  await page.goto('/admin/posts');
  await expect(page.getByRole('columnheader', { name: 'SEO' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row.locator('[data-seo-column]')).toHaveText('Description set');
  await page.getByRole('combobox', { name: 'All descriptions' }).selectOption('missing');
  await expect(page).toHaveURL(/pressbase-seo-description=missing/);
  await expect(page.getByRole('row').filter({ hasText: title })).toHaveCount(0);

  // Settings → SEO opens with the first-run questions.
  await page.goto('/admin/settings/pressbase-seo');
  await expect(page.getByRole('heading', { name: 'Set up SEO' })).toBeVisible();

  // Leave the site as the other specs expect it: without the plugin's publish step.
  await page.goto('/admin/plugins');
  const seoPlugin = page.getByRole('listitem').filter({ hasText: 'Pressbase SEO' });
  await seoPlugin.getByRole('button', { name: 'Deactivate Pressbase SEO' }).click();
  await expect(page.getByText('Pressbase SEO is deactivated.')).toBeVisible();
});
