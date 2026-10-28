import { expect, type Page, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/** The bits of window.pressbase this test uses to register fills at runtime. */
interface Host {
  element: { createElement: (...args: unknown[]) => unknown };
  registerPlugin: (name: string, settings: { render: () => unknown }) => void;
  [fill: string]: unknown;
}

/** Registers a plugin from the page, as a module would (it lasts until the next page load). */
async function registerFills(page: Page, fills: [string, Record<string, unknown>, string?][]) {
  await page.waitForFunction(() => 'pressbase' in globalThis);
  await page.evaluate((list) => {
    const host = (globalThis as unknown as { pressbase: Host }).pressbase;
    const h = host.element.createElement;
    host.registerPlugin('e2e-fills', {
      render: () =>
        h(
          'div',
          null,
          ...list.map(([component, props, child]) => {
            const extra: Record<string, unknown> = {};
            // Functions can't cross into the page, so they're described here.
            if (props.query === 'author') extra.query = () => ({ author: 999999 });
            if (props.href === 'id') extra.href = (post: { id: number }) => `#post-${post.id}`;
            return h(host[component], { ...props, ...extra }, child);
          }),
        ),
    });
  }, fills);
}

test('a plugin’s editor sidebar follows the post as it’s written, and its column shows in the posts list', async ({
  page,
}) => {
  await logInAsAdmin(page);
  await page.goto('/admin/plugins');
  const tips = page.getByRole('listitem').filter({ hasText: 'Daily Tips' });
  await tips.getByRole('button', { name: 'Activate Daily Tips' }).click();
  await expect(page.getByText('Daily Tips is active.')).toBeVisible();

  // The Writing sidebar is a tab beside Post and Block.
  await page.goto('/admin/posts/new');
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  const titleField = canvas.getByLabel('Add title');
  await expect(titleField).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Writing' }).click();
  const sidebar = page.getByRole('tabpanel', { name: 'Writing' });
  await expect(sidebar.getByRole('heading', { name: 'Writing' })).toBeVisible();
  await expect(sidebar.locator('[data-daily-tips-title]')).toHaveText('0 characters');

  // It reads the title and content live, as they're typed.
  const title = unique('Notes from the allotment');
  await titleField.fill(title);
  await expect(sidebar.locator('[data-daily-tips-title]')).toHaveText(`${title.length} characters`);
  await titleField.press('Enter');
  await page.keyboard.type('Water the beans early. Then mulch the rows.');
  // Selecting a block doesn't leave a plugin's tab.
  await expect(sidebar.locator('[data-daily-tips-words]')).toHaveText('8');

  // Its edit (editPost) is an unsaved change and saves with the post.
  await sidebar.getByRole('button', { name: 'Use the first sentence as the excerpt' }).click();
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Post' }).click();
  await expect(page.getByLabel('Excerpt', { exact: true })).toHaveValue('Water the beans early.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved.')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/posts\/\d+$/);

  await page.reload();
  await expect(page.getByLabel('Excerpt', { exact: true })).toHaveValue('Water the beans early.');
  await expect(canvas.getByLabel('Add title')).toBeVisible({ timeout: 30_000 });

  // The top-bar button opens the sidebar on the plugin's tab.
  await page.getByRole('button', { name: 'Writing', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Writing' })).toHaveAttribute('aria-selected', 'true');
  await expect(sidebar.locator('[data-daily-tips-words]')).toHaveText('8');

  // A pre-publish panel shows before publishing, and never blocks it.
  await registerFills(page, [
    ['PluginPrePublishPanel', { title: 'Final checks' }, 'Nothing here blocks publishing.'],
  ]);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const ready = page.getByRole('dialog', { name: 'Ready to publish?' });
  await expect(ready.getByText('Nothing here blocks publishing.')).toBeVisible();
  await ready.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Post published.')).toBeVisible();

  // The Words column in the posts list.
  await page.goto('/admin/posts');
  await expect(page.getByRole('columnheader', { name: 'Words' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row.getByRole('cell').last()).toHaveText('8');

  // Row actions and filters registered at runtime.
  await registerFills(page, [
    ['PostsListRowAction', { label: 'Copy link', href: 'id' }],
    [
      'PostsListFilter',
      {
        id: 'e2e-owner',
        label: 'Everyone',
        options: [{ value: 'nobody', label: 'Nobody' }],
        query: 'author',
      },
    ],
  ]);
  await expect(row.getByRole('link', { name: 'Copy link' })).toHaveAttribute('href', /^#post-\d+$/);
  await page.getByRole('combobox', { name: 'Everyone' }).selectOption('nobody');
  await expect(page).toHaveURL(/e2e-owner=nobody/);
  await expect(page.getByRole('heading', { name: 'No posts match' })).toBeVisible();

  // Deactivated: the column and the sidebar are gone.
  await page.goto('/admin/plugins');
  await tips.getByRole('button', { name: 'Deactivate Daily Tips' }).click();
  await expect(page.getByText('Daily Tips is deactivated.')).toBeVisible();
  await page.goto('/admin/posts');
  await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Words' })).toHaveCount(0);
});
