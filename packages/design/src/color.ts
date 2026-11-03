/**
 * Colour maths: OKLCH (the perceptual space palettes are built in) to sRGB
 * hex and back, and WCAG 2.2 contrast. OKLab is Björn Ottosson's
 * (https://bottosson.github.io/posts/oklab/), as CSS Color 4 defines it.
 */

/** A colour in OKLCH: lightness 0–1, chroma ≥ 0 (about 0.37 at most in sRGB), hue in degrees. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

type Rgb = [number, number, number];

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

/** sRGB transfer function, encoded 0–1 → linear. */
function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function fromLinear(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/** Linear sRGB of an OKLCH colour; channels may fall outside 0–1 (out of gamut). */
function oklchToLinearRgb({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

function linearRgbToOklch([r, g, b]: Rgb): Oklch {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = c < 1e-7 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

/**
 * The colour, brought into sRGB by lowering its chroma (keeping lightness
 * and hue), as CSS Color 4's gamut mapping does in spirit.
 */
export function toGamut(color: Oklch): Oklch {
  const l = clamp(color.l);
  const c = Math.max(0, color.c);
  if (inGamut(oklchToLinearRgb({ l, c, h: color.h }))) return { l, c, h: color.h };
  let low = 0;
  let high = c;
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    if (inGamut(oklchToLinearRgb({ l, c: mid, h: color.h }))) low = mid;
    else high = mid;
  }
  return { l, c: low, h: color.h };
}

const hex2 = (v: number) =>
  Math.round(clamp(v) * 255)
    .toString(16)
    .padStart(2, '0');

/** `#rrggbb` for an OKLCH colour, mapped into sRGB first. */
export function oklchToHex(color: Oklch): string {
  const [r, g, b] = oklchToLinearRgb(toGamut(color));
  return `#${hex2(fromLinear(r))}${hex2(fromLinear(g))}${hex2(fromLinear(b))}`;
}

/** OKLCH of a `#rgb` or `#rrggbb` colour. */
export function hexToOklch(hex: string): Oklch {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`Not a hex colour: ${hex}`);
  return linearRgbToOklch(rgb.map((v) => toLinear(v / 255)) as Rgb);
}

/** 0–255 channels of `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (alpha ignored), or null. */
export function parseHex(hex: string): Rgb | null {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!match?.[1]) return null;
  let digits = match[1];
  if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('');
  return [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16)) as Rgb;
}

/** WCAG 2.2 relative luminance of a hex colour. */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`Not a hex colour: ${hex}`);
  const [r, g, b] = rgb.map((v) => toLinear(v / 255)) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.2 contrast ratio of two hex colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * WCAG 2.2 AA minimums: 4.5:1 for text (1.4.3), 3:1 for large text (18pt,
 * or 14pt bold) and for UI components and graphics (1.4.11). `high` is AAA
 * for text (1.4.6): 7:1, and 4.5:1 for large text.
 */
export const CONTRAST_MINIMUMS = {
  standard: { text: 4.5, large: 3, ui: 3 },
  high: { text: 7, large: 4.5, ui: 3 },
} as const;

export type ContrastLevel = keyof typeof CONTRAST_MINIMUMS;
export type ContrastUse = 'text' | 'large' | 'ui';
