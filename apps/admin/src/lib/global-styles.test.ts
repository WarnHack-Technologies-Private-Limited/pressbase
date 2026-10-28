import { describe, expect, it } from 'vitest';
import {
  applyVariation,
  configsEqual,
  contrastRatio,
  fontFaceCss,
  isVariationApplied,
  lengthToPx,
  palette,
  presetSlug,
  resolveColor,
  setFont,
  setPaletteColor,
  setPath,
  setRoleColor,
  styleValue,
  variationKind,
} from './global-styles';

const base = {
  settings: {
    color: {
      palette: {
        default: [{ slug: 'black', name: 'Black', color: '#000000' }],
        theme: [
          { slug: 'base', name: 'Base', color: '#FFFFFF' },
          { slug: 'contrast', name: 'Contrast', color: '#111111' },
          { slug: 'accent-1', name: 'Accent 1', color: '#FFEE58' },
        ],
      },
    },
  },
  styles: {
    color: { background: 'var:preset|color|base', text: 'var:preset|color|contrast' },
    elements: { button: { color: { background: 'var:preset|color|contrast' } } },
  },
};

const evening = {
  title: 'Evening',
  settings: { color: { palette: { theme: [{ slug: 'base', name: 'Base', color: '#1B1B1B' }] } } },
  styles: { color: { text: 'var:preset|color|base' }, typography: { fontSize: '20px' } },
};
const noon = {
  title: 'Noon',
  settings: { color: { palette: { theme: [{ slug: 'base', name: 'Base', color: '#F8F7F5' }] } } },
  styles: { color: { text: 'var:preset|color|contrast' } },
};
const pairing = {
  title: 'Beiruti & Literata',
  settings: {
    typography: {
      fontFamilies: { theme: [{ slug: 'beiruti', name: 'Beiruti', fontFamily: 'Beiruti' }] },
    },
  },
  styles: { typography: { fontFamily: 'var:preset|font-family|beiruti' } },
};

describe('style variations', () => {
  it('sorts variations into full, colour and typography', () => {
    expect(variationKind(evening)).toBe('full');
    expect(variationKind(noon)).toBe('color');
    expect(variationKind(pairing)).toBe('typography');
    expect(variationKind({})).toBe('full');
  });

  it('replaces everything with a full variation, only colours or type with partial ones', () => {
    let user = applyVariation({}, pairing);
    user = applyVariation(user, noon);
    expect(isVariationApplied(user, noon)).toBe(true);
    expect(isVariationApplied(user, pairing)).toBe(true);
    user = applyVariation(user, evening);
    expect(isVariationApplied(user, pairing)).toBe(false);
    expect(configsEqual(user, evening)).toBe(true);
    expect(isVariationApplied({}, {})).toBe(true);
    expect(isVariationApplied(user, {})).toBe(false);
  });
});

describe('reading and editing user styles', () => {
  it('reads the effective palette and styles, user first', () => {
    expect(palette(base, {}).map((c) => c.slug)).toEqual(['base', 'contrast', 'accent-1']);
    expect(palette(base, evening)[0]?.color).toBe('#1B1B1B');
    expect(styleValue(base, evening, ['color', 'text'])).toBe('var:preset|color|base');
    expect(styleValue(base, evening, ['color', 'background'])).toBe('var:preset|color|base');
    expect(resolveColor('var:preset|color|contrast', palette(base, {}))).toBe('#111111');
    expect(resolveColor('#abcdef', [])).toBe('#abcdef');
    expect(presetSlug('var(--wp--preset--color--accent-1)', 'color')).toBe('accent-1');
  });

  it('edits palette colours, fonts and paths without touching the input', () => {
    const user = {};
    const next = setPaletteColor(user, palette(base, user), 'base', '#FAFAFA');
    expect(user).toEqual({});
    expect(next.settings?.color.palette.theme[0]).toEqual({
      slug: 'base',
      name: 'Base',
      color: '#FAFAFA',
    });
    expect(next.settings?.color.palette.theme).toHaveLength(3);
    expect(setFont({}, 'heading', 'beiruti').styles).toEqual({
      elements: { heading: { typography: { fontFamily: 'var:preset|font-family|beiruti' } } },
    });
    const sized = setPath({}, ['settings', 'layout', 'contentSize'], '700px');
    expect(setPath(sized, ['settings', 'layout', 'contentSize'], undefined)).toEqual({});
  });

  it('gives buttons the text colour that reads best on the accent', () => {
    const user = setRoleColor(base, {}, 'accent', 'var:preset|color|accent-1');
    expect(user.styles?.elements.button.color).toEqual({
      background: 'var:preset|color|accent-1',
      text: 'var:preset|color|contrast',
    });
    expect(user.styles?.elements.link.color.text).toBe('var:preset|color|accent-1');
    expect(user.styles?.elements.button[':hover'].color.background).toBe(
      'color-mix(in srgb, var(--wp--preset--color--accent-1) 85%, transparent)',
    );
    const dark = setRoleColor(base, {}, 'accent', '#202020');
    expect(dark.styles?.elements.button.color.text).toBe('var:preset|color|base');
  });

  it('measures contrast and lengths', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
    expect(contrastRatio('red', '#fff')).toBeUndefined();
    expect(lengthToPx('1.5rem')).toBe(24);
    expect(lengthToPx('645px')).toBe(645);
    expect(lengthToPx('50%')).toBeUndefined();
  });

  it('turns theme fonts into @font-face rules, refusing odd sources', () => {
    const css = fontFaceCss(
      [
        {
          slug: 'a',
          name: 'A',
          fontFamily: 'A',
          fontFace: [
            { src: ['file:./fonts/a.woff2'], fontWeight: '200 900' },
            { src: 'javascript:alert(1)' },
            { src: ['file:./x") ;}body{color:red'] },
          ],
        },
      ],
      '/wp-content/themes/t',
    );
    expect(css).toBe(
      '@font-face{font-family:"A";font-style:normal;font-weight:200 900;font-display:swap;src:url("/wp-content/themes/t/fonts/a.woff2");}',
    );
  });
});
