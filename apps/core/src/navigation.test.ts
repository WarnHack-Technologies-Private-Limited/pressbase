import { describe, expect, it } from 'vitest';
import { setup } from './test-utils';

/**
 * Navigation menus: the wp_navigation post type at /wp/v2/navigation, the
 * navigation fallback (WordPress's and Pressbase's chosen header menu), the
 * preview, and how core/navigation renders a menu in Twenty Twenty-Five.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

async function render(ctx: Ctx, url: string) {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { html: string }).html;
}

async function createPage(ctx: Ctx, title: string, extra: Record<string, unknown> = {}) {
  const res = await ctx.request('POST', '/wp/v2/pages', { title, status: 'publish', ...extra });
  expect(res.status).toBe(201);
  return res.body as { id: number; link: string };
}

async function createMenu(ctx: Ctx, title: string, content: string, status = 'publish') {
  const res = await ctx.request('POST', '/wp/v2/navigation', { title, content, status });
  expect(res.status).toBe(201);
  return res.body as { id: number };
}

const link = (attrs: Record<string, unknown>) =>
  `<!-- wp:navigation-link ${JSON.stringify(attrs)} /-->`;

/** The header's <nav> element. */
const headerNav = (html: string) =>
  /<header class="wp-block-template-part">[\s\S]*?(<nav[\s\S]*?<\/nav>)/.exec(html)?.[1] ?? '';

describe('/wp/v2/navigation', () => {
  it('is registered as WordPress registers it', async () => {
    const ctx = await site();
    const types = await ctx.request('GET', '/wp/v2/types?context=edit');
    expect(types.body.wp_navigation).toMatchObject({
      slug: 'wp_navigation',
      rest_base: 'navigation',
      rest_namespace: 'wp/v2',
      viewable: false,
      name: 'Navigation Menus',
      capabilities: { edit_posts: 'edit_theme_options', create_posts: 'edit_theme_options' },
    });
  });

  it('needs edit_theme_options to create, edit and delete menus', async () => {
    const ctx = await site();
    const menu = await createMenu(ctx, 'Main', link({ label: 'A', url: '/a/', kind: 'custom' }));
    const editor = await ctx.loginAs('ed', 'editor');
    expect((await editor.request('POST', '/wp/v2/navigation', { title: 'X' })).body.code).toBe(
      'rest_cannot_create',
    );
    expect(
      (await editor.request('POST', `/wp/v2/navigation/${menu.id}`, { title: 'Y' })).body.code,
    ).toBe('rest_cannot_edit');
    expect((await editor.request('DELETE', `/wp/v2/navigation/${menu.id}`)).status).toBe(403);
    expect((await editor.request('GET', '/wp/v2/navigation?context=edit')).body.code).toBe(
      'rest_forbidden_context',
    );

    // Published menus are public, as in WordPress; drafts are not.
    const draft = await createMenu(ctx, 'Draft', '', 'draft');
    const visitor = ctx.client();
    const list = await visitor.request('GET', '/wp/v2/navigation');
    expect(list.status).toBe(200);
    expect(list.body.map((m: { id: number }) => m.id)).toEqual([menu.id]);
    expect((await visitor.request('GET', `/wp/v2/navigation/${draft.id}`)).status).toBe(401);
    expect((await visitor.request('GET', '/wp/v2/navigation?status=draft')).status).toBe(401);

    // The administrator can do everything.
    const updated = await ctx.request('POST', `/wp/v2/navigation/${menu.id}`, { title: 'Primary' });
    expect(updated.body).toMatchObject({ title: { raw: 'Primary' }, type: 'wp_navigation' });
    expect(updated.body.link).toBe(`http://localhost:3000/?post_type=wp_navigation&p=${menu.id}`);
    expect(
      (await ctx.request('DELETE', `/wp/v2/navigation/${menu.id}?force=true`)).body,
    ).toMatchObject({ deleted: true });
  });

  it('answers OPTIONS with the methods the user may use (core-data’s canUser)', async () => {
    const ctx = await site();
    const menu = await createMenu(ctx, 'Main', '');
    const options = (path: string) => ctx.request('OPTIONS', path);
    expect((await options('/wp/v2/navigation')).headers.get('allow')).toBe('GET, POST');
    expect((await options(`/wp/v2/navigation/${menu.id}`)).headers.get('allow')).toBe(
      'GET, POST, PUT, PATCH, DELETE',
    );
    const author = await ctx.loginAs('writer', 'author');
    expect((await author.request('OPTIONS', '/wp/v2/navigation')).headers.get('allow')).toBe('GET');
    expect(
      (await author.request('OPTIONS', `/wp/v2/navigation/${menu.id}`)).headers.get('allow'),
    ).toBe('GET');
    // Edit-context responses carry the same hints.
    const item = await ctx.request('GET', `/wp/v2/navigation/${menu.id}?context=edit`);
    expect(item.headers.get('allow')).toBe('GET, POST, PUT, PATCH, DELETE');
    expect(item.body._links.self[0].targetHints.allow).toContain('DELETE');
  });

  it('saves through the posts service, so save_post and friends fire', async () => {
    const ctx = await site();
    const saved: string[] = [];
    ctx.kernel.hooks.addAction('save_post', (_id: unknown, post: unknown) => {
      saved.push((post as { type: string }).type);
    });
    const menu = await createMenu(ctx, 'Main', '');
    await ctx.request('POST', `/wp/v2/navigation/${menu.id}`, {
      content: '<!-- wp:page-list /-->',
    });
    expect(saved.filter((t) => t === 'wp_navigation')).toHaveLength(2);
    const revisions = await ctx.request('GET', `/wp/v2/navigation/${menu.id}/revisions`);
    expect(revisions.status).toBe(200);
  });
});

describe('navigation fallback', () => {
  it('creates a menu from the page list when there is none (WP_Navigation_Fallback)', async () => {
    const ctx = await site();
    const first = await ctx.request('GET', '/wp-block-editor/v1/navigation-fallback?_embed');
    expect(first.status).toBe(200);
    expect(first.body._links.self[0]).toMatchObject({
      href: `/wp-json/wp/v2/navigation/${first.body.id}`,
      embeddable: true,
    });
    expect(first.body._embedded.self[0]).toMatchObject({
      id: first.body.id,
      status: 'publish',
      title: { raw: 'Navigation' },
      content: { raw: '<!-- wp:page-list /-->' },
    });
    // Once there is one, it's reused.
    const again = await ctx.request('GET', '/wp-block-editor/v1/navigation-fallback');
    expect(again.body).toEqual({ id: first.body.id, _links: first.body._links });
    expect((await ctx.request('GET', '/wp/v2/navigation')).body).toHaveLength(1);

    const author = await ctx.loginAs('writer', 'author');
    expect((await author.request('GET', '/wp-block-editor/v1/navigation-fallback')).body.code).toBe(
      'rest_cannot_create',
    );
  });

  it('prefers the chosen menu, then the newest published one', async () => {
    const ctx = await site();
    const older = await createMenu(ctx, 'Older', link({ label: 'Old', url: '/', kind: 'custom' }));
    const newer = await createMenu(ctx, 'Newer', link({ label: 'New', url: '/', kind: 'custom' }));
    const fallback = () => ctx.request('GET', '/wp-block-editor/v1/navigation-fallback');
    expect((await fallback()).body.id).toBe(newer.id);

    expect((await ctx.request('GET', '/pressbase/v1/navigation-fallback')).body).toMatchObject({
      id: 0,
      current: newer.id,
    });
    const chosen = await ctx.request('PUT', '/pressbase/v1/navigation-fallback', { id: older.id });
    expect(chosen.body).toMatchObject({ id: older.id, current: older.id });
    expect((await fallback()).body.id).toBe(older.id);

    // Only published menus can be chosen; a chosen menu that's trashed stops counting.
    const draft = await createMenu(ctx, 'Draft', '', 'draft');
    expect(
      (await ctx.request('PUT', '/pressbase/v1/navigation-fallback', { id: draft.id })).status,
    ).toBe(400);
    await ctx.request('DELETE', `/wp/v2/navigation/${older.id}`);
    expect((await ctx.request('GET', '/pressbase/v1/navigation-fallback')).body).toMatchObject({
      id: 0,
      current: newer.id,
    });

    const editor = await ctx.loginAs('ed', 'editor');
    expect(
      (await editor.request('PUT', '/pressbase/v1/navigation-fallback', { id: newer.id })).status,
    ).toBe(403);
  });
});

describe('rendering menus', () => {
  it('shows the chosen menu in Twenty Twenty-Five’s header, else the newest, else pages', async () => {
    const ctx = await site();
    let nav = headerNav(await render(ctx, '/'));
    expect(nav).toContain('wp-block-pages-list__item');
    expect(nav).toContain('aria-label="Navigation"');

    const main = await createMenu(
      ctx,
      'Main menu',
      link({ label: 'Shop', url: '/shop/', kind: 'custom' }),
    );
    const other = await createMenu(
      ctx,
      'Other',
      link({ label: 'Elsewhere', url: '/x/', kind: 'custom' }),
    );
    nav = headerNav(await render(ctx, '/'));
    expect(nav).toContain('Elsewhere');
    expect(nav).not.toContain('wp-block-pages-list__item');

    await ctx.request('PUT', '/pressbase/v1/navigation-fallback', { id: main.id });
    nav = headerNav(await render(ctx, '/'));
    expect(nav).toContain('aria-label="Main menu"');
    expect(nav).toContain(
      '<a class="wp-block-navigation-item__content" href="/shop/"><span class="wp-block-navigation-item__label">Shop</span></a>',
    );
    expect(nav).not.toContain('Elsewhere');
    // TT5's overlay colours reach the responsive container.
    expect(nav).toContain(
      'class="wp-block-navigation__responsive-container has-text-color has-contrast-color has-background has-base-background-color"',
    );
    expect(other.id).toBeGreaterThan(main.id);
  });

  it('renders nested submenus with accessible toggles and marks the current item', async () => {
    const ctx = await site();
    const about = await createPage(ctx, 'About');
    const team = await createPage(ctx, 'Team', { parent: about.id });
    const content = [
      '<!-- wp:home-link {"label":"Home"} /-->',
      `<!-- wp:navigation-submenu ${JSON.stringify({ label: 'About', type: 'page', id: about.id, url: about.link, kind: 'post-type' })} -->`,
      link({ label: 'Team', type: 'page', id: team.id, url: team.link, kind: 'post-type' }),
      `<!-- wp:navigation-submenu ${JSON.stringify({ label: 'Deeper', url: '/deeper/', kind: 'custom' })} -->`,
      link({ label: 'Deepest', url: '/deepest/', kind: 'custom', opensInNewTab: true }),
      '<!-- /wp:navigation-submenu -->',
      '<!-- /wp:navigation-submenu -->',
    ].join('\n');
    const menu = await createMenu(ctx, 'Main', content);
    await ctx.request('PUT', '/pressbase/v1/navigation-fallback', { id: menu.id });

    const html = await render(ctx, new URL(team.link).pathname);
    const nav = headerNav(html);
    // The submenu: link, then a toggle button with aria-expanded, then the list.
    expect(nav).toContain(
      `<li class="wp-block-navigation-item has-child open-on-hover-click current-menu-ancestor wp-block-navigation-submenu"><a class="wp-block-navigation-item__content" href="${about.link}"><span class="wp-block-navigation-item__label">About</span></a><button aria-label="About submenu" class="wp-block-navigation__submenu-icon wp-block-navigation-submenu__toggle" aria-expanded="false">`,
    );
    expect(nav).toContain(
      '<ul class="wp-block-navigation__submenu-container has-text-color has-contrast-color has-background has-base-background-color wp-block-navigation-submenu">',
    );
    // The current page.
    expect(nav).toContain(
      `<li class="wp-block-navigation-item current-menu-item wp-block-navigation-link"><a class="wp-block-navigation-item__content" href="${team.link}" aria-current="page">`,
    );
    // Nested two levels, new tab.
    expect(nav).toContain('aria-label="Deeper submenu"');
    expect(nav).toMatch(/href="\/deepest\/" target="_blank"/);
    // Home isn't current here; the script and no-JS fallback are on the page.
    expect(nav).not.toMatch(/rel="home" aria-current/);
    expect(html).toContain('wp-block-navigation-submenu__toggle');
    expect(html).toContain('.has-child:focus-within>.wp-block-navigation__submenu-container');
    expect(html).toContain("closest('.wp-block-navigation .has-child')");

    const home = headerNav(await render(ctx, '/'));
    expect(home).toMatch(/rel="home" aria-current="page"/);
    expect(home).toContain('wp-block-navigation-item current-menu-item wp-block-home-link');
  });

  it('escapes hostile labels and strips javascript: URLs', async () => {
    const ctx = await site();
    const content = [
      link({
        label: '<script>alert(1)</script><img src=x onerror=alert(2)>Evil',
        url: 'javascript:alert(3)',
        kind: 'custom',
        description: '<b onmouseover="alert(4)">d</b>',
        title: '"><script>alert(5)</script>',
        rel: '" onclick="alert(6)',
      }),
      link({ label: 'Data', url: 'data:text/html,<script>alert(7)</script>', kind: 'custom' }),
      `<!-- wp:navigation-submenu ${JSON.stringify({ label: '<svg onload=alert(8)>Sub', url: ' JaVaScRiPt:alert(9)', kind: 'custom' })} -->`,
      link({ label: 'Child', url: '/child/', kind: 'custom' }),
      '<!-- /wp:navigation-submenu -->',
    ].join('\n');
    const menu = await createMenu(ctx, '<img src=x onerror=alert(10)>Menu', content);
    await ctx.request('PUT', '/pressbase/v1/navigation-fallback', { id: menu.id });
    const nav = headerNav(await render(ctx, '/'));
    expect(nav).toContain('Evil');
    expect(nav).toContain('Sub');
    expect(nav).not.toMatch(/<script|onerror|onload|onmouseover|onclick="|javascript:|data:text/i);
    expect(nav).toContain('<a class="wp-block-navigation-item__content" href=""');
    expect(nav).toContain('title="&quot;&gt;&lt;script&gt;alert(5)&lt;/script&gt;"');
    expect(nav).toMatch(/aria-label="[^"<]*Menu"/);
  });

  it('hides links to unpublished content and refuses menus that contain themselves', async () => {
    const ctx = await site();
    const draft = await ctx.request('POST', '/wp/v2/pages', { title: 'Secret', status: 'draft' });
    const menu = await createMenu(
      ctx,
      'Main',
      [
        link({
          label: 'Secret',
          type: 'page',
          id: draft.body.id,
          url: '/?page_id=1',
          kind: 'post-type',
        }),
        link({ label: 'Gone', type: 'page', id: 99999, url: '/gone/', kind: 'post-type' }),
        link({ label: 'Visible', url: '/v/', kind: 'custom' }),
      ].join('\n'),
    );
    await ctx.request('PUT', '/pressbase/v1/navigation-fallback', { id: menu.id });
    const nav = headerNav(await render(ctx, '/'));
    expect(nav).toContain('Visible');
    expect(nav).not.toContain('Secret');
    expect(nav).not.toContain('Gone');

    const loop = await createMenu(ctx, 'Loop', '<!-- wp:navigation {"ref":1} /-->');
    const rendered = await ctx.kernel.blocks.render(`<!-- wp:navigation {"ref":${loop.id}} /-->`);
    expect(rendered).toBe('');
  });

  it('renders a menu by ref in post content, and a page list with the current page', async () => {
    const ctx = await site();
    const menu = await createMenu(
      ctx,
      'Footer links',
      link({ label: 'Legal', url: '/legal/', kind: 'custom' }),
    );
    const html = await ctx.kernel.blocks.render(
      `<!-- wp:navigation {"ref":${menu.id},"overlayMenu":"never"} /-->`,
    );
    expect(html).toBe(
      '<nav class="wp-block-navigation is-layout-flex wp-block-navigation-is-layout-flex" aria-label="Footer links"><ul class="wp-block-navigation__container wp-block-navigation"><li class="wp-block-navigation-item wp-block-navigation-link"><a class="wp-block-navigation-item__content" href="/legal/"><span class="wp-block-navigation-item__label">Legal</span></a></li></ul></nav>',
    );

    // Without menus, the header lists pages.
    await ctx.request('DELETE', `/wp/v2/navigation/${menu.id}?force=true`);
    const about = await createPage(ctx, 'About');
    await createPage(ctx, 'Team', { parent: about.id });
    const page = await render(ctx, new URL(about.link).pathname);
    const nav = headerNav(page);
    expect(nav).toContain(
      'class="wp-block-pages-list__item current-menu-item has-child wp-block-navigation-item open-on-hover-click"',
    );
    expect(nav).toMatch(new RegExp(`href="${about.link}" aria-current="page">About</a>`));
  });

  it('previews unsaved menus in the theme’s header', async () => {
    const ctx = await site();
    const res = await ctx.request('POST', '/pressbase/v1/navigation-preview', {
      title: 'Draft menu',
      content: link({ label: 'Preview me', url: '/p/', kind: 'custom' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(headerNav(res.body.html)).toContain('Preview me');
    expect(headerNav(res.body.html)).toContain('aria-label="Draft menu"');
    // Nothing was saved.
    expect((await ctx.request('GET', '/wp/v2/navigation')).body).toHaveLength(0);
    expect(headerNav(await render(ctx, '/'))).not.toContain('Preview me');

    const author = await ctx.loginAs('writer', 'author');
    expect(
      (await author.request('POST', '/pressbase/v1/navigation-preview', { content: '' })).status,
    ).toBe(403);
  });
});
