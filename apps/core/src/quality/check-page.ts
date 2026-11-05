import type { AttributeSchema } from '@pressbase/blocks';
import {
  blockDelimiterPattern,
  type ParsedBlock,
  parseBlocks,
  validateValueFromSchema,
} from '@pressbase/blocks';
import { CONTRAST_MINIMUMS, contrastRatio, parseHex } from '@pressbase/design';
import { extractSlots, findPlaceholders, richTextToPlain, type Slot } from '@pressbase/slots';

/**
 * Quality checks for a page: what runs after every AI generation and on
 * Studio's "Before you publish" checklist, and is useful without AI too.
 * Pure: give it the page's block markup, the styles it's shown with and the
 * registered block types. See docs/architecture/quality-checks.md.
 */

export type CheckRule =
  | 'block_unknown'
  | 'block_invalid'
  | 'contrast'
  | 'heading_multiple_h1'
  | 'heading_no_h1'
  | 'heading_skipped'
  | 'image_alt'
  | 'placeholder'
  | 'link_text'
  | 'color_raw';

export const CHECK_RULES: readonly CheckRule[] = [
  'block_unknown',
  'block_invalid',
  'contrast',
  'heading_multiple_h1',
  'heading_no_h1',
  'heading_skipped',
  'image_alt',
  'placeholder',
  'link_text',
  'color_raw',
];

/** Where a finding is: the block's indexes from the page's top-level blocks through `innerBlocks`. */
export interface BlockReference {
  path: number[];
  name: string | null;
}

export interface PageFinding {
  rule: CheckRule;
  /** `error`: fails the page (the evaluation suite's bar). `warning`: listed for a person to decide. */
  severity: 'error' | 'warning';
  message: string;
  /** Null for the page as a whole (its delimiters, the site's body colours, a missing h1). */
  block: BlockReference | null;
  data?: Record<string, unknown>;
}

/** Colours as the page shows them; values are hex, or preset references (`var:preset|color|base`). */
export interface ColorPair {
  text?: string;
  background?: string;
}

/**
 * The styles a page is checked against. Build it from merged theme.json
 * data with {@link pageStylesFromThemeJson}.
 */
export interface PageStyles {
  /** Preset colours by slug, hex. */
  palette: Record<string, string>;
  /** The body's text and background (`styles.color`). */
  text?: string;
  background?: string;
  /** Links (`styles.elements.link.color.text`). */
  link?: string;
  /** Buttons (`styles.elements.button.color`). */
  button?: ColorPair;
  /** Block style variations (`is-style-{name}`) that set colours, such as section styles. */
  variations?: Record<string, ColorPair & { link?: string; button?: ColorPair }>;
}

/** The part of a block type the checks read (a BlockType from @pressbase/blocks fits). */
export interface CheckedBlockType {
  parent: string[] | null;
  ancestor: string[] | null;
  allowedBlocks: string[] | null;
  attributes: Record<string, AttributeSchema>;
}

export interface CheckPageOptions {
  /** Registered block types (kernel.blocks.registry). Without it, unknown blocks and attributes aren't checked. */
  blockTypes?: { get(name: string): CheckedBlockType | undefined };
  /**
   * Whether the page's template shows the title as its `h1`: then the
   * content must not have another; when false, the content must have one.
   * Unknown (undefined): only more than one `h1` in the content is reported.
   */
  titleIsH1?: boolean;
  /** Translates messages (kernel.i18n); English otherwise. */
  i18n?: { __(text: string, domain: string): string };
  /** Only these rules. */
  rules?: readonly CheckRule[];
}

/* ------------------------------------------------------------------ util */

const identity = { __: (text: string) => text };

/** sprintf()'s `%s` and `%1$s` placeholders. */
function format(text: string, ...args: (string | number)[]): string {
  let next = 0;
  return text.replace(/%(?:(\d+)\$)?s/g, (_, n: string | undefined) =>
    String(args[n ? Number(n) - 1 : next++] ?? ''),
  );
}

type Visit = (block: ParsedBlock, path: number[], parents: ParsedBlock[]) => void;

function walk(
  blocks: ParsedBlock[],
  visit: Visit,
  path: number[] = [],
  parents: ParsedBlock[] = [],
) {
  blocks.forEach((block, index) => {
    const here = [...path, index];
    visit(block, here, parents);
    walk(block.innerBlocks, visit, here, [...parents, block]);
  });
}

const ref = (block: ParsedBlock, path: number[]): BlockReference => ({
  path,
  name: block.blockName,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const get = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
};

/** The block's own text, inner blocks left out. */
const plainText = (block: ParsedBlock) => richTextToPlain(block.innerHTML).trim();

/* --------------------------------------------------------------- colours */

const KEYWORDS = new Set(['transparent', 'inherit', 'currentcolor', 'initial', 'unset', 'none']);

function isPresetReference(value: string): boolean {
  return value.startsWith('var:preset|') || /^var\(--wp--preset--/.test(value);
}

/** A colour value as hex: a preset reference resolved through the palette, or a hex literal. */
function resolveColor(value: unknown, palette: Record<string, string>): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const preset =
    /^var:preset\|color\|([a-z0-9-]+)$/i.exec(value) ??
    /^var\(--wp--preset--color--([a-z0-9-]+)\)$/i.exec(value);
  if (preset?.[1]) return palette[preset[1]];
  if (parseHex(value)) return value;
  const rgb =
    /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(
      value,
    );
  if (rgb) {
    const alpha = rgb[4];
    if (alpha !== undefined && Number.parseFloat(alpha) < (alpha.endsWith('%') ? 100 : 1)) {
      return undefined;
    }
    return `#${[rgb[1], rgb[2], rgb[3]]
      .map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0'))
      .join('')}`;
  }
  return undefined;
}

/** Palette presets, keyed by origin or not: later origins win, as in the global stylesheet. */
function flattenPalette(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (isObject(entry) && typeof entry.slug === 'string' && typeof entry.color === 'string') {
        out[entry.slug] = entry.color;
      }
    }
  };
  if (Array.isArray(value)) add(value);
  else if (isObject(value)) for (const origin of ['default', 'theme', 'custom']) add(value[origin]);
  return out;
}

/**
 * {@link PageStyles} from merged theme.json data (`{ settings, styles }`,
 * as WP_Theme_JSON::get_raw_data() has them): the palette, the body,
 * link and button colours, and the colours of every block style variation.
 */
export function pageStylesFromThemeJson(data: {
  settings?: unknown;
  styles?: unknown;
}): PageStyles {
  const palette = flattenPalette(get(data.settings, 'color', 'palette'));
  const color = (value: unknown) => resolveColor(value, palette) ?? (value as string | undefined);
  const pair = (node: unknown): ColorPair => ({
    text: color(get(node, 'color', 'text')),
    background: color(get(node, 'color', 'background')),
  });
  const styles = data.styles;
  const variations: NonNullable<PageStyles['variations']> = {};
  const blocks = get(styles, 'blocks');
  if (isObject(blocks)) {
    for (const node of Object.values(blocks)) {
      const list = get(node, 'variations');
      if (!isObject(list)) continue;
      for (const [name, variation] of Object.entries(list)) {
        if (variations[name]) continue;
        const own = pair(variation);
        const link = color(get(variation, 'elements', 'link', 'color', 'text'));
        const button = pair(get(variation, 'elements', 'button'));
        if (!own.text && !own.background && !link && !button.text && !button.background) continue;
        variations[name] = {
          ...own,
          ...(link ? { link } : {}),
          ...(button.text || button.background ? { button } : {}),
        };
      }
    }
  }
  const root = pair(styles);
  return {
    palette,
    ...(root.text ? { text: root.text } : {}),
    ...(root.background ? { background: root.background } : {}),
    ...(color(get(styles, 'elements', 'link', 'color', 'text'))
      ? { link: color(get(styles, 'elements', 'link', 'color', 'text')) }
      : {}),
    button: pair(get(styles, 'elements', 'button')),
    variations,
  };
}

/* ------------------------------------------------------------ the checks */

const LARGE_FONT_SIZES = new Set([
  'large',
  'x-large',
  'xx-large',
  'xxx-large',
  'huge',
  'display',
  'larger',
  'extra-large',
]);

/** Vague link text (WCAG 2.4.4): it doesn't say where the link goes. Lowercase, trimmed. */
const VAGUE_LINK_TEXT = new Set([
  'click here',
  'click',
  'here',
  'click this',
  'this',
  'this link',
  'link',
  'read more',
  'more',
  'learn more',
  'more info',
  'more information',
  'details',
  'go',
  'continue',
]);

/** Blocks whose `img` is a background, not content. */
const BACKGROUND_IMAGE_BLOCKS = new Set(['core/cover']);

function styleVariation(block: ParsedBlock): string | undefined {
  const className = typeof block.attrs.className === 'string' ? block.attrs.className : '';
  return /(?:^|\s)is-style-([a-z0-9-]+)/.exec(className)?.[1];
}

/** What a placeholder finding shows a person: the bracketed text, or the button's label. */
function placeholderText(slot: Slot): string {
  if (slot.kind === 'button') return richTextToPlain(slot.value.text).trim();
  if (slot.kind === 'image') return slot.value.alt.trim();
  if (slot.kind === 'group') return '';
  return richTextToPlain(slot.value).trim();
}

/**
 * Checks a page's block markup and returns what's wrong, each finding with
 * a reference to its block. Rules: invalid or unknown blocks, colour pairs
 * below WCAG 2.2 AA, more than one `h1` or skipped heading levels, images
 * without alt text that aren't marked decorative, unfilled placeholders,
 * empty or vague link text, and raw colours outside the presets.
 */
export function checkPage(
  markup: string,
  styles: PageStyles | null = null,
  options: CheckPageOptions = {},
): PageFinding[] {
  const t = options.i18n ?? identity;
  const enabled = new Set(options.rules ?? CHECK_RULES);
  const findings: PageFinding[] = [];
  const add = (finding: PageFinding) => {
    if (enabled.has(finding.rule)) findings.push(finding);
  };
  const blocks = parseBlocks(markup);

  /* Delimiters: every opener closed, in order. */
  const stack: { name: string; start: number }[] = [];
  for (const match of markup.matchAll(blockDelimiterPattern())) {
    const name = `${match[2] ?? 'core/'}${match[3]}`;
    if (match[6]) continue;
    if (!match[1]) {
      stack.push({ name, start: match.index ?? 0 });
      continue;
    }
    if (stack[stack.length - 1]?.name === name) stack.pop();
    else {
      add({
        rule: 'block_invalid',
        severity: 'error',
        message: format(
          t.__('A closing %s delimiter has no matching opening one.', 'pressbase'),
          name,
        ),
        block: null,
        data: { name, offset: match.index },
      });
    }
  }
  for (const open of stack) {
    add({
      rule: 'block_invalid',
      severity: 'error',
      message: format(t.__('The %s block is never closed.', 'pressbase'), open.name),
      block: null,
      data: { name: open.name, offset: open.start },
    });
  }

  /* Blocks: known, valid attributes, allowed where they are. */
  const types = options.blockTypes;
  walk(blocks, (block, path, parents) => {
    if (block.blockName === null) {
      if (block.innerHTML.trim()) {
        add({
          rule: 'block_invalid',
          severity: 'error',
          message: t.__('Some content is outside any block.', 'pressbase'),
          block: ref(block, path),
        });
      }
      return;
    }
    if (!types) return;
    const type = types.get(block.blockName);
    if (!type) {
      add({
        rule: 'block_unknown',
        severity: 'error',
        message: format(
          t.__('The block %s is not available on this site.', 'pressbase'),
          block.blockName,
        ),
        block: ref(block, path),
      });
      return;
    }
    for (const [name, value] of Object.entries(block.attrs)) {
      const schema = type.attributes[name];
      if (!schema) continue;
      const problem = validateValueFromSchema(value, schema, name);
      if (problem) {
        add({
          rule: 'block_invalid',
          severity: 'error',
          message: format(
            t.__('The %1$s block has an invalid attribute: %2$s', 'pressbase'),
            block.blockName,
            problem,
          ),
          block: ref(block, path),
          data: { attribute: name },
        });
      }
    }
    const parent = parents[parents.length - 1];
    const parentName = parent?.blockName ?? null;
    if (type.parent?.length && (!parentName || !type.parent.includes(parentName))) {
      add({
        rule: 'block_invalid',
        severity: 'error',
        message: format(
          t.__('The %1$s block must be inside %2$s.', 'pressbase'),
          block.blockName,
          type.parent.join(', '),
        ),
        block: ref(block, path),
      });
    } else if (
      type.ancestor?.length &&
      !parents.some((p) => p.blockName && type.ancestor?.includes(p.blockName))
    ) {
      add({
        rule: 'block_invalid',
        severity: 'error',
        message: format(
          t.__('The %1$s block must be inside %2$s.', 'pressbase'),
          block.blockName,
          type.ancestor.join(', '),
        ),
        block: ref(block, path),
      });
    }
    const allowed = parentName ? types.get(parentName)?.allowedBlocks : null;
    if (allowed?.length && !allowed.includes(block.blockName)) {
      add({
        rule: 'block_invalid',
        severity: 'error',
        message: format(
          t.__('The %1$s block can’t contain %2$s.', 'pressbase'),
          parentName ?? '',
          block.blockName,
        ),
        block: ref(block, path),
      });
    }
  });

  /* Headings: one h1, no skipped levels. */
  let previous = options.titleIsH1 ? 1 : 0;
  let h1s = options.titleIsH1 ? 1 : 0;
  walk(blocks, (block, path) => {
    if (block.blockName !== 'core/heading') return;
    const level = Number(block.attrs.level ?? 2);
    if (!Number.isInteger(level) || level < 1 || level > 6) return;
    if (level === 1) {
      h1s++;
      if (h1s > 1) {
        add({
          rule: 'heading_multiple_h1',
          severity: 'error',
          message: options.titleIsH1
            ? t.__('The page title is already the main heading (h1); use h2 here.', 'pressbase')
            : t.__('A page has one main heading (h1); this is another.', 'pressbase'),
          block: ref(block, path),
        });
      }
    }
    if (previous && level > previous + 1) {
      add({
        rule: 'heading_skipped',
        severity: 'error',
        message: format(
          t.__('This heading skips from h%1$s to h%2$s.', 'pressbase'),
          previous,
          level,
        ),
        block: ref(block, path),
        data: { from: previous, to: level },
      });
    }
    previous = level;
  });
  if (options.titleIsH1 === false && h1s === 0) {
    add({
      rule: 'heading_no_h1',
      severity: 'error',
      message: t.__('The page has no main heading (h1).', 'pressbase'),
      block: null,
    });
  }

  /* Images: alt text, unless marked decorative. */
  walk(blocks, (block, path) => {
    if (!block.blockName || BACKGROUND_IMAGE_BLOCKS.has(block.blockName)) return;
    const decorative = get(block.attrs, 'metadata', 'decorative') === true;
    for (const [tag] of block.innerHTML.matchAll(/<img\b[^>]*>/gi)) {
      const src = attribute(tag, 'src');
      if (!src) continue; // No image yet: a placeholder (below).
      if (decorative || /\brole\s*=\s*["']?(presentation|none)\b/i.test(tag)) continue;
      if (/\baria-hidden\s*=\s*["']?true\b/i.test(tag)) continue;
      if ((attribute(tag, 'alt') ?? '').trim()) continue;
      add({
        rule: 'image_alt',
        severity: 'error',
        message: t.__(
          'This image has no alternative text. Describe it, or mark it as decorative.',
          'pressbase',
        ),
        block: ref(block, path),
        data: { src },
      });
    }
  });

  /* Placeholders: text in [brackets], `#` links, images not chosen (the slots' rules). */
  if (enabled.has('placeholder')) {
    for (const found of findPlaceholders(extractSlots(blocks))) {
      const block = blockAt(blocks, found.slot.path);
      add({
        rule: 'placeholder',
        severity: 'warning',
        message:
          found.reason === 'image'
            ? t.__('Choose an image.', 'pressbase')
            : found.reason === 'link'
              ? t.__('This button doesn’t link anywhere yet.', 'pressbase')
              : t.__('Replace this placeholder with real content.', 'pressbase'),
        block: block ? ref(block, found.slot.path) : null,
        data: { reason: found.reason, slot: found.path, text: placeholderText(found.slot) },
      });
    }
  }

  /* Links: text that says where they go. */
  walk(blocks, (block, path) => {
    if (!block.blockName) return;
    for (const match of block.innerHTML.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const [, attributes = '', inner = ''] = match;
      const label = (attribute(`<a ${attributes}>`, 'aria-label') ?? '').trim();
      const imageAlt = [...inner.matchAll(/<img\b[^>]*>/gi)]
        .map(([tag]) => attribute(tag, 'alt') ?? '')
        .join(' ');
      const text = (label || `${richTextToPlain(inner)} ${imageAlt}`).replace(/\s+/g, ' ').trim();
      const normalised = text
        .toLowerCase()
        .replace(/[.…:!?»›→]+$/u, '')
        .trim();
      if (!text) {
        add({
          rule: 'link_text',
          severity: 'error',
          message: t.__(
            'This link has no text, so screen readers can’t say where it goes.',
            'pressbase',
          ),
          block: ref(block, path),
        });
      } else if (VAGUE_LINK_TEXT.has(normalised)) {
        add({
          rule: 'link_text',
          severity: 'warning',
          message: format(
            t.__(
              '“%s” doesn’t say where the link goes. Name the destination instead.',
              'pressbase',
            ),
            text,
          ),
          block: ref(block, path),
          data: { text },
        });
      }
    }
  });

  /* Raw colours: values outside the presets. */
  walk(blocks, (block, path) => {
    for (const [property, value] of rawColors(block.attrs)) {
      const preset = styles
        ? Object.entries(styles.palette).find(
            ([, color]) => color.toLowerCase() === value.toLowerCase(),
          )?.[0]
        : undefined;
      add({
        rule: 'color_raw',
        severity: 'warning',
        message: preset
          ? format(
              t.__(
                'This colour (%1$s) is the “%2$s” preset; use the preset so it follows the site’s styles.',
                'pressbase',
              ),
              value,
              preset,
            )
          : format(t.__('This colour (%s) isn’t one of the site’s colours.', 'pressbase'), value),
        block: ref(block, path),
        data: { property, value, ...(preset ? { preset } : {}) },
      });
    }
  });

  /* Contrast: each block's text on its background. */
  if (styles && enabled.has('contrast')) checkContrast(blocks, styles, add, t);

  return findings;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? '';
}

function blockAt(blocks: ParsedBlock[], path: number[]): ParsedBlock | undefined {
  let list = blocks;
  let block: ParsedBlock | undefined;
  for (const index of path) {
    block = list[index];
    if (!block) return undefined;
    list = block.innerBlocks;
  }
  return block;
}

/** Colour values in a block's attributes that aren't presets: [attribute path, value]. */
function rawColors(attrs: Record<string, unknown>): [string, string][] {
  const out: [string, string][] = [];
  const check = (property: string, value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const v = value.trim();
    if (KEYWORDS.has(v.toLowerCase()) || isPresetReference(v)) return;
    // A literal colour: hex, a colour function, or a named colour on its own.
    // Gradients and color-mix() built from presets, currentColor and
    // transparent follow the site's styles, so they're fine.
    const literal =
      /#[0-9a-f]{3,8}\b/i.test(v) ||
      /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i.test(v) ||
      /^[a-z]+$/i.test(v);
    if (literal) out.push([property, v]);
  };
  for (const key of [
    'customTextColor',
    'customBackgroundColor',
    'customOverlayColor',
    'customGradient',
  ]) {
    check(key, attrs[key]);
  }
  const style = attrs.style;
  for (const key of ['text', 'background', 'gradient'])
    check(`style.color.${key}`, get(style, 'color', key));
  check('style.border.color', get(style, 'border', 'color'));
  for (const side of ['top', 'right', 'bottom', 'left']) {
    check(`style.border.${side}.color`, get(style, 'border', side, 'color'));
  }
  const elements = get(style, 'elements');
  if (isObject(elements)) {
    for (const [element, node] of Object.entries(elements)) {
      for (const key of ['text', 'background', 'gradient']) {
        check(`style.elements.${element}.color.${key}`, get(node, 'color', key));
      }
    }
  }
  return out;
}

function isLarge(block: ParsedBlock): boolean {
  if (block.blockName === 'core/heading' && Number(block.attrs.level ?? 2) <= 3) return true;
  const size = block.attrs.fontSize;
  if (typeof size === 'string' && LARGE_FONT_SIZES.has(size)) return true;
  const custom = get(block.attrs, 'style', 'typography', 'fontSize');
  if (typeof custom === 'string') {
    const px = /^([\d.]+)px$/.exec(custom)?.[1];
    const rem = /^([\d.]+)r?em$/.exec(custom)?.[1];
    const value = px ? Number(px) : rem ? Number(rem) * 16 : 0;
    if (value >= 24) return true;
  }
  return false;
}

/** Blocks whose own text is drawn in the inherited colours. */
const TEXT_BLOCKS = new Set([
  'core/paragraph',
  'core/heading',
  'core/list-item',
  'core/quote',
  'core/pullquote',
  'core/verse',
  'core/preformatted',
  'core/details',
  'core/table',
  'core/site-title',
  'core/site-tagline',
]);

/**
 * Each text block's colours against the background it sits on, following
 * colours down the tree as CSS inherits them: preset classes, `style.color`,
 * section styles (`is-style-…`), the theme's link and button colours. A
 * failing pair is reported once, on the block that set it (where a person
 * would fix it), with the first text block it affects. Under a gradient,
 * an image or a partly transparent overlay the background is unknown and
 * nothing is checked.
 */
function checkContrast(
  blocks: ParsedBlock[],
  styles: PageStyles,
  add: (finding: PageFinding) => void,
  t: { __(text: string, domain: string): string },
) {
  const palette = styles.palette;
  const color = (value: unknown) => resolveColor(value, palette);
  const preset = (slug: unknown) => (typeof slug === 'string' ? palette[slug] : undefined);
  const reported = new Set<string>();

  const check = (
    source: BlockReference | null,
    block: ParsedBlock | null,
    path: number[],
    fg: string | undefined,
    bg: string | undefined,
    use: 'text' | 'large',
    kind: 'text' | 'link' | 'button',
  ) => {
    if (!fg || !bg) return;
    const ratio = contrastRatio(fg, bg);
    const min = CONTRAST_MINIMUMS.standard[use];
    const key = `${source?.path.join('.') ?? 'root'}|${kind}|${fg}|${bg}|${use}`;
    if (ratio >= min || reported.has(key)) return;
    reported.add(key);
    const message =
      kind === 'link'
        ? t.__(
            'Links don’t stand out enough from their background (%1$s:1, %2$s:1 is needed).',
            'pressbase',
          )
        : t.__(
            'Text doesn’t stand out enough from its background (%1$s:1, %2$s:1 is needed).',
            'pressbase',
          );
    add({
      rule: 'contrast',
      severity: 'error',
      message: format(message, ratio.toFixed(2), min),
      block: source ?? (block ? ref(block, path) : null),
      data: {
        kind,
        text: fg,
        background: bg,
        ratio: Number(ratio.toFixed(2)),
        min,
        ...(block && source ? { example: path } : {}),
      },
    });
  };

  interface Context {
    text?: string;
    /** Undefined: unknown (a gradient, an image), so nothing below is checked. */
    background?: string;
    link?: string;
    button?: ColorPair;
    /** The block that set these colours; null: the site's styles. */
    source: BlockReference | null;
  }

  const root: Context = {
    text: color(styles.text),
    background: color(styles.background) ?? '#ffffff',
    link: color(styles.link),
    button: styles.button,
    source: null,
  };
  check(null, null, [], root.text, root.background, 'text', 'text');
  check(null, null, [], root.link, root.background, 'text', 'link');

  const visit = (list: ParsedBlock[], path: number[], context: Context) => {
    list.forEach((block, index) => {
      const here = [...path, index];
      if (!block.blockName) return;
      const attrs = block.attrs;
      const variation = styleVariation(block);
      const varied = variation ? styles.variations?.[variation] : undefined;
      const ownText = preset(attrs.textColor) ?? color(get(attrs, 'style', 'color', 'text'));
      const gradient = Boolean(attrs.gradient || get(attrs, 'style', 'color', 'gradient'));
      const ownBackground =
        preset(attrs.backgroundColor) ?? color(get(attrs, 'style', 'color', 'background'));
      const large = isLarge(block) ? 'large' : 'text';
      const words = Boolean(plainText(block));

      if (block.blockName === 'core/button') {
        const outline = variation === 'outline';
        const fg =
          ownText ?? (outline ? context.text : (color(context.button?.text) ?? context.text));
        const bg = gradient
          ? undefined
          : (ownBackground ??
            (outline
              ? context.background
              : (color(context.button?.background) ?? context.background)));
        const sets = Boolean(ownText || ownBackground);
        if (words)
          check(sets ? ref(block, here) : context.source, block, here, fg, bg, large, 'button');
        return;
      }

      const next: Context = { ...context };
      if (varied) {
        if (varied.text) next.text = color(varied.text);
        if (varied.background) next.background = color(varied.background);
        if (varied.link) next.link = color(varied.link);
        if (varied.button) next.button = varied.button;
      }
      if (ownText) next.text = ownText;
      if (gradient) next.background = undefined;
      else if (ownBackground) next.background = ownBackground;
      if (block.blockName === 'core/cover') {
        // An image, or an overlay that's only partly opaque: unknown.
        const overlay = preset(attrs.overlayColor) ?? color(attrs.customOverlayColor);
        next.background =
          !attrs.url && overlay && Number(attrs.dimRatio ?? 50) === 100 ? overlay : undefined;
      }
      const ownLink = color(get(attrs, 'style', 'elements', 'link', 'color', 'text'));
      if (ownLink) next.link = ownLink;
      if (varied || ownText || ownBackground || gradient || ownLink) next.source = ref(block, here);

      if (words && TEXT_BLOCKS.has(block.blockName)) {
        check(next.source, block, here, next.text, next.background, large, 'text');
      }
      if (/<a\b/i.test(block.innerHTML)) {
        check(next.source, block, here, next.link ?? next.text, next.background, large, 'link');
      }
      visit(block.innerBlocks, here, next);
    });
  };
  visit(blocks, [], root);
}
