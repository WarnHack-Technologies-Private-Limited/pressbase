/**
 * Multi-select for the media picker (galleries). The selection is a list of
 * IDs in the order they were picked, which becomes the gallery's order.
 * Pure functions, kept out of the .tsx so they can be unit-tested.
 */

export type Selection = readonly number[];

/** Click or Space: add to the end, or take out. */
export function toggleSelection(selection: Selection, id: number): number[] {
  return selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id];
}

/**
 * Shift+click: select everything between the anchor (the last item toggled)
 * and the target, in grid order, appended after what's already picked.
 * Without an anchor that's on screen, it's a plain toggle.
 */
export function selectRange(
  selection: Selection,
  gridOrder: readonly number[],
  anchor: number | undefined,
  target: number,
): number[] {
  const from = anchor === undefined ? -1 : gridOrder.indexOf(anchor);
  const to = gridOrder.indexOf(target);
  if (from < 0 || to < 0) return toggleSelection(selection, target);
  const [start, end] = from <= to ? [from, to] : [to, from];
  // Walk from the anchor towards the target, so the picked order follows the gesture.
  const range = gridOrder.slice(start, end + 1);
  if (from > to) range.reverse();
  return [...selection, ...range.filter((id) => !selection.includes(id))];
}

/** The `value` blocks pass to MediaUpload (a gallery's image IDs) as a preselection. */
export function initialSelection(value: unknown): number[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const ids = list
    .map((item) =>
      Number(
        item && typeof item === 'object' && 'id' in item ? (item as { id: unknown }).id : item,
      ),
    )
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)];
}

/** Keeps the picked order, dropping IDs that aren't loaded (e.g. deleted since). */
export function orderedSelection<T extends { id: number }>(
  selection: Selection,
  known: ReadonlyMap<number, T>,
): T[] {
  return selection.flatMap((id) => {
    const item = known.get(id);
    return item ? [item] : [];
  });
}

/** "3 selected", for the footer. */
export const selectedCount = (n: number) => (n === 0 ? 'Nothing selected' : `${n} selected`);

/** The primary button: "Insert 3 images", "Create gallery"… */
export function multiSelectLabel(
  n: number,
  { action = 'insert', noun = 'item' }: { action?: 'insert' | 'gallery'; noun?: string } = {},
): string {
  if (action === 'gallery') return n ? `Create gallery (${n})` : 'Create gallery';
  if (!n) return `Insert ${noun}s`;
  return `Insert ${n} ${n === 1 ? noun : `${noun}s`}`;
}
