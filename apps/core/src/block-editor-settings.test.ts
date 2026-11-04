import { describe, expect, it } from 'vitest';
import { editorFeatureSettings } from './routes/block-editor-settings';
import { setup } from './test-utils';

/**
 * GET /wp-block-editor/v1/settings: the theme-dependent block editor settings
 * Studio's canvas is built from (global styles, theme.json features, the
 * theme's fonts and stylesheets).
 */
describe('block editor settings', () => {
  it('gives editors the global styles in WordPress’s order and the theme’s canvas assets', async () => {
    const ctx = await setup();
    await ctx.install();
    const res = await ctx.request('GET', '/wp-block-editor/v1/settings');
    expect(res.status).toBe(200);
    const types = res.body.styles.map((s: { __unstableType: string }) => s.__unstableType);
    expect(types.slice(0, 3)).toEqual(['presets', 'presets', 'theme']);
    for (const style of res.body.styles) expect(style.isGlobalStyles).toBe(true);
    expect(res.body.styles[0].css).toContain('--wp--preset--color--accent');
    expect(res.body.styles[1].css).toContain('.has-accent-color');
    expect(res.body.styles[2].css).toContain('.wp-site-blocks');
    // The Pressbase theme's fonts, as @font-face rules at the theme's URLs.
    const assets = res.body.__unstableResolvedAssets;
    expect(assets.styles).toContain("<style class='wp-fonts-local'>");
    expect(assets.styles).toContain('/wp-content/themes/pressbase/assets/fonts/');
    expect(assets.scripts).toBe('');
    // Presets keyed by origin, and the theme's list picked for `colors`.
    expect(Object.keys(res.body.__experimentalFeatures.color.palette)).toContain('theme');
    expect(res.body.colors.map((c: { slug: string }) => c.slug)).toContain('accent');
    expect(res.body.__unstableIsBlockBasedTheme).toBe(true);
  });

  it('includes the user’s global styles', async () => {
    const ctx = await setup();
    await ctx.install();
    const themes = await ctx.request('GET', '/wp/v2/themes?status=active');
    const id = String(themes.body[0]._links['wp:user-global-styles'][0].href).split('/').pop();
    const saved = await ctx.request('POST', `/wp/v2/global-styles/${id}`, {
      styles: { color: { background: '#123456' }, css: 'p { letter-spacing: 1px; }' },
    });
    expect(saved.status).toBe(200);
    const res = await ctx.request('GET', '/wp-block-editor/v1/settings');
    const css = res.body.styles.map((s: { css: string }) => s.css).join('\n');
    expect(css).toContain('#123456');
    expect(res.body.styles.at(-1)).toMatchObject({ __unstableType: 'user' });
    expect(res.body.styles.at(-1).css).toContain('letter-spacing');
  });

  it('is only for people who can edit content', async () => {
    const ctx = await setup();
    await ctx.install();
    const subscriber = await ctx.loginAs('reader', 'subscriber');
    const denied = await subscriber.request('GET', '/wp-block-editor/v1/settings');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('rest_cannot_read_block_editor_settings');
    const author = await ctx.loginAs('writer', 'author');
    expect((await author.request('GET', '/wp-block-editor/v1/settings')).status).toBe(200);
    ctx.clearCookie();
    expect((await ctx.request('GET', '/wp-block-editor/v1/settings')).status).toBe(401);
  });

  it('moves the custom switches out of the features, as get_block_editor_settings() does', () => {
    const out = editorFeatureSettings({
      color: { custom: false, customGradient: true, palette: { default: [1], theme: [2] } },
      typography: { customFontSize: false, lineHeight: true, fontSizes: { default: [3] } },
      spacing: { units: ['px'], padding: true, customSpacingSize: false },
    });
    expect(out).toMatchObject({
      colors: [2],
      fontSizes: [3],
      disableCustomColors: true,
      disableCustomGradients: false,
      disableCustomFontSizes: true,
      enableCustomLineHeight: true,
      enableCustomUnits: ['px'],
      enableCustomSpacing: true,
      disableCustomSpacingSizes: true,
    });
    expect(out.__experimentalFeatures.color).toEqual({ palette: { default: [1], theme: [2] } });
    expect(out.__experimentalFeatures.spacing).toEqual({});
  });
});
