import type { GroupSlot, Slot, SlotValue, SlotValues } from './types';

/**
 * transferSlots(from, to): moves a section's content into another pattern,
 * for Swap layout. Values go to slots of the same role first (title to
 * title, actions to actions), then to slots of the same kind in order.
 * Groups map item by item. What doesn't fit (a fourth card into a
 * three-column layout, an image into a layout without one) comes back in
 * `unused`, so the editor can keep it and tell the person.
 *
 *   const { values, unused } = transferSlots(extractSlots(current), extractSlots(next));
 *   const blocks = fillSlots(next, values);
 */
export interface UnusedValue {
  /** Dotted path in the source: `items.3.title`. */
  path: string;
  slot: Slot;
  value: SlotValue;
}

export interface SlotTransfer {
  values: SlotValues;
  unused: UnusedValue[];
}

type Leaf = Exclude<Slot, { kind: 'group' }>;

const family = (slot: Slot) => (slot.kind === 'heading' ? 'text' : slot.kind);

function leafValue(slot: Leaf): SlotValue {
  return typeof slot.value === 'string' ? slot.value : { ...slot.value };
}

/** Path of a slot in a group item; a flat item is addressed by its index alone. */
const itemPath = (group: GroupSlot, path: string, index: number, child: Slot) =>
  group.flat ? `${path}.${index}` : `${path}.${index}.${child.id}`;

function allLeaves(slot: Slot, path: string): UnusedValue[] {
  if (slot.kind !== 'group') return [{ path, slot, value: leafValue(slot) }];
  return slot.items.flatMap((item, index) =>
    item.flatMap((child) => allLeaves(child, itemPath(slot, path, index, child))),
  );
}

/** The kinds of content in a group's items (headings count as text). */
function kindsOf(slots: Slot[]): Set<string> {
  const kinds = new Set<string>();
  for (const slot of slots) {
    if (slot.kind === 'group') for (const item of slot.items) for (const k of kindsOf(item)) kinds.add(k);
    else kinds.add(family(slot));
  }
  return kinds;
}

/** Two groups can exchange items when their items share a kind of content. */
function compatible(a: GroupSlot, b: GroupSlot): boolean {
  const theirs = kindsOf(b.items.flat());
  return [...kindsOf(a.items.flat())].some((kind) => theirs.has(kind));
}

export function transferSlots(from: Slot[], to: Slot[], prefix = ''): SlotTransfer {
  const values: SlotValues = {};
  const unused: UnusedValue[] = [];
  const used = new Set<Slot>();

  const pick = <T extends Slot>(sources: T[], match: (s: T) => boolean): T | undefined => {
    const found = sources.find((s) => !used.has(s) && match(s));
    if (found) used.add(found);
    return found;
  };

  // Leaves: same role, then same kind (a heading only takes a heading).
  const sourceLeaves = from.filter((s): s is Leaf => s.kind !== 'group');
  const targetLeaves = to.filter((s): s is Leaf => s.kind !== 'group');
  const pending: Leaf[] = [];
  for (const target of targetLeaves) {
    const source = pick(sourceLeaves, (s) => s.role === target.role && family(s) === family(target));
    if (source) values[target.id] = leafValue(source);
    else pending.push(target);
  }
  for (const target of pending) {
    const source = pick(sourceLeaves, (s) => s.kind === target.kind);
    if (source) values[target.id] = leafValue(source);
  }

  // Groups: same role, then in order among groups whose items hold the same
  // kinds of content (buttons never become cards).
  const sourceGroups = from.filter((s): s is GroupSlot => s.kind === 'group');
  const targetGroups = to.filter((s): s is GroupSlot => s.kind === 'group');
  const pairs: [GroupSlot, GroupSlot][] = [];
  const waiting: GroupSlot[] = [];
  for (const target of targetGroups) {
    const source = pick(sourceGroups, (s) => s.role === target.role && compatible(s, target));
    if (source) pairs.push([source, target]);
    else waiting.push(target);
  }
  for (const target of waiting) {
    const source = pick(sourceGroups, (s) => compatible(s, target));
    if (source) pairs.push([source, target]);
  }
  for (const [source, target] of pairs) {
    const items: SlotValue[] = [];
    source.items.forEach((sourceItem, index) => {
      const base = `${prefix}${source.id}`;
      if (index >= target.maxItems) {
        for (const child of sourceItem) {
          unused.push(...allLeaves(child, itemPath(source, base, index, child)));
        }
        return;
      }
      const template = target.items[Math.min(index, target.items.length - 1)] ?? [];
      const moved = transferSlots(sourceItem, template, `${base}.${index}.`);
      if (source.flat) for (const u of moved.unused) u.path = `${base}.${index}`;
      unused.push(...moved.unused);
      const only = template[0];
      items.push(target.flat && only ? (moved.values[only.id] ?? leafOrEmpty(only)) : moved.values);
    });
    values[target.id] = items;
  }

  for (const slot of from) {
    if (!used.has(slot)) unused.push(...allLeaves(slot, prefix + slot.id));
  }
  return { values, unused };
}

/** A flat item whose source had nothing that fits keeps the template's content. */
function leafOrEmpty(slot: Slot): SlotValue {
  return slot.kind === 'group' ? [] : leafValue(slot);
}
