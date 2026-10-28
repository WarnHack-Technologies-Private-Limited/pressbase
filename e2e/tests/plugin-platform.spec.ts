import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { logInAsAdmin, unique } from './helpers';

/**
 * The v0.7 server-side plugin API through a small test plugin, on the real
 * stack: registered meta in REST, a template_redirect redirect, a plugin file
 * at the site root, and core's rel_canonical removed by name. See
 * docs/architecture/plugins.md#meta-requests-head-output-the-cache-and-files-v07.
 */

const WEB_URL = `http://localhost:${process.env.E2E_WEB_PORT ?? 3001}`;
const SLUG = 'e2e-platform';

const PLUGIN = `
export default function register(api) {
  api.meta.registerPostMeta('post', '_e2e_seo_title', {
    type: 'string', single: true, showInRest: true, authCallback: () => true,
  });
  api.meta.registerPostMeta('post', '_e2e_locked', { type: 'string', single: true, showInRest: true });
  api.hooks.addAction('template_redirect', (request) => {
    if (request.path === '/e2e-old-address/') request.redirect('/e2e-new-address/', 301);
  });
  api.hooks.removeAction('wp_head', 'rel_canonical');
  api.hooks.addAction('wp_head', (out) => out.print('<meta name="e2e-platform" content="on" />'), 1);
  api.public.addFile('/e2e-llms.txt', () => '# E2E site');
}
`;

test('a plugin registers meta, redirects early, serves a root file and replaces head output', async ({
  page,
}) => {
  const dataDir = process.env.PRESSBASE_E2E_DATA_DIR;
  if (!dataDir) throw new Error('PRESSBASE_E2E_DATA_DIR is not set (see playwright.config.ts).');
  const dir = path.join(dataDir, 'plugins', SLUG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ name: SLUG, title: 'E2E Platform', version: '1.0.0', main: 'index.js' }),
  );
  writeFileSync(path.join(dir, 'index.js'), PLUGIN);

  await logInAsAdmin(page);
  const headers = { 'x-pressbase-request': '1' };
  const activated = await page.request.put(`/wp-json/wp/v2/plugins/${SLUG}`, {
    headers,
    data: { status: 'active' },
  });
  expect(activated.status()).toBe(200);

  try {
    // Registered meta, readable and writable through /wp/v2/posts.
    const title = unique('Platform post');
    const created = await page.request.post('/wp-json/wp/v2/posts', {
      headers,
      data: { title, status: 'publish', meta: { _e2e_seo_title: 'Search title' } },
    });
    expect(created.status()).toBe(201);
    const post = await created.json();
    expect(post.meta).toEqual({ _e2e_seo_title: 'Search title', _e2e_locked: '' });
    const locked = await page.request.post(`/wp-json/wp/v2/posts/${post.id}`, {
      headers,
      data: { meta: { _e2e_locked: 'no' } },
    });
    expect(locked.status()).toBe(403);
    expect((await locked.json()).code).toBe('rest_cannot_update');

    // On the public site: the redirect, the root file and the head.
    const redirect = await page.request.get(`${WEB_URL}/e2e-old-address/`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(301);
    expect(redirect.headers().location).toBe('/e2e-new-address/');
    const file = await page.request.get(`${WEB_URL}/e2e-llms.txt`);
    expect(file.status()).toBe(200);
    expect(file.headers()['content-type']).toContain('text/plain');
    expect(await file.text()).toBe('# E2E site');
    const html = await (
      await page.request.get(post.link.replace(/^https?:\/\/[^/]+/, WEB_URL))
    ).text();
    expect(html).toContain('<meta name="e2e-platform" content="on" />');
    expect(html).not.toContain('rel="canonical"');
  } finally {
    await page.request.put(`/wp-json/wp/v2/plugins/${SLUG}`, {
      headers,
      data: { status: 'inactive' },
    });
  }
  expect((await page.request.get(`${WEB_URL}/e2e-llms.txt`)).status()).toBe(404);
});
