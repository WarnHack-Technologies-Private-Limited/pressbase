/**
 * The parts of Studio's screen that later issues fill in: the inspector's
 * tabs and the left rail's panels. Data only, so the shell, its tests and
 * the issues that extend it (#32 Simple/Advanced, #35 Elements, #44
 * Sections, #50 Layers…) agree on one list. See docs/architecture/studio.md.
 */

/* --------------------------------------------------------------- inspector */

/**
 * A group of block controls: one of @wordpress/block-editor's
 * `InspectorControls` groups. `slot` is the group's SlotFill name, used to
 * tell whether the selected block has any controls in it.
 */
export interface InspectorGroup {
  group:
    | 'default'
    | 'content'
    | 'list'
    | 'bindings'
    | 'advanced'
    | 'typography'
    | 'color'
    | 'background'
    | 'elements'
    | 'border'
    | 'effects'
    | 'filter'
    | 'styles'
    | 'layout'
    | 'dimensions'
    | 'position';
  slot: string;
  /** WordPress's panel title, for groups it shows in a tools panel ("Color"). */
  label?: string;
}

export type InspectorTabId = 'content' | 'style' | 'layout';

export interface InspectorTab {
  id: InspectorTabId;
  label: string;
  /** Shown when the selected block has nothing in this tab. */
  empty: string;
  groups: InspectorGroup[];
}

/**
 * Content / Style / Layout. Every block control WordPress's own inspector
 * shows is in exactly one tab (tested). #32 (Simple and Advanced) narrows
 * these lists per mode rather than adding tabs.
 */
export const INSPECTOR_TABS: readonly InspectorTab[] = [
  {
    id: 'content',
    label: 'Content',
    empty: 'This block has no content settings. Edit it on the page.',
    groups: [
      { group: 'default', slot: 'InspectorControls' },
      { group: 'content', slot: 'InspectorControlsContent' },
      { group: 'list', slot: 'InspectorControlsListView' },
      { group: 'bindings', slot: 'InspectorControlsBindings' },
      { group: 'advanced', slot: 'InspectorAdvancedControls', label: 'Advanced' },
    ],
  },
  {
    id: 'style',
    label: 'Style',
    empty: 'This block has no style settings.',
    groups: [
      { group: 'styles', slot: 'InspectorControlsStyles' },
      { group: 'typography', slot: 'InspectorControlsTypography', label: 'Typography' },
      { group: 'color', slot: 'InspectorControlsColor', label: 'Color' },
      { group: 'background', slot: 'InspectorControlsBackground', label: 'Background' },
      { group: 'elements', slot: 'InspectorControlsElements', label: 'Elements' },
      { group: 'border', slot: 'InspectorControlsBorder', label: 'Borders' },
      { group: 'effects', slot: 'InspectorControlsEffects' },
      { group: 'filter', slot: 'InspectorControlsFilter' },
    ],
  },
  {
    id: 'layout',
    label: 'Layout',
    empty: 'This block has no layout settings.',
    groups: [
      { group: 'layout', slot: 'InspectorControlsLayout', label: 'Layout' },
      { group: 'dimensions', slot: 'InspectorControlsDimensions', label: 'Dimensions' },
      { group: 'position', slot: 'InspectorControlsPosition', label: 'Position' },
    ],
  },
];

/** The tab to show: the one asked for when it has controls, else the first that has. */
export function visibleTab(
  wanted: InspectorTabId,
  hasControls: (tab: InspectorTab) => boolean,
): InspectorTabId {
  const tab = INSPECTOR_TABS.find((t) => t.id === wanted);
  if (tab && hasControls(tab)) return wanted;
  return INSPECTOR_TABS.find(hasControls)?.id ?? wanted;
}

/* --------------------------------------------------------------- left rail */

export type RailPanelId = 'pages' | 'elements' | 'sections' | 'layers' | 'styles' | 'media' | 'ai';

export interface RailPanel {
  id: RailPanelId;
  label: string;
  /** What the panel is for, in one line (its description and tooltip). */
  summary: string;
  /** The issue that builds the panel out, shown while it's on the way. */
  issue: number;
  /** What the shell already offers in the panel until then. */
  interim: 'pages' | 'inserter' | 'list-view' | 'none';
  /** The note shown in the panel until the issue lands. */
  coming: string;
}

export const RAIL_PANELS: readonly RailPanel[] = [
  {
    id: 'pages',
    label: 'Pages',
    summary: 'Your site’s pages',
    issue: 29,
    interim: 'pages',
    coming: 'Adding, nesting and reordering pages, and choosing the home page, arrive with #29.',
  },
  {
    id: 'elements',
    label: 'Elements',
    summary: 'Blocks to add to the page',
    issue: 35,
    interim: 'inserter',
    coming: 'Large tiles you can drag onto the page arrive with #35.',
  },
  {
    id: 'sections',
    label: 'Sections',
    summary: 'Ready-made sections, in your site’s style',
    issue: 44,
    interim: 'none',
    coming: 'Sections arrive with #44: heroes, features, pricing, opening hours and more, ready to drop in.',
  },
  {
    id: 'layers',
    label: 'Layers',
    summary: 'Everything on the page, as a list',
    issue: 50,
    interim: 'list-view',
    coming: 'Renaming, hiding on a device and drag to nest arrive with #50.',
  },
  {
    id: 'styles',
    label: 'Styles',
    summary: 'Colours, fonts and spacing for the whole site',
    issue: 46,
    interim: 'none',
    coming: 'Site styles in Studio arrive with #46 and #47. Until then, use Appearance → Styles.',
  },
  {
    id: 'media',
    label: 'Media',
    summary: 'Your images, video and audio',
    issue: 58,
    interim: 'none',
    coming:
      'A media panel with your library and free photos arrives with #58. Until then, add an Image block from Elements and choose Media Library.',
  },
  {
    id: 'ai',
    label: 'AI',
    summary: 'Ask for changes in your own words',
    issue: 62,
    interim: 'none',
    coming: 'The AI panel arrives with #62: ask for site-wide changes and keep or undo each one.',
  },
];

/* ------------------------------------------------------------- top bar */

export type Device = 'desktop' | 'tablet' | 'mobile';

/**
 * Canvas widths for Desktop, Tablet and Mobile. Tablet and Mobile match the
 * breakpoints WordPress 7.1 uses for responsive styles (`settings.viewport`:
 * tablet 782px, mobile 480px), less a little so the media queries apply;
 * per-device styles are #49.
 */
export const DEVICES: readonly { id: Device; label: string; width: number | null }[] = [
  { id: 'desktop', label: 'Desktop', width: null },
  { id: 'tablet', label: 'Tablet', width: 768 },
  { id: 'mobile', label: 'Mobile', width: 390 },
];
