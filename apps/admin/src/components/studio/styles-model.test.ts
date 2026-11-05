import { describe, expect, it } from 'vitest';
import type { GlobalStylesConfig } from '../../lib/global-styles';
import { CONTROLS, showsControl } from './mode-model';
import {
  BUTTON_SIZES,
  blockStyleSupports,
  buttonSize,
  cornerScale,
  EXAMPLE_IMAGE,
  exampleAttributes,
  exampleInnerBlocks,
  hasBlockStyles,
  hasStyleControls,
  isForeignEntry,
  paddingPreset,
  pickConfig,
  radiusSizes,
  resetBlockStyles,
  STYLES_SCREENS,
  setButtonColor,
  setCornerScale,
  setPadding,
  shadowPresets,
  spacingSizes,
  styleBookSections,
  stylesEntry,
  stylesKey,
  styleTarget,
} from './styles-model';

const live: GlobalStylesConfig = { settings: {}, styles: { color: { text: '#111111' } } };

const theme: GlobalStylesConfig = {
  settings: {
    border: {
      radiusSizes: {
        theme: [
          { slug: 'sm', name: 'Small', size: '4px' },
          { slug: 'lg', name: 'Large', size: '1.5rem' },
          { slug: 'full', name: 'Full', size: '9999px' },
        ],
      },
    },
    spacing: { spacingSizes: { theme: [{ slug: '40', name: 'Medium', size: '1rem' }] } },
    shadow: {
      presets: {
        default: [{ slug: 'natural', name: 'Natural', shadow: '6px 6px 9px rgba(0,0,0,.2)' }],
      },
    },
  },
  styles: {},
};

describe('the draft entry', () => {
  it('is wp_global_styles:{stylesheet}, holding settings and styles only', () => {
    expect(stylesKey('pressbase')).toBe('wp_global_styles:pressbase');
    expect(pickConfig({ styles: { css: 'a{}' }, title: 'x', id: 3 })).toEqual({
      settings: {},
      styles: { css: 'a{}' },
    });
    expect(pickConfig('nope')).toEqual({ settings: {}, styles: {} });
  });

  it('is left out when the styles are what visitors see', () => {
    expect(stylesEntry({ styles: { color: { text: '#111111' } } }, live)).toBeNull();
    expect(stylesEntry({ styles: { color: { text: '#222222' } } }, live)).toEqual({
      settings: {},
      styles: { color: { text: '#222222' } },
    });
  });

  it('takes up entries written elsewhere, but not its own', () => {
    const mine = { settings: {}, styles: { color: { text: '#222222' } } };
    expect(isForeignEntry(undefined, mine, null)).toBe(false);
    expect(isForeignEntry(mine, mine, null)).toBe(false);
    // The panel moved on; the draft still holds what it last sent.
    expect(isForeignEntry(mine, { styles: { color: { text: '#333333' } } }, mine)).toBe(false);
    // History restored a version, or an AI edit changed the palette.
    expect(isForeignEntry({ styles: { color: { text: '#444444' } } }, mine, mine)).toBe(true);
  });
});

describe('block styles', () => {
  it('reads what a block supports as WordPress does', () => {
    const button = blockStyleSupports({
      color: { background: true, text: true },
      typography: { fontSize: true, __experimentalFontFamily: true },
      spacing: { padding: true },
      __experimentalBorder: { radius: true, width: true, color: true, style: true },
      shadow: true,
    });
    expect(button).toEqual({
      text: true,
      background: true,
      link: false,
      fontFamily: true,
      fontSize: true,
      padding: true,
      radius: true,
      border: true,
      shadow: true,
    });
    const image = blockStyleSupports({ border: { radius: true } });
    expect(image.radius).toBe(true);
    expect(image.border).toBe(false);
    expect(blockStyleSupports({ color: { text: false, link: true } })).toMatchObject({
      text: false,
      background: true,
      link: true,
    });
    expect(hasStyleControls(blockStyleSupports({ html: false }))).toBe(false);
  });

  it('changes and resets one block', () => {
    const config = setPadding({ styles: {} }, ['styles', 'blocks', 'core/quote'], '40');
    expect(hasBlockStyles(config, 'core/quote')).toBe(true);
    expect(paddingPreset(config.styles?.blocks?.['core/quote']?.spacing?.padding)).toBe('40');
    expect(paddingPreset({ top: 'var:preset|spacing|40', bottom: '1rem' })).toBeUndefined();
    expect(hasBlockStyles(resetBlockStyles(config, 'core/quote'), 'core/quote')).toBe(false);
  });
});

describe('presets', () => {
  it('come from the user, else the theme, else WordPress', () => {
    expect(radiusSizes(theme, {}).map((s) => s.slug)).toEqual(['sm', 'lg', 'full']);
    expect(spacingSizes(theme, {}).map((s) => s.slug)).toEqual(['40']);
    expect(shadowPresets(theme, {}).map((s) => s.slug)).toEqual(['natural']);
    const user = { settings: { border: { radiusSizes: { theme: [{ slug: 'sm', size: '0' }] } } } };
    expect(radiusSizes(theme, user)).toEqual([{ slug: 'sm', size: '0' }]);
  });
});

describe('corners', () => {
  it('scale every corner size together, and keep pills', () => {
    const round = setCornerScale(theme, {}, 1.75);
    expect(radiusSizes(theme, round).map((s) => s.size)).toEqual(['7px', '2.625rem', '9999px']);
    expect(cornerScale(theme, round)).toBe('round');
    const square = setCornerScale(theme, round, 0);
    expect(radiusSizes(theme, square).map((s) => s.size)).toEqual(['0', '0', '9999px']);
    expect(cornerScale(theme, square)).toBe('square');
    const back = setCornerScale(theme, square, 1);
    expect(back.settings?.border?.radiusSizes).toBeUndefined();
    expect(cornerScale(theme, back)).toBe('theme');
  });
});

describe('buttons', () => {
  it('know their size from their padding', () => {
    const large = BUTTON_SIZES.find((s) => s.id === 'large');
    const config = { styles: { elements: { button: { spacing: { padding: large?.padding } } } } };
    expect(buttonSize(config)).toBe('large');
    expect(buttonSize({})).toBeUndefined();
  });

  it('keep a hover colour that follows the new one', () => {
    const next = setButtonColor({}, 'background', 'var:preset|color|accent');
    expect(next.styles?.elements?.button).toEqual({
      color: { background: 'var:preset|color|accent' },
      ':hover': {
        color: {
          background: 'color-mix(in srgb, var(--wp--preset--color--accent) 85%, transparent)',
        },
      },
    });
    const text = setButtonColor(next, 'text', '#ffffff');
    expect(text.styles?.elements?.button?.[':hover']?.color?.text).toBe('#ffffff');
    const reset = setButtonColor(text, 'background', undefined);
    expect(reset.styles?.elements?.button?.color).toEqual({ text: '#ffffff' });
  });
});

describe('the panel’s screens and modes', () => {
  it('put Additional CSS in Advanced only, for people with edit_css', () => {
    const css = STYLES_SCREENS.find((s) => s.id === 'css');
    expect(css).toMatchObject({ control: 'additional-css', css: true });
    expect(showsControl('simple', 'additional-css')).toBe(false);
    expect(showsControl('advanced', 'additional-css')).toBe(true);
    // The design system is in every mode.
    for (const id of ['looks', 'colors', 'fonts', 'spacing', 'buttons', 'blocks']) {
      expect(STYLES_SCREENS.find((s) => s.id === id)?.control).toBeUndefined();
    }
    // Borders and shadows are Advanced controls.
    for (const id of ['borders', 'shadows', 'states']) {
      expect(CONTROLS.find((c) => c.id === id)?.mode).toBe('advanced');
    }
  });
});

describe('the style book', () => {
  const type = (name: string, category: string, title = name, more = {}) => ({
    name,
    title,
    category,
    example: true,
    inserter: true,
    ...more,
  });

  it('shows every block type with an example, by category, the common ones first', () => {
    const sections = styleBookSections([
      type('core/verse', 'text', 'Poetry'),
      type('core/paragraph', 'text', 'Paragraph'),
      type('core/heading', 'text', 'Heading', { example: false }),
      type('core/code', 'text', 'Code'),
      type('core/buttons', 'design', 'Buttons'),
      type('core/spacer', 'design', 'Spacer'),
      type('core/group', 'design', 'Group'),
      type('core/image', 'media', 'Image'),
      type('core/embed', 'embed', 'Embed'),
      type('core/missing', 'text', 'Missing', { example: false }),
      type('core/hidden', 'text', 'Hidden', { inserter: false }),
      type('core/calendar', 'widgets', 'Calendar'),
    ]);
    expect(sections.map((s) => [s.slug, s.blocks])).toEqual([
      ['text', ['core/heading', 'core/paragraph', 'core/code', 'core/verse']],
      ['buttons', ['core/buttons']],
      ['media', ['core/image']],
      ['layout', ['core/group', 'core/spacer']],
      ['widgets', ['core/calendar']],
    ]);
  });

  it('opens a Button’s styles from the Buttons example', () => {
    expect(styleTarget('core/buttons')).toBe('core/button');
    expect(styleTarget('core/quote')).toBe('core/quote');
  });

  it('shows the site’s styles, not an example’s own, and loads no pictures from elsewhere', () => {
    expect(
      exampleAttributes({
        url: 'https://s.w.org/images/core/5.3/MtBlanc1.jpg',
        style: { color: { text: 'red' } },
        images: [{ url: 'http://example.com/a.jpg', alt: 'A' }],
        caption: 'Mont Blanc',
      }),
    ).toEqual({
      url: EXAMPLE_IMAGE,
      images: [{ url: EXAMPLE_IMAGE, alt: 'A' }],
      caption: 'Mont Blanc',
    });
    expect(
      exampleInnerBlocks([
        {
          name: 'core/image',
          attributes: { url: 'https://x.test/b.jpg', style: {} },
          innerBlocks: [],
        },
      ]),
    ).toEqual([{ name: 'core/image', attributes: { url: EXAMPLE_IMAGE }, innerBlocks: [] }]);
  });
});
