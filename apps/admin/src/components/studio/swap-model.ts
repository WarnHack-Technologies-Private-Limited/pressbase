/**
 * Swap layout (#45): which patterns a section can change to, and moving its
 * content into one of them with @pressbase/slots. Pure functions over block
 * markup, tested in swap-model.test.ts. See
 * docs/architecture/studio.md#swap-layout and docs/architecture/patterns.md#swap-layout.
 *
 *   const found = sectionLayouts(markup, sections);       // { current, layouts, index }
 *   const next = found.layouts[(found.index + 1) % found.layouts.length];
 *   const { markup: swapped, unused } = swapLayout(sectionSlots(markup, found.current), next);
 */
import { type ParsedBlock, parseBlocks, serializeBlocks } from '@pressbase/blocks';
import {
  extractSlots,
  fillSlots,
  placeholderFor,
  plainToRichText,
  richTextToPlain,
  type Slot,
  type SlotDeclarations,
  type SlotValue,
  type SlotValues,
  transferSlots,
  type UnusedValue,
} from '@pressbase/slots';

/** The pattern fields Swap layout reads (a `Section` from sections-model.ts has them). */
export interface LayoutPattern {
  name: string;
  title: string;
  content: string;
  /** The section's own category ("banner" for heroes). */
  category: string;
  categories: string[];
  /** Declared slots, as `/wp/v2/block-patterns/patterns` serves them. */
  slots?: SlotDeclarations;
}

export interface SectionLayouts<P extends LayoutPattern = LayoutPattern> {
  /** The pattern the section was made from. */
  current: P;
  /** The patterns of its category it can change to, the current one included, in library order. */
  layouts: P[];
  /** Where the current one is in `layouts`. */
  index: number;
}

/** The blocks of some markup, without the whitespace between them. */
function rootsOf(markup: string): ParsedBlock[] {
  return parseBlocks(markup).filter((block) => block.blockName !== null);
}

const parsed = new Map<string, ParsedBlock[]>();
/** A pattern's blocks, parsed once per content (patterns don't change while Studio is open). */
function patternBlocks(pattern: Pick<LayoutPattern, 'content'>): ParsedBlock[] {
  let blocks = parsed.get(pattern.content);
  if (!blocks) {
    blocks = rootsOf(pattern.content);
    parsed.set(pattern.content, blocks);
  }
  return blocks;
}

/**
 * A block's shape: its name (and a heading's level) and its inner blocks'
 * shapes, with runs of alike inner blocks counted once. A hero with three
 * buttons and the same hero with two have the same shape; text and other
 * attributes don't count.
 */
export function shapeOf(block: Pick<ParsedBlock, 'blockName' | 'innerBlocks' | 'attrs'>): string {
  const inner: string[] = [];
  for (const child of block.innerBlocks) {
    if (child.blockName === null) continue;
    const shape = shapeOf(child);
    if (inner[inner.length - 1] !== shape) inner.push(shape);
  }
  // core/heading's level defaults to 2 (block.json).
  const name =
    block.blockName === 'core/heading'
      ? `${block.blockName}${String(block.attrs?.level ?? 2)}`
      : String(block.blockName);
  return inner.length ? `${name}(${inner.join(',')})` : name;
}

/** Only patterns of one block can take a section's place (as WordPress's "Change design"). */
export function isSingleBlock(pattern: Pick<LayoutPattern, 'content'>): boolean {
  return patternBlocks(pattern).length === 1;
}

const patternNameOf = (block: ParsedBlock | undefined): string => {
  const name = (block?.attrs.metadata as { patternName?: unknown } | undefined)?.patternName;
  return typeof name === 'string' ? name : '';
};

/**
 * The pattern a section came from, and the others of its category. A
 * section added from Studio names its pattern (`metadata.patternName`, as
 * WordPress's inserter does); any other section is matched by its shape.
 * Null when no single-block pattern matches, or the markup isn't one block.
 */
export function sectionLayouts<P extends LayoutPattern>(
  markup: string,
  patterns: readonly P[],
): SectionLayouts<P> | null {
  const roots = rootsOf(markup);
  const root = roots[0];
  if (!root || roots.length !== 1) return null;
  const named = patternNameOf(root);
  const candidates = patterns.filter(isSingleBlock);
  let current = named ? candidates.find((p) => p.name === named) : undefined;
  if (!current) {
    const shape = shapeOf(root);
    current = candidates.find((p) => shapeOf(patternBlocks(p)[0] as ParsedBlock) === shape);
  }
  if (!current) return null;
  const category = current.category;
  const layouts = candidates.filter((p) => p === current || p.categories.includes(category));
  return { current, layouts, index: layouts.indexOf(current) };
}

/** Without the section's own name (it isn't content), so the pattern's slot IDs apply. */
function withoutRootName(blocks: ParsedBlock[]): ParsedBlock[] {
  return blocks.map((block, index) => {
    const metadata = block.attrs.metadata as Record<string, unknown> | undefined;
    if (index > 0 || !metadata || !('name' in metadata)) return block;
    const { name: _name, ...rest } = metadata;
    return { ...block, attrs: { ...block.attrs, metadata: rest } };
  });
}

/** A section's content as the slots of the pattern it came from. */
export function sectionSlots(markup: string, pattern: Pick<LayoutPattern, 'slots'>): Slot[] {
  return extractSlots(withoutRootName(rootsOf(markup)), { declarations: pattern.slots });
}

const rootName = (blocks: ParsedBlock[]): string => {
  const name = (blocks[0]?.attrs.metadata as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : '';
};

/** The section's name in Layers (`metadata.name`), if it has one. */
export function sectionName(markup: string): string {
  return rootName(rootsOf(markup));
}

/**
 * The name the person gave the section, to keep through a swap: not one
 * that came with its pattern (its title, as WordPress's inserter names a
 * section, or the pattern's own block name).
 */
export function personalName(
  markup: string,
  pattern: Pick<LayoutPattern, 'title' | 'content'>,
): string {
  const name = sectionName(markup);
  return name && name !== pattern.title && name !== rootName(patternBlocks(pattern)) ? name : '';
}

export interface SwappedLayout {
  /** The new section's markup, naming its pattern. */
  markup: string;
  /** Content the new layout has no place for (a fourth card in a three-card layout). */
  unused: UnusedValue[];
}

/** Makes a placeholder's text for a slot ("[Add a short label]"), in the person's language. */
export type PlaceholderText = (slot: Slot) => string;

function placeholderValue(slot: Slot, placeholder: PlaceholderText): SlotValue | undefined {
  if (slot.kind === 'heading' || slot.kind === 'text') return plainToRichText(placeholder(slot));
  if (slot.kind === 'button') return { text: plainToRichText(placeholder(slot)), url: '#' };
  // Images keep the pattern's picture; groups are filled item by item.
  return undefined;
}

/**
 * Honest content (plan, Principle 7): text slots the section had nothing
 * for get a placeholder (`[Add a short label]`) instead of keeping the
 * pattern's sample text, which describes some other business. A group the
 * section had nothing for keeps its fewest items, as placeholders. Images
 * keep the pattern's picture.
 */
export function withPlaceholders(
  slots: Slot[],
  values: SlotValues,
  placeholder: PlaceholderText = placeholderFor,
): SlotValues {
  const out: SlotValues = { ...values };
  for (const slot of slots) {
    const value = values[slot.id];
    if (slot.kind !== 'group') {
      if (value === undefined) {
        const filled = placeholderValue(slot, placeholder);
        if (filled !== undefined) out[slot.id] = filled;
      }
      continue;
    }
    const template = (index: number) => slot.items[Math.min(index, slot.items.length - 1)] ?? [];
    if (Array.isArray(value)) {
      if (!slot.flat) {
        out[slot.id] = value.map((item, index) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? withPlaceholders(template(index), item as SlotValues, placeholder)
            : item,
        );
      }
      continue;
    }
    const items: SlotValue[] = [];
    for (let index = 0; index < Math.max(1, slot.minItems); index++) {
      const children = template(index);
      const only = children[0];
      if (slot.flat && only) {
        const filled = placeholderValue(only, placeholder);
        if (filled === undefined) break;
        items.push(filled);
      } else items.push(withPlaceholders(children, {}, placeholder));
    }
    if (items.length) out[slot.id] = items;
  }
  return out;
}

/**
 * The pattern `to`, holding the content in `from` (the section's slots):
 * the same text, links and images where the layout has room, and a
 * placeholder where the section had nothing to give (withPlaceholders()).
 * `name` keeps the name the person gave the section in Layers.
 */
export function swapLayout(
  from: Slot[],
  to: LayoutPattern,
  {
    name = '',
    placeholder = placeholderFor,
  }: { name?: string; placeholder?: PlaceholderText } = {},
): SwappedLayout {
  const blocks = patternBlocks(to);
  const declarations = to.slots;
  const target = extractSlots(blocks, { declarations });
  const { values, unused } = transferSlots(from, target);
  const filled = fillSlots(blocks, withPlaceholders(target, values, placeholder), { declarations });
  const root = filled[0];
  if (root) {
    const metadata = { ...(root.attrs.metadata as Record<string, unknown> | undefined) };
    metadata.patternName = to.name;
    if (name) metadata.name = name;
    root.attrs = { ...root.attrs, metadata };
  }
  return { markup: serializeBlocks(filled), unused };
}

/** What a piece of content that didn't fit says, in plain text, for the person. */
export function unusedText(value: UnusedValue): string {
  const { slot } = value;
  const v = value.value as unknown;
  if (slot.kind === 'image') {
    const image = v as { alt?: string; url?: string };
    return image.alt?.trim() || image.url || '';
  }
  if (slot.kind === 'button') return richTextToPlain((v as { text?: string }).text ?? '').trim();
  return typeof v === 'string' ? richTextToPlain(v).trim() : '';
}

/**
 * What Studio remembers about a section it swapped: the content it had
 * before the first swap, and the markup the last swap produced. While the
 * section still holds exactly that markup, the next swap starts from the
 * original content again, so swapping to a smaller layout and back loses
 * nothing. `kept` is what the current layout leaves out.
 */
export interface SwapMemory {
  origin: Slot[];
  produced: string;
  kept: UnusedValue[];
}

/**
 * Where the next swap takes its content from: the remembered original
 * (the section is as the last swap left it), or the section as it is now.
 * After an edit, what the earlier layout left out can't be placed again,
 * so it stays listed (`carried`) rather than vanishing.
 */
export function swapSource(
  memory: SwapMemory | undefined,
  markup: string,
  current: Pick<LayoutPattern, 'slots'>,
): { from: Slot[]; carried: UnusedValue[] } {
  if (memory && memory.produced === markup) return { from: memory.origin, carried: [] };
  return { from: sectionSlots(markup, current), carried: memory?.kept ?? [] };
}
