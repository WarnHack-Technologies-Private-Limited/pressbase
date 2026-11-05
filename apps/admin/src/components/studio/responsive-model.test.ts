import { describe, expect, it } from 'vitest';
import {
  blockVisibility,
  deviceFrames,
  deviceState,
  deviceValues,
  displayValue,
  hiddenOn,
  inheritDown,
  ownDeviceValues,
  propertyLabel,
  resetDeviceValue,
  viewportBreakpoints,
  withBlockVisibility,
} from './responsive-model';

describe('breakpoints', () => {
  it('default to WordPress 7.1’s', () => {
    expect(viewportBreakpoints(undefined)).toEqual({ mobile: '480px', tablet: '782px' });
    expect(viewportBreakpoints({ mobile: 'big' })).toEqual({ mobile: '480px', tablet: '782px' });
  });

  it('are sanitised as WordPress does', () => {
    expect(viewportBreakpoints({ mobile: ' 30em ', tablet: '60em' })).toEqual({
      mobile: '30em',
      tablet: '60em',
    });
    expect(viewportBreakpoints({ mobile: '600px' })).toEqual({ mobile: '600px' });
    expect(viewportBreakpoints({ tablet: '900px' })).toEqual({ tablet: '900px' });
    // Tablet must be wider than mobile.
    expect(viewportBreakpoints({ mobile: '800px', tablet: '700px' })).toEqual({ mobile: '800px' });
    expect(viewportBreakpoints({ mobile: '50%', tablet: '1000px' })).toEqual({ tablet: '1000px' });
  });
});

describe('device frames', () => {
  it('fit the default ranges: 768px is a tablet, 390px a phone', () => {
    const frames = deviceFrames(undefined);
    expect(frames.desktop.width).toBeNull();
    expect(frames.tablet).toMatchObject({ width: 768, available: true });
    expect(frames.mobile).toMatchObject({ width: 390, available: true });
    expect(frames.mobile.range).toEqual({ max: '480px' });
    expect(frames.tablet.range).toEqual({ min: '480px', max: '782px' });
    expect(frames.desktop.range).toEqual({ min: '782px' });
  });

  it('follow the theme’s breakpoints when the usual sizes don’t fit', () => {
    const frames = deviceFrames({ mobile: '360px', tablet: '700px' });
    expect(frames.mobile.width).toBe(360);
    expect(frames.tablet.width).toBe(700);
    // A tablet range above 768px: the breakpoint itself.
    expect(deviceFrames({ mobile: '800px', tablet: '1100px' }).tablet.width).toBe(1100);
    expect(deviceFrames({ mobile: '30em', tablet: '64em' }).tablet.width).toBe(768);
  });

  it('leave out a device the theme has no breakpoint for', () => {
    const frames = deviceFrames({ mobile: '600px' });
    expect(frames.tablet.available).toBe(false);
    expect(frames.mobile.width).toBe(390);
    expect(frames.desktop.range).toEqual({ min: '600px' });
  });

  it('name the style state each device edits', () => {
    expect(deviceState('desktop')).toBeNull();
    expect(deviceState('tablet')).toBe('@tablet');
    expect(deviceState('mobile')).toBe('@mobile');
  });
});

const small = 'var:preset|font-size|small';
const medium = 'var:preset|font-size|medium';

describe('values inherit downward', () => {
  it('copy a tablet value to mobile', () => {
    const prev = { typography: { fontSize: '48px' } };
    const next = { ...prev, '@tablet': { typography: { fontSize: medium } } };
    expect(inheritDown('tablet', prev, next)).toEqual({
      typography: { fontSize: '48px' },
      '@tablet': { typography: { fontSize: medium } },
      '@mobile': { typography: { fontSize: medium } },
    });
  });

  it('keep mobile’s own value when tablet changes', () => {
    const prev = {
      '@tablet': { typography: { fontSize: medium } },
      '@mobile': { typography: { fontSize: small } },
    };
    const next = { ...prev, '@tablet': { typography: { fontSize: '30px' } } };
    expect(inheritDown('tablet', prev, next)?.['@mobile']).toEqual({
      typography: { fontSize: small },
    });
  });

  it('update mobile where it had tablet’s value', () => {
    const prev = {
      '@tablet': { typography: { fontSize: medium } },
      '@mobile': { typography: { fontSize: medium }, spacing: { padding: { top: '8px' } } },
    };
    const next = { ...prev, '@tablet': { typography: { fontSize: '30px' } } };
    expect(inheritDown('tablet', prev, next)?.['@mobile']).toEqual({
      typography: { fontSize: '30px' },
      spacing: { padding: { top: '8px' } },
    });
  });

  it('remove from mobile a tablet value it had copied', () => {
    const prev = {
      '@tablet': { typography: { fontSize: medium } },
      '@mobile': { typography: { fontSize: medium } },
    };
    expect(inheritDown('tablet', prev, {})).toBeUndefined();
    expect(inheritDown('tablet', prev, { '@mobile': prev['@mobile'] })).toBeUndefined();
  });

  it('go back to tablet’s value when mobile is reset', () => {
    const prev = {
      '@tablet': { typography: { fontSize: medium } },
      '@mobile': { typography: { fontSize: small } },
    };
    const next = { '@tablet': prev['@tablet'] };
    expect(inheritDown('mobile', prev, next)?.['@mobile']).toEqual({
      typography: { fontSize: medium },
    });
    // Nothing on tablet: mobile goes back to desktop's.
    expect(inheritDown('mobile', { '@mobile': { color: { text: 'red' } } }, {})).toBeUndefined();
  });

  it('leave desktop edits alone', () => {
    const next = { typography: { fontSize: small } };
    expect(inheritDown('desktop', {}, next)).toBe(next);
  });
});

describe('device values', () => {
  const style = {
    typography: { fontSize: '48px' },
    '@tablet': { typography: { fontSize: medium } },
    '@mobile': { typography: { fontSize: medium }, spacing: { padding: { top: '8px' } } },
  };

  it('list a device’s values, marking those mobile inherits from tablet', () => {
    expect(deviceValues(style, 'desktop')).toEqual([]);
    expect(deviceValues(style, 'tablet')).toEqual([
      { path: ['typography', 'fontSize'], value: medium, inherited: false },
    ]);
    expect(deviceValues(style, 'mobile')).toEqual([
      { path: ['typography', 'fontSize'], value: medium, inherited: true },
      { path: ['spacing', 'padding', 'top'], value: '8px', inherited: false },
    ]);
    expect(ownDeviceValues(style, 'mobile').map((v) => v.path)).toEqual([
      ['spacing', 'padding', 'top'],
    ]);
  });

  it('reset one value or all of a device’s, keeping the inheritance', () => {
    expect(resetDeviceValue(style, 'mobile', ['spacing', 'padding', 'top'])).toEqual({
      typography: { fontSize: '48px' },
      '@tablet': { typography: { fontSize: medium } },
      '@mobile': { typography: { fontSize: medium } },
    });
    expect(resetDeviceValue(style, 'tablet', ['typography', 'fontSize'])).toEqual({
      typography: { fontSize: '48px' },
      '@mobile': { spacing: { padding: { top: '8px' } } },
    });
    expect(resetDeviceValue(style, 'tablet')).toEqual({
      typography: { fontSize: '48px' },
      '@mobile': { spacing: { padding: { top: '8px' } } },
    });
    expect(resetDeviceValue(style, 'desktop')).toBe(style);
  });

  it('read as plain words', () => {
    expect(propertyLabel(['typography', 'fontSize'])).toEqual({ label: 'Font size' });
    expect(propertyLabel(['spacing', 'padding', 'top'])).toEqual({
      label: 'Padding',
      detail: 'top',
    });
    expect(propertyLabel(['border', 'radius'])).toEqual({ label: 'Border', detail: 'radius' });
    expect(propertyLabel(['custom', 'thing'])).toEqual({ label: 'custom thing' });
    expect(displayValue(small)).toBe('small');
    expect(displayValue('var:preset|font-size|x-large')).toBe('x large');
    expect(displayValue('2rem')).toBe('2rem');
  });
});

describe('block visibility', () => {
  it('reads WordPress 7.1’s blockVisibility', () => {
    expect(blockVisibility(undefined)).toEqual({ desktop: true, tablet: true, mobile: true });
    expect(blockVisibility({ blockVisibility: false })).toEqual({
      desktop: false,
      tablet: false,
      mobile: false,
    });
    expect(blockVisibility({ blockVisibility: { viewport: { mobile: false } } })).toEqual({
      desktop: true,
      tablet: true,
      mobile: false,
    });
  });

  it('hides and shows a block per device', () => {
    const hidden = withBlockVisibility({ name: 'Hero' }, 'mobile', false);
    expect(hidden).toEqual({ name: 'Hero', blockVisibility: { viewport: { mobile: false } } });
    const both = withBlockVisibility(hidden, 'tablet', false);
    expect(both?.blockVisibility).toEqual({ viewport: { tablet: false, mobile: false } });
    expect(hiddenOn(blockVisibility(both))).toEqual(['tablet', 'mobile']);
    expect(withBlockVisibility(hidden, 'mobile', true)).toEqual({ name: 'Hero' });
    expect(withBlockVisibility({ blockVisibility: { viewport: { mobile: false } } }, 'mobile', true))
      .toBeUndefined();
    // Hidden everywhere, then shown on desktop.
    expect(withBlockVisibility({ blockVisibility: false }, 'desktop', true)).toEqual({
      blockVisibility: { viewport: { tablet: false, mobile: false } },
    });
  });
});
