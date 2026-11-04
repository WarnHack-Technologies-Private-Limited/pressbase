import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  availableFontPairs,
  CONTRAST_MINIMUMS,
  checkPalette,
  contrastRatio,
  createDesign,
  DENSITIES,
  DESIGN_CHOICE_SCHEMA,
  type DesignChoice,
  FONT_PAIR_IDS,
  FONT_PAIRS,
  FONTS,
  generatePalette,
  hexToOklch,
  MOODS,
  oklchToHex,
  PALETTE_PAIRS,
  PALETTE_SLUGS,
  parseHex,
  RADII,
  radiusPresets,
  relativeLuminance,
  spacingPresets,
  toGlobalStyles,
} from './index';

/** A small seeded PRNG (mulberry32), so a failing input can be reproduced. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(next: () => number, list: readonly T[]): T =>
  list[Math.floor(next() * list.length)] as T;

const themeJson = JSON.parse(
  readFileSync(new URL('../../../themes/pressbase/theme.json', import.meta.url), 'utf8'),
) as {
  settings: {
    color: { palette: { slug: string; color: string }[] };
    border: { radiusSizes: { slug: string }[] };
    spacing: { spacingSizes: { slug: string }[] };
    typography: { fontFamilies: { slug: string; fontFamily: string }[] };
  };
};

describe('colour maths', () => {
  it('computes WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    // WebAIM's checker: #767676 on white is 4.54:1.
    expect(contrastRatio('#767676', '#fff')).toBeCloseTo(4.54, 2);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(parseHex('#abc')).toEqual([170, 187, 204]);
    expect(parseHex('#11223380')).toEqual([17, 34, 51]);
    expect(parseHex('red')).toBeNull();
  });

  it('converts hex to OKLCH and back', () => {
    const next = random(7);
    for (let i = 0; i < 500; i++) {
      const hex = `#${Math.floor(next() * 0xffffff)
        .toString(16)
        .padStart(6, '0')}`;
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
    // CSS Color 4's reference values.
    const white = hexToOklch('#ffffff');
    expect(white.l).toBeCloseTo(1, 4);
    expect(white.c).toBeCloseTo(0, 4);
    expect(hexToOklch('#ff0000').h).toBeCloseTo(29.23, 1);
  });

  it('maps colours outside sRGB into it by lowering chroma', () => {
    const hex = oklchToHex({ l: 0.9, c: 0.4, h: 250 });
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(hexToOklch(hex).l).toBeCloseTo(0.9, 2);
  });
});

describe('generatePalette()', () => {
  it('uses the Pressbase theme’s palette slugs, in its order', () => {
    const palette = generatePalette({ hue: 250, mood: 'calm' });
    expect(palette.map((c) => c.slug)).toEqual(themeJson.settings.color.palette.map((c) => c.slug));
    expect(palette.map((c) => c.slug)).toEqual([...PALETTE_SLUGS]);
    for (const entry of palette) expect(entry.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('checks the pairs the theme’s own palettes are tested on', () => {
    // The Pressbase theme's palettes pass the same pairs (apps/core/src/pressbase-theme.test.ts).
    expect(
      checkPalette(themeJson.settings.color.palette.map((c) => ({ ...c, name: c.slug }))),
    ).toEqual([]);
    const failing = checkPalette([
      { name: 'Base', slug: 'base', color: '#ffffff' },
      { name: 'Muted', slug: 'muted', color: '#aaaaaa' },
    ]);
    expect(failing).toEqual([
      expect.objectContaining({ text: 'muted', background: 'base', use: 'text', min: 4.5 }),
    ]);
  });

  it('keeps the hue and follows the mood', () => {
    const vibrant = generatePalette({ hue: 140, mood: 'vibrant' });
    const minimal = generatePalette({ hue: 140, mood: 'minimal' });
    const accent = (p: typeof vibrant) =>
      hexToOklch(p.find((c) => c.slug === 'accent')?.color ?? '');
    expect(accent(vibrant).h).toBeGreaterThan(120);
    expect(accent(vibrant).h).toBeLessThan(160);
    expect(accent(vibrant).c).toBeGreaterThan(accent(minimal).c * 3);
    // Hues wrap.
    expect(generatePalette({ hue: 400, mood: 'calm' })).toEqual(
      generatePalette({ hue: 40, mood: 'calm' }),
    );
    expect(generatePalette({ hue: -20, mood: 'calm' })).toEqual(
      generatePalette({ hue: 340, mood: 'calm' }),
    );
  });

  it('makes dark palettes with light text', () => {
    const palette = generatePalette({ hue: 20, mood: 'warm', scheme: 'dark' });
    const color = (slug: string) => palette.find((c) => c.slug === slug)?.color ?? '';
    expect(relativeLuminance(color('base'))).toBeLessThan(0.05);
    expect(relativeLuminance(color('contrast'))).toBeGreaterThan(0.8);
  });

  it('refuses unknown moods and hues that are not numbers', () => {
    expect(() => generatePalette({ hue: 10, mood: 'grumpy' as 'calm' })).toThrow('Unknown mood');
    expect(() => generatePalette({ hue: Number.NaN, mood: 'calm' })).toThrow();
  });

  // The property the design stage relies on: whatever the model picks, every
  // pair passes. 2 schemes × 2 levels × 1,500 random inputs each.
  for (const scheme of ['light', 'dark'] as const) {
    for (const contrast of ['standard', 'high'] as const) {
      it(`passes every pair for random ${scheme} palettes at ${contrast} contrast`, () => {
        const next = random(scheme.length * 31 + contrast.length);
        for (let i = 0; i < 1500; i++) {
          const hue = next() * 720 - 180;
          const mood = pick(next, MOODS);
          const palette = generatePalette({ hue, mood, contrast, scheme });
          const failures = checkPalette(palette, contrast);
          expect(failures, `hue ${hue}, ${mood}, ${scheme}, ${contrast}`).toEqual([]);
          // And the AA minimums hold whatever the level.
          for (const pair of PALETTE_PAIRS) {
            const fg = palette.find((c) => c.slug === pair.text)?.color ?? '';
            const bg = palette.find((c) => c.slug === pair.background)?.color ?? '';
            expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(
              CONTRAST_MINIMUMS.standard[pair.use],
            );
          }
        }
      });
    }
  }

  it('covers every hue in whole degrees for every mood', () => {
    for (const mood of MOODS) {
      for (let hue = 0; hue < 360; hue++) {
        expect(checkPalette(generatePalette({ hue, mood })), `${mood} ${hue}`).toEqual([]);
      }
    }
  });
});

describe('fonts and presets', () => {
  it('pairs only fonts that are open and local', () => {
    expect(FONT_PAIRS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(FONT_PAIR_IDS).size).toBe(FONT_PAIR_IDS.length);
    const themeFonts = new Map(themeJson.settings.typography.fontFamilies.map((f) => [f.slug, f]));
    for (const font of Object.values(FONTS)) {
      expect(['OFL-1.1', 'CC0-1.0']).toContain(font.license);
      expect(font.fontFamily).not.toMatch(/googleapis|gstatic|url\(/);
      // Theme fonts are the ones the Pressbase theme bundles, with the same stack.
      if (font.source === 'theme')
        expect(themeFonts.get(font.slug)?.fontFamily).toBe(font.fontFamily);
      // Stacks end with a generic family.
      expect(font.fontFamily).toMatch(/(sans-serif|serif)$/);
    }
  });

  it('offers theme-font pairs only where the theme has those fonts', () => {
    expect(availableFontPairs(['manrope', 'platypi'])).toHaveLength(FONT_PAIRS.length);
    const ids = availableFontPairs([]).map((p) => p.id);
    expect(ids).not.toContain('platypi-manrope');
    expect(ids).toContain('old-style');
  });

  it('maps radius and density to the theme’s preset slugs', () => {
    const radiusSlugs = themeJson.settings.border.radiusSizes.map((r) => r.slug);
    const spacingSlugs = themeJson.settings.spacing.spacingSizes.map((s) => s.slug);
    for (const radius of RADII) {
      expect(radiusPresets(radius).map((r) => r.slug)).toEqual(radiusSlugs);
    }
    for (const density of DENSITIES) {
      expect(spacingPresets(density).map((s) => s.slug)).toEqual(spacingSlugs);
    }
    // "comfortable" and "rounded" are the theme's own values.
    expect(spacingPresets('comfortable')).toEqual(themeJson.settings.spacing.spacingSizes);
    expect(radiusPresets('rounded')).toEqual(
      themeJson.settings.border.radiusSizes.map((r) => ({ ...r })),
    );
    expect(radiusPresets('square').every((r) => r.size === '0')).toBe(true);
    expect(spacingPresets('spacious')[6]?.size).toBe('clamp(5.85rem, 14.3vw, 11.05rem)');
  });
});

describe('createDesign() and toGlobalStyles()', () => {
  const choice: DesignChoice = {
    mood: 'earthy',
    hue: 30,
    contrast: 'standard',
    scheme: 'light',
    fontPair: 'slab-humanist',
    radius: 'subtle',
    density: 'spacious',
  };

  it('describes the choice as a JSON Schema the model answers with', () => {
    expect(DESIGN_CHOICE_SCHEMA.required).toEqual(Object.keys(choice));
    expect(DESIGN_CHOICE_SCHEMA.properties.fontPair.enum).toEqual(FONT_PAIR_IDS);
    expect(DESIGN_CHOICE_SCHEMA.properties.fontPair.description).toContain('slab-humanist:');
  });

  it('returns user global styles with the palette, presets and fonts', () => {
    const design = createDesign(choice);
    const styles = toGlobalStyles(design);
    expect(styles).toMatchObject({
      version: 3,
      isGlobalStylesUserThemeJSON: true,
      settings: {
        color: { palette: { theme: design.palette } },
        border: { radiusSizes: { theme: radiusPresets('subtle') } },
        spacing: { spacingSizes: { theme: spacingPresets('spacious') } },
        typography: {
          fontFamilies: {
            custom: [
              {
                name: 'Slab serif',
                slug: 'slab-serif',
                fontFamily: FONTS['slab-serif'].fontFamily,
              },
              { name: 'Humanist', slug: 'humanist', fontFamily: FONTS.humanist.fontFamily },
            ],
          },
        },
      },
      styles: {
        spacing: { blockGap: '1.625rem' },
        typography: { fontFamily: 'var:preset|font-family|humanist' },
        elements: {
          heading: { typography: { fontFamily: 'var:preset|font-family|slab-serif' } },
          button: { typography: { fontFamily: 'var:preset|font-family|humanist' } },
        },
      },
    });
  });

  it('adds no font families for a pair of theme fonts', () => {
    const styles = toGlobalStyles(createDesign({ ...choice, fontPair: 'platypi-manrope' }));
    expect(styles.settings).not.toHaveProperty('typography');
    const single = toGlobalStyles(createDesign({ ...choice, fontPair: 'old-style' }));
    expect(
      (single.settings.typography as { fontFamilies: { custom: unknown[] } }).fontFamilies.custom,
    ).toHaveLength(1);
  });

  it('refuses unknown font pairs', () => {
    expect(() => createDesign({ ...choice, fontPair: 'comic' as 'old-style' })).toThrow(
      'Unknown font pair',
    );
  });
});
