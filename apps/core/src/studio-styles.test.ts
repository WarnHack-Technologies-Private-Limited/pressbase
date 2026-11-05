import { schema } from '@pressbase/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { setup } from './test-utils';

/**
 * Studio's Styles panel (#46): the editor settings for unsaved styles that
 * keep the canvas live, and the Additional CSS rule — `styles.css` and each
 * block's `css` must pass validate_custom_css() for everyone, and survive only
 * for people with `edit_css` (which maps to `unfiltered_html`), whether they
 * come through the REST API or a changeset.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

async function globalStylesId(ctx: Ctx): Promise<number> {
  const res = await ctx.request('GET', '/wp/v2/themes?status=active');
  const href: string = res.body[0]._links['wp:user-global-styles'][0].href;
  return Number(href.split('/').pop());
}

/** An administrator without unfiltered_html (as on multisite), so without edit_css. */
async function filteredAdmin(ctx: Ctx) {
  const client = await ctx.loginAs('designer', 'administrator');
  await ctx.kernel.db
    .update(schema.usermeta)
    .set({ value: { administrator: true, unfiltered_html: false } })
    .where(and(eq(schema.usermeta.userId, client.id), eq(schema.usermeta.key, 'capabilities')));
  return client;
}

type EditorStyle = { css: string; __unstableType: string; isGlobalStyles: boolean };
const allCss = (styles: EditorStyle[]) => styles.map((s) => s.css).join('\n');

const BUTTON_CSS = { 'core/button': { css: '& .wp-block-button__link{letter-spacing:.1em}' } };

describe('editor settings for unsaved styles (/pressbase/v1/global-styles/editor-settings)', () => {
  it('gives the canvas the new palette and features, and stores nothing', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    const stored = (await ctx.kernel.posts.get(id))?.content;
    const res = await ctx.request('POST', '/pressbase/v1/global-styles/editor-settings', {
      settings: {
        color: {
          palette: {
            theme: [
              { slug: 'base', name: 'Paper', color: '#fffdf8' },
              { slug: 'accent', name: 'Accent', color: '#b4232a' },
            ],
          },
        },
      },
      styles: { blocks: { 'core/quote': { border: { width: '3px', style: 'solid' } } } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const css = allCss(res.body.styles);
    // Every use of the accent reads the variable, so changing it changes them all.
    expect(css).toContain('--wp--preset--color--accent: #b4232a;');
    expect(css).toContain('border-width: 3px;');
    expect(res.body.styles.map((s: EditorStyle) => s.__unstableType)).toEqual([
      'presets',
      'presets',
      'theme',
    ]);
    const palette = res.body.__experimentalFeatures.color.palette;
    expect(palette.custom ?? palette.theme).toContainEqual({
      slug: 'accent',
      name: 'Accent',
      color: '#b4232a',
    });
    expect(res.body.colors).toContainEqual({ slug: 'accent', name: 'Accent', color: '#b4232a' });
    expect(res.body.fontFaces).toContain('@font-face');
    expect(res.body.config.settings.color.palette).toBeDefined();
    // Nothing stored.
    expect((await ctx.kernel.posts.get(id))?.content).toBe(stored);
    const live = await ctx.request('GET', '/wp-block-editor/v1/settings');
    expect(allCss(live.body.styles)).not.toContain('#b4232a');
  });

  it('starts from the saved styles when only some are sent', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    await ctx.request('POST', `/wp/v2/global-styles/${id}`, {
      settings: { layout: { contentSize: '610px' } },
    });
    const res = await ctx.request('POST', '/pressbase/v1/global-styles/editor-settings', {
      styles: { color: { text: '#202020' } },
    });
    expect(allCss(res.body.styles)).toContain('--wp--style--global--content-size: 610px;');
    expect(allCss(res.body.styles)).toContain('color: #202020;');
  });

  it('is for people who can change the site’s design', async () => {
    const ctx = await site();
    const editor = await ctx.loginAs('editor', 'editor');
    const res = await editor.request('POST', '/pressbase/v1/global-styles/editor-settings', {});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('rest_cannot_edit');
    const bad = await ctx.request('POST', '/pressbase/v1/global-styles/editor-settings', {
      styles: 'body{}',
    });
    expect(bad.body.code).toBe('rest_invalid_param');
  });
});

describe('Additional CSS: validate_custom_css() and edit_css', () => {
  it('prints the site’s and a block’s Additional CSS for people with edit_css', async () => {
    const ctx = await site();
    const res = await ctx.request('POST', '/pressbase/v1/global-styles/editor-settings', {
      styles: { css: '.note{outline:1px solid}', blocks: BUTTON_CSS },
    });
    expect(res.status).toBe(200);
    const user = res.body.styles.find((s: EditorStyle) => s.__unstableType === 'user');
    expect(user?.css).toContain('.note{outline:1px solid}');
    expect(allCss(res.body.styles)).toContain('letter-spacing:.1em');
    expect(res.body.config.styles.css).toBe('.note{outline:1px solid}');
  });

  it('drops it for people without edit_css, through REST and through a changeset', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    const designer = await filteredAdmin(ctx);
    const styles = {
      css: '.note{outline:1px solid}',
      color: { text: '#222222' },
      blocks: BUTTON_CSS,
    };

    const settings = await designer.request(
      'POST',
      '/pressbase/v1/global-styles/editor-settings',
      { styles },
    );
    expect(settings.status).toBe(200);
    expect(allCss(settings.body.styles)).not.toContain('.note');
    expect(allCss(settings.body.styles)).not.toContain('letter-spacing:.1em');
    const noCss = { color: { text: '#222222' }, blocks: { 'core/button': {} } };
    expect(settings.body.config.styles).toEqual(noCss);

    const saved = await designer.request('POST', `/wp/v2/global-styles/${id}`, { styles });
    expect(saved.body.styles).toEqual(noCss);

    const { body } = await designer.request('POST', '/pressbase/v1/changesets', {
      entries: { 'wp_global_styles:pressbase': { styles } },
    });
    expect(body.entries['wp_global_styles:pressbase'].value.styles).toEqual(noCss);

    // An administrator with edit_css keeps both.
    const admin = await ctx.request('POST', '/pressbase/v1/changesets', {
      entries: { 'wp_global_styles:pressbase': { styles } },
    });
    expect(admin.body.entries['wp_global_styles:pressbase'].value.styles).toMatchObject({
      css: '.note{outline:1px solid}',
      blocks: BUTTON_CSS,
    });
  });

  it('refuses CSS that could close the style element, for the site and for each block', async () => {
    const ctx = await site();
    const id = await globalStylesId(ctx);
    const blockCss = { blocks: { 'core/button': { css: 'a{}</style ><script>x</script>' } } };
    const variationCss = {
      blocks: { 'core/group': { variations: { 'section-ink': { css: 'a{}</' } } } },
    };
    for (const styles of [{ css: 'p{}</style>' }, blockCss, variationCss]) {
      const settings = await ctx.request('POST', '/pressbase/v1/global-styles/editor-settings', {
        styles,
      });
      expect(settings.status).toBe(400);
      expect(settings.body.code).toBe('rest_custom_css_illegal_markup');
      const saved = await ctx.request('POST', `/wp/v2/global-styles/${id}`, { styles });
      expect(saved.body.code).toBe('rest_custom_css_illegal_markup');
    }
    const { body } = await ctx.request('POST', '/pressbase/v1/changesets', {});
    const res = await ctx.request('POST', `/pressbase/v1/changesets/${body.uuid}`, {
      entries: { 'wp_global_styles:pressbase': { styles: blockCss } },
    });
    expect(res.status).toBe(400);
    expect(res.body.data.entries['wp_global_styles:pressbase'].code).toBe(
      'rest_custom_css_illegal_markup',
    );
    const notString = await ctx.request('POST', '/pressbase/v1/global-styles/editor-settings', {
      styles: { blocks: { 'core/button': { css: 42 } } },
    });
    expect(notString.body.code).toBe('rest_custom_css_invalid_type');
  });
});
