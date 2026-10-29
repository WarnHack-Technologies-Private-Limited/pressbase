import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyStyleVariation,
  areGlobalStyleConfigsEqual,
  getGlobalStylesheet,
  isSafeCssDeclaration,
  isStyleVariationApplied,
  keyPresetsByOrigin,
  removeInsecureProperties,
  resolvedThemeUris,
  resolveThemeJson,
  type StyleVariation,
  styleVariationKind,
  styleVariationScope,
  type ThemeJsonData,
  validateCustomCss,
} from './index';

const PRESSBASE = path.resolve(import.meta.dirname, '../../../themes/pressbase');
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as ThemeJsonData;
const partials = readdirSync(path.join(PRESSBASE, 'styles', 'sections')).map((f) =>
  readJson(path.join(PRESSBASE, 'styles', 'sections', f)),
);
const theme = readJson(path.join(PRESSBASE, 'theme.json'));

/** A variation as /wp/v2/global-styles/themes/{stylesheet}/variations returns it. */
const variation = (file: string) =>
  keyPresetsByOrigin(readJson(path.join(PRESSBASE, 'styles', file)), 'theme') as StyleVariation;

function stylesheetWith(user?: ThemeJsonData) {
  const resolved = resolveThemeJson({ theme, blockStyleVariations: partials, user });
  return getGlobalStylesheet(resolved, { resolveFileUri: (p) => `/t/${p}` });
}

describe('theme style variations (styles/*.json)', () => {
  it('tells full, colour and typography variations apart, as the site editor does', () => {
    expect(styleVariationKind(variation('01-midnight.json'))).toBe('full');
    expect(styleVariationKind(variation('colors/02-violet.json'))).toBe('color');
    expect(styleVariationKind(variation('typography/03-grotesk.json'))).toBe('typography');
    expect(styleVariationKind({ title: 'Default' })).toBe('full');
    expect(
      styleVariationScope(readJson(path.join(PRESSBASE, 'styles/sections/section-ink.json'))),
    ).toBe('block');
    expect(styleVariationScope(variation('01-midnight.json'))).toBe('theme');
  });

  it('keys preset lists by origin, leaving preset references as written', () => {
    const midnight = variation('01-midnight.json');
    expect(midnight.settings?.color).toMatchObject({
      palette: {
        theme: expect.arrayContaining([{ color: '#1b1b19', name: 'Ink', slug: 'base' }]),
      },
    });
    const blocks = midnight.styles?.blocks as
      | Record<string, { variations?: Record<string, object> }>
      | undefined;
    expect(blocks?.['core/group']?.variations?.['section-ink']).toMatchObject({
      color: { background: 'var:preset|color|surface' },
    });
  });

  it('merges Midnight over the theme as WordPress merges the user origin', () => {
    const user = applyStyleVariation(
      { version: 3, isGlobalStylesUserThemeJSON: true },
      variation('01-midnight.json'),
    );
    const { stylesheet } = stylesheetWith(user);
    // The variation's palette replaces the theme's (same slugs, custom origin wins).
    expect(stylesheet).toContain('--wp--preset--color--base: #1b1b19;');
    expect(stylesheet).toContain('--wp--preset--color--on-accent: #000000;');
    expect(stylesheet).not.toContain('--wp--preset--color--base: #f6f6f3;');
    // So do its shadows.
    expect(stylesheet).toContain(
      '--wp--preset--shadow--glow: 0 1px 0 rgb(255 255 255 / 0.2) inset, 0 8px 28px -8px rgb(91 108 240 / 0.7);',
    );
    // Root and element styles the variation doesn't touch are the theme's.
    expect(stylesheet).toContain(
      'body{background-color: var(--wp--preset--color--base);color: var(--wp--preset--color--contrast);font-family: var(--wp--preset--font-family--manrope);',
    );
    expect(stylesheet).toMatch(
      /:root :where\(\.wp-element-button, \.wp-block-button__link\)\{background-color: var\(--wp--preset--color--accent\);border-radius: var\(--wp--preset--border-radius--full\);[^}]*color: var\(--wp--preset--color--on-accent\);/,
    );
    // Theme presets the variation doesn't touch are kept.
    expect(stylesheet).toContain(
      '--wp--preset--font-family--platypi: Platypi, "Platypi Fallback", ui-serif, Georgia, serif;',
    );
  });

  it('applies shared section variations from a style variation to block instances', () => {
    const shared: StyleVariation = {
      title: 'Shared sections',
      styles: {
        variations: {
          'section-ink': {
            elements: { button: { color: { background: 'var:preset|color|accent' } } },
          },
        },
      },
    } as StyleVariation;
    const user = applyStyleVariation({ version: 3 }, shared);
    const resolved = resolveThemeJson({ theme, blockStyleVariations: partials, user });
    const raw = resolved.tree.getRawData();
    // styles.variations.section-ink is unwrapped onto every block that registers it.
    const blocks = (raw.styles as { blocks: Record<string, { variations?: object }> }).blocks;
    for (const block of ['core/group', 'core/columns', 'core/column']) {
      expect(blocks[block]?.variations, block).toMatchObject({
        'section-ink': {
          elements: { button: { color: { background: 'var(--wp--preset--color--accent)' } } },
        },
      });
    }
  });

  it('loads only the fonts a typography variation brings, from the theme folder', () => {
    const user = applyStyleVariation({ version: 3 }, variation('typography/03-grotesk.json'));
    const { stylesheet, fontFaces } = stylesheetWith(user);
    expect(stylesheet).toContain(
      'h1, h2, h3, h4, h5, h6{font-family: var(--wp--preset--font-family--manrope);font-weight: 700;letter-spacing: -0.035em;line-height: 1.1;}',
    );
    expect(fontFaces).toContain(
      "@font-face{font-family:Manrope;font-style:normal;font-weight:200 800;font-display:swap;src:url('/t/assets/fonts/manrope/Manrope-VariableFont_wght.woff2') format('woff2');}",
    );
    // The variation's families replace the theme's, so Platypi is no longer loaded.
    expect(fontFaces).not.toContain('Platypi');
    expect(stylesheet).not.toContain('--wp--preset--font-family--platypi');
  });

  it('combines a colour and a typography variation, keeping the other choices', () => {
    let user = applyStyleVariation({ version: 3 }, variation('typography/03-grotesk.json'));
    user = applyStyleVariation(user, variation('colors/02-violet.json'));
    expect(isStyleVariationApplied(user, variation('typography/03-grotesk.json'))).toBe(true);
    expect(isStyleVariationApplied(user, variation('colors/02-violet.json'))).toBe(true);
    const { stylesheet } = stylesheetWith(user);
    expect(stylesheet).toContain('--wp--preset--color--base: #f7f5fb;');
    expect(stylesheet).toContain('--wp--preset--color--accent: #6236c9;');
    expect(stylesheet).toContain(
      'font-family: var(--wp--preset--font-family--manrope);font-weight: 700;',
    );

    // Another colour variation replaces only the colours.
    const sand = keyPresetsByOrigin(
      {
        version: 3,
        title: 'Sand',
        settings: { color: { palette: [{ color: '#f4efe6', name: 'Sand', slug: 'base' }] } },
      },
      'theme',
    ) as StyleVariation;
    user = applyStyleVariation(user, sand);
    expect(isStyleVariationApplied(user, variation('colors/02-violet.json'))).toBe(false);
    expect(isStyleVariationApplied(user, sand)).toBe(true);
    expect(isStyleVariationApplied(user, variation('typography/03-grotesk.json'))).toBe(true);

    // A full variation replaces everything.
    user = applyStyleVariation(user, variation('01-midnight.json'));
    expect(isStyleVariationApplied(user, variation('colors/02-violet.json'))).toBe(false);
    expect(isStyleVariationApplied(user, variation('typography/03-grotesk.json'))).toBe(false);
    expect(areGlobalStyleConfigsEqual(user, variation('01-midnight.json'))).toBe(true);
  });

  it('lists file:./ URLs with their resolved address', () => {
    const uris = resolvedThemeUris(variation('typography/03-grotesk.json'), (p) => `/t/${p}`);
    expect(uris[0]).toEqual({
      name: 'file:./assets/fonts/manrope/Manrope-VariableFont_wght.woff2',
      href: '/t/assets/fonts/manrope/Manrope-VariableFont_wght.woff2',
      target: 'settings.typography.fontFamilies.theme.0.fontFace.0.src.0',
    });
  });
});

describe('sanitising user global styles (remove_insecure_properties)', () => {
  const blockNames = ['core/group', 'core/button', 'core/paragraph'];

  it('passes safecss_filter_attr() values and refuses the rest', () => {
    expect(isSafeCssDeclaration('color', 'var(--wp--preset--color--base)')).toBe(true);
    expect(isSafeCssDeclaration('font-size', 'clamp(1rem, 2vw + 1rem, 3rem)')).toBe(true);
    expect(isSafeCssDeclaration('max-width', '645px')).toBe(true);
    expect(isSafeCssDeclaration('color', 'red;background:url(x)')).toBe(false);
    expect(isSafeCssDeclaration('color', 'expression(alert(1))')).toBe(false);
    expect(isSafeCssDeclaration('color', 'rgb(0 0 0)')).toBe(false);
    expect(isSafeCssDeclaration('background', 'url(javascript:alert(1))')).toBe(false);
    expect(isSafeCssDeclaration('background', "url('https://example.com/a.png')")).toBe(true);
    expect(isSafeCssDeclaration('background', 'linear-gradient(red, rgba(0,0,0,.5))')).toBe(true);
    expect(isSafeCssDeclaration('color', '</style><script>')).toBe(false);
  });

  it('drops hostile values, unknown blocks and custom CSS for users without edit_css', () => {
    const out = removeInsecureProperties(
      {
        version: 3,
        isGlobalStylesUserThemeJSON: true,
        settings: {
          color: {
            palette: {
              theme: [
                { slug: 'base', name: 'Base', color: '#fff' },
                { slug: 'bad', name: 'Bad', color: 'red;}</style><script>alert(1)</script>' },
                { slug: 'x"><img', name: 'Evil', color: '#000' },
              ],
            },
          },
          layout: { contentSize: '700px', wideSize: '1200px;}body{display:none' },
        },
        styles: {
          css: 'body{background:red}',
          color: { text: 'var:preset|color|base', background: 'red;}</style>' },
          typography: { fontSize: '18px' },
          elements: {
            link: { color: { text: '#00f' }, ':hover': { color: { text: 'url(evil)' } } },
            nonsense: { color: { text: '#f00' } },
          },
          blocks: {
            'core/group': { color: { text: '#111' }, css: '& p{color:red}' },
            'plugin/unknown': { color: { text: '#111' } },
          },
        },
      },
      { blockNames, canEditCss: false },
    );
    expect(out.isGlobalStylesUserThemeJSON).toBe(true);
    expect(out.settings).toEqual({
      color: { palette: { theme: [{ slug: 'base', name: 'Base', color: '#fff' }] } },
      layout: { contentSize: '700px' },
    });
    expect(out.styles).toEqual({
      color: { text: 'var:preset|color|base' },
      typography: { fontSize: '18px' },
      elements: { link: { color: { text: '#00f' }, ':hover': {} } },
      blocks: { 'core/group': { color: { text: '#111' } } },
    });
  });

  it('keeps custom CSS for users with edit_css', () => {
    const out = removeInsecureProperties(
      { version: 3, styles: { css: 'body{background:red}' } },
      { blockNames, canEditCss: true },
    );
    expect(out.styles).toEqual({ css: 'body{background:red}' });
  });

  it('refuses CSS that could close the style element (validate_custom_css)', () => {
    expect(validateCustomCss('p{color:red}')).toEqual({ ok: true });
    expect(validateCustomCss('a::after{content:"<"}')).toEqual({ ok: true });
    expect(validateCustomCss('p{}</style><script>alert(1)</script>')).toMatchObject({
      ok: false,
      code: 'rest_custom_css_illegal_markup',
    });
    expect(validateCustomCss('p{} </STYLE >')).toMatchObject({ ok: false });
    expect(validateCustomCss('p{} </sty')).toMatchObject({ ok: false });
    expect(validateCustomCss(42)).toMatchObject({ code: 'rest_custom_css_invalid_type' });
  });

  it('never prints user CSS that could close the style element', () => {
    const { customCss } = stylesheetWith({
      version: 3,
      styles: { css: 'p{}</style><script>alert(1)</script>' },
    });
    expect(customCss).toBe('');
    expect(stylesheetWith({ version: 3, styles: { css: 'p{color:red}' } }).customCss).toBe(
      'p{color:red}',
    );
  });
});
