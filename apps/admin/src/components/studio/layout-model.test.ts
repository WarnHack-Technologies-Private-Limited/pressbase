import { describe, expect, it } from 'vitest';
import { DEVICES, INSPECTOR_TABS, RAIL_PANELS, visibleTab } from './layout-model';

describe('inspector tabs', () => {
  it('are Content, Style and Layout', () => {
    expect(INSPECTOR_TABS.map((tab) => tab.label)).toEqual(['Content', 'Style', 'Layout']);
  });

  it('place every InspectorControls group of the block editor in exactly one tab', () => {
    // @wordpress/block-editor 19's groups (components/inspector-controls/groups.ts),
    // less `settings` (an alias of `default`) and `style-state` (a style state's own panel).
    const editorGroups = [
      'default',
      'advanced',
      'background',
      'bindings',
      'border',
      'color',
      'content',
      'dimensions',
      'effects',
      'elements',
      'filter',
      'layout',
      'list',
      'position',
      'styles',
      'typography',
    ];
    const placed = INSPECTOR_TABS.flatMap((tab) => tab.groups.map((g) => g.group));
    expect([...placed].sort()).toEqual([...editorGroups].sort());
    const slots = INSPECTOR_TABS.flatMap((tab) => tab.groups.map((g) => g.slot));
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('fall back to a tab that has controls', () => {
    const only = (id: string) => (tab: { id: string }) => tab.id === id;
    expect(visibleTab('style', only('style'))).toBe('style');
    expect(visibleTab('style', only('layout'))).toBe('layout');
    expect(visibleTab('layout', () => false)).toBe('layout');
  });
});

describe('left rail', () => {
  it('has the panels from the plan, in order, each saying which issue builds it', () => {
    expect(RAIL_PANELS.map((panel) => panel.label)).toEqual([
      'Pages',
      'Elements',
      'Sections',
      'Layers',
      'Styles',
      'Media',
      'AI',
    ]);
    for (const panel of RAIL_PANELS) expect(panel.coming).toContain(`#${panel.issue}`);
  });
});

describe('devices', () => {
  it('keep Tablet and Mobile below WordPress’s breakpoints', () => {
    const width = (id: string) => DEVICES.find((d) => d.id === id)?.width ?? 0;
    expect(width('tablet')).toBeLessThan(782);
    expect(width('mobile')).toBeLessThan(480);
    expect(DEVICES.find((d) => d.id === 'desktop')?.width).toBeNull();
  });
});
