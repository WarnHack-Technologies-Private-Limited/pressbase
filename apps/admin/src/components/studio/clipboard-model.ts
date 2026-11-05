/**
 * The canvas's right-click menu (#36): what Paste style copies between
 * blocks, and where Paste puts blocks. Pure functions, tested in
 * clipboard-model.test.ts. See docs/architecture/studio.md#the-right-click-menu.
 *
 * Paste style is WordPress's (`usePasteStyles()` in
 * @wordpress/block-editor's use-paste-styles): the attributes the block
 * supports add (`STYLE_ATTRIBUTES`) are copied when both blocks support
 * them, an attribute the source doesn't have is cleared on the target, and
 * inner blocks take the styles of the source's inner blocks at the same
 * place. Studio is stricter in three ways, so pasting never leaves a block
 * with styles it can't show or edit:
 *
 * - `style` keeps only the parts the target supports (no typography on an
 *   image, no padding on a block without padding), per device too
 *   (`style["@tablet"]`, `style["@mobile"]`);
 * - `align` is copied only when the target offers that alignment;
 * - `layout` only between blocks of the same type (a row stays a row).
 */

/** A block's `supports`, as its block type declares them (block.json). */
export type Supports = Record<string, unknown> | undefined;

export interface StyleBlock {
  name: string;
  attributes: Record<string, unknown>;
  innerBlocks?: readonly StyleBlock[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** getBlockSupport(): a support by its path ("typography.fontSize"), or the default. */
export function support(supports: Supports, path: string, fallback?: unknown): unknown {
  let node: unknown = supports;
  for (const key of path.split('.')) {
    if (!isObject(node)) return fallback;
    node = node[key];
  }
  return node ?? fallback;
}

/** hasBlockSupport() */
const has = (supports: Supports, path: string, fallback = false) =>
  Boolean(support(supports, path, fallback));

/* The checks in @wordpress/block-editor's hooks/supports.ts, on a supports object. */

function hasBorder(supports: Supports, feature: 'any' | 'color' = 'any'): boolean {
  const border = support(supports, '__experimentalBorder');
  if (border === true) return true;
  if (!isObject(border)) return false;
  if (feature === 'any')
    return Boolean(border.color || border.radius || border.width || border.style);
  return Boolean(border[feature]);
}

function hasColor(supports: Supports): boolean {
  const color = support(supports, 'color');
  if (!color) return false;
  if (!isObject(color)) return true;
  return (
    color.link === true ||
    color.gradient === true ||
    color.background !== false ||
    color.text !== false
  );
}

const colorPart = (supports: Supports, part: 'background' | 'text') => {
  const color = support(supports, 'color');
  if (!color) return false;
  return !isObject(color) || color[part] !== false;
};

const hasGradient = (supports: Supports) => {
  const color = support(supports, 'color');
  return isObject(color) && Boolean(color.gradients);
};

const TYPOGRAPHY: Record<string, string> = {
  fontSize: 'typography.fontSize',
  lineHeight: 'typography.lineHeight',
  fontFamily: 'typography.__experimentalFontFamily',
  fontStyle: 'typography.__experimentalFontStyle',
  fontWeight: 'typography.__experimentalFontWeight',
  textAlign: 'typography.textAlign',
  textColumns: 'typography.textColumns',
  textDecoration: 'typography.__experimentalTextDecoration',
  textTransform: 'typography.__experimentalTextTransform',
  writingMode: 'typography.__experimentalWritingMode',
  letterSpacing: 'typography.__experimentalLetterSpacing',
};

const hasTypography = (supports: Supports) =>
  Object.values(TYPOGRAPHY).some((path) => has(supports, path));

/** hasStyleSupport(): the block has a `style` attribute to take. */
const hasStyle = (supports: Supports) =>
  has(supports, 'shadow') ||
  hasTypography(supports) ||
  has(supports, '__experimentalBorder') ||
  has(supports, 'color') ||
  has(supports, 'spacing');

/** The alignments a block offers (`supports.align`: true is every one). */
function alignments(supports: Supports): readonly string[] {
  const align = support(supports, 'align');
  if (align === true) return ['left', 'center', 'right', 'wide', 'full'];
  return Array.isArray(align) ? align.map(String) : [];
}

/**
 * The parts of a `style` value the target supports. Unknown parts
 * (a plugin's) are kept, as WordPress keeps the whole style.
 */
export function supportedStyle(
  style: unknown,
  supports: Supports,
): Record<string, unknown> | undefined {
  if (!isObject(style)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style)) {
    let kept: unknown = value;
    switch (key) {
      case '@tablet':
      case '@mobile':
        kept = supportedStyle(value, supports);
        break;
      case 'color':
      case 'elements':
        if (!hasColor(supports)) kept = undefined;
        break;
      case 'typography':
        kept = isObject(value)
          ? pick(value, (part) => (TYPOGRAPHY[part] ? has(supports, TYPOGRAPHY[part]) : false))
          : undefined;
        break;
      case 'spacing':
        kept = isObject(value)
          ? pick(value, (part) =>
              ['padding', 'margin', 'blockGap'].includes(part)
                ? has(supports, `spacing.${part}`)
                : false,
            )
          : undefined;
        break;
      case 'border':
        if (!hasBorder(supports)) kept = undefined;
        break;
      case 'shadow':
      case 'dimensions':
      case 'background':
      case 'position':
        if (!has(supports, key)) kept = undefined;
        break;
      case 'layout':
        // A child's size in a row (`flexSize`, `columnSpan`): it belongs to where the block sits.
        kept = undefined;
        break;
      default:
        break;
    }
    if (kept !== undefined && !(isObject(kept) && Object.keys(kept).length === 0)) out[key] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}

function pick(source: Record<string, unknown>, keep: (key: string) => boolean) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) if (keep(key)) out[key] = value;
  return Object.keys(out).length ? out : undefined;
}

/** STYLE_ATTRIBUTES in use-paste-styles: each style attribute, and whether a block supports it. */
const STYLE_ATTRIBUTES: Record<string, (supports: Supports) => boolean> = {
  align: (s) => has(s, 'align'),
  borderColor: (s) => hasBorder(s, 'color'),
  backgroundColor: (s) => colorPart(s, 'background'),
  textAlign: (s) => has(s, 'typography.textAlign'),
  textColor: (s) => colorPart(s, 'text'),
  gradient: hasGradient,
  className: (s) => has(s, 'customClassName', true),
  fontFamily: (s) => has(s, 'typography.__experimentalFontFamily'),
  fontSize: (s) => has(s, 'typography.fontSize'),
  layout: (s) => has(s, 'layout'),
  style: hasStyle,
};

/** The attribute names Paste style can copy, in WordPress's order. */
export const PASTE_STYLE_ATTRIBUTES = Object.keys(STYLE_ATTRIBUTES);

/**
 * The attributes Paste style sets on `target` from `source` (WordPress's
 * getStyleAttributes(), made stricter: see the top of this file). An
 * attribute both support but the source lacks is set to undefined, so the
 * target loses its own: the result looks like the source.
 */
export function styleAttributes(
  source: StyleBlock,
  target: StyleBlock,
  supportsOf: (name: string) => Supports,
): Record<string, unknown> {
  const from = supportsOf(source.name);
  const to = supportsOf(target.name);
  const out: Record<string, unknown> = {};
  for (const [attribute, supported] of Object.entries(STYLE_ATTRIBUTES)) {
    if (!supported(from) || !supported(to)) continue;
    const value = source.attributes[attribute];
    if (attribute === 'layout' && source.name !== target.name) continue;
    if (attribute === 'align' && value !== undefined && !alignments(to).includes(String(value))) {
      continue;
    }
    out[attribute] = attribute === 'style' ? supportedStyle(value, to) : value;
  }
  return out;
}

/**
 * Paste style for a set of targets (WordPress's
 * recursivelyUpdateBlockAttributes()): one copied block styles every
 * target; several are matched one to one. Inner blocks take the styles of
 * the source's inner blocks at the same place. Returns the attributes per
 * client ID, for one `updateBlockAttributes(ids, attributes, { uniqueByBlock: true })`
 * (one undo step). Targets whose style wouldn't change are left out.
 */
export function pasteStyles(
  copied: readonly StyleBlock[],
  targets: readonly (StyleBlock & { clientId: string })[],
  supportsOf: (name: string) => Supports,
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const first = copied[0];
  if (!first) return out;
  const sources = copied.length === 1 ? targets.map(() => first) : copied;
  const walk = (
    into: readonly (StyleBlock & { clientId?: string })[],
    from: readonly StyleBlock[],
  ) => {
    for (let i = 0; i < Math.min(into.length, from.length); i++) {
      const target = into[i] as StyleBlock & { clientId?: string };
      const source = from[i] as StyleBlock;
      const attributes = styleAttributes(source, target, supportsOf);
      const changed = Object.entries(attributes).some(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(target.attributes[key]),
      );
      if (target.clientId && changed) out.set(target.clientId, attributes);
      walk(target.innerBlocks ?? [], source.innerBlocks ?? []);
    }
  };
  walk(targets, sources);
  return out;
}

/* ------------------------------------------------------------- Paste */

/** Where pasted blocks go: after `after` (a client ID) in `root`, at `index`. */
export interface PastePlace {
  root: string;
  index: number;
}

/**
 * Where Paste puts the copied blocks, for the block the menu was opened on:
 * just after it, in its parent, when the parent takes every copied block;
 * otherwise after its parent, and so on up to the page's content. A copied
 * section (a top-level block of a page) goes after the target's section,
 * so it's never nested inside another section. Null when nowhere takes them.
 *
 * `chain` is the target and its parents, outermost first (from the
 * template's root). `canInsert(name, root)` is the block editor's
 * canInsertBlockType(), so locking, allowed blocks and editing modes count.
 */
export function pastePlace(
  chain: readonly string[],
  names: readonly string[],
  options: {
    /** The page's content block (core/post-content), whose children are sections. */
    contentRoot: string | null;
    /** The copied blocks were a section of a page. */
    section: boolean;
    indexOf: (clientId: string, root: string) => number;
    canInsert: (name: string, root: string) => boolean;
  },
): PastePlace | null {
  const { contentRoot } = options;
  let level = chain.length - 1;
  if (options.section && contentRoot) {
    const at = chain.indexOf(contentRoot);
    // The target's section (the target itself when it's a section).
    if (at >= 0 && at < chain.length - 1) level = at + 1;
  }
  for (; level >= 1; level--) {
    const clientId = chain[level] as string;
    const root = chain[level - 1] as string;
    if (names.every((name) => options.canInsert(name, root))) {
      return { root, index: options.indexOf(clientId, root) + 1 };
    }
    // Pasting never climbs out of the page's content into the template.
    if (root === contentRoot) break;
  }
  return null;
}

/** Whether text holds serialized blocks (block comments), not just words. */
export function looksLikeBlocks(text: string): boolean {
  return /<!--\s+wp:[a-z]/.test(text);
}
