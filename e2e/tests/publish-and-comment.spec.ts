import { expect, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

test('writes a post in the block editor, publishes it, and a visitor’s comment is moderated', async ({
  page,
  browser,
}) => {
  const title = unique('A walk by the river');
  const body = 'The heron stood perfectly still, then struck.';
  const comment = unique('Lovely piece, thank you');

  // Write and publish.
  await logInAsAdmin(page);
  await page.goto('/admin/posts/new');
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  const titleField = canvas.getByLabel('Add title');
  await expect(titleField).toBeVisible({ timeout: 30_000 });
  await titleField.fill(title);
  await titleField.press('Enter');
  await page.keyboard.type(body);
  await expect(canvas.getByRole('document', { name: /Block: Paragraph/ })).toContainText(body);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Post published.')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/posts\/\d+$/);

  // A visitor finds it on the public site, served from the same address as the admin.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto('/');
  await visitor.getByRole('link', { name: title }).first().click();
  await expect(visitor.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  // The post's own content: the theme also lists the latest posts, with excerpts.
  await expect(visitor.locator('.wp-block-post-content').getByText(body)).toBeVisible();
  const permalink = visitor.url();

  // Their first comment is held for moderation; they see a preview, nobody else does.
  await visitor.getByLabel('Comment').fill(comment);
  await visitor.getByLabel('Name').fill('Rosa Visitor');
  await visitor.getByLabel('Email').fill('rosa@example.com');
  await visitor.getByRole('button', { name: 'Post Comment' }).click();
  await expect(visitor.getByText('Your comment is awaiting moderation.')).toBeVisible();
  await expect(visitor.getByText(comment)).toBeVisible();

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await other.goto(permalink);
  await expect(other.locator('.wp-block-post-content').getByText(body)).toBeVisible();
  await expect(other.getByText(comment)).toHaveCount(0);

  // The administrator approves it.
  await page.goto('/admin/comments?comment_status=moderated');
  const row = page.getByRole('row').filter({ hasText: comment });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /^Approve:/ }).click();

  // Now everyone sees it.
  await expect
    .poll(async () => {
      await other.reload();
      return other.getByText(comment).count();
    })
    .toBe(1);
  await expect(other.getByText('Rosa Visitor')).toBeVisible();

  await visitorContext.close();
  await otherContext.close();
});
