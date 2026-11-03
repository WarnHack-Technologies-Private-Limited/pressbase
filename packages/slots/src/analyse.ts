import type { ParsedBlock } from '@pressbase/blocks';
import { richTextToPlain } from './html';
import { type Leaf, leavesOf, OPAQUE_BLOCKS } from './leaves';
import type { Slot, SlotDeclaration, SlotDeclarations } from './types';

/**
 * The walk behind extractSlots() and fillSlots(): finds a pattern's slots
 * and keeps a reference to the block each one lives in, so filling can
 * write in place.
 */

export interface LeafNode {
  type: 'leaf';
  leaf: Leaf;
  block: ParsedBlock;
  path: number[];
  role: string;
  id: string;
  name?: string;
  declaration?: SlotDeclaration;
}

export interface GroupNode {
  type: 'group';
  /** The block whose inner blocks repeat. */
  parent: ParsedBlock;
  path: number[];
  /** The run of repeated inner blocks: parent.innerBlocks[start … start + count). */
  start: number;
  count: number;
  items: Node[][];
  role: string;
  id: string;
  name?: string;
  /** Lists, buttons and galleries are groups even with one item. */
  collection: boolean;
  declaration?: SlotDeclaration;
}

export type Node = LeafNode | GroupNode;

/** Containers whose inner blocks always form one repeated group. */
const COLLECTIONS: Record<string, string> = {
  'core/list': 'list',
  'core/buttons': 'actions',
  'core/gallery': 'gallery',
};

/** Blocks that are slots on their own; siblings of these are separate slots, never a group. */
const SINGLE_SLOT_BLOCKS = new Set(['core/paragraph', 'core/heading', 'core/pullquote']);

/**
 * A block's structure, ignoring attributes and repetition counts inside
 * lists, buttons and galleries: two cards are alike when their signatures
 * are equal. (Not cached: fillSlots() changes the tree as it goes.)
 */
export function signature(block: ParsedBlock): string {
  const name = block.blockName ?? '#html';
  let inner = '';
  if (block.innerBlocks.length > 0) {
    const kids = block.innerBlocks.map(signature);
    const collapsed: string[] = [];
    const always = block.blockName !== null && block.blockName in COLLECTIONS;
    for (const kid of kids) {
      const last = collapsed[collapsed.length - 1];
      if (last === `${kid}*` || (last === kid && !always)) collapsed[collapsed.length - 1] = `${kid}*`;
      else collapsed.push(always ? `${kid}*` : kid);
    }
    inner = `(${collapsed.join(',')})`;
  }
  return name + inner;
}

function holdsSlots(block: ParsedBlock): boolean {
  if (block.blockName === null || OPAQUE_BLOCKS.has(block.blockName)) return false;
  const leaves = leavesOf(block);
  if (leaves.before.length || leaves.after.length) return true;
  return block.innerBlocks.some(holdsSlots);
}

function blockName(block: ParsedBlock): string | undefined {
  const metadata = block.attrs.metadata as { name?: unknown } | undefined;
  return typeof metadata?.name === 'string' && metadata.name.trim() ? metadata.name.trim() : undefined;
}

export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'slot'
  );
}

/** Finds runs of alike siblings: [start, count] pairs. */
function runsOf(block: ParsedBlock, groups: ReadonlySet<string>): [number, number][] {
  const kids = block.innerBlocks;
  if (block.blockName && block.blockName in COLLECTIONS) {
    return kids.length > 0 && kids.some(holdsSlots) ? [[0, kids.length]] : [];
  }
  // Containers that hold only alike items stay a group when one item is left:
  // columns, grids, and containers declared as groups (minItems or maxItems).
  const name = blockName(block);
  const layout = (block.attrs.layout as { type?: unknown } | undefined)?.type;
  if (
    kids.length > 0 &&
    (block.blockName === 'core/columns' || layout === 'grid' || (name && groups.has(slugify(name)))) &&
    kids.every((kid) => kid.blockName && !SINGLE_SLOT_BLOCKS.has(kid.blockName) && holdsSlots(kid)) &&
    kids.every((kid) => signature(kid) === signature(kids[0] as ParsedBlock))
  ) {
    return [[0, kids.length]];
  }
  const runs: [number, number][] = [];
  let i = 0;
  while (i < kids.length) {
    const kid = kids[i] as ParsedBlock;
    let j = i + 1;
    if (kid.blockName && !SINGLE_SLOT_BLOCKS.has(kid.blockName) && holdsSlots(kid)) {
      const sig = signature(kid);
      while (j < kids.length && signature(kids[j] as ParsedBlock) === sig) j++;
    }
    if (j - i >= 2) runs.push([i, j - i]);
    i = j;
  }
  return runs;
}

function walkBlock(block: ParsedBlock, path: number[], out: Node[], groups: ReadonlySet<string>): void {
  if (block.blockName === null || OPAQUE_BLOCKS.has(block.blockName)) return;
  const leaves = leavesOf(block);
  const name = blockName(block);
  const single = leaves.before.length + leaves.after.length === 1;
  const leafNode = (leaf: Leaf): LeafNode => ({
    type: 'leaf',
    leaf,
    block,
    path,
    role: leaf.role,
    id: '',
    ...(single && name ? { name } : {}),
  });
  for (const leaf of leaves.before) out.push(leafNode(leaf));
  walkChildren(block, path, out, groups);
  for (const leaf of leaves.after) out.push(leafNode(leaf));
}

function walkChildren(block: ParsedBlock, path: number[], out: Node[], groups: ReadonlySet<string>): void {
  const runs = runsOf(block, groups);
  const kids = block.innerBlocks;
  let r = 0;
  for (let i = 0; i < kids.length; i++) {
    const run = runs[r];
    if (run && run[0] === i) {
      const [start, count] = run;
      const collection = !!block.blockName && block.blockName in COLLECTIONS;
      const items: Node[][] = [];
      for (let k = start; k < start + count; k++) {
        items.push(analyseItem(kids[k] as ParsedBlock, [...path, k], groups));
      }
      const name = start === 0 && count === kids.length ? blockName(block) : undefined;
      out.push({
        type: 'group',
        parent: block,
        path,
        start,
        count,
        items,
        role: COLLECTIONS[block.blockName ?? ''] ?? 'items',
        id: '',
        collection,
        ...(name ? { name } : {}),
      });
      i = start + count - 1;
      r++;
      continue;
    }
    walkBlock(kids[i] as ParsedBlock, [...path, i], out, groups);
  }
}

function analyseItem(item: ParsedBlock, path: number[], groups: ReadonlySet<string>): Node[] {
  const nodes: Node[] = [];
  walkBlock(item, path, nodes, groups);
  return finishScope(nodes);
}

/**
 * Roles that depend on neighbours, then IDs: the first heading of a scope is
 * its title and paragraphs before it are eyebrows.
 */
function finishScope(nodes: Node[]): Node[] {
  const titleIndex = nodes.findIndex((n) => n.type === 'leaf' && n.leaf.kind === 'heading');
  nodes.forEach((node, index) => {
    if (node.type !== 'leaf') return;
    if (index === titleIndex) node.role = 'title';
    else if (index < titleIndex && node.role === 'body') node.role = 'eyebrow';
  });
  const taken = new Map<string, number>();
  for (const node of nodes) {
    const base = node.name ? slugify(node.name) : node.role;
    const seen = taken.get(base) ?? 0;
    taken.set(base, seen + 1);
    node.id = seen === 0 ? base : `${base}-${seen + 1}`;
  }
  return nodes;
}

/** Applies declarations (keys `id` or `group.child`) and drops ignored slots. */
function declare(nodes: Node[], declarations: SlotDeclarations, prefix: string): Node[] {
  const kept: Node[] = [];
  for (const node of nodes) {
    const key = prefix + node.id;
    const declaration = declarations[key];
    if (declaration?.ignore) continue;
    if (declaration) {
      node.declaration = declaration;
      if (declaration.role) node.role = declaration.role;
    }
    if (node.type === 'group') {
      node.items = node.items.map((item) => declare(item, declarations, `${key}.`));
    }
    kept.push(node);
  }
  return kept;
}

/** Slot IDs declared as groups (with minItems or maxItems): the last segment of each key. */
function declaredGroups(declarations: SlotDeclarations): Set<string> {
  const ids = new Set<string>();
  for (const [key, d] of Object.entries(declarations)) {
    if (d.minItems !== undefined || d.maxItems !== undefined) ids.add(key.split('.').pop() as string);
  }
  return ids;
}

export function analyse(blocks: ParsedBlock[], declarations: SlotDeclarations = {}): Node[] {
  const nodes: Node[] = [];
  const groups = declaredGroups(declarations);
  blocks.forEach((block, index) => {
    walkBlock(block, [index], nodes, groups);
  });
  return declare(finishScope(nodes), declarations, '');
}

/** Re-analyses one group after its items changed (fillSlots grows and shrinks groups). */
export function analyseGroupItems(
  group: GroupNode,
  declarations: SlotDeclarations,
  key: string,
): Node[][] {
  const items: Node[][] = [];
  const groups = declaredGroups(declarations);
  for (let k = group.start; k < group.start + group.count; k++) {
    const item = analyseItem(group.parent.innerBlocks[k] as ParsedBlock, [...group.path, k], groups);
    items.push(declare(item, declarations, `${key}.`));
  }
  return items;
}

/* ------------------------------------------------------------ public slots */

const roundUp = (n: number, step: number) => Math.ceil(n / step) * step;

/** A length limit from the pattern's own text: room to grow by half, never tiny. */
export function lengthLimit(length: number): number {
  return roundUp(Math.max(length * 1.5, length + 10, 20), 10);
}

function itemLimits(group: GroupNode): { minItems: number; maxItems: number } {
  const n = group.count;
  // Columns sit side by side: more than designed squeezes them. Buttons too.
  if (group.parent.blockName === 'core/columns' || group.parent.blockName === 'core/buttons') {
    return { minItems: 1, maxItems: n };
  }
  return { minItems: 1, maxItems: Math.max(n * 2, n + 2) };
}

function common(node: Node) {
  const d = node.declaration;
  return {
    id: node.id,
    role: node.role,
    path: node.path,
    ...((d?.label ?? node.name) ? { label: d?.label ?? node.name } : {}),
    ...(d?.description ? { description: d.description } : {}),
    ...(d?.facts ? { facts: true } : {}),
    ...(d?.placeholder ? { placeholder: d.placeholder } : {}),
  };
}

export function toSlot(node: Node): Slot {
  const d = node.declaration;
  if (node.type === 'group') {
    const limits = itemLimits(node);
    const items = node.items.map((item) => item.map(toSlot));
    const minItems = d?.minItems ?? limits.minItems;
    return {
      ...common(node),
      kind: 'group',
      block: node.parent.blockName ?? '',
      itemBlock: node.parent.innerBlocks[node.start]?.blockName ?? '',
      items,
      flat: items.every((item) => item.length === 1 && item[0]?.kind !== 'group'),
      minItems,
      maxItems: Math.max(d?.maxItems ?? limits.maxItems, minItems),
    };
  }
  const { leaf, block } = node;
  const block_ = block.blockName ?? '';
  if (leaf.kind === 'image') {
    const value = leaf.read(block) as { url: string; alt: string };
    const subject = d?.subject ?? (value.alt || undefined);
    return { ...common(node), kind: 'image', block: block_, value, ...(subject ? { subject } : {}) };
  }
  if (leaf.kind === 'button') {
    const value = leaf.read(block) as { text: string; url: string };
    const length = richTextToPlain(value.text).length;
    return {
      ...common(node),
      kind: 'button',
      block: block_,
      value,
      length,
      maxLength: d?.maxLength ?? Math.min(lengthLimit(length), 40),
    };
  }
  const value = leaf.read(block) as string;
  const length = richTextToPlain(value).length;
  return {
    ...common(node),
    kind: leaf.kind,
    block: block_,
    value,
    length,
    maxLength: d?.maxLength ?? lengthLimit(length),
    ...(leaf.level ? { level: leaf.level(block) } : {}),
  };
}
