import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/** A small WXR file, as WordPress's Tools → Export writes it. */
function wxr(title: string, author: string) {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>Allotment Diary</title>
  <link>https://allotment.example</link>
  <wp:wxr_version>1.2</wp:wxr_version>
  <wp:base_site_url>https://allotment.example</wp:base_site_url>
  <wp:base_blog_url>https://allotment.example</wp:base_blog_url>
  <wp:author><wp:author_id>2</wp:author_id><wp:author_login><![CDATA[${author}]]></wp:author_login><wp:author_email><![CDATA[${author}@allotment.example]]></wp:author_email><wp:author_display_name><![CDATA[Priya Shah]]></wp:author_display_name></wp:author>
  <wp:category><wp:term_id>3</wp:term_id><wp:category_nicename><![CDATA[beans]]></wp:category_nicename><wp:category_parent><![CDATA[]]></wp:category_parent><wp:cat_name><![CDATA[Beans]]></wp:cat_name></wp:category>
  <item>
    <title>${title}</title>
    <dc:creator><![CDATA[${author}]]></dc:creator>
    <guid isPermaLink="false">https://allotment.example/?p=7</guid>
    <content:encoded><![CDATA[<!-- wp:paragraph --><p>Runner beans went in today.</p><!-- /wp:paragraph -->]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>7</wp:post_id>
    <wp:post_date><![CDATA[2024-05-02 09:00:00]]></wp:post_date>
    <wp:post_date_gmt><![CDATA[2024-05-02 08:00:00]]></wp:post_date_gmt>
    <wp:comment_status><![CDATA[open]]></wp:comment_status>
    <wp:ping_status><![CDATA[closed]]></wp:ping_status>
    <wp:post_name><![CDATA[runner-beans]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_parent>0</wp:post_parent>
    <wp:menu_order>0</wp:menu_order>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <wp:post_password><![CDATA[]]></wp:post_password>
    <wp:is_sticky>0</wp:is_sticky>
    <category domain="category" nicename="beans"><![CDATA[Beans]]></category>
  </item>
</channel>
</rss>`;
}

test('Tools → Import: upload, assign authors, import in the background, see the summary', async ({
  page,
}) => {
  await logInAsAdmin(page);
  await page.goto('/admin/tools');
  await page.getByRole('link', { name: /Import/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();

  // Nothing chosen: the error says what to do.
  await page.getByRole('button', { name: 'Upload file' }).click();
  await expect(page.getByText('Choose the .xml file you downloaded')).toBeVisible();

  const title = unique('Runner beans');
  const author = `priya${Date.now().toString(36)}`;
  await page.getByLabel('WordPress export file').setInputFiles({
    name: 'allotment.WordPress.xml',
    mimeType: 'application/xml',
    buffer: Buffer.from(wxr(title, author)),
  });
  await page.getByRole('button', { name: 'Upload file' }).click();
  await expect(page.getByText('Export file read.')).toBeVisible();

  await expect(page.getByText('Check what will be imported')).toBeFocused();
  await expect(page.getByText('1 post · 1 category or tag')).toBeVisible();
  const authorSelect = page.getByLabel('Posts by Priya Shah');
  await expect(authorSelect).toHaveValue('new');
  await expect(page.getByLabel('Download and import file attachments')).toBeChecked();
  await page.getByLabel('Download and import file attachments').uncheck();

  await page.getByRole('button', { name: 'Start import' }).click();
  await expect(page.getByText('Import started.')).toBeVisible();
  await expect(page.getByText('Import finished.')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible();
  const imported = page.getByRole('list', { name: 'Imported' });
  await expect(imported).toContainText('1 post');
  await expect(imported).toContainText('1 new user');

  await page.getByRole('link', { name: 'View posts' }).click();
  await expect(page.getByRole('link', { name: title }).first()).toBeVisible();
});

test('Tools → Export: choose pages and download a WXR file', async ({ page }) => {
  await logInAsAdmin(page);
  await page.goto('/admin/tools/export');
  await expect(page.getByRole('heading', { level: 1, name: 'Export' })).toBeVisible();
  await expect(page.getByLabel('All content', { exact: true })).toBeChecked();

  await page.getByLabel('Pages', { exact: true }).check();
  await expect(page.getByLabel('Status')).toBeVisible();
  await expect(page.getByLabel('Category')).toBeHidden();

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download export file' }).click();
  await expect(page.getByText('Your export file is downloading.')).toBeVisible();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.WordPress\.\d{4}-\d{2}-\d{2}\.xml$/);
  const xml = await readFile((await download.path()) as string, 'utf8');
  expect(xml).toContain('<wp:wxr_version>1.2</wp:wxr_version>');
  expect(xml).toContain('<wp:post_type><![CDATA[page]]></wp:post_type>');
  expect(xml).not.toContain('<wp:post_type><![CDATA[post]]></wp:post_type>');
});
