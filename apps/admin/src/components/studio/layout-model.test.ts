import { describe, expect, it } from 'vitest';
import { DEVICES, INSPECTOR_TABS, RAIL_PANELS } from './layout-model';

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
});

describe('left rail', () => {
  it('has the panels from the plan, in order, each built or saying which issue builds it', () => {
    expect(RAIL_PANELS.map((panel) => panel.label)).toEqual([
      'Pages',
      'Elements',
      'Sections',
      'Layers',
      'Styles',
      'Media',
      'AI',
      'History',
    ]);
    for (const panel of RAIL_PANELS) {
      if (panel.interim === 'built') expect(panel.coming).toBeUndefined();
      else expect(panel.coming).toContain(`#${panel.issue}`);
    }
    // Pages (#29), Elements (#35), Sections (#44), Styles (#46), AI (#62) and History (#34) are built.
    expect(RAIL_PANELS.filter((p) => p.interim === 'built').map((p) => p.id)).toEqual([
      'pages',
      'elements',
      'sections',
      'styles',
      'ai',
      'history',
    ]);
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
