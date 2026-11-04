/**
 * Simple and Advanced (#32): which inspector panels and controls each mode
 * shows. Data and pure functions only, tested in mode-model.test.ts, so the
 * inspector and the issues that add controls (#46 styles and Additional CSS,
 * #49 per-device values and visibility, #47…) agree on one list. A new
 * control adds itself to `CONTROLS` with the lowest mode that shows it.
 *
 * Simple is the default (plan, Principle 3): content, colour, font and
 * spacing presets, alignment and visibility. Advanced adds exact values and
 * units, per-device values, borders, shadows, states and Additional CSS.
 * See docs/architecture/studio.md#simple-and-advanced.
 */

import { msgid } from '../../lib/i18n/locale';
import { INSPECTOR_TABS, type InspectorGroup, type InspectorTab } from './layout-model';

export type StudioMode = 'simple' | 'advanced';

/** The user meta that remembers the choice (apps/core/src/people/user-meta.ts). */
export const STUDIO_MODE_META = 'pressbase_studio_mode';

export const DEFAULT_MODE: StudioMode = 'simple';

export const parseMode = (value: unknown): StudioMode =>
  value === 'advanced' ? 'advanced' : DEFAULT_MODE;

export const MODES: readonly { id: StudioMode; label: string; hint: string }[] = [
  {
    id: 'simple',
    label: msgid('Simple'),
    hint: msgid('Choices from your site’s styles: colours, fonts and spacing that match.'),
  },
  {
    id: 'advanced',
    label: msgid('Advanced'),
    hint: msgid('Every setting: exact sizes and units, borders, shadows and more.'),
  },
];

/* ------------------------------------------------------------ the groups */

type GroupId = InspectorGroup['group'];

/**
 * The lowest mode that shows each of the block editor's control groups
 * (layout-model.ts puts each in a tab). Advanced shows everything.
 */
export const GROUP_MODES: Readonly<Record<GroupId, StudioMode>> = {
  // Content: a block's own settings and its items.
  default: 'simple',
  content: 'simple',
  list: 'simple',
  bindings: 'advanced',
  // HTML anchor and Additional CSS class(es).
  advanced: 'advanced',
  // Style: style variations, colour and font presets.
  styles: 'simple',
  typography: 'simple',
  color: 'simple',
  background: 'advanced',
  elements: 'advanced',
  border: 'advanced',
  // Shadows.
  effects: 'advanced',
  // Duotone.
  filter: 'advanced',
  // Layout: alignment, width and spacing presets.
  layout: 'simple',
  dimensions: 'simple',
  position: 'advanced',
};

const RANK: Record<StudioMode, number> = { simple: 0, advanced: 1 };

/** Whether a mode shows something whose lowest mode is `lowest`. */
export const shows = (mode: StudioMode, lowest: StudioMode) => RANK[mode] >= RANK[lowest];

/** The groups a tab shows in a mode, in the tab's order. */
export function tabGroups(tab: InspectorTab, mode: StudioMode): InspectorGroup[] {
  return tab.groups.filter((g) => shows(mode, GROUP_MODES[g.group]));
}

/** The inspector's tabs in a mode, each with only its groups for that mode. */
export function modeTabs(mode: StudioMode): InspectorTab[] {
  return INSPECTOR_TABS.map((tab) => ({ ...tab, groups: tabGroups(tab, mode) }));
}

/* ---------------------------------------------------------- the controls */

/**
 * Controls that aren't a whole group: a kind of choice inside one, or a
 * feature a later issue adds. `issue` names the issue that builds it, when
 * it isn't there yet; `mode` is the lowest mode that shows it.
 */
export interface ModeControl {
  id: string;
  label: string;
  mode: StudioMode;
  issue?: number;
}

export const CONTROLS: readonly ModeControl[] = [
  { id: 'presets', label: msgid('Colour, font and spacing presets'), mode: 'simple' },
  { id: 'alignment', label: msgid('Alignment'), mode: 'simple' },
  { id: 'visibility', label: msgid('Hide on a device'), mode: 'simple', issue: 49 },
  { id: 'custom-values', label: msgid('Any colour or size'), mode: 'advanced' },
  { id: 'units', label: msgid('Units (px, em, %…)'), mode: 'advanced' },
  { id: 'type-details', label: msgid('Line height and letter spacing'), mode: 'advanced' },
  { id: 'per-device', label: msgid('Values per device'), mode: 'advanced', issue: 49 },
  { id: 'borders', label: msgid('Borders'), mode: 'advanced' },
  { id: 'shadows', label: msgid('Shadows'), mode: 'advanced' },
  { id: 'states', label: msgid('Hover and focus styles'), mode: 'advanced', issue: 46 },
  { id: 'additional-css', label: msgid('Additional CSS'), mode: 'advanced', issue: 46 },
];

/** Whether a mode shows a control (unknown controls: Advanced only). */
export function showsControl(mode: StudioMode, id: string): boolean {
  const control = CONTROLS.find((c) => c.id === id);
  return shows(mode, control?.mode ?? 'advanced');
}

/* ----------------------------------------------------- editor settings */

type Settings = Record<string, unknown>;

/**
 * theme.json settings Simple turns off, inside `__experimentalFeatures`
 * (and any block's own settings there). Each maps to a control above.
 */
const SIMPLE_FEATURES: readonly { path: [string, string]; value: unknown; control: string }[] = [
  { path: ['color', 'custom'], value: false, control: 'custom-values' },
  { path: ['color', 'customGradient'], value: false, control: 'custom-values' },
  { path: ['color', 'customDuotone'], value: false, control: 'custom-values' },
  { path: ['typography', 'customFontSize'], value: false, control: 'custom-values' },
  { path: ['spacing', 'customSpacingSize'], value: false, control: 'custom-values' },
  { path: ['spacing', 'units'], value: ['px'], control: 'units' },
  { path: ['typography', 'lineHeight'], value: false, control: 'type-details' },
  { path: ['typography', 'letterSpacing'], value: false, control: 'type-details' },
  { path: ['typography', 'textDecoration'], value: false, control: 'type-details' },
  { path: ['typography', 'writingMode'], value: false, control: 'type-details' },
];

/**
 * The same switches under the names get_block_editor_settings() moves them
 * to (core's block-editor-settings.ts). The block editor reads these when
 * `__experimentalFeatures` doesn't have the key, which is how core sends
 * them.
 */
const SIMPLE_LEGACY: Settings = {
  disableCustomColors: true,
  disableCustomGradients: true,
  disableCustomFontSizes: true,
  disableCustomSpacingSizes: true,
  enableCustomLineHeight: false,
  enableCustomUnits: ['px'],
};

const withSetting = (group: unknown, key: string, value: unknown): Settings => ({
  ...((group as Settings | undefined) ?? {}),
  [key]: value,
});

/**
 * The editor settings for a mode: Advanced keeps the theme's; Simple turns
 * off custom values, units and the finer type controls, so the inspector
 * offers the site's presets only. Never changes `settings`.
 */
export function modeEditorSettings<T extends Settings>(settings: T, mode: StudioMode): T {
  if (mode === 'advanced') return settings;
  const narrow = (features: Settings): Settings => {
    let out = features;
    for (const { path, value } of SIMPLE_FEATURES) {
      const [group, key] = path;
      out = { ...out, [group]: withSetting(out[group], key, value) };
    }
    return out;
  };
  const features = (settings.__experimentalFeatures as Settings | undefined) ?? {};
  let next = narrow(features);
  // A block's own settings could turn a custom control back on: narrow those where set.
  const blocks = features.blocks as Record<string, Settings> | undefined;
  if (blocks) {
    const narrowed: Record<string, Settings> = {};
    for (const [name, block] of Object.entries(blocks)) {
      let out = block;
      for (const { path, value } of SIMPLE_FEATURES) {
        const [group, key] = path;
        const current = out[group] as Settings | undefined;
        if (current && key in current) out = { ...out, [group]: withSetting(current, key, value) };
      }
      narrowed[name] = out;
    }
    next = { ...next, blocks: narrowed };
  }
  return { ...settings, ...SIMPLE_LEGACY, __experimentalFeatures: next };
}

/** The feature switches Simple turns off, for the docs and tests. */
export const SIMPLE_SWITCHES = SIMPLE_FEATURES.map((f) => ({
  setting: f.path.join('.'),
  control: f.control,
}));
