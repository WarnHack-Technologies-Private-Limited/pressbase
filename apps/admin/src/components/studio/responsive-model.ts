/**
 * Responsive editing (#49): the theme's breakpoints, the canvas width for
 * each device, values per device and hiding a block on a device. Data and
 * pure functions only, tested in responsive-model.test.ts.
 *
 * The stored shapes are WordPress 7.1's (ADR 0023): `style["@tablet"]` and
 * `style["@mobile"]` beside a block's base style, `metadata.blockVisibility`
 * (`false`, or `{ viewport: { mobile?, tablet?, desktop? } }`) and the
 * theme's `settings.viewport` breakpoints.
 *
 * WordPress's ranges don't overlap: `@tablet` is `(480px < width <= 782px)`
 * and `@mobile` `(width <= 480px)`, so CSS never carries a tablet value to
 * phones. Studio promises that values inherit downward (Desktop → Tablet →
 * Mobile), so it copies instead (`inheritDown()`):
 *
 * - a value set for Tablet is written to Mobile too, unless Mobile has a
 *   value of its own there (one that differs from Tablet's old value);
 * - resetting a value on Mobile goes back to Tablet's value, when Tablet has
 *   one, rather than to Desktop's;
 * - a Mobile value equal to Tablet's is shown as inherited, not as a change.
 *
 * Desktop values reach both through CSS (they are the base style), so they
 * need no copying. See docs/architecture/studio.md#responsive-editing.
 */

import { msgid } from '../../lib/i18n/locale';
import type { Device, InspectorGroup, InspectorTab } from './layout-model';

/* ------------------------------------------------------------ breakpoints */

export interface ViewportBreakpoints {
  mobile?: string;
  tablet?: string;
}

/** WP_Theme_JSON::DEFAULT_VIEWPORT_BREAKPOINTS */
export const DEFAULT_BREAKPOINTS: Readonly<Required<ViewportBreakpoints>> = {
  mobile: '480px',
  tablet: '782px',
};

const LENGTH = /^(?:\d+|\d*\.\d+)(?:px|em|rem)$/;

/** A breakpoint in pixels; `em` and `rem` count as 16px, as in WordPress. */
export function breakpointPx(value: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith('rem')) return Number.parseFloat(trimmed) * 16;
  if (trimmed.endsWith('em')) return Number.parseFloat(trimmed) * 16;
  return Number.parseFloat(trimmed);
}

/**
 * The theme's breakpoints (`__experimentalFeatures.viewport`), sanitised as
 * WordPress does (sanitize_viewport_settings(), packages/theme-json
 * viewport.ts): only px, em and rem lengths; nothing valid gives the
 * defaults; a single valid value stands alone; tablet must be wider than
 * mobile.
 */
export function viewportBreakpoints(settings: unknown): ViewportBreakpoints {
  const source =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : null;
  if (!source) return { ...DEFAULT_BREAKPOINTS };
  const valid = (v: unknown): v is string => typeof v === 'string' && LENGTH.test(v.trim());
  const mobile = valid(source.mobile) ? source.mobile.trim() : undefined;
  const tablet = valid(source.tablet) ? source.tablet.trim() : undefined;
  if (!mobile && !tablet) return { ...DEFAULT_BREAKPOINTS };
  if (!mobile) return { tablet };
  if (!tablet) return { mobile };
  return breakpointPx(mobile) < breakpointPx(tablet) ? { mobile, tablet } : { mobile };
}

/** The canvas widths Studio prefers: a common tablet and phone, when they fit the theme's ranges. */
const PREFERRED_WIDTH: Readonly<Record<Exclude<Device, 'desktop'>, number>> = {
  tablet: 768,
  mobile: 390,
};

export interface DeviceFrame {
  id: Device;
  /** The canvas width in pixels; null for Desktop (the whole space). */
  width: number | null;
  /** False when the theme has no breakpoint for the device. */
  available: boolean;
  /** The device's range, for people: "480px and narrower". */
  range: { min?: string; max?: string };
}

/**
 * The canvas for each device, inside the theme's ranges so its media
 * queries (and the `@tablet` and `@mobile` styles) apply: 768px and 390px
 * when they fit, else the breakpoint itself. A device the theme has no
 * breakpoint for isn't offered.
 */
export function deviceFrames(viewport: unknown): Record<Device, DeviceFrame> {
  const bp = viewportBreakpoints(viewport);
  const mobilePx = bp.mobile ? breakpointPx(bp.mobile) : undefined;
  const tabletPx = bp.tablet ? breakpointPx(bp.tablet) : undefined;
  const mobileWidth = mobilePx === undefined ? null : Math.min(PREFERRED_WIDTH.mobile, mobilePx);
  let tabletWidth: number | null = null;
  if (tabletPx !== undefined) {
    const floor = mobilePx === undefined ? 0 : mobilePx;
    tabletWidth =
      PREFERRED_WIDTH.tablet > floor && PREFERRED_WIDTH.tablet <= tabletPx
        ? PREFERRED_WIDTH.tablet
        : tabletPx;
  }
  const widest = bp.tablet ?? bp.mobile;
  return {
    desktop: { id: 'desktop', width: null, available: true, range: { min: widest } },
    tablet: {
      id: 'tablet',
      width: tabletWidth,
      available: tabletWidth !== null,
      range: { min: bp.mobile, max: bp.tablet },
    },
    mobile: {
      id: 'mobile',
      width: mobileWidth,
      available: mobileWidth !== null,
      range: { max: bp.mobile },
    },
  };
}

/** The style state a device edits (`@tablet`, `@mobile`); null for Desktop, the base style. */
export const deviceState = (device: Device): '@tablet' | '@mobile' | null =>
  device === 'desktop' ? null : `@${device}`;

/**
 * The inspector groups whose controls edit a style state, so they work per
 * device: WordPress 7.1's style panels (typography with colour, background,
 * dimensions, border, elements). Left out on Tablet and Mobile: style
 * variations, shadows and duotone (one value for every size), and layout
 * and position, whose per-device values the public site doesn't print yet
 * (ADR 0023).
 */
export const DEVICE_GROUPS: readonly InspectorGroup['group'][] = [
  'typography',
  'color',
  'background',
  'elements',
  'border',
  'dimensions',
];

/** The inspector's tabs on a device: Content as it is, Style and Layout with per-device groups only. */
export function deviceTabs(tabs: readonly InspectorTab[], device: Device): InspectorTab[] {
  if (device === 'desktop') return [...tabs];
  return tabs.map((tab) =>
    tab.id === 'content'
      ? tab
      : { ...tab, groups: tab.groups.filter((g) => DEVICE_GROUPS.includes(g.group)) },
  );
}

/* ------------------------------------------------------------ the values */

export type Style = Record<string, unknown>;
type Path = readonly string[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function getPath(source: unknown, path: Path): unknown {
  let node = source;
  for (const key of path) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** A copy of `source` with `path` set to `value` (removed when undefined), emptied objects dropped. */
function setPath(source: Style | undefined, path: Path, value: unknown): Style | undefined {
  const [key, ...rest] = path;
  if (key === undefined) return isObject(value) ? value : undefined;
  const out: Style = { ...(source ?? {}) };
  const next = rest.length
    ? setPath(isObject(out[key]) ? (out[key] as Style) : undefined, rest, value)
    : value;
  if (next === undefined || (isObject(next) && Object.keys(next).length === 0)) delete out[key];
  else out[key] = next;
  return Object.keys(out).length ? out : undefined;
}

/** Each value in a style object, with its path. Arrays and strings are values. */
export function leafValues(source: unknown, prefix: string[] = []): [string[], unknown][] {
  if (!isObject(source)) return source === undefined ? [] : [[prefix, source]];
  const out: [string[], unknown][] = [];
  for (const [key, value] of Object.entries(source))
    out.push(...leafValues(value, [...prefix, key]));
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A block's style with one state's styles replaced (emptied states removed). */
function withState(style: Style | undefined, state: '@tablet' | '@mobile', value: unknown) {
  return setPath(style, [state], value);
}

/**
 * Keeps "values inherit downward" true after an edit made on `device`:
 * `prev` is the block's style before the edit and `next` after it.
 *
 * - Tablet: each value that changed in `@tablet` is copied to `@mobile`
 *   where Mobile had nothing or had Tablet's old value (it was inherited);
 *   a Tablet value removed goes from Mobile too, where Mobile had copied it.
 * - Mobile: a value removed from `@mobile` (a reset) takes Tablet's value
 *   again when Tablet has one.
 * - Desktop: nothing to do; the base style reaches every size.
 */
export function inheritDown(
  device: Device,
  prev: Style | undefined,
  next: Style | undefined,
): Style | undefined {
  if (device === 'tablet') {
    const before = getPath(prev, ['@tablet']);
    const after = getPath(next, ['@tablet']);
    const paths = new Map<string, string[]>();
    for (const [path] of [...leafValues(before), ...leafValues(after)]) {
      paths.set(JSON.stringify(path), path);
    }
    let mobile = getPath(next, ['@mobile']) as Style | undefined;
    for (const path of paths.values()) {
      const old = getPath(before, path);
      const now = getPath(after, path);
      if (same(old, now)) continue;
      const mine = getPath(mobile, path);
      if (mine === undefined || same(mine, old)) mobile = setPath(mobile, path, now);
    }
    return withState(next, '@mobile', mobile);
  }
  if (device === 'mobile') {
    const before = getPath(prev, ['@mobile']);
    let mobile = getPath(next, ['@mobile']) as Style | undefined;
    const tablet = getPath(next, ['@tablet']);
    for (const [path] of leafValues(before)) {
      if (getPath(mobile, path) !== undefined) continue;
      const inherited = getPath(tablet, path);
      if (inherited !== undefined) mobile = setPath(mobile, path, inherited);
    }
    return withState(next, '@mobile', mobile);
  }
  return next;
}

export interface DeviceValue {
  path: string[];
  value: unknown;
  /** Mobile only: the value is Tablet's, carried down. */
  inherited: boolean;
}

/** The values a block has for a device (`@tablet` or `@mobile`), in the order they're stored. */
export function deviceValues(style: Style | undefined, device: Device): DeviceValue[] {
  const state = deviceState(device);
  if (!state) return [];
  const tablet = getPath(style, ['@tablet']);
  return leafValues(getPath(style, [state])).map(([path, value]) => ({
    path,
    value,
    inherited: device === 'mobile' && same(getPath(tablet, path), value),
  }));
}

/** The values the device changes itself (a dot in the inspector): not inherited from Tablet. */
export const ownDeviceValues = (style: Style | undefined, device: Device) =>
  deviceValues(style, device).filter((v) => !v.inherited);

/**
 * Resets one value (or all of them, with no path) for a device, keeping
 * the inheritance: Tablet's reset leaves Mobile's own values alone; Mobile
 * goes back to Tablet's value.
 */
export function resetDeviceValue(
  style: Style | undefined,
  device: Device,
  path?: readonly string[],
): Style | undefined {
  const state = deviceState(device);
  if (!state) return style;
  const next = setPath(style, path ? [state, ...path] : [state], undefined);
  return inheritDown(device, style, next);
}

/* ------------------------------------------------------- labels for people */

/** Names for the style properties Studio's inspector edits, in plain words. */
const PROPERTY_LABELS: Readonly<Record<string, string>> = {
  'typography.fontSize': msgid('Font size'),
  'typography.fontFamily': msgid('Font'),
  'typography.fontWeight': msgid('Font weight'),
  'typography.fontStyle': msgid('Font style'),
  'typography.lineHeight': msgid('Line height'),
  'typography.letterSpacing': msgid('Letter spacing'),
  'typography.textTransform': msgid('Letter case'),
  'typography.textDecoration': msgid('Decoration'),
  'typography.textAlign': msgid('Text alignment'),
  'typography.textColumns': msgid('Columns'),
  'typography.writingMode': msgid('Orientation'),
  'color.text': msgid('Text colour'),
  'color.background': msgid('Background colour'),
  'color.gradient': msgid('Gradient'),
  'background.backgroundImage': msgid('Background image'),
  'background.backgroundSize': msgid('Background size'),
  'background.backgroundPosition': msgid('Background position'),
  'spacing.padding': msgid('Padding'),
  'spacing.margin': msgid('Margin'),
  'spacing.blockGap': msgid('Space between blocks'),
  'dimensions.minHeight': msgid('Minimum height'),
  'dimensions.aspectRatio': msgid('Aspect ratio'),
  'dimensions.width': msgid('Width'),
  'dimensions.height': msgid('Height'),
  border: msgid('Border'),
  shadow: msgid('Shadow'),
  elements: msgid('Links and buttons'),
};

/** The words for a side or corner ("top"), translated by the caller. */
const SIDE_LABELS: Readonly<Record<string, string>> = {
  top: msgid('top'),
  right: msgid('right'),
  bottom: msgid('bottom'),
  left: msgid('left'),
  topLeft: msgid('top left'),
  topRight: msgid('top right'),
  bottomLeft: msgid('bottom left'),
  bottomRight: msgid('bottom right'),
};

/**
 * What a value is, for people: the property's name and, for a side or
 * corner, which one ("Padding", "top"). Unknown properties show their own
 * name. Labels are msgids; translate them with `__()`.
 */
export function propertyLabel(path: readonly string[]): { label: string; detail?: string } {
  for (let length = Math.min(path.length, 2); length > 0; length--) {
    const key = path.slice(0, length).join('.');
    const label = PROPERTY_LABELS[key];
    if (label) {
      const rest = path.slice(length);
      const side = rest.length === 1 ? SIDE_LABELS[rest[0] as string] : undefined;
      return { label, detail: side ?? (rest.length ? rest.join(' ') : undefined) };
    }
  }
  return { label: path.join(' ') };
}

/** A stored value as people read it: a preset's name for `var:preset|font-size|small`. */
export function displayValue(value: unknown): string {
  if (typeof value === 'string') {
    const preset = /^var:preset\|[^|]+\|(.+)$/.exec(value);
    if (preset) return (preset[1] as string).replace(/-/g, ' ');
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/* ------------------------------------------------------------ visibility */

export type DeviceVisibility = Readonly<Record<Device, boolean>>;

const DEVICE_IDS: readonly Device[] = ['desktop', 'tablet', 'mobile'];

/**
 * Where a block shows, from `metadata.blockVisibility` (WordPress 7.1):
 * `false` hides it everywhere; `{ viewport: { mobile: false } }` hides it
 * on phones.
 */
export function blockVisibility(metadata: unknown): DeviceVisibility {
  const value = isObject(metadata) ? metadata.blockVisibility : undefined;
  if (value === false) return { desktop: false, tablet: false, mobile: false };
  const viewport = isObject(value) && isObject(value.viewport) ? value.viewport : {};
  return {
    desktop: viewport.desktop !== false,
    tablet: viewport.tablet !== false,
    mobile: viewport.mobile !== false,
  };
}

/**
 * The block's metadata with it shown or hidden on one device. Shown
 * everywhere removes `blockVisibility`; anything else is the viewport form,
 * which keeps a block hidden everywhere selectable in the editor.
 */
export function withBlockVisibility(
  metadata: unknown,
  device: Device,
  visible: boolean,
): Record<string, unknown> | undefined {
  const current = { ...blockVisibility(metadata), [device]: visible };
  const out: Record<string, unknown> = { ...(isObject(metadata) ? metadata : {}) };
  const hidden = DEVICE_IDS.filter((d) => !current[d]);
  if (hidden.length === 0) delete out.blockVisibility;
  else out.blockVisibility = { viewport: Object.fromEntries(hidden.map((d) => [d, false])) };
  return Object.keys(out).length ? out : undefined;
}

/** "Hidden on mobile", "Hidden on tablet and mobile"… or null when it shows everywhere. */
export function hiddenOn(visibility: DeviceVisibility): Device[] {
  return DEVICE_IDS.filter((d) => !visibility[d]);
}
