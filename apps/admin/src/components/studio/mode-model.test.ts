import { describe, expect, it } from 'vitest';
import { INSPECTOR_TABS } from './layout-model';
import {
  CONTROLS,
  GROUP_MODES,
  MODES,
  modeEditorSettings,
  modeTabs,
  parseMode,
  SIMPLE_SWITCHES,
  showsControl,
} from './mode-model';

const groupsOf = (mode: 'simple' | 'advanced') =>
  modeTabs(mode).flatMap((tab) => tab.groups.map((g) => g.group));

describe('the mode map', () => {
  it('is Simple, then Advanced; anything but "advanced" is Simple', () => {
    expect(MODES.map((m) => m.label)).toEqual(['Simple', 'Advanced']);
    expect(parseMode('advanced')).toBe('advanced');
    expect(parseMode('simple')).toBe('simple');
    expect(parseMode(undefined)).toBe('simple');
    expect(parseMode('expert')).toBe('simple');
  });

  it('places every inspector group in a mode', () => {
    const all = INSPECTOR_TABS.flatMap((tab) => tab.groups.map((g) => g.group));
    expect(Object.keys(GROUP_MODES).sort()).toEqual([...all].sort());
  });

  it('shows everything in Advanced, in the tabs’ order', () => {
    expect(groupsOf('advanced')).toEqual(
      INSPECTOR_TABS.flatMap((tab) => tab.groups.map((g) => g.group)),
    );
  });

  it('shows content, presets and layout in Simple, without borders, shadows or CSS classes', () => {
    const simple = groupsOf('simple');
    expect(simple).toEqual([
      'default',
      'content',
      'list',
      'styles',
      'typography',
      'color',
      'layout',
      'dimensions',
    ]);
    for (const group of ['border', 'effects', 'advanced', 'position', 'filter']) {
      expect(simple).not.toContain(group);
    }
    // Every tab keeps something in Simple, so none is empty for a typical block.
    for (const tab of modeTabs('simple')) expect(tab.groups.length).toBeGreaterThan(0);
  });

  it('lists the controls each mode shows, Advanced a superset of Simple', () => {
    const simple = CONTROLS.filter((c) => showsControl('simple', c.id)).map((c) => c.id);
    const advanced = CONTROLS.filter((c) => showsControl('advanced', c.id)).map((c) => c.id);
    expect(simple).toEqual(['presets', 'alignment', 'visibility']);
    expect(advanced).toEqual(CONTROLS.map((c) => c.id));
    for (const id of [
      'custom-values',
      'units',
      'per-device',
      'borders',
      'shadows',
      'states',
      'additional-css',
    ]) {
      expect(showsControl('simple', id)).toBe(false);
      expect(showsControl('advanced', id)).toBe(true);
    }
    // A control nobody listed is Advanced only.
    expect(showsControl('simple', 'something-new')).toBe(false);
    // Controls still to come name their issue.
    expect(CONTROLS.filter((c) => c.issue).map((c) => [c.id, c.issue])).toEqual([
      ['visibility', 49],
      ['per-device', 49],
      ['states', 46],
      ['additional-css', 46],
    ]);
  });

  it('ties every setting Simple switches off to a control Simple hides', () => {
    for (const { control } of SIMPLE_SWITCHES) {
      expect(CONTROLS.some((c) => c.id === control)).toBe(true);
      expect(showsControl('simple', control)).toBe(false);
    }
  });
});

describe('editor settings per mode', () => {
  const theme = {
    disableCustomColors: false,
    disableCustomFontSizes: false,
    enableCustomUnits: ['px', 'em', 'rem', '%'],
    colors: [{ slug: 'accent', color: '#3a5a40' }],
    __experimentalFeatures: {
      color: { palette: { theme: [] }, link: true },
      typography: { fluid: true },
      spacing: { padding: true },
      blocks: {
        'core/button': { color: { custom: true }, border: { radius: true } },
      },
    },
  };

  it('keeps the theme’s settings in Advanced', () => {
    expect(modeEditorSettings(theme, 'advanced')).toBe(theme);
  });

  it('offers presets only in Simple', () => {
    const simple = modeEditorSettings(theme, 'simple');
    expect(simple).toMatchObject({
      disableCustomColors: true,
      disableCustomGradients: true,
      disableCustomFontSizes: true,
      disableCustomSpacingSizes: true,
      enableCustomLineHeight: false,
      enableCustomUnits: ['px'],
      colors: theme.colors,
    });
    const features = simple.__experimentalFeatures as typeof theme.__experimentalFeatures &
      Record<string, Record<string, unknown>>;
    expect(features.color).toEqual({
      palette: { theme: [] },
      link: true,
      custom: false,
      customGradient: false,
      customDuotone: false,
    });
    expect(features.typography).toMatchObject({ fluid: true, customFontSize: false });
    expect(features.spacing).toEqual({ padding: true, customSpacingSize: false, units: ['px'] });
    // A block that turned custom colours back on doesn't get them in Simple.
    expect(features.blocks['core/button']).toEqual({
      color: { custom: false },
      border: { radius: true },
    });
    // The theme's own settings are untouched.
    expect(theme.__experimentalFeatures.blocks['core/button'].color.custom).toBe(true);
    expect(theme.disableCustomColors).toBe(false);
  });
});
