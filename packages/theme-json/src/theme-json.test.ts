import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendToSelector,
  blockStyleVariationInstanceStyles,
  blockStyleVariationSelector,
  computeSpacingSizes,
  fontFaceCss,
  getBlocksMetadata,
  getChildLayoutStyle,
  getGlobalStylesheet,
  getLayoutStyle,
  resolveThemeJson,
  scopeSelector,
  splitSelectorList,
  ThemeJson,
  type ThemeJsonData,
  toKebabCase,
  typographyFontSizeValue,
} from './index';

const PRESSBASE = path.resolve(import.meta.dirname, '../../../themes/pressbase');
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as ThemeJsonData;

function pressbaseTheme() {
  const sections = path.join(PRESSBASE, 'styles', 'sections');
  return resolveThemeJson({
    theme: readJson(path.join(PRESSBASE, 'theme.json')),
    blockStyleVariations: readdirSync(sections).map((f) => readJson(path.join(sections, f))),
  });
}

describe('global stylesheet for the Pressbase theme', () => {
  const resolved = pressbaseTheme();
  const { stylesheet, fontFaces } = getGlobalStylesheet(resolved, {
    resolveFileUri: (p) => `https://example.com/wp-content/themes/pressbase/${p}`,
  });

  it('starts with the preset custom properties on :root, fluid font sizes included', () => {
    expect(stylesheet.startsWith(':root{--wp--preset--aspect-ratio--square: 1;')).toBe(true);
    expect(stylesheet).toContain('--wp--preset--color--base: #f6f6f3;');
    expect(stylesheet).toContain('--wp--preset--font-size--small: 0.875rem;');
    expect(stylesheet).toContain(
      '--wp--preset--font-size--medium: clamp(1rem, 1rem + ((1vw - 0.2rem) * 0.115), 1.0625rem);',
    );
    expect(stylesheet).toContain(
      '--wp--preset--font-size--display: clamp(2.625rem, 2.625rem + ((1vw - 0.2rem) * 5.682), 5.75rem);',
    );
    expect(stylesheet).toContain(
      '--wp--preset--font-family--fira-code: "Fira Code", ui-monospace, monospace;',
    );
    expect(stylesheet).toContain('--wp--preset--spacing--50: clamp(1.5rem, 4vw, 2.5rem);');
    // The default shadows stay alongside the theme's.
    expect(stylesheet).toContain('--wp--preset--shadow--natural: 6px 6px 9px rgba(0, 0, 0, 0.2);');
    expect(stylesheet).toContain(
      '--wp--preset--shadow--soft: 0 1px 2px rgb(20 20 18 / 0.05), 0 6px 20px -6px rgb(20 20 18 / 0.08);',
    );
    // Block-level presets go on the block's selector.
    expect(stylesheet).toContain('.wp-block-button{--wp--preset--dimension--25: 25%;');
  });

  it('prints the root layout rules with root padding aware alignments', () => {
    expect(stylesheet).toContain(
      ':root { --wp--style--global--content-size: 720px;--wp--style--global--wide-size: 1200px; }:where(body) { margin: 0; }',
    );
    expect(stylesheet).toContain(
      '.has-global-padding { padding-right: var(--wp--style--root--padding-right); padding-left: var(--wp--style--root--padding-left); }',
    );
    expect(stylesheet).toContain(
      ':where(.wp-site-blocks) > * { margin-block-start: 1.25rem; margin-block-end: 0; }',
    );
    expect(stylesheet).toContain(':root { --wp--style--block-gap: 1.25rem; }');
    expect(stylesheet).toContain(
      ':root :where(.is-layout-flow) > *{margin-block-start: 1.25rem;margin-block-end: 0;}',
    );
    expect(stylesheet).toContain(':root :where(.is-layout-flex){gap: 1.25rem;}');
    expect(stylesheet).toContain('body .is-layout-flex{display: flex;}');
    expect(stylesheet).toContain(
      '.is-layout-constrained > :where(:not(.alignleft):not(.alignright):not(.alignfull)){max-width: var(--wp--style--global--content-size);margin-left: auto !important;margin-right: auto !important;}',
    );
  });

  it('styles the body, swapping root padding for custom properties', () => {
    expect(stylesheet).toContain(
      'body{background-color: var(--wp--preset--color--base);color: var(--wp--preset--color--contrast);font-family: var(--wp--preset--font-family--manrope);font-size: var(--wp--preset--font-size--medium);font-weight: 400;letter-spacing: -0.005em;line-height: 1.65;--wp--style--root--padding-top: 0px;--wp--style--root--padding-right: var(--wp--preset--spacing--40);--wp--style--root--padding-bottom: 0px;--wp--style--root--padding-left: var(--wp--preset--spacing--40);}',
    );
  });

  it('styles elements with zero-specificity selectors and pseudo states', () => {
    expect(stylesheet).toContain(
      'a:where(:not(.wp-element-button)){color: var(--wp--preset--color--accent-text);text-decoration: underline;}',
    );
    expect(stylesheet).toContain(
      ':root :where(a:where(:not(.wp-element-button)):hover){color: var(--wp--preset--color--contrast);}',
    );
    expect(stylesheet).toContain(
      'h1, h2, h3, h4, h5, h6{font-family: var(--wp--preset--font-family--platypi);font-weight: 600;letter-spacing: -0.02em;line-height: 1.1;}',
    );
    expect(stylesheet).toContain('h1{font-size: var(--wp--preset--font-size--xxx-large);}');
    expect(stylesheet).toContain(
      ':root :where(.wp-element-button:hover, .wp-block-button__link:hover){background-color: var(--wp--preset--color--accent);color: var(--wp--preset--color--on-accent);}',
    );
    expect(stylesheet).toContain(
      ':root :where(.wp-element-button:focus, .wp-block-button__link:focus){background-color: var(--wp--preset--color--accent);color: var(--wp--preset--color--on-accent);}',
    );
  });

  it('styles blocks: feature selectors, block gap per layout, elements and custom CSS', () => {
    expect(stylesheet).toContain(
      ':root :where(.wp-block-avatar img){border-radius: var(--wp--preset--border-radius--full);}',
    );
    expect(stylesheet).toContain(
      ':root :where(.wp-block-columns-is-layout-flex){gap: var(--wp--preset--spacing--40);}',
    );
    expect(stylesheet).toContain(':root :where(.wp-block-buttons-is-layout-grid){gap: 0.75rem;}');
    expect(stylesheet).toContain(
      ':root :where(.wp-block-post-date a:where(:not(.wp-element-button))){color: var(--wp--preset--color--muted);text-decoration: none;}',
    );
    expect(stylesheet).toContain(
      ':root :where(.wp-block-quote){border-left-color: var(--wp--preset--color--accent);border-left-width: 3px;border-left-style: solid;',
    );
    // Block custom CSS: each `&` rule is scoped to the block, as process_blocks_custom_css() does.
    expect(stylesheet).toContain(
      ':root :where(.wp-block-details summary){font-weight:600;font-size:var(--wp--preset--font-size--large);cursor:pointer;}',
    );
    expect(stylesheet).toContain(':root :where(.wp-block-post-comments-form textarea){');
    expect(stylesheet).toContain(
      ':root :where(.wp-block-post-comments-form label){font-size:var(--wp--preset--font-size--small);font-weight:600;}',
    );
  });

  it('ends with the preset classes, important as WordPress makes them', () => {
    expect(stylesheet).toContain(
      '.has-base-background-color{background-color: var(--wp--preset--color--base) !important;}',
    );
    expect(stylesheet).toContain(
      '.has-small-font-size{font-size: var(--wp--preset--font-size--small) !important;}',
    );
    expect(
      stylesheet
        .trimEnd()
        .endsWith(
          '.has-fira-code-font-family{font-family: var(--wp--preset--font-family--fira-code) !important;}',
        ),
    ).toBe(true);
  });

  it('leaves block style variations out of the global stylesheet (they render per instance)', () => {
    expect(stylesheet).not.toContain('is-style-section-ink');
    expect(stylesheet).not.toContain('is-style-section-soft');
  });

  it('writes @font-face rules with theme file URLs, italic faces included', () => {
    const url = (file: string) =>
      `url('https://example.com/wp-content/themes/pressbase/assets/fonts/${file}') format('woff2')`;
    expect(fontFaces).toBe(
      [
        `@font-face{font-family:Manrope;font-style:normal;font-weight:200 800;font-display:swap;src:${url('manrope/Manrope-VariableFont_wght.woff2')};}`,
        `@font-face{font-family:Platypi;font-style:normal;font-weight:300 800;font-display:swap;src:${url('platypi/Platypi-VariableFont_wght.woff2')};}`,
        `@font-face{font-family:Platypi;font-style:italic;font-weight:300 800;font-display:swap;src:${url('platypi/Platypi-Italic-VariableFont_wght.woff2')};}`,
        `@font-face{font-family:"Fira Code";font-style:normal;font-weight:300 700;font-display:swap;src:${url('fira-code/FiraCode-VariableFont_wght.woff2')};}`,
      ].join('\n'),
    );
  });

  it('registers style variations from theme.json partials', () => {
    expect(resolved.variations['core/group']).toEqual(['section-ink', 'section-soft']);
    expect(resolved.variations['core/columns']).toEqual(['section-ink', 'section-soft']);
    expect(resolved.blocks['core/group']?.styleVariations['section-ink']).toBe(
      '.wp-block-group.is-style-section-ink',
    );
  });

  it('builds per-instance styles for a variation that styles inner elements', () => {
    const css = blockStyleVariationInstanceStyles(
      resolved,
      'core/group',
      'section-ink',
      'section-ink--1',
    );
    expect(css).toContain(
      ':root :where(.is-style-section-ink--1 a:where(:not(.wp-element-button))){color: var(--wp--preset--color--base);}',
    );
    expect(css).toContain(
      ':root :where(.is-style-section-ink--1 .wp-element-button, .is-style-section-ink--1 .wp-block-button__link){background-color: var(--wp--preset--color--base);color: var(--wp--preset--color--contrast);}',
    );
    expect(css).toContain(
      ':root :where(.wp-block-group.is-style-section-ink--1){background-color: var(--wp--preset--color--contrast);color: var(--wp--preset--color--base);}',
    );
    expect(blockStyleVariationInstanceStyles(resolved, 'core/group', 'nope', 'nope--1')).toBe('');
  });

  it("appends a variation's custom CSS without `&` to the selector as is, as WordPress does", () => {
    const withCss = resolveThemeJson({
      theme: {
        version: 3,
        styles: {
          blocks: {
            'core/button': {
              variations: {
                outline: {
                  css: ':not(.has-background):hover{background-color:red;}',
                  elements: { link: { color: { text: 'currentColor' } } },
                },
              },
            },
          },
        },
      },
    });
    const outline = blockStyleVariationInstanceStyles(
      withCss,
      'core/button',
      'outline',
      'outline--2',
    );
    expect(outline).toContain(
      ':root :where(.wp-block-button.is-style-outline--2 .wp-block-button__link:not(.has-background):hover){background-color:red;}',
    );
  });
});

describe('merging origins', () => {
  it('lets user styles override the theme, and keeps the default origin first', () => {
    const resolved = resolveThemeJson({
      theme: {
        version: 3,
        settings: { color: { palette: [{ slug: 'base', name: 'Base', color: '#fff' }] } },
        styles: { color: { text: 'var:preset|color|base' } },
      },
      user: {
        version: 3,
        settings: { color: { palette: [{ slug: 'base', name: 'Base', color: '#000' }] } },
        styles: { color: { text: '#123456' } },
      },
    });
    const css = resolved.tree.getStylesheet(
      ['variables', 'styles'],
      ['default', 'theme', 'custom'],
    );
    expect(css).toContain('--wp--preset--color--base: #000;');
    expect(css).toContain('body{color: #123456;');
    expect(css.indexOf('--wp--preset--color--black')).toBeLessThan(css.indexOf('color--base'));
  });

  it("drops a theme preset that redefines a default slug when defaults can't be overridden", () => {
    const resolved = resolveThemeJson({
      theme: {
        version: 3,
        settings: {
          color: {
            defaultPalette: true,
            palette: [
              { slug: 'black', name: 'Black', color: '#111' },
              { slug: 'brand', name: 'Brand', color: '#f00' },
            ],
          },
        },
      },
    });
    const css = resolved.tree.getStylesheet(['variables'], ['default', 'theme']);
    expect(css).toContain('--wp--preset--color--black: #000000;');
    expect(css).toContain('--wp--preset--color--brand: #f00;');
  });

  it('opts into appearance tools and names theme font sizes from the defaults', () => {
    const resolved = resolveThemeJson({
      theme: {
        version: 3,
        settings: {
          appearanceTools: true,
          typography: { defaultFontSizes: false, fontSizes: [{ slug: 'small', size: '1px' }] },
        },
      },
    });
    const settings = resolved.tree.getSettings();
    expect(settings.spacing).toMatchObject({ blockGap: true, margin: true, padding: true });
    expect(resolved.tree.getGlobalSettings().typography).toMatchObject({
      fontSizes: expect.arrayContaining([{ slug: 'small', size: '1px', name: 'Small' }]),
    });
  });

  it('strips values that could break out of a declaration from user styles', () => {
    const resolved = resolveThemeJson({
      user: {
        version: 3,
        styles: {
          color: { text: 'red;}</style><script>alert(1)</script>' },
          css: 'body{}',
          typography: { fontSize: '20px' },
        },
      },
    });
    const css = resolved.tree.getStylesheet(['styles', 'custom-css'], ['default', 'custom']);
    expect(css).not.toContain('script');
    expect(css).toContain('font-size: 20px;');
  });

  it('migrates schema version 2 themes (theme font sizes replace the defaults)', () => {
    const tree = new ThemeJson(
      { version: 2, settings: { typography: { fontSizes: [{ slug: 'big', size: '3rem' }] } } },
      'theme',
    );
    expect(tree.getSettings().typography).toMatchObject({ defaultFontSizes: false });
  });
});

describe('fluid typography (wp_get_typography_font_size_value)', () => {
  const settings = { typography: { fluid: true }, layout: { wideSize: '1340px' } };
  it('keeps sizes at or below the minimum, and non-fluid presets', () => {
    expect(typographyFontSizeValue({ size: '14px' }, settings)).toBe('14px');
    expect(typographyFontSizeValue({ size: '2rem', fluid: false }, settings)).toBe('2rem');
    expect(typographyFontSizeValue({ size: '2rem' }, {})).toBe('2rem');
  });
  it('computes a minimum from the preferred size', () => {
    expect(typographyFontSizeValue({ size: '28px' }, { typography: { fluid: true } })).toBe(
      'clamp(17.905px, 1.119rem + ((1vw - 3.2px) * 0.789), 28px)',
    );
  });
  it('uses explicit min and max', () => {
    expect(
      typographyFontSizeValue(
        { size: '1.38rem', fluid: { min: '1.125rem', max: '1.375rem' } },
        settings,
      ),
    ).toBe('clamp(1.125rem, 1.125rem + ((1vw - 0.2rem) * 0.392), 1.375rem)');
  });
  it('leaves values it cannot parse alone', () => {
    expect(typographyFontSizeValue({ size: 'var(--x)' }, settings)).toBe('var(--x)');
  });
});

describe('spacing scale (compute_spacing_sizes)', () => {
  it("generates WordPress's default spacing presets", () => {
    expect(
      computeSpacingSizes({
        operator: '*',
        increment: 1.5,
        steps: 7,
        mediumStep: 1.5,
        unit: 'rem',
      }),
    ).toEqual([
      { name: '2X-Small', slug: '20', size: '0.44rem' },
      { name: 'X-Small', slug: '30', size: '0.67rem' },
      { name: 'Small', slug: '40', size: '1rem' },
      { name: 'Medium', slug: '50', size: '1.5rem' },
      { name: 'Large', slug: '60', size: '2.25rem' },
      { name: 'X-Large', slug: '70', size: '3.38rem' },
      { name: '2X-Large', slug: '80', size: '5.06rem' },
    ]);
    expect(computeSpacingSizes({ steps: 0 })).toEqual([]);
  });
});

describe('selectors', () => {
  it('splits, appends, scopes and adds variation classes', () => {
    expect(splitSelectorList('a, b:is(.c, .d), e')).toEqual(['a', 'b:is(.c, .d)', 'e']);
    expect(appendToSelector('.a, .b', ':hover')).toBe('.a:hover, .b:hover');
    expect(scopeSelector('.x', '.a, .b')).toBe('.x .a, .x .b');
    expect(blockStyleVariationSelector('outline', '.wp-block-button .wp-block-button__link')).toBe(
      '.wp-block-button.is-style-outline .wp-block-button__link',
    );
    expect(toKebabCase('accent1')).toBe('accent-1');
    expect(toKebabCase('x-large')).toBe('x-large');
    expect(toKebabCase('fontSize')).toBe('font-size');
  });

  it('derives block selectors from block.json', () => {
    const blocks = getBlocksMetadata();
    expect(blocks['core/group']?.selector).toBe('.wp-block-group');
    expect(blocks['core/button']?.selector).toBe('.wp-block-button .wp-block-button__link');
    expect(blocks['core/image']?.selectors.border).toContain('.wp-block-image img');
    expect(blocks['core/group']?.elements.link).toBe(
      '.wp-block-group a:where(:not(.wp-element-button))',
    );
  });
});

describe('layout support styles (wp_get_layout_style)', () => {
  const base = {
    hasBlockGapSupport: true,
    gapValue: null,
    shouldSkipGapSerialization: false,
    fallbackGapValue: '0.5em',
    blockSpacing: null,
  };
  it('flex: wrapping, justification and gap', () => {
    expect(
      getLayoutStyle({
        ...base,
        selector: '.wp-container-1',
        layout: { type: 'flex', flexWrap: 'nowrap', justifyContent: 'space-between' },
        gapValue: 'var:preset|spacing|10',
      }),
    ).toBe(
      '.wp-container-1{flex-wrap:nowrap;gap:var(--wp--preset--spacing--10);justify-content:space-between;}',
    );
    expect(
      getLayoutStyle({
        ...base,
        selector: '.c',
        layout: { type: 'flex', orientation: 'vertical' },
      }),
    ).toBe('.c{flex-direction:column;align-items:flex-start;}');
  });
  it('constrained: content sizes, full-width margins and gap', () => {
    expect(
      getLayoutStyle({
        ...base,
        selector: '.c',
        layout: { type: 'constrained', contentSize: '600px' },
        blockSpacing: { padding: { left: '0', right: 'var:preset|spacing|50' } },
        gapValue: '2rem',
      }),
    ).toBe(
      '.c > :where(:not(.alignleft):not(.alignright):not(.alignfull)){max-width:600px;margin-left:auto !important;margin-right:auto !important;}' +
        '.c > .alignwide{max-width:600px;}.c .alignfull{max-width:none;}' +
        '.c > .alignfull{margin-right:calc(var(--wp--preset--spacing--50) * -1);margin-left:calc(0px * -1);}' +
        '.c > *{margin-block-start:0;margin-block-end:0;}.c > * + *{margin-block-start:2rem;margin-block-end:0;}',
    );
  });
  it('grid: columns from a minimum width', () => {
    expect(
      getLayoutStyle({
        ...base,
        selector: '.g',
        layout: { type: 'grid', minimumColumnWidth: '10rem' },
      }),
    ).toBe(
      '.g{grid-template-columns:repeat(auto-fill, minmax(min(10rem, 100%), 1fr));container-type:inline-size;}',
    );
  });
  it('child layout: fill and fixed sizes', () => {
    expect(getChildLayoutStyle('.x', { selfStretch: 'fill' })).toBe('.x{flex-grow:1;}');
    expect(getChildLayoutStyle('.x', { selfStretch: 'fixed', flexSize: '200px' })).toBe(
      '.x{flex-basis:200px;box-sizing:border-box;}',
    );
  });
  it('child layout: spans in a responsive grid collapse below the span (container query)', () => {
    // wp_get_child_layout_style_rules(): 2 × 18rem + 1 × 1.5rem gap = 37.5rem.
    expect(
      getChildLayoutStyle(
        '.x',
        { columnSpan: 2, rowSpan: 2 },
        { columnCount: 4, minimumColumnWidth: '18rem' },
      ),
    ).toBe(
      '.x{grid-column:span 2;grid-row:span 2;}' +
        '@container (max-width: 37.5rem ){.x{grid-column:1/-1;grid-row:auto;}}',
    );
    // No minimumColumnWidth but no columnCount either: 12rem columns; px widths use a 24px gap.
    expect(getChildLayoutStyle('.x', { columnStart: 3 })).toBe(
      '.x{grid-column:3;}@container (max-width: 39rem ){.x{grid-column:auto;grid-row:auto;}}',
    );
    expect(getChildLayoutStyle('.x', { columnSpan: 3 }, { minimumColumnWidth: '200px' })).toBe(
      '.x{grid-column:span 3;}@container (max-width: 648px ){.x{grid-column:1/-1;grid-row:auto;}}',
    );
    // A fixed grid (columnCount without minimumColumnWidth) keeps its spans.
    expect(getChildLayoutStyle('.x', { columnSpan: 2 }, { columnCount: 3 })).toBe(
      '.x{grid-column:span 2;}',
    );
  });
});

describe('fonts', () => {
  it('orders sources, quotes names with spaces and skips invalid faces', () => {
    expect(
      fontFaceCss(
        {
          theme: [
            {
              fontFamily: 'X',
              fontFace: [
                {
                  fontFamily: 'My Font',
                  src: ['file:./a.ttf', 'file:./a.woff2'],
                  fontWeight: '400',
                },
                { fontFamily: '', src: 'x.woff2' },
              ],
            },
          ],
        },
        (p) => `/t/${p}`,
      ),
    ).toBe(
      "@font-face{font-family:\"My Font\";font-style:normal;font-weight:400;font-display:fallback;src:url('/t/a.woff2') format('woff2'), url('/t/a.ttf') format('truetype');}",
    );
  });
});
