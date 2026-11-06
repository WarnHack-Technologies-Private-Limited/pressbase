/**
 * Handles on the canvas (#37): dragging a block's padding and margin, and
 * the gap between columns. Snapping, keyboard steps and the values they
 * write. Pure functions, tested in handles-model.test.ts. See
 * docs/architecture/studio.md#handles-on-the-canvas.
 *
 * - Spacing snaps to the theme's spacing presets in Simple
 *   (`var:preset|spacing|50`, as WordPress's spacing controls store them)
 *   and to whole pixels in Advanced.
 * - Column widths snap to common fractions (1/4, 1/3, 1/2, 2/3…), stored as
 *   WordPress's Column block stores its width (`"33.33%"`).
 * - On Tablet or Mobile, spacing goes into `style["@tablet"]` or
 *   `style["@mobile"]` (ADR 0023), through inheritDown() as the inspector's
 *   changes do.
 */

import type { Device } from './layout-model';
import type { StudioMode } from './mode-model';
import { inheritDown, type Style } from './responsive-model';

export type SpacingKind = 'padding' | 'margin';
export type Side = 'top' | 'right' | 'bottom' | 'left';
export const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

/** A theme spacing preset, with its size in pixels on the canvas now. */
export interface SpacingPreset {
  slug: string;
  name: string;
  px: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/* ------------------------------------------------------------ supports */

/**
 * The sides a block lets people set (`supports.spacing.padding` or
 * `.margin`): true is every side; a list names sides, or `vertical` and
 * `horizontal` (WordPress's BoxControl sides).
 */
export function spacingSides(spacing: unknown, kind: SpacingKind): Side[] {
  if (!isObject(spacing)) return [];
  const value = spacing[kind];
  if (value === true) return [...SIDES];
  if (!Array.isArray(value)) return [];
  const out = new Set<Side>();
  for (const entry of value) {
    if (entry === 'vertical') {
      out.add('top');
      out.add('bottom');
    } else if (entry === 'horizontal') {
      out.add('left');
      out.add('right');
    } else if (SIDES.includes(entry)) out.add(entry);
  }
  return SIDES.filter((side) => out.has(side));
}

/* -------------------------------------------------------- spacing values */

const PRESET = /^var:preset\|spacing\|(.+)$/;

export const presetValue = (slug: string) => `var:preset|spacing|${slug}`;

/** The preset a stored value names, if any. */
export const presetSlug = (value: unknown): string | null =>
  typeof value === 'string' ? (PRESET.exec(value)?.[1] ?? null) : null;

/** A stored value in pixels: a preset's size, px, or rem/em at 16px. Null when it can't tell. */
export function spacingPx(
  value: unknown,
  presets: readonly SpacingPreset[],
  rootPx = 16,
): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (value === 0 || value === '0') return 0;
  const slug = presetSlug(value);
  if (slug) return presets.find((p) => p.slug === slug)?.px ?? null;
  if (typeof value !== 'string') return null;
  const match = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return match[2] === 'rem' || match[2] === 'em' ? n * rootPx : n;
}

export interface SpacingValue {
  /** What's stored: a preset (`var:preset|spacing|50`), `"24px"` or `"0"`. */
  value: string;
  px: number;
  /** The preset, in Simple. */
  preset?: SpacingPreset;
}

const ZERO: SpacingValue = { value: '0', px: 0 };
/** The most a handle sets in Advanced. */
export const MAX_SPACING = 400;

/** The presets to snap to, smallest first, with none (0) before them. */
function snapPoints(presets: readonly SpacingPreset[]): SpacingValue[] {
  return [
    ZERO,
    ...[...presets]
      .filter((p) => Number.isFinite(p.px) && p.px > 0)
      .sort((a, b) => a.px - b.px)
      .map((preset) => ({ value: presetValue(preset.slug), px: preset.px, preset })),
  ];
}

/**
 * A dragged size, snapped: the nearest preset (or none) in Simple, or the
 * theme has no presets; whole pixels in Advanced.
 */
export function snapSpacing(
  px: number,
  mode: StudioMode,
  presets: readonly SpacingPreset[],
): SpacingValue {
  const points = snapPoints(presets);
  if (mode === 'simple' && points.length > 1) {
    let best = ZERO;
    for (const point of points) if (Math.abs(point.px - px) < Math.abs(best.px - px)) best = point;
    return best;
  }
  const n = Math.round(Math.min(MAX_SPACING, Math.max(0, px)));
  return n === 0 ? ZERO : { value: `${n}px`, px: n };
}

/**
 * One arrow key on a spacing handle: the next preset up or down in Simple;
 * a pixel (ten with Shift) in Advanced. `to: 'min' | 'max'` is Home and End.
 */
export function stepSpacing(
  px: number,
  step: 1 | -1 | 'min' | 'max',
  mode: StudioMode,
  presets: readonly SpacingPreset[],
  big = false,
): SpacingValue {
  const points = snapPoints(presets);
  if (mode === 'simple' && points.length > 1) {
    if (step === 'min') return ZERO;
    if (step === 'max') return points[points.length - 1] as SpacingValue;
    // Half a pixel either way counts as being on a preset.
    // Presets the same size here (a clamp() at its minimum on a phone): the first of them.
    const below = [...points].reverse().find((p) => p.px < px - 0.5);
    const next =
      step === 1
        ? points.find((p) => p.px > px + 0.5)
        : below && points.find((p) => p.px === below.px);
    return next ?? (step === 1 ? (points[points.length - 1] as SpacingValue) : ZERO);
  }
  if (step === 'min') return ZERO;
  if (step === 'max') return snapSpacing(MAX_SPACING, 'advanced', presets);
  return snapSpacing(Math.round(px) + step * (big ? 10 : 1), 'advanced', presets);
}

/** The state a device writes to, as in responsive-model.ts. */
const stateOf = (device: Device) =>
  device === 'tablet' ? '@tablet' : device === 'mobile' ? '@mobile' : null;

/** A side's value in `spacing.padding` (a string there sets every side). */
function sideOf(box: unknown, side: Side): unknown {
  if (typeof box === 'string') return box;
  return isObject(box) ? box[side] : undefined;
}

/**
 * The value a side has for a device as stored: the device's own, else
 * Desktop's (the base style reaches every size).
 */
export function storedSpacing(
  style: Style | undefined,
  device: Device,
  kind: SpacingKind,
  side: Side,
): unknown {
  const state = stateOf(device);
  if (state) {
    const scope = style?.[state] as Style | undefined;
    const own = sideOf((scope?.spacing as Style | undefined)?.[kind], side);
    if (own !== undefined) return own;
  }
  return sideOf((style?.spacing as Style | undefined)?.[kind], side);
}

/**
 * A block's style with one side's padding or margin set, for the device
 * shown: the base style on Desktop, `style["@tablet"]` or `["@mobile"]`
 * on the others, carried down as the inspector's changes are
 * (inheritDown()). A box stored as one string becomes four sides first.
 */
export function withSpacing(
  style: Style | undefined,
  device: Device,
  kind: SpacingKind,
  side: Side,
  value: string,
): Style {
  const state = stateOf(device);
  const scope = (state ? (style?.[state] as Style | undefined) : style) ?? {};
  const spacing = isObject(scope.spacing) ? scope.spacing : {};
  const current = spacing[kind];
  const box: Record<string, unknown> =
    typeof current === 'string'
      ? Object.fromEntries(SIDES.map((s) => [s, current]))
      : isObject(current)
        ? { ...current }
        : {};
  box[side] = value;
  const nextScope = { ...scope, spacing: { ...spacing, [kind]: box } };
  const next: Style = state
    ? { ...(style ?? {}), [state]: nextScope }
    : { ...(style ?? {}), ...nextScope };
  return device === 'desktop' ? next : (inheritDown(device, style, next) ?? next);
}

/* ------------------------------------------------------------- columns */

/** The fractions column widths snap to. */
export const FRACTIONS: readonly [number, number][] = [
  [1, 6],
  [1, 5],
  [1, 4],
  [1, 3],
  [2, 5],
  [1, 2],
  [3, 5],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
];

/** The narrowest a column gets from a handle: a tenth of the row. */
export const MIN_COLUMN = 0.1;
/** How near a fraction an Advanced drag has to come to snap to it. */
const SNAP_RANGE = 0.02;

const nearestFraction = (f: number) => {
  let best = FRACTIONS[0] as [number, number];
  for (const fraction of FRACTIONS) {
    if (Math.abs(fraction[0] / fraction[1] - f) < Math.abs(best[0] / best[1] - f)) best = fraction;
  }
  return best[0] / best[1];
};

/**
 * A column's share of the row, snapped: always to the nearest common
 * fraction in Simple; in Advanced only when within 2%, else to a whole
 * percent.
 */
export function snapFraction(f: number, mode: StudioMode): number {
  const near = nearestFraction(f);
  if (mode === 'simple' || Math.abs(near - f) <= SNAP_RANGE) return near;
  return Math.round(f * 100) / 100;
}

/** Each column's share of the row, from their widths on the canvas. */
export function shares(widths: readonly number[]): number[] {
  const total = widths.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (!total) return widths.map(() => 1 / Math.max(1, widths.length));
  return widths.map((w) => Math.max(0, w) / total);
}

/**
 * The row's shares after moving the gap after column `index` so that
 * column takes `share` of the row (snapped); the column after it gives or
 * takes the difference, the others keep theirs. Neither gets narrower than
 * MIN_COLUMN.
 */
export function resizeColumns(
  current: readonly number[],
  index: number,
  share: number,
  /** `exact`: no snapping (Advanced's arrow keys). */
  mode: StudioMode | 'exact',
): number[] {
  const left = current[index];
  const right = current[index + 1];
  if (left === undefined || right === undefined) return [...current];
  const pair = left + right;
  let next = mode === 'exact' ? share : snapFraction(share, mode);
  if (next < MIN_COLUMN || next > pair - MIN_COLUMN) {
    next = Math.min(pair - MIN_COLUMN, Math.max(MIN_COLUMN, share));
  }
  const out = [...current];
  out[index] = next;
  out[index + 1] = pair - next;
  return out;
}

/**
 * One arrow key on a column gap: the column before it to the next common
 * fraction (Simple) or a percent, ten with Shift (Advanced).
 */
export function stepColumns(
  current: readonly number[],
  index: number,
  step: 1 | -1,
  mode: StudioMode,
  big = false,
): number[] {
  const left = current[index] ?? 0;
  if (mode === 'simple') {
    const values = FRACTIONS.map(([a, b]) => a / b);
    const target =
      step === 1
        ? values.find((v) => v > left + 0.001)
        : [...values].reverse().find((v) => v < left - 0.001);
    if (target === undefined) return [...current];
    return resizeColumns(current, index, target, 'simple');
  }
  const target = Math.round((left + step * (big ? 0.1 : 0.01)) * 100) / 100;
  return resizeColumns(current, index, target, 'exact');
}

/** A share as WordPress's Column block stores its width: `"33.33%"`. */
export const columnWidth = (share: number) => `${Number.parseFloat((share * 100).toFixed(2))}%`;

/** A share in words: "1/3" when it's a common fraction, else "37%". */
export function fractionLabel(share: number): string {
  for (const [a, b] of FRACTIONS) if (Math.abs(a / b - share) < 0.002) return `${a}/${b}`;
  return `${Math.round(share * 100)}%`;
}
