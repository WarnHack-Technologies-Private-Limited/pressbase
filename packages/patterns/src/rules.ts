import { type ParsedBlock, parseBlocks, serializeBlocks } from '@pressbase/blocks';
import { extractSlots, type Slot, unknownDeclarations } from '@pressbase/slots';
import { LIBRARY_CATEGORIES, type LibraryPattern } from './library';

/**
 * checkPattern(): the library's rules (see the README), as code. Returns
 * the problems found; an empty list means the pattern may ship.
 */

/** Presets every block theme is expected to have: WordPress's default slugs. */
export const PORTABLE_PRESETS = {
  /** WordPress's default font sizes. Themes that replace them keep these slugs. */
  'font-size': ['small', 'medium', 'large', 'x-large', 'xx-large'],
  /** The default spacing scale (spacingScale, steps 20–80). */
  spacing: ['20', '30', '40', '50', '60', '70', '80'],
  /** The two colours block themes name alike; anything else comes from the theme's own styles. */
  color: ['base', 'contrast'],
} as const;

/**
 * The Pressbase theme's own presets (themes/pressbase/theme.json), which
 * every site Pressbase builds has: generated designs (@pressbase/design's
 * PALETTE_SLUGS) restyle these slugs. A theme without one of them ignores
 * it (the class or variable matches nothing), so a section must still read
 * without them: a card on `surface` is a card on the page colour, a
 * `display` headline is the theme's h1.
 */
export const PRESSBASE_PRESETS = {
  'font-size': ['xxx-large', 'display'],
  color: [
    'surface',
    'muted',
    'border',
    'accent',
    'accent-text',
    'accent-soft',
    'on-accent',
    'violet',
  ],
  'border-radius': ['sm', 'md', 'lg', 'xl', 'full'],
} as const;

/** Block style variations WordPress registers for core blocks. */
const CORE_BLOCK_STYLES = new Set([
  'is-style-default',
  'is-style-fill',
  'is-style-outline',
  'is-style-rounded',
  'is-style-wide',
  'is-style-dots',
  'is-style-plain',
  'is-style-stripes',
  'is-style-logos-only',
  'is-style-pill-shape',
]);

/** Core blocks a library pattern can't use: arbitrary HTML, scripts or third-party embeds. */
const FORBIDDEN_BLOCKS = new Set([
  'core/html',
  'core/freeform',
  'core/shortcode',
  'core/embed',
  'core/pattern',
  'core/block',
  'core/template-part',
]);

/** Attributes that hold a custom (non-preset) colour or gradient. */
const CUSTOM_COLOUR_ATTRIBUTES = [
  'customTextColor',
  'customBackgroundColor',
  'customGradient',
  'customOverlayColor',
  'overlayColor',
  'gradient',
];

const RAW_COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/i;
const RAW_LENGTH =
  /\d(?:\.\d+)?(?:px|rem|em|ex|ch|vw|vh|vmin|vmax|svh|dvh|lvh|pt|pc|cm|mm|in|%)(?![a-z0-9])/i;
const PRESET = /^var:preset\|([a-z-]+)\|([a-z0-9-]+)$/;
const CSS_PRESET = /var\(--wp--preset--([a-z-]+)--([a-z0-9-]+)\)/g;

function* walk(blocks: ParsedBlock[]): Generator<ParsedBlock> {
  for (const block of blocks) {
    yield block;
    yield* walk(block.innerBlocks);
  }
}

function presetProblem(kind: string, slug: string): string | null {
  const portable = (PORTABLE_PRESETS as Record<string, readonly string[]>)[kind] ?? [];
  const pressbase = (PRESSBASE_PRESETS as Record<string, readonly string[]>)[kind] ?? [];
  return portable.includes(slug) || pressbase.includes(slug)
    ? null
    : `the ${kind} preset "${slug}" isn't one every theme has`;
}

/** Every string in `style`: a preset, `0`, or a plain keyword or number, never a raw size or colour. */
function checkStyle(value: unknown, where: string, problems: string[]): void {
  if (typeof value === 'string') {
    const preset = PRESET.exec(value);
    if (preset) {
      const problem = presetProblem(preset[1] as string, preset[2] as string);
      if (problem) problems.push(`${where}: ${problem}`);
    } else if (RAW_COLOUR.test(value) || RAW_LENGTH.test(value)) {
      problems.push(`${where}: "${value}" is a raw value; use a preset`);
    } else if (/(?:^|\.)(?:color|fontFamily)(?:\.|$)/.test(where) && value !== '') {
      problems.push(`${where}: "${value}" isn't a preset`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value))
      checkStyle(child, `${where}.${key}`, problems);
  }
}

function checkHtml(block: ParsedBlock, name: string, problems: string[]): void {
  const html = block.innerContent.filter((c): c is string => typeof c === 'string').join('');
  if (/<script\b|<style\b|<iframe\b/i.test(html))
    problems.push(`${name}: scripts, styles and frames aren't allowed`);
  if (/\son[a-z]+\s*=/i.test(html))
    problems.push(`${name}: event handler attributes aren't allowed`);
  if (/javascript:/i.test(html)) problems.push(`${name}: javascript: links aren't allowed`);
  for (const m of html.matchAll(/\sstyle="([^"]*)"/g)) {
    let css = (m[1] as string).replace(CSS_PRESET, '');
    // A column's width (saved as its flex-basis) is a share of the row, not a size.
    if (name === 'core/column') css = css.replace(/flex-basis:\d+(?:\.\d+)?%/g, '');
    if (RAW_COLOUR.test(css) || RAW_LENGTH.test(css)) {
      problems.push(`${name}: inline style "${m[1]}" has a raw value`);
    }
    for (const preset of (m[1] as string).matchAll(CSS_PRESET)) {
      const problem = presetProblem(preset[1] as string, preset[2] as string);
      if (problem) problems.push(`${name}: ${problem}`);
    }
  }
}

function checkBlock(block: ParsedBlock, problems: string[]): void {
  const name = block.blockName;
  if (name === null) {
    if (block.innerHTML.trim()) problems.push('HTML outside blocks');
    return;
  }
  if (!name.startsWith('core/')) problems.push(`${name}: only core blocks are allowed`);
  if (FORBIDDEN_BLOCKS.has(name)) problems.push(`${name}: not allowed in a library pattern`);
  const attrs = block.attrs;
  for (const key of CUSTOM_COLOUR_ATTRIBUTES) {
    if (attrs[key] !== undefined) problems.push(`${name}: "${key}" is a custom colour`);
  }
  if (attrs.fontFamily !== undefined) {
    problems.push(`${name}: fonts come from the theme ("fontFamily" is set)`);
  }
  if (typeof attrs.fontSize === 'string') {
    const problem = presetProblem('font-size', attrs.fontSize);
    if (problem) problems.push(`${name}: ${problem}`);
  }
  for (const key of ['textColor', 'backgroundColor']) {
    if (typeof attrs[key] === 'string') {
      const problem = presetProblem('color', attrs[key] as string);
      if (problem) problems.push(`${name}: ${problem}`);
    }
  }
  if (attrs.style !== undefined) checkStyle(attrs.style, `${name} style`, problems);
  const layout = attrs.layout as Record<string, unknown> | undefined;
  for (const key of ['contentSize', 'wideSize']) {
    if (layout?.[key] !== undefined) problems.push(`${name}: layout.${key} is a raw size`);
  }
  // A grid's minimum column width is what lets it wrap on small screens. In
  // rem, it follows the text size rather than fixing a width.
  const minimum = layout?.minimumColumnWidth;
  if (
    minimum !== undefined &&
    !(typeof minimum === 'string' && /^\d+(?:\.\d+)?rem$/.test(minimum))
  ) {
    problems.push(`${name}: layout.minimumColumnWidth must be in rem`);
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'style' || key === 'metadata' || typeof value !== 'string') continue;
    // A column's width is a share of the row, not a size.
    if (name === 'core/column' && key === 'width' && /^\d+(?:\.\d+)?%$/.test(value)) continue;
    if (RAW_COLOUR.test(value) || RAW_LENGTH.test(value)) {
      problems.push(`${name}: "${key}" is a raw value ("${value}")`);
    }
  }
  if (attrs.isStackedOnMobile === false) problems.push(`${name}: must stack on mobile`);
  if (typeof attrs.className === 'string') {
    for (const token of attrs.className.split(/\s+/).filter(Boolean)) {
      if (!CORE_BLOCK_STYLES.has(token)) {
        problems.push(`${name}: class "${token}" depends on a theme; use core block styles only`);
      }
    }
  }
  checkHtml(block, name, problems);
}

function checkHeadings(blocks: ParsedBlock[], pattern: LibraryPattern, problems: string[]): void {
  const levels = [...walk(blocks)]
    .filter((b) => b.blockName === 'core/heading')
    .map((b) => (typeof b.attrs.level === 'number' ? b.attrs.level : 2));
  const section = pattern.categories[0];
  if (section === 'header' || section === 'footer') return;
  const [first, ...rest] = levels;
  const expected = section === 'banner' ? 1 : 2;
  if (first !== expected) {
    problems.push(`the section must open with one h${expected}${first ? `, not h${first}` : ''}`);
    return;
  }
  let previous = first;
  for (const level of rest) {
    if (level <= first)
      problems.push(`only the first heading may be h${first}; found another h${level}`);
    else if (level > previous + 1)
      problems.push(`heading levels skip from h${previous} to h${level}`);
    previous = level;
  }
}

function checkImages(slots: Slot[], problems: string[]): void {
  for (const slot of slots) {
    if (slot.kind === 'group') {
      for (const item of slot.items) checkImages(item, problems);
    } else if (slot.kind === 'image' && !slot.value.alt.trim()) {
      problems.push(`image "${slot.id}" needs alt text that says what it shows`);
    }
  }
}

/** The problems with a library pattern; empty when it follows every rule. */
export function checkPattern(pattern: LibraryPattern): string[] {
  const problems: string[] = [];
  const blocks = parseBlocks(pattern.content);
  if (serializeBlocks(blocks) !== pattern.content) {
    problems.push("the markup doesn't serialise back to itself; copy it from the Code editor");
  }
  if (!blocks.some((b) => b.blockName !== null)) problems.push('there are no blocks');
  for (const block of walk(blocks)) checkBlock(block, problems);
  checkHeadings(blocks, pattern, problems);

  const section = LIBRARY_CATEGORIES.find((c) => c.name === pattern.categories[0]);
  if (!section) {
    problems.push(
      `the first category, "${pattern.categories[0]}", must be one of the library's: ${LIBRARY_CATEGORIES.map((c) => c.name).join(', ')}`,
    );
  }
  if (pattern.viewportWidth < 320 || pattern.viewportWidth > 1600) {
    problems.push('viewportWidth must be between 320 and 1600');
  }
  if (pattern.keywords.length === 0) problems.push('add a few keywords for search');

  // Declarations apply, so a group declared with minItems or maxItems is one
  // even with a single item; `ignore` doesn't, so an ignored slot still counts.
  const kept = Object.fromEntries(
    Object.entries(pattern.slots ?? {}).map(([id, { ignore: _ignore, ...rest }]) => [id, rest]),
  );
  const inferred = extractSlots(blocks, { declarations: kept });
  const unknown = unknownDeclarations(inferred, pattern.slots ?? {});
  if (unknown.length) problems.push(`declared slots that don't exist: ${unknown.join(', ')}`);
  const slots = extractSlots(blocks, { declarations: pattern.slots });
  if (slots.length === 0 && section?.section !== 'header' && section?.section !== 'footer') {
    problems.push('the pattern has no slots to fill');
  }
  checkImages(slots, problems);
  return problems;
}
