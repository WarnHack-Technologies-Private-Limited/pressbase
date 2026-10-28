/**
 * Approximate pixel widths for search result snippets.
 *
 * Google truncates titles and descriptions by rendered width, not by character count, so
 * "WWWW" runs out of room long before "iiii". We estimate width with Arial's advance widths
 * (Google's results use Arial-like sans-serif fonts). Estimates only: real rendering depends on
 * the font actually used, kerning and the device.
 */

/**
 * Google's search result layout, approximately, as of 2026. These numbers are not published by
 * Google and change from time to time; treat them as guidance, not limits.
 */
export const SERP = {
  titleFontPx: 20,
  titleMaxPx: 600,
  titleMaxMobilePx: 600,
  descFontPx: 14,
  descMaxDesktopPx: 920,
  descMaxMobilePx: 680,
} as const;

/** Arial advance widths in 1/1000 em for ASCII 32 (space) … 126 (~). */
// biome-ignore format: one row per 16 characters keeps the table readable
const ASCII_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, //  !"#$%&'()*+,-./
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9:;<=>?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @A-O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z[\]^_
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // `a-o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p-z{|}~
];

const SPECIAL_WIDTHS: Record<string, number> = {
  ' ': 278,
  '…': 1000,
  '‘': 222,
  '’': 222,
  '“': 333,
  '”': 333,
  '–': 556,
  '—': 1000,
  '•': 350,
  '·': 278,
  '«': 556,
  '»': 556,
  '©': 737,
  '®': 737,
  '™': 1000,
  '€': 556,
  '£': 556,
};

/** Width of one character (code point) in 1/1000 em. */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 32 && code <= 126) return ASCII_WIDTHS[code - 32] ?? 556;
  const special = SPECIAL_WIDTHS[ch];
  if (special !== undefined) return special;
  if (code < 32 || (code >= 0x300 && code <= 0x36f) || code === 0x200b) return 0; // controls, marks
  // Accented Latin letters: use the base letter's width (é → e).
  const base = ch.normalize('NFD').codePointAt(0) ?? code;
  if (base !== code && base >= 32 && base <= 126) return ASCII_WIDTHS[base - 32] ?? 556;
  if (
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals … unified ideographs, kana
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xff60) || // full-width forms
    code >= 0x1f000 // emoji and other astral symbols
  ) {
    return 1000;
  }
  return 550;
}

/** Estimated rendered width in pixels of `text` in Arial at `fontSizePx`. */
export function textWidth(text: string, fontSizePx: number): number {
  let units = 0;
  for (const ch of text) units += charWidth(ch);
  return (units * fontSizePx) / 1000;
}

const ELLIPSIS = ' …';

/**
 * Cuts `text` to fit within `maxPx` at a word boundary, appending ' …' when it was cut.
 * A single word too long to fit is cut mid-word.
 */
export function truncateToWidth(
  text: string,
  fontSizePx: number,
  maxPx: number,
): { text: string; truncated: boolean } {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (textWidth(clean, fontSizePx) <= maxPx) return { text: clean, truncated: false };

  const budget = maxPx - textWidth(ELLIPSIS, fontSizePx);
  let fitted = '';
  for (const word of clean.split(' ')) {
    const next = fitted ? `${fitted} ${word}` : word;
    if (textWidth(next, fontSizePx) > budget) break;
    fitted = next;
  }
  if (!fitted) {
    // Not even the first word fits: cut it by characters.
    let width = 0;
    for (const ch of clean) {
      width += (charWidth(ch) * fontSizePx) / 1000;
      if (width > budget) break;
      fitted += ch;
    }
  }
  fitted = fitted.replace(/[\s,;:–—-]+$/u, '');
  return { text: `${fitted}${ELLIPSIS}`, truncated: true };
}
