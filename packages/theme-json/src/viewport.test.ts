import { describe, expect, it } from 'vitest';
import {
  blockStyleVariationInstanceStyles,
  getGlobalStylesheet,
  getViewportMediaQueries,
  removeInsecureProperties,
  resolveThemeJson,
  sanitizeViewportSettings,
  type ThemeJsonData,
} from './index';

/**
 * Fixtures for WordPress 7.1's responsive styles. The expected CSS was
 * written by following WP_Theme_JSON::get_block_nodes(),
 * get_styles_for_block() and get_layout_styles() (class-wp-theme-json.php,
 * WordPress 7.1.3) by hand for the same theme.json.
 */

describe('viewport breakpoints (get_viewport_media_queries())', () => {
  it('defaults to mobile 480px and tablet 782px, with ranges that do not overlap', () => {
    expect(getViewportMediaQueries()).toEqual({
      '@mobile': '@media (width <= 480px)',
      '@tablet': '@media (480px < width <= 782px)',
    });
    expect(getViewportMediaQueries(undefined, { includeDesktop: true })).toEqual({
      '@mobile': '@media (width <= 480px)',
      '@tablet': '@media (480px < width <= 782px)',
      '@desktop': '@media (width > 782px)',
    });
  });

  it('takes px, em and rem lengths and keeps their units', () => {
    expect(getViewportMediaQueries({ mobile: ' 30em ', tablet: '64rem' })).toEqual({
      '@mobile': '@media (width <= 30em)',
      '@tablet': '@media (30em < width <= 64rem)',
    });
  });

  it('sanitizes like sanitize_viewport_settings()', () => {
    // Nothing valid: the defaults.
    expect(sanitizeViewportSettings('480px')).toEqual({ mobile: '480px', tablet: '782px' });
    expect(sanitizeViewportSettings({ mobile: '50%', tablet: 'calc(1px)' })).toEqual({
      mobile: '480px',
      tablet: '782px',
    });
    expect(sanitizeViewportSettings({ mobile: 480 })).toEqual({ mobile: '480px', tablet: '782px' });
    // One valid value stays alone, with a single max-width query.
    expect(sanitizeViewportSettings({ tablet: '900px', mobile: 'x' })).toEqual({ tablet: '900px' });
    expect(getViewportMediaQueries({ tablet: '900px' })).toEqual({
      '@tablet': '@media (width <= 900px)',
    });
    expect(getViewportMediaQueries({ mobile: '600px' }, { includeDesktop: true })).toEqual({
      '@mobile': '@media (width <= 600px)',
      '@desktop': '@media (width > 600px)',
    });
    // A tablet breakpoint not larger than mobile (compared at 16px per em) is dropped.
    expect(sanitizeViewportSettings({ mobile: '40em', tablet: '640px' })).toEqual({
      mobile: '40em',
    });
    expect(sanitizeViewportSettings({ mobile: '.5rem', tablet: '9px' })).toEqual({
      mobile: '.5rem',
      tablet: '9px',
    });
  });
});

const theme = (data: ThemeJsonData) => getGlobalStylesheet(resolveThemeJson({ theme: data }));

describe('@mobile and @tablet styles in the global stylesheet', () => {
  const { stylesheet } = theme({
    version: 3,
    settings: { spacing: { blockGap: true } },
    styles: {
      blocks: {
        'core/heading': {
          typography: { fontSize: '3rem' },
          '@mobile': {
            typography: { fontSize: '2rem' },
            elements: {
              link: { color: { text: 'red' }, ':hover': { color: { text: 'blue' } } },
            },
          },
          '@tablet': { typography: { fontSize: '2.5rem' }, css: '& em{color:red}' },
        },
        'core/button': {
          ':hover': { color: { background: 'black' } },
          '@mobile': { ':hover': { color: { background: 'red' } }, border: { radius: '0' } },
        },
        'core/group': { '@tablet': { spacing: { blockGap: '1rem' } } },
      },
    },
  });

  it('follows each block node with its breakpoint nodes, then its elements', () => {
    expect(stylesheet).toContain(
      ':root :where(.wp-block-heading){font-size: 3rem;}' +
        '@media (width <= 480px){:root :where(.wp-block-heading){font-size: 2rem;}}' +
        '@media (480px < width <= 782px){:root :where(.wp-block-heading){font-size: 2.5rem;}:root :where(.wp-block-heading em){color:red}}' +
        '@media (width <= 480px){:root :where(.wp-block-heading a:where(:not(.wp-element-button))){color: red;}}' +
        '@media (width <= 480px){:root :where(.wp-block-heading a:where(:not(.wp-element-button)):hover){color: blue;}}',
    );
  });

  it('puts a breakpoint pseudo state right after the default one', () => {
    expect(stylesheet).toContain(
      '@media (width <= 480px){:root :where(.wp-block-button .wp-block-button__link){border-radius: 0;}}' +
        ':root :where(.wp-block-button .wp-block-button__link:hover){background-color: black;}' +
        '@media (width <= 480px){:root :where(.wp-block-button .wp-block-button__link:hover){background-color: red;}}',
    );
  });

  it('prints a breakpoint block gap as layout rules inside the media query', () => {
    expect(stylesheet).toContain(
      '@media (480px < width <= 782px){:root :where(.wp-block-group-is-layout-flow) > :first-child{margin-block-start: 0;}',
    );
    expect(stylesheet).toContain(
      ':root :where(.wp-block-group-is-layout-flex){gap: 1rem;}:root :where(.wp-block-group-is-layout-grid){gap: 1rem;}}',
    );
  });

  it('uses the theme breakpoints, and ignores states they do not define', () => {
    const custom = theme({
      version: 3,
      settings: { viewport: { tablet: '60rem' } },
      styles: {
        blocks: {
          'core/heading': {
            '@mobile': { color: { text: 'red' } },
            '@tablet': { color: { text: 'blue' } },
          },
        },
      },
    }).stylesheet;
    expect(custom).toContain('@media (width <= 60rem){:root :where(.wp-block-heading){color: blue;}}');
    expect(custom).not.toContain('color: red');
  });

  it('prints nothing new without responsive values', () => {
    const plain = theme({ version: 3, styles: { blocks: { 'core/heading': { color: { text: 'red' } } } } });
    expect(plain.stylesheet).not.toContain('@media');
  });
});

describe('@mobile and @tablet in block style variations (per instance)', () => {
  it('prints feature, base, custom CSS, block gap and element rules per breakpoint, pseudo states last', () => {
    const resolved = resolveThemeJson({
      theme: {
        version: 3,
        settings: { viewport: { mobile: '600px', tablet: '64rem' } },
        styles: {
          blocks: {
            'core/group': {
              variations: {
                'section-1': {
                  color: { background: 'white' },
                  '@mobile': {
                    color: { background: 'red' },
                    spacing: { blockGap: '2px' },
                    elements: {
                      link: { color: { text: 'blue' }, ':hover': { color: { text: 'green' } } },
                    },
                    css: '& p{margin:0}',
                  },
                },
              },
            },
          },
        },
      },
      registeredStyles: { 'core/group': ['section-1'] },
    });
    const v = '.wp-block-group.is-style-section-1--1';
    const gap = (type: string) =>
      `:root :where(${v}.wp-block-group-is-layout-${type}) > :first-child{margin-block-start: 0;}` +
      `:root :where(${v}.wp-block-group-is-layout-${type}) > :last-child{margin-block-end: 0;}` +
      `:root :where(${v}.wp-block-group-is-layout-${type}) > *{margin-block-start: 2px;margin-block-end: 0;}`;
    expect(
      blockStyleVariationInstanceStyles(resolved, 'core/group', 'section-1', 'section-1--1'),
    ).toBe(
      `:root :where(${v}){background-color: white;}` +
        `@media (width <= 600px){:root :where(${v}){background-color: red;}}` +
        `@media (width <= 600px){:root :where(${v} p){margin:0}}` +
        `@media (width <= 600px){${gap('flow')}${gap('constrained')}` +
        `:root :where(${v}.wp-block-group-is-layout-flex){gap: 2px;}` +
        `:root :where(${v}.wp-block-group-is-layout-grid){gap: 2px;}}` +
        `@media (width <= 600px){:root :where(${v} a:where(:not(.wp-element-button))){color: blue;}}` +
        `@media (width <= 600px){:root :where(${v} a:where(:not(.wp-element-button)):hover){color: green;}}`,
    );
  });
});

describe('settings.viewport and user styles', () => {
  it('sanitizes settings.viewport and drops it from block settings', () => {
    const resolved = resolveThemeJson({
      theme: {
        version: 3,
        settings: {
          viewport: { mobile: '20rem', tablet: 'bad', desktop: '1200px' },
          blocks: { 'core/heading': { viewport: { mobile: '1px' } } },
        },
      },
    });
    const settings = resolved.tree.getSettings();
    expect(settings.viewport).toEqual({ mobile: '20rem' });
    expect((settings.blocks as Record<string, Record<string, unknown>>)['core/heading']).toEqual({});
  });

  it('keeps safe breakpoint styles of user global styles (remove_insecure_properties())', () => {
    const out = removeInsecureProperties(
      {
        version: 3,
        settings: { viewport: { mobile: '400px', tablet: 'x' } },
        styles: {
          blocks: {
            'core/button': {
              '@mobile': {
                color: { text: 'red', background: 'url(javascript:alert(1))' },
                ':hover': { color: { text: 'blue' } },
                elements: { link: { color: { text: 'green' } } },
                css: 'color: red',
              },
              '@desktop': { color: { text: 'red' } },
            },
          },
        },
      },
      { blockNames: ['core/button'], canEditCss: false },
    );
    expect(out.settings).toEqual({ viewport: { mobile: '400px' } });
    expect(out.styles).toEqual({
      blocks: {
        'core/button': {
          '@mobile': {
            color: { text: 'red' },
            ':hover': { color: { text: 'blue' } },
            elements: { link: { color: { text: 'green' } } },
          },
        },
      },
    });
  });
});
