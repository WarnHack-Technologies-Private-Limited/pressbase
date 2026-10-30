import { schema } from '@pressbase/db';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { mediaStorage } from './media/service';
import { SITE, setup } from './test-utils';

/**
 * Global styles, style variations, the live preview and site identity:
 * WP_REST_Global_Styles_Controller and its revisions controller, the
 * sanitising of user styles, the public stylesheet, and wp_site_icon().
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

/** The user global styles post ID, from the active theme's links (as the site editor finds it). */
async function globalStylesId(ctx: Ctx): Promise<number> {
  const res = await ctx.request('GET', '/wp/v2/themes?status=active');
  expect(res.status).toBe(200);
  const href: string = res.body[0]._links['wp:user-global-styles'][0].href;
  return Number(href.split('/').pop());
}

async function page(ctx: Ctx, url = '/') {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  return (await res.json()) as { status: number; headers: Record<string, string>; html: string };
}

const globalCss = (html: string) =>
  /<style id='global-styles-inline-css'>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';

/** A logged-in administrator who lacks unfiltered_html (as on multisite). */
async function filteredAdmin(ctx: Ctx) {
  const client = await ctx.loginAs('designer', 'administrator');
  await ctx.kernel.db
    .update(schema.usermeta)
    .set({ value: { administrator: true, unfiltered_html: false } })
    .where(and(eq(schema.usermeta.userId, client.id), eq(schema.usermeta.key, 'capabilities')));
  return client;
}

describe('theme global styles and style variations', () => {
  it('serves the theme’s settings and styles, for the active theme only', async () => {
    const ctx = await site();
    const res = await ctx.request('GET', '/wp/v2/global-styles/themes/pressbase');
    expect(res.status).toBe(200);
    expect(res.body.settings.color.palette.theme).toContainEqual({
      color: '#f6f6f3',
      name: 'Paper',
      slug: 'base',
    });
    expect(res.body.settings.layout).toEqual({ contentSize: '720px', wideSize: '1200px' });
    expect(res.body.styles.color).toEqual({
      background: 'var:preset|color|base',
      text: 'var:preset|color|contrast',
    });
    expect(res.body._links['wp:theme-file'][0]).toMatchObject({
      name: 'file:./assets/fonts/manrope/Manrope-VariableFont_wght.woff2',
      href: 'http://localhost:3000/wp-content/themes/pressbase/assets/fonts/manrope/Manrope-VariableFont_wght.woff2',
    });
    const other = await ctx.request('GET', '/wp/v2/global-styles/themes/twentytwentyfour');
    expect(other.status).toBe(404);
    expect(other.body.code).toBe('rest_theme_not_found');
  });

  it('lists the theme’s style variations: full, colour and typography', async () => {
    const ctx = await site();
    const res = await ctx.request('GET', '/wp/v2/global-styles/themes/pressbase/variations');
    expect(res.status).toBe(200);
    // Sorted by path, as WordPress sorts them: styles/*.json, then colors/, then typography/.
    expect(res.body.map((v: { title: string }) => v.title)).toEqual([
      'Midnight',
      'Violet',
      'Grotesk',
    ]);
    // No block style variations (styles/blocks, styles/sections) in the list.
    expect(res.body.some((v: { blockTypes?: unknown }) => v.blockTypes)).toBe(false);
    const typography = res.body.find((v: { title: string }) => v.title === 'Grotesk');
    expect(typography.settings.typography.fontFamilies.theme[0].slug).toBe('manrope');
    expect(typography._links['wp:theme-file'].length).toBeGreaterThan(0);
  });

  it('lets anyone who edits content read them, and nobody else', async () => {
    const ctx = await site();
    const author = await ctx.loginAs('writer', 'author');
    const subscriber = await ctx.loginAs('reader', 'subscriber');
    const anonymous = ctx.client();
    const url = '/wp/v2/global-styles/themes/pressbase';
    expect((await author.request('GET', url)).status).toBe(200);
    const denied = await subscriber.request('GET', `${url}/variations`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('rest_cannot_read_global_styles');
    expect((await anonymous.request('GET', url)).status).toBe(401);
  });
});

describe('user global styles (/wp/v2/global-styles/{id})', () => {
  it('creates the theme’s wp_global_styles post on demand and answers like WordPress', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    expect(await globalStylesId(ctx)).toBe(id);
    const res = await ctx.request('GET', `/wp/v2/global-styles/${id}?context=edit`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      title: { raw: 'Custom Styles' },
      settings: {},
      styles: {},
    });
    expect(res.body._links['version-history'][0].href).toBe(
      `http://localhost:3000/wp-json/wp/v2/global-styles/${id}/revisions`,
    );
    expect(res.body._links['wp:action-edit-css']).toBeDefined();
    const post = await ctx.kernel.posts.get(id);
    expect(post).toMatchObject({
      type: 'wp_global_styles',
      status: 'publish',
      slug: 'wp-global-styles-pressbase',
    });
    expect(JSON.parse(post?.content ?? '')).toEqual({
      version: 3,
      isGlobalStylesUserThemeJSON: true,
    });
    expect((await ctx.request('GET', '/wp/v2/global-styles/999999')).body.code).toBe(
      'rest_global_styles_not_found',
    );
  });

  it('needs edit_theme_options to change them', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    const author = await ctx.loginAs('writer', 'author');
    const editor = await ctx.loginAs('boss', 'editor');
    const body = { styles: { color: { text: '#123456' } } };
    expect((await author.request('GET', `/wp/v2/global-styles/${id}`)).status).toBe(200);
    expect((await author.request('GET', `/wp/v2/global-styles/${id}?context=edit`)).body.code).toBe(
      'rest_forbidden_context',
    );
    const denied = await editor.request('POST', `/wp/v2/global-styles/${id}`, body);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('rest_cannot_edit');
    expect((await ctx.client().request('GET', `/wp/v2/global-styles/${id}`)).status).toBe(401);
    expect((await editor.request('GET', `/wp/v2/global-styles/${id}/revisions`)).body.code).toBe(
      'rest_cannot_read',
    );
  });

  it('saves user styles, which the public stylesheet then uses, and announces the change', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    const fired: unknown[][] = [];
    ctx.kernel.hooks.addAction('pressbase_global_styles_updated', (...args: unknown[]) => {
      fired.push(args);
    });
    const before = globalCss((await page(ctx)).html);
    expect(before).toContain('--wp--preset--color--base: #f6f6f3;');

    const res = await ctx.request('POST', `/wp/v2/global-styles/${id}`, {
      settings: {
        color: {
          palette: {
            theme: [
              { slug: 'base', name: 'Base', color: '#101820' },
              { slug: 'contrast', name: 'Contrast', color: '#F2AA4C' },
            ],
          },
        },
        layout: { contentSize: '760px' },
      },
      styles: {
        typography: { fontSize: '19px' },
        elements: { link: { color: { text: '#F2AA4C' } } },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.styles.typography).toEqual({ fontSize: '19px' });
    expect(fired).toHaveLength(1);
    expect(fired[0]?.[0]).toBe('pressbase');

    const after = globalCss((await page(ctx)).html);
    expect(after).toContain('--wp--preset--color--base: #101820;');
    expect(after).toContain('--wp--style--global--content-size: 760px;');
    // Fluid typography applies to the user's base size too, as in WordPress.
    // The theme's wide size (1200px) is the largest viewport: (19 - 14) / (1200 - 320) * 100.
    expect(after).toContain('font-size: clamp(14px, 0.875rem + ((1vw - 3.2px) * 0.568), 19px);');
    expect(after).toContain('a:where(:not(.wp-element-button)){color: #F2AA4C;');
    // The theme's other presets are untouched.
    expect(after).toContain(
      '--wp--preset--font-family--manrope: Manrope, "Manrope Fallback", ui-sans-serif, system-ui, sans-serif;',
    );

    // A request without styles keeps the stored ones (prepare_item_for_database()).
    const title = await ctx.request('POST', `/wp/v2/global-styles/${id}`, {
      settings: { layout: { contentSize: '700px' } },
    });
    expect(title.body.styles.typography).toEqual({ fontSize: '19px' });
  });

  it('refuses CSS that could close the style element, and non-object styles', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    const bad = await ctx.request('POST', `/wp/v2/global-styles/${id}`, {
      styles: { css: 'p{color:red}</style><script>alert(1)</script>' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('rest_custom_css_illegal_markup');
    const notString = await ctx.request('POST', `/wp/v2/global-styles/${id}`, {
      styles: { css: ['x'] },
    });
    expect(notString.body.code).toBe('rest_custom_css_invalid_type');
    expect(
      (await ctx.request('POST', `/wp/v2/global-styles/${id}`, { styles: 'body{}' })).status,
    ).toBe(400);

    // Administrators (edit_css) may add custom CSS; it is printed after the global styles.
    const ok = await ctx.request('POST', `/wp/v2/global-styles/${id}`, {
      styles: { css: '.site-note{outline:1px solid red}' },
    });
    expect(ok.status).toBe(200);
    expect(globalCss((await page(ctx)).html)).toContain('.site-note{outline:1px solid red}');
  });

  it('strips hostile values for users without unfiltered_html (wp_filter_global_styles_post)', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    const designer = await filteredAdmin(ctx);
    const res = await designer.request('POST', `/wp/v2/global-styles/${id}`, {
      settings: {
        color: {
          palette: {
            theme: [
              { slug: 'base', name: 'Base', color: '#000000' },
              { slug: 'evil', name: 'Evil', color: 'red;}</style><script>alert(1)</script>' },
            ],
          },
        },
      },
      styles: {
        css: 'body{background:url(https://tracker.example/pixel)}',
        color: { text: 'red;}</style><script>alert(2)</script>', background: '#fafafa' },
        typography: { fontFamily: 'expression(alert(3))' },
        blocks: { 'core/group': { css: '& {display:none}', color: { text: '#222' } } },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.styles).toEqual({
      color: { background: '#fafafa' },
      blocks: { 'core/group': { color: { text: '#222' } } },
    });
    expect(res.body.settings.color.palette.custom ?? res.body.settings.color.palette.theme).toEqual(
      [{ slug: 'base', name: 'Base', color: '#000000' }],
    );
    // Stored as WordPress stores it, with <, > and & escaped.
    const stored = (await ctx.kernel.posts.get(id))?.content ?? '';
    expect(stored).not.toMatch(/[<>]/);
    const html = (await page(ctx)).html;
    expect(html).not.toContain('alert(');
    expect(html).not.toContain('tracker.example');
    expect(globalCss(html)).toContain('background-color: #fafafa;');
  });

  it('keeps revisions, and restoring one brings the old styles back', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    const save = (text: string) =>
      ctx.request('POST', `/wp/v2/global-styles/${id}`, { styles: { color: { text } } });
    await save('#111111');
    await save('#222222');
    const res = await ctx.request('GET', `/wp/v2/global-styles/${id}/revisions`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-wp-total')).toBe(String(res.body.length));
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    // Newest first, each with its own styles and the parent's ID.
    expect(res.body[0]).toMatchObject({ parent: id, styles: { color: { text: '#222222' } } });
    expect(res.body[1].styles).toEqual({ color: { text: '#111111' } });
    // Each revision records who saved it.
    const me = await ctx.request('GET', '/wp/v2/users/me');
    expect(res.body[0].author).toBe(me.body.id);
    expect(Object.keys(res.body[0]).sort()).toEqual([
      'author',
      'date',
      'date_gmt',
      'id',
      'modified',
      'modified_gmt',
      'parent',
      'settings',
      'styles',
    ]);

    const one = await ctx.request('GET', `/wp/v2/global-styles/${id}/revisions/${res.body[1].id}`);
    expect(one.body.styles).toEqual({ color: { text: '#111111' } });

    // "Restore previous styles": save the revision's styles and settings.
    await ctx.request('POST', `/wp/v2/global-styles/${id}`, {
      styles: one.body.styles,
      settings: one.body.settings,
    });
    expect(globalCss((await page(ctx)).html)).toContain('color: #111111;');

    const paged = await ctx.request(
      'GET',
      `/wp/v2/global-styles/${id}/revisions?per_page=1&page=2`,
    );
    expect(paged.body).toHaveLength(1);
    expect(
      (await ctx.request('GET', `/wp/v2/global-styles/${id}/revisions?per_page=1&page=99`)).body
        .code,
    ).toBe('rest_revision_invalid_page_number');
    expect((await ctx.request('GET', '/wp/v2/global-styles/12345/revisions')).body.code).toBe(
      'rest_post_invalid_parent',
    );
  });

  it('is not a public page', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    expect((await page(ctx, `/?p=${id}`)).status).toBe(404);
  });
});

describe('the live preview (/pressbase/v1/global-styles/preview)', () => {
  it('renders a page with unsaved styles and never stores them', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    await ctx.request('POST', `/wp/v2/global-styles/${id}`, {
      styles: { color: { text: '#333333' } },
    });
    const stored = (await ctx.kernel.posts.get(id))?.content;
    const revisions = (await ctx.kernel.posts.revisions(id)).length;

    const res = await ctx.request('POST', '/pressbase/v1/global-styles/preview', {
      url: '/',
      settings: {
        color: { palette: { theme: [{ slug: 'base', name: 'Base', color: '#ABCDEF' }] } },
      },
      styles: { color: { text: '#FEDCBA' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(200);
    expect(res.body.headers['cache-control']).toBe('no-store');
    expect(globalCss(res.body.html)).toContain('--wp--preset--color--base: #ABCDEF;');
    expect(globalCss(res.body.html)).toContain('color: #FEDCBA;');

    // Nothing changed: the post, its revisions, the public page.
    expect((await ctx.kernel.posts.get(id))?.content).toBe(stored);
    expect((await ctx.kernel.posts.revisions(id)).length).toBe(revisions);
    const pub = globalCss((await page(ctx)).html);
    expect(pub).toContain('color: #333333;');
    expect(pub).not.toContain('#FEDCBA');
    expect((await ctx.request('GET', `/wp/v2/global-styles/${id}`)).body.styles).toEqual({
      color: { text: '#333333' },
    });
  });

  it('starts from the saved styles when only some are sent, and checks its input', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    await ctx.request('POST', `/wp/v2/global-styles/${id}`, {
      settings: { layout: { contentSize: '600px' } },
    });
    const res = await ctx.request('POST', '/pressbase/v1/global-styles/preview', {
      styles: { color: { text: '#FEDCBA' } },
    });
    expect(globalCss(res.body.html)).toContain('--wp--style--global--content-size: 600px;');
    expect(
      (await ctx.request('POST', '/pressbase/v1/global-styles/preview', { url: 'https://x.test/' }))
        .body.code,
    ).toBe('rest_invalid_param');
    expect(
      (
        await ctx.request('POST', '/pressbase/v1/global-styles/preview', {
          styles: { css: '</style><script>' },
        })
      ).body.code,
    ).toBe('rest_custom_css_illegal_markup');
    const author = await ctx.loginAs('writer', 'author');
    expect((await author.request('POST', '/pressbase/v1/global-styles/preview', {})).status).toBe(
      403,
    );
  });
});

describe('site identity: logo and icon', () => {
  async function adminCookie(ctx: Ctx): Promise<string> {
    const res = await ctx.app.request('/wp-json/pressbase/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pressbase-request': '1' },
      body: JSON.stringify({ login: SITE.username, password: SITE.password }),
    });
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }

  async function uploadImage(ctx: Ctx, name: string, width: number, height: number) {
    const png = await sharp({
      create: { width, height, channels: 4, background: { r: 200, g: 40, b: 90, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set('file', new File([new Uint8Array(png)], name, { type: 'image/png' }));
    const res = await ctx.app.request('/wp-json/wp/v2/media', {
      method: 'POST',
      headers: { cookie: await adminCookie(ctx), 'x-pressbase-request': '1' },
      body: form,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: number; source_url: string };
  }

  it('registers site_logo and site_icon in /wp/v2/settings', async () => {
    const ctx = await site();
    const res = await ctx.request('GET', '/wp/v2/settings');
    expect(res.body).toMatchObject({ site_logo: 0, site_icon: 0 });
    const bad = await ctx.request('POST', '/wp/v2/settings', { site_icon: 'x' });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.data.params)).toEqual(['site_icon']);
  });

  it('crops the site icon to WordPress’s sizes and prints wp_site_icon()’s tags', async () => {
    const ctx = await site();
    const image = await uploadImage(ctx, 'mark.png', 800, 600);
    const res = await ctx.request('POST', '/wp/v2/settings', { site_icon: image.id });
    expect(res.status).toBe(200);
    const metadata = (await ctx.kernel.posts.getMeta(image.id, '_wp_attachment_metadata')) as {
      sizes: Record<string, { file: string; width: number; height: number }>;
    };
    for (const size of [512, 270, 192, 180, 32]) {
      const sub = metadata.sizes[`site_icon-${size}`];
      expect(sub, String(size)).toMatchObject({ width: size, height: size });
      const stream = await mediaStorage(ctx.kernel).read(
        `${((await ctx.kernel.posts.getMeta(image.id, '_wp_attached_file')) as string).replace(/[^/]+$/, '')}${sub?.file}`,
      );
      const info = await sharp(new Uint8Array(await new Response(stream).arrayBuffer())).metadata();
      expect([info.width, info.height]).toEqual([size, size]);
    }
    const html = (await page(ctx)).html;
    const base = image.source_url.replace(/\.png$/, '');
    expect(html).toContain(`<link rel="icon" href="${base}-32x32.png" sizes="32x32" />`);
    expect(html).toContain(`<link rel="icon" href="${base}-192x192.png" sizes="192x192" />`);
    expect(html).toContain(`<link rel="apple-touch-icon" href="${base}-180x180.png" />`);
    expect(html).toContain(`<meta name="msapplication-TileImage" content="${base}-270x270.png" />`);
    const index = await ctx.request('GET', '/');
    expect(index.body).toMatchObject({ site_icon: image.id, site_icon_url: `${base}-512x512.png` });

    // Deleting the image forgets the icon.
    await ctx.request('DELETE', `/wp/v2/media/${image.id}?force=true`);
    expect((await ctx.request('GET', '/wp/v2/settings')).body.site_icon).toBe(0);
    expect((await page(ctx)).html).not.toContain('rel="icon"');
  });

  it('shows the site logo through core/site-logo', async () => {
    const ctx = await site();
    const image = await uploadImage(ctx, 'logo.png', 400, 100);
    await ctx.request('POST', '/wp/v2/settings', { site_logo: image.id, title: 'Acme' });
    const res = await ctx.request('POST', '/wp/v2/block-renderer/core/site-logo', {
      attributes: { width: 120 },
    });
    const rendered: string = res.body.rendered ?? '';
    expect(rendered).toContain('class="wp-block-site-logo"');
    expect(rendered).toContain('class="custom-logo-link" rel="home"');
    expect(rendered).toContain('width="120" height="30"');
    expect(rendered).toContain('alt="Acme"');
  });
});
