import { describe, expect, it } from 'vitest';
import {
  initialSelection,
  multiSelectLabel,
  orderedSelection,
  selectedCount,
  selectRange,
  toggleSelection,
} from './selection';

describe('media picker multi-select', () => {
  it('keeps the order things were picked in', () => {
    let selection = toggleSelection([], 5);
    selection = toggleSelection(selection, 2);
    selection = toggleSelection(selection, 9);
    expect(selection).toEqual([5, 2, 9]);
    expect(toggleSelection(selection, 2)).toEqual([5, 9]);
    expect(toggleSelection([5, 9], 2)).toEqual([5, 9, 2]);
  });

  it('selects ranges in grid order from the anchor, after earlier picks', () => {
    const grid = [1, 2, 3, 4, 5, 6];
    expect(selectRange([6], grid, 2, 4)).toEqual([6, 2, 3, 4]);
    // Backwards from the anchor.
    expect(selectRange([], grid, 5, 3)).toEqual([5, 4, 3]);
    // Already-picked items keep their place.
    expect(selectRange([3, 1], grid, 1, 4)).toEqual([3, 1, 2, 4]);
    // No anchor (or one that's gone): a plain toggle.
    expect(selectRange([1], grid, undefined, 4)).toEqual([1, 4]);
    expect(selectRange([1], grid, 99, 4)).toEqual([1, 4]);
  });

  it('turns a block’s value into a preselection', () => {
    expect(initialSelection([3, '7', 3, 0, null])).toEqual([3, 7]);
    expect(initialSelection(4)).toEqual([4]);
    expect(initialSelection([{ id: 5 }, { id: 2 }])).toEqual([5, 2]);
    expect(initialSelection({})).toEqual([]);
    expect(initialSelection(undefined)).toEqual([]);
  });

  it('resolves the selection to items in picked order', () => {
    const known = new Map([1, 2, 3].map((id) => [id, { id }]));
    expect(orderedSelection([3, 8, 1], known)).toEqual([{ id: 3 }, { id: 1 }]);
  });

  it('labels the footer and the primary button', () => {
    expect(selectedCount(0)).toBe('Nothing selected');
    expect(selectedCount(3)).toBe('3 selected');
    expect(multiSelectLabel(0, { noun: 'image' })).toBe('Insert images');
    expect(multiSelectLabel(1, { noun: 'image' })).toBe('Insert 1 image');
    expect(multiSelectLabel(3, { noun: 'image' })).toBe('Insert 3 images');
    expect(multiSelectLabel(3, { action: 'gallery' })).toBe('Create gallery (3)');
  });
});
