import { describe, expect, it } from 'vitest';
import {
  columnWidth,
  fractionLabel,
  presetValue,
  resizeColumns,
  type SpacingPreset,
  shares,
  snapFraction,
  snapSpacing,
  spacingPx,
  spacingSides,
  stepColumns,
  stepSpacing,
  storedSpacing,
  withSpacing,
} from './handles-model';

const presets: SpacingPreset[] = [
  { slug: '50', name: 'Medium', px: 24 },
  { slug: '20', name: '2X-Small', px: 8 },
  { slug: '30', name: 'Small', px: 16 },
  { slug: '70', name: 'Large', px: 48 },
];

describe('which sides', () => {
  it('reads WordPress’s spacing supports', () => {
    expect(spacingSides({ padding: true }, 'padding')).toEqual(['top', 'right', 'bottom', 'left']);
    expect(spacingSides({ margin: ['top', 'bottom'] }, 'margin')).toEqual(['top', 'bottom']);
    expect(spacingSides({ margin: ['vertical'] }, 'margin')).toEqual(['top', 'bottom']);
    expect(spacingSides({ padding: ['horizontal'] }, 'padding')).toEqual(['right', 'left']);
    expect(spacingSides({ blockGap: true }, 'padding')).toEqual([]);
    expect(spacingSides(undefined, 'margin')).toEqual([]);
  });
});

describe('snapping spacing', () => {
  it('snaps to the nearest preset, or none, in Simple', () => {
    expect(snapSpacing(22, 'simple', presets)).toMatchObject({
      value: presetValue('50'),
      px: 24,
      preset: { name: 'Medium' },
    });
    expect(snapSpacing(3, 'simple', presets)).toEqual({ value: '0', px: 0 });
    expect(snapSpacing(500, 'simple', presets).value).toBe('var:preset|spacing|70');
  });

  it('takes exact pixels in Advanced, from 0 to 400', () => {
    expect(snapSpacing(22.4, 'advanced', presets)).toEqual({ value: '22px', px: 22 });
    expect(snapSpacing(-10, 'advanced', presets)).toEqual({ value: '0', px: 0 });
    expect(snapSpacing(900, 'advanced', presets).value).toBe('400px');
  });

  it('takes pixels in Simple too when the theme has no presets', () => {
    expect(snapSpacing(13.2, 'simple', [])).toEqual({ value: '13px', px: 13 });
  });
});

describe('arrow keys on a spacing handle', () => {
  it('moves preset by preset in Simple', () => {
    expect(stepSpacing(0, 1, 'simple', presets).preset?.name).toBe('2X-Small');
    expect(stepSpacing(24, 1, 'simple', presets).preset?.name).toBe('Large');
    expect(stepSpacing(24, -1, 'simple', presets).preset?.name).toBe('Small');
    // Between presets: to the next one in that direction.
    expect(stepSpacing(20, 1, 'simple', presets).preset?.name).toBe('Medium');
    expect(stepSpacing(20, -1, 'simple', presets).preset?.name).toBe('Small');
    expect(stepSpacing(8, -1, 'simple', presets)).toEqual({ value: '0', px: 0 });
    expect(stepSpacing(0, -1, 'simple', presets)).toEqual({ value: '0', px: 0 });
    expect(stepSpacing(48, 1, 'simple', presets).preset?.name).toBe('Large');
    expect(stepSpacing(20, 'max', 'simple', presets).preset?.name).toBe('Large');
    expect(stepSpacing(20, 'min', 'simple', presets).value).toBe('0');
  });

  it('takes the first of presets the same size here (a clamp() at its minimum on a phone)', () => {
    const phone = [...presets, { slug: '55', name: 'Regular', px: 24 }];
    expect(stepSpacing(40, -1, 'simple', phone).preset?.name).toBe('Medium');
    expect(snapSpacing(25, 'simple', phone).preset?.name).toBe('Medium');
    // Up from there: past both.
    expect(stepSpacing(24, 1, 'simple', phone).preset?.name).toBe('Large');
  });

  it('moves a pixel, or ten with Shift, in Advanced', () => {
    expect(stepSpacing(24, 1, 'advanced', presets).value).toBe('25px');
    expect(stepSpacing(24, -1, 'advanced', presets, true).value).toBe('14px');
    expect(stepSpacing(4, -1, 'advanced', presets, true).value).toBe('0');
    expect(stepSpacing(4, 'max', 'advanced', presets).value).toBe('400px');
  });
});

describe('stored values', () => {
  it('reads presets, pixels and rem', () => {
    expect(spacingPx('var:preset|spacing|50', presets)).toBe(24);
    expect(spacingPx('var:preset|spacing|99', presets)).toBeNull();
    expect(spacingPx('12px', presets)).toBe(12);
    expect(spacingPx('1.5rem', presets)).toBe(24);
    expect(spacingPx('0', presets)).toBe(0);
    expect(spacingPx('clamp(1rem, 2vw, 2rem)', presets)).toBeNull();
    expect(spacingPx(undefined, presets)).toBeNull();
  });

  it('finds the value that applies on a device', () => {
    const style = {
      spacing: { padding: { top: '10px', left: '4px' } },
      '@mobile': { spacing: { padding: { top: '2px' } } },
    };
    expect(storedSpacing(style, 'mobile', 'padding', 'top')).toBe('2px');
    expect(storedSpacing(style, 'mobile', 'padding', 'left')).toBe('4px');
    expect(storedSpacing(style, 'tablet', 'padding', 'top')).toBe('10px');
    expect(storedSpacing({ spacing: { padding: '1rem' } }, 'desktop', 'padding', 'right')).toBe(
      '1rem',
    );
  });
});

describe('writing spacing', () => {
  it('writes the base style on Desktop, keeping the other sides', () => {
    const style = {
      spacing: { padding: { top: '1rem', bottom: '1rem' } },
      color: { text: '#000' },
    };
    expect(withSpacing(style, 'desktop', 'padding', 'top', presetValue('70'))).toEqual({
      spacing: { padding: { top: 'var:preset|spacing|70', bottom: '1rem' } },
      color: { text: '#000' },
    });
  });

  it('turns a box stored as one value into four sides', () => {
    expect(
      withSpacing({ spacing: { margin: '2rem' } }, 'desktop', 'margin', 'bottom', '0'),
    ).toEqual({
      spacing: { margin: { top: '2rem', right: '2rem', bottom: '0', left: '2rem' } },
    });
  });

  it('writes Mobile’s own value on Mobile, leaving Desktop’s', () => {
    const style = { spacing: { padding: { top: '48px' } } };
    expect(withSpacing(style, 'mobile', 'padding', 'top', '16px')).toEqual({
      spacing: { padding: { top: '48px' } },
      '@mobile': { spacing: { padding: { top: '16px' } } },
    });
  });

  it('carries a Tablet value down to Mobile, as the inspector does', () => {
    const next = withSpacing(undefined, 'tablet', 'padding', 'left', presetValue('30'));
    expect(next).toEqual({
      '@tablet': { spacing: { padding: { left: 'var:preset|spacing|30' } } },
      '@mobile': { spacing: { padding: { left: 'var:preset|spacing|30' } } },
    });
    // Mobile's own value stays.
    const own = withSpacing(
      { '@mobile': { spacing: { padding: { left: '2px' } } } },
      'tablet',
      'padding',
      'left',
      '20px',
    );
    expect(own['@mobile']).toEqual({ spacing: { padding: { left: '2px' } } });
  });
});

describe('column widths', () => {
  it('snaps to common fractions: always in Simple, when near in Advanced', () => {
    expect(snapFraction(0.31, 'simple')).toBeCloseTo(1 / 3);
    expect(snapFraction(0.47, 'simple')).toBe(0.5);
    expect(snapFraction(0.32, 'advanced')).toBeCloseTo(1 / 3);
    expect(snapFraction(0.37, 'advanced')).toBe(0.37);
  });

  it('moves the gap: the column after it gives or takes, the others keep theirs', () => {
    const half = resizeColumns([0.5, 0.5], 0, 0.64, 'simple');
    expect(half[0]).toBeCloseTo(2 / 3);
    expect(half[1]).toBeCloseTo(1 / 3);
    const three = resizeColumns([1 / 3, 1 / 3, 1 / 3], 1, 0.5, 'simple');
    expect(three[0]).toBeCloseTo(1 / 3);
    expect(three[1]).toBeCloseTo(0.5);
    expect(three[2]).toBeCloseTo(1 / 6);
  });

  it('keeps every column at least a tenth of the row', () => {
    const squeezed = resizeColumns([0.5, 0.5], 0, 0.97, 'advanced');
    expect(squeezed[1]).toBeCloseTo(0.1);
    expect(resizeColumns([0.5, 0.5], 0, 0.01, 'simple')[0]).toBeCloseTo(1 / 6);
    expect(resizeColumns([0.5, 0.5], 3, 0.2, 'simple')).toEqual([0.5, 0.5]);
  });

  it('steps a fraction (Simple) or a percent (Advanced) with the arrow keys', () => {
    expect(stepColumns([0.5, 0.5], 0, 1, 'simple')[0]).toBeCloseTo(0.6);
    expect(stepColumns([0.5, 0.5], 0, -1, 'simple')[0]).toBeCloseTo(0.4);
    expect(stepColumns([0.5, 0.5], 0, 1, 'advanced')[0]).toBeCloseTo(0.51);
    expect(stepColumns([0.5, 0.5], 0, -1, 'advanced', true)[0]).toBeCloseTo(0.4);
    // Nothing further: as it was.
    expect(stepColumns([5 / 6, 1 / 6], 0, 1, 'simple')).toEqual([5 / 6, 1 / 6]);
  });

  it('reads shares from the widths on the canvas and writes them as WordPress does', () => {
    expect(shares([300, 600])).toEqual([1 / 3, 2 / 3]);
    expect(shares([0, 0])).toEqual([0.5, 0.5]);
    expect(columnWidth(1 / 3)).toBe('33.33%');
    expect(columnWidth(2 / 3)).toBe('66.67%');
    expect(columnWidth(0.5)).toBe('50%');
    expect(fractionLabel(2 / 3)).toBe('2/3');
    expect(fractionLabel(0.37)).toBe('37%');
  });
});
