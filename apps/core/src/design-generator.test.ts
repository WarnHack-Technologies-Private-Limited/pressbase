import { createDesign, FONTS, toGlobalStyles } from '@pressbase/design';
import { describe, expect, it } from 'vitest';
import { setup } from './test-utils';

/**
 * A generated design (@pressbase/design, #54) restyles the Pressbase theme
 * when saved as user global styles: its palette, corner and spacing presets
 * replace the theme's, and its fonts reach headings and body text.
 */
describe('a generated design on the Pressbase theme', () => {
  it('replaces the theme’s presets and fonts in the global stylesheet', async () => {
    const ctx = await setup();
    await ctx.install();
    await ctx.kernel.themes.activate('pressbase');
    const design = createDesign({
      mood: 'warm',
      hue: 30,
      contrast: 'standard',
      scheme: 'light',
      fontPair: 'transitional-humanist',
      radius: 'square',
      density: 'compact',
    });
    const styled = await ctx.kernel.themes.withUserStyles(toGlobalStyles(design));
    const css = styled.css.global;

    for (const { slug, color } of design.palette) {
      expect(css).toContain(`--wp--preset--color--${slug}: ${color};`);
    }
    // The theme's own indigo is gone.
    expect(css).not.toContain('--wp--preset--color--accent: #3b4cca;');
    expect(css).toContain('--wp--preset--border-radius--full: 0;');
    expect(css).toContain('--wp--preset--spacing--20: 0.375rem;');
    expect(css).toContain(
      `--wp--preset--font-family--transitional: ${FONTS.transitional.fontFamily};`,
    );
    expect(css).toContain(`--wp--preset--font-family--humanist: ${FONTS.humanist.fontFamily};`);
    // The theme's bundled fonts stay available.
    expect(css).toContain('--wp--preset--font-family--manrope:');
    expect(css).toMatch(
      /h1, h2, h3, h4, h5, h6[^{]*\{[^}]*font-family: var\(--wp--preset--font-family--transitional\)/,
    );
    expect(css).toMatch(/body\s*\{[^}]*font-family: var\(--wp--preset--font-family--humanist\)/);
  });
});
