import type { JsonObject } from './types';
import { isObject } from './util';

/**
 * Fluid typography — wp_get_typography_value_and_unit(),
 * wp_get_computed_fluid_typography_value() and wp_get_typography_font_size_value()
 * (wordpress/wp-includes/block-supports/typography.php).
 */

interface ValueAndUnit {
  value: number;
  unit: string;
}

/** PHP's round( $value, 3 ), printed as PHP prints floats. */
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** wp_get_typography_value_and_unit() */
export function typographyValueAndUnit(
  raw: unknown,
  options: { coerceTo?: string; rootSize?: number; acceptableUnits?: string[] } = {},
): ValueAndUnit | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  if (raw === '' || raw === 0 || raw === '0') return null;
  let input = String(raw);
  if (typeof raw === 'number' || /^\d*\.?\d+$/.test(input)) input = `${input}px`;
  const coerceTo = options.coerceTo ?? '';
  const rootSize = options.rootSize ?? 16;
  const acceptable = options.acceptableUnits ?? ['rem', 'px', 'em'];
  const match = /^(\d*\.?\d+)([a-zA-Z]+|%)$/.exec(input);
  if (!match) return null;
  let value = Number.parseFloat(match[1] as string);
  let unit = match[2] as string;
  if (!acceptable.includes(unit)) return null;
  if (coerceTo === 'px' && (unit === 'em' || unit === 'rem')) {
    value *= rootSize;
    unit = coerceTo;
  }
  if (unit === 'px' && (coerceTo === 'em' || coerceTo === 'rem')) {
    value /= rootSize;
    unit = coerceTo;
  }
  if ((coerceTo === 'em' || coerceTo === 'rem') && (unit === 'em' || unit === 'rem')) {
    unit = coerceTo;
  }
  return { value: round3(value), unit };
}

/** wp_get_computed_fluid_typography_value() */
export function computedFluidTypographyValue(args: {
  minimumViewportWidth: string;
  maximumViewportWidth: string;
  minimumFontSize: string;
  maximumFontSize: string;
  scaleFactor?: number;
}): string | null {
  const minimumFontSize = typographyValueAndUnit(args.minimumFontSize);
  const unit = minimumFontSize?.unit ?? 'rem';
  const maximumFontSize = typographyValueAndUnit(args.maximumFontSize, { coerceTo: unit });
  if (!maximumFontSize || !minimumFontSize) return null;
  const minimumFontSizeRem = typographyValueAndUnit(args.minimumFontSize, { coerceTo: 'rem' });
  const maximumViewport = typographyValueAndUnit(args.maximumViewportWidth, { coerceTo: unit });
  const minimumViewport = typographyValueAndUnit(args.minimumViewportWidth, { coerceTo: unit });
  if (!minimumViewport || !maximumViewport || !minimumFontSizeRem) return null;
  const denominator = maximumViewport.value - minimumViewport.value;
  if (!denominator) return null;
  const viewportOffset = `${round3(minimumViewport.value / 100)}${unit}`;
  const linearFactor = 100 * ((maximumFontSize.value - minimumFontSize.value) / denominator);
  let scaled = round3(linearFactor * (args.scaleFactor ?? 1));
  if (!scaled) scaled = 1;
  const target = `${minimumFontSizeRem.value}${minimumFontSizeRem.unit} + ((1vw - ${viewportOffset}) * ${scaled})`;
  return `clamp(${args.minimumFontSize}, ${target}, ${args.maximumFontSize})`;
}

/**
 * wp_get_typography_font_size_value(): a preset's (or custom) font size,
 * turned into a fluid `clamp()` when the theme enables fluid typography.
 * `settings` are the global settings (wp_get_global_settings()).
 */
export function typographyFontSizeValue(
  preset: { size?: unknown; fluid?: unknown },
  settings: JsonObject = {},
): string | undefined {
  if (preset.size === undefined || preset.size === null) return undefined;
  const size = String(preset.size);
  const fluidPreset = preset.fluid;
  if (fluidPreset === false || size === '' || size === '0') return size;

  const typography = isObject(settings.typography) ? settings.typography : {};
  const fluidPresetObject = isObject(fluidPreset) ? fluidPreset : undefined;
  const fluidEnabled = typography.fluid;
  const isEmptyFluid =
    fluidEnabled === undefined ||
    fluidEnabled === null ||
    fluidEnabled === false ||
    (isObject(fluidEnabled) && Object.keys(fluidEnabled).length === 0);
  const presetFluidEmpty =
    fluidPreset === undefined ||
    fluidPreset === null ||
    (isObject(fluidPreset) && Object.keys(fluidPreset).length === 0);
  if (isEmptyFluid && presetFluidEmpty) return size;

  const fluid = isObject(fluidEnabled) ? fluidEnabled : {};
  const layout = isObject(settings.layout) ? settings.layout : {};
  const minimumViewportWidth =
    typeof fluid.minViewportWidth === 'string' ? fluid.minViewportWidth : '320px';
  let maximumViewportWidth =
    typeof layout.wideSize === 'string' && typographyValueAndUnit(layout.wideSize)
      ? layout.wideSize
      : '1600px';
  if (typeof fluid.maxViewportWidth === 'string') maximumViewportWidth = fluid.maxViewportWidth;
  const hasMinFontSize =
    typeof fluid.minFontSize === 'string' && typographyValueAndUnit(fluid.minFontSize) !== null;
  const minimumLimitRaw = hasMinFontSize ? (fluid.minFontSize as string) : '14px';

  let minimumRaw = typeof fluidPresetObject?.min === 'string' ? fluidPresetObject.min : undefined;
  let maximumRaw = typeof fluidPresetObject?.max === 'string' ? fluidPresetObject.max : undefined;

  const preferred = typographyValueAndUnit(size);
  if (!preferred?.unit) return size;
  const minimumLimit = typographyValueAndUnit(minimumLimitRaw, { coerceTo: preferred.unit });
  if (minimumLimit && !minimumRaw && !maximumRaw) {
    // Font sizes at or below the minimum limit don't become fluid.
    if (preferred.value <= minimumLimit.value) return size;
  }
  if (!maximumRaw) maximumRaw = `${preferred.value}${preferred.unit}`;
  if (!minimumRaw) {
    const inPx = preferred.unit === 'px' ? preferred.value : preferred.value * 16;
    const factor = Math.min(Math.max(1 - 0.075 * Math.log2(inPx), 0.25), 0.75);
    const calculated = round3(preferred.value * factor);
    minimumRaw =
      minimumLimit && calculated <= minimumLimit.value
        ? `${minimumLimit.value}${minimumLimit.unit}`
        : `${calculated}${preferred.unit}`;
  }
  return (
    computedFluidTypographyValue({
      minimumViewportWidth,
      maximumViewportWidth,
      minimumFontSize: minimumRaw,
      maximumFontSize: maximumRaw,
      scaleFactor: 1,
    }) ?? size
  );
}
