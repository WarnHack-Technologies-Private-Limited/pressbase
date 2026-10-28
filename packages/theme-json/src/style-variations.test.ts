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

const TT5 = path.resolve(import.meta.dirname, '../../../themes/twentytwentyfive');
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as ThemeJsonData;
const partials = ['blocks', 'sections'].flatMap((dir) =>
  readdirSync(path.join(TT5, 'styles', dir)).map((f) => readJson(path.join(TT5, 'styles', dir, f))),
);
const theme = readJson(path.join(TT5, 'theme.json'));

/** A variation as /wp/v2/global-styles/themes/{stylesheet}/variations returns it. */
const variation = (file: string) =>
  keyPresetsByOrigin(readJson(path.join(TT5, 'styles', file)), 'theme') as StyleVariation;

function stylesheetWith(user?: ThemeJsonData) {
  const resolved = resolveThemeJson({ theme, blockStyleVariations: partials, user });
  return getGlobalStylesheet(resolved, { resolveFileUri: (p) => `/t/${p}` });
}

describe('theme style variations (styles/*.json)', () => {
  it('tells full, colour and typography variations apart, as the site editor does', () => {
    expect(styleVariationKind(variation('01-evening.json'))).toBe('full');
    expect(styleVariationKind(variation('03-dusk.json'))).toBe('full');
    expect(styleVariationKind(variation('colors/02-noon.json'))).toBe('color');
    expect(styleVariationKind(variation('typography/typography-preset-1.json'))).toBe('typography');
    expect(styleVariationKind({ title: 'Default' })).toBe('full');
    expect(styleVariationScope(readJson(path.join(TT5, 'styles/blocks/01-display.json')))).toBe(
      'block',
    );
    expect(styleVariationScope(variation('01-evening.json'))).toBe('theme');
  });

  it('keys preset lists by origin, leaving preset references as written', () => {
    const evening = variation('01-evening.json');
    expect(evening.settings?.color).toMatchObject({
      palette: {
        theme: expect.arrayContaining([{ color: '#1B1B1B', name: 'Base', slug: 'base' }]),
      },
    });
    expect(evening.styles?.color).toEqual({ text: 'var:preset|color|accent-4' });
  });

  it('merges Evening over Twenty Twenty-Five as WordPress merges the user origin', () => {
    const user = applyStyleVariation(
      { version: 3, isGlobalStylesUserThemeJSON: true },
      variation('01-evening.json'),
    );
    const { stylesheet } = stylesheetWith(user);
    // The variation's palette replaces the theme's (same slugs, custom origin wins).
    expect(stylesheet).toContain('--wp--preset--color--base: #1B1B1B;');
    expect(stylesheet).toContain('--wp--preset--color--accent-6: #FFFFFF33;');
    expect(stylesheet).not.toContain('--wp--preset--color--base: #FFFFFF;');
    // Root styles: the variation's text colour over the theme's other body styles.
    expect(stylesheet).toContain(
      'body{background-color: var(--wp--preset--color--base);color: var(--wp--preset--color--accent-4);font-family: var(--wp--preset--font-family--manrope);',
    );
    // Element styles merge key by key: the theme's button radius stays, the colours change.
    expect(stylesheet).toMatch(
      /:root :where\(\.wp-element-button, \.wp-block-button__link\)\{background-color: var\(--wp--preset--color--contrast\);[^}]*color: var\(--wp--preset--color--base\);/,
    );
    // Theme presets the variation doesn't touch are kept.
    expect(stylesheet).toContain('--wp--preset--font-family--manrope: Manrope, sans-serif;');
  });

  it('applies shared section variations from a style variation to block instances', () => {
    const user = applyStyleVariation({ version: 3 }, variation('01-evening.json'));
    const resolved = resolveThemeJson({ theme, blockStyleVariations: partials, user });
    const raw = resolved.tree.getRawData();
    // styles.variations.section-2 is unwrapped onto every block that registers it.
    expect(
      (raw.styles as Record<string, unknown> & { blocks: Record<string, { variations?: object }> })
        .blocks['core/group']?.variations,
    ).toMatchObject({
      'section-2': {
        elements: { button: { color: { background: 'var(--wp--preset--color--base)' } } },
      },
    });
  });

  it('loads the fonts a typography variation brings, from the theme folder', () => {
    const user = applyStyleVariation(
      { version: 3 },
      variation('typography/typography-preset-1.json'),
    );
    const { stylesheet, fontFaces } = stylesheetWith(user);
    expect(stylesheet).toContain('--wp--preset--font-family--beiruti: Beiruti, sans-serif;');
    expect(stylesheet).toContain(
      'body{background-color: var(--wp--preset--color--base);color: var(--wp--preset--color--contrast);font-family: var(--wp--preset--font-family--literata);',
    );
    expect(fontFaces).toContain(
      "@font-face{font-family:Beiruti;font-style:normal;font-weight:200 900;font-display:fallback;src:url('/t/assets/fonts/beiruti/Beiruti-VariableFont_wght.woff2') format('woff2');}",
    );
    // The variation's families replace the theme's, so Manrope is no longer loaded.
    expect(fontFaces).not.toContain('Manrope');
  });

  it('combines a colour and a typography variation, keeping the other choices', () => {
    let user = applyStyleVariation(
      { version: 3 },
      variation('typography/typography-preset-1.json'),
    );
    user = applyStyleVariation(user, variation('colors/02-noon.json'));
    expect(isStyleVariationApplied(user, variation('typography/typography-preset-1.json'))).toBe(
      true,
    );
    expect(isStyleVariationApplied(user, variation('colors/02-noon.json'))).toBe(true);
    const { stylesheet } = stylesheetWith(user);
    expect(stylesheet).toContain('--wp--preset--color--base: #F8F7F5;');
    expect(stylesheet).toContain('--wp--preset--font-family--literata: Literata, serif;');

    // Another colour variation replaces only the colours.
    user = applyStyleVariation(user, variation('colors/01-evening.json'));
    expect(isStyleVariationApplied(user, variation('colors/02-noon.json'))).toBe(false);
    expect(isStyleVariationApplied(user, variation('typography/typography-preset-1.json'))).toBe(
      true,
    );
    // A full variation replaces everything.
    user = applyStyleVariation(user, variation('03-dusk.json'));
    expect(isStyleVariationApplied(user, variation('typography/typography-preset-1.json'))).toBe(
      false,
    );
    expect(areGlobalStyleConfigsEqual(user, variation('03-dusk.json'))).toBe(true);
  });

  it('lists file:./ URLs with their resolved address', () => {
    const uris = resolvedThemeUris(
      variation('typography/typography-preset-1.json'),
      (p) => `/t/${p}`,
    );
    expect(uris[0]).toEqual({
      name: 'file:./assets/fonts/beiruti/Beiruti-VariableFont_wght.woff2',
      href: '/t/assets/fonts/beiruti/Beiruti-VariableFont_wght.woff2',
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
