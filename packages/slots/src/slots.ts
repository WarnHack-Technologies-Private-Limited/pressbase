import type { ParsedBlock } from '@pressbase/blocks';
import { analyse, analyseGroupItems, type GroupNode, type Node, toSlot } from './analyse';
import type { FillOptions, Slot, SlotOptions, SlotValue, SlotValues } from './types';

/**
 * extractSlots(blocks): a pattern's editable content as typed, ordered slots.
 *
 *   const slots = extractSlots(parseBlocks(pattern.content), { declarations: pattern.slots });
 *   // [{ id: 'eyebrow', kind: 'text', … }, { id: 'title', kind: 'heading', level: 1, … },
 *   //  { id: 'actions', kind: 'group', flat: true, items: [[{ kind: 'button', … }], …] }]
 */
export function extractSlots(blocks: ParsedBlock[], options: SlotOptions = {}): Slot[] {
  return analyse(blocks, options.declarations).map(toSlot);
}

/** The values the slots hold now, in the shape fillSlots() takes. */
export function slotValues(slots: Slot[]): SlotValues {
  const values: SlotValues = {};
  for (const slot of slots) values[slot.id] = slotValue(slot);
  return values;
}

function slotValue(slot: Slot): SlotValue {
  if (slot.kind === 'group') {
    return slot.items.map((item) => (slot.flat && item[0] ? slotValue(item[0]) : slotValues(item)));
  }
  if (slot.kind === 'button' || slot.kind === 'image') return { ...slot.value };
  return slot.value;
}

/**
 * fillSlots(blocks, values): the pattern with its slots set to `values`.
 * The input isn't changed. Every attribute, class and preset style stays as
 * the pattern had it; only the text, links and images move. Slots without a
 * value keep the pattern's content.
 *
 * Repeated groups take as many items as the value has, within the group's
 * minItems–maxItems: missing items drop the group's last item, extra ones
 * duplicate it. Values past maxItems are ignored; transferSlots() reports
 * them.
 */
export function fillSlots(
  blocks: ParsedBlock[],
  values: SlotValues,
  options: FillOptions = {},
): ParsedBlock[] {
  const copy = blocks.map(cloneBlock);
  const declarations = options.declarations ?? {};
  const nodes = analyse(copy, declarations);
  fillNodes(nodes, values, options.format ?? 'html', declarations, '');
  return copy;
}

function fillNodes(
  nodes: Node[],
  values: SlotValues,
  format: 'html' | 'text',
  declarations: NonNullable<FillOptions['declarations']>,
  prefix: string,
): void {
  for (const node of nodes) {
    if (!Object.hasOwn(values, node.id)) continue;
    const value = values[node.id];
    if (value === undefined || value === null) continue;
    if (node.type === 'leaf') {
      node.leaf.write(node.block, value, format);
      continue;
    }
    if (!Array.isArray(value)) continue;
    const slot = toSlot(node) as Extract<Slot, { kind: 'group' }>;
    const target = Math.min(Math.max(value.length, slot.minItems), slot.maxItems);
    const before = node.count;
    resize(node, target);
    // A later run in the same container moves with this one.
    for (const other of nodes) {
      if (other !== node && other.type === 'group' && other.parent === node.parent) {
        if (other.start > node.start) other.start += node.count - before;
      }
    }
    const key = prefix + node.id;
    node.items = analyseGroupItems(node, declarations, key);
    node.items.forEach((item, index) => {
      const itemValue = value[index];
      if (itemValue === undefined) return;
      if (slot.flat && item.length === 1) {
        fillNodes(item, { [(item[0] as Node).id]: itemValue }, format, declarations, `${key}.`);
      } else if (itemValue && typeof itemValue === 'object' && !Array.isArray(itemValue)) {
        fillNodes(item, itemValue as SlotValues, format, declarations, `${key}.`);
      }
    });
  }
}

/* --------------------------------------------------------- growing groups */

/** A deep copy of a parsed block (attributes are JSON). Works in Node.js and browsers alike. */
function cloneBlock(block: ParsedBlock): ParsedBlock {
  return {
    blockName: block.blockName,
    attrs: JSON.parse(JSON.stringify(block.attrs)),
    innerBlocks: block.innerBlocks.map(cloneBlock),
    innerHTML: block.innerHTML,
    innerContent: [...block.innerContent],
  };
}

const isWhitespace = (chunk: unknown): chunk is string =>
  typeof chunk === 'string' && chunk.trim() === '';

/** Position in innerContent of the n-th inner block. */
function slotOf(block: ParsedBlock, n: number): number {
  let seen = -1;
  for (let i = 0; i < block.innerContent.length; i++) {
    if (block.innerContent[i] === null && ++seen === n) return i;
  }
  return -1;
}

function syncInnerHTML(block: ParsedBlock): void {
  block.innerHTML = block.innerContent.filter((c): c is string => typeof c === 'string').join('');
}

function removeInner(block: ParsedBlock, n: number): void {
  const at = slotOf(block, n);
  if (at === -1) return;
  const content = block.innerContent;
  // Take the whitespace that separated this block from the previous one with it.
  if (isWhitespace(content[at - 1]) && content[at - 2] === null) {
    content.splice(at - 1, 2);
  } else if (isWhitespace(content[at + 1]) && content[at + 2] === null) {
    content.splice(at, 2);
  } else {
    content.splice(at, 1);
  }
  block.innerBlocks.splice(n, 1);
  syncInnerHTML(block);
}

function insertAfter(block: ParsedBlock, n: number, inner: ParsedBlock): void {
  const at = slotOf(block, n);
  if (at === -1) return;
  const content = block.innerContent;
  const before = content[at - 1];
  // The same separator as between the previous two items, or the indentation before this one.
  const separator =
    isWhitespace(before) && content[at - 2] === null
      ? before
      : typeof before === 'string'
        ? (/\s*$/.exec(before)?.[0] ?? '')
        : '';
  content.splice(at + 1, 0, ...(separator ? [separator, null] : [null]));
  block.innerBlocks.splice(n + 1, 0, inner);
  syncInnerHTML(block);
}

function resize(group: GroupNode, target: number): void {
  const { parent, start } = group;
  while (group.count > target) {
    removeInner(parent, start + group.count - 1);
    group.count--;
  }
  while (group.count < target) {
    const last = parent.innerBlocks[start + group.count - 1] as ParsedBlock;
    insertAfter(parent, start + group.count - 1, cloneBlock(last));
    group.count++;
  }
}
