import { describe, expect, it } from 'vitest';
import {
  blockAtPath,
  type ChecklistItem,
  groupItems,
  holdsPlaceholder,
  itemPlace,
  itemRegion,
  itemText,
  namedItems,
  totalLeft,
} from './checklist-model';

const __ = (text: string) => text;
const sprintf = (format: string, ...args: (string | number)[]) => {
  let i = 0;
  return format.replace(/%(\d\$)?[sd]/g, () => String(args[i++]));
};

const item = (over: Partial<ChecklistItem>): ChecklistItem => ({
  key: 'page:12',
  kind: 'placeholder',
  page: 12,
  part: null,
  title: 'Home',
  rule: 'placeholder',
  severity: 'warning',
  message: 'Replace this placeholder with real content.',
  text: '[Add a customer quote]',
  block: { path: [1, 0], name: 'core/paragraph' },
  ...over,
});

describe('the checklist', () => {
  it('groups placeholders, images and failed checks, in that order', () => {
    const items = [
      item({ kind: 'check', rule: 'contrast', message: 'Text doesn’t stand out.' }),
      item({}),
      item({ kind: 'image', text: 'The bakery' }),
    ];
    expect([...groupItems(items).keys()]).toEqual(['placeholder', 'image', 'check']);
    expect(totalLeft({ counts: { placeholder: 1, image: 1, check: 1 } })).toBe(3);
    expect(totalLeft(null)).toBe(0);
  });

  it('says what each item is and where', () => {
    expect(itemText(item({}), __, sprintf)).toBe('[Add a customer quote]');
    expect(itemText(item({ text: 'Book a table' }), __, sprintf)).toBe(
      'The “Book a table” button doesn’t link anywhere yet',
    );
    expect(itemText(item({ kind: 'image', text: 'Our oven' }), __, sprintf)).toBe(
      'Choose an image: Our oven',
    );
    expect(itemText(item({ kind: 'check', message: 'No alt text.' }), __, sprintf)).toBe(
      'No alt text.',
    );
    expect(itemPlace(item({}), __, sprintf)).toBe('Home');
    expect(itemPlace(item({ part: 'footer', page: null, title: 'Footer' }), __, sprintf)).toBe(
      'Footer · on every page',
    );
  });

  it('names a few items for the publish question, and counts the rest', () => {
    const items = Array.from({ length: 8 }, (_, i) => item({ text: `[Add ${i}]` }));
    const { shown, more } = namedItems(items);
    expect(shown).toHaveLength(6);
    expect(more).toBe(2);
  });

  it('finds the item’s region and block on the canvas', () => {
    expect(itemRegion(item({}))).toBe('page:12');
    expect(itemRegion(item({ page: 'catering' }))).toBe('page:catering');
    expect(itemRegion(item({ page: null, part: 'header' }))).toBe('wp_template_part:header');
    const blocks = [
      { clientId: 'a', innerBlocks: [] },
      { clientId: 'b', innerBlocks: [{ clientId: 'b0', innerBlocks: [] }] },
    ];
    expect(blockAtPath(blocks, [1, 0])?.clientId).toBe('b0');
    expect(blockAtPath(blocks, [2])).toBeNull();
  });

  it('knows which blocks hold a placeholder, for the canvas', () => {
    expect(holdsPlaceholder('core/paragraph', { content: '[Add your opening hours]' })).toBe(true);
    expect(holdsPlaceholder('core/heading', { content: 'Open daily' })).toBe(false);
    expect(holdsPlaceholder('core/button', { text: '[Add a button label]' })).toBe(true);
    // WordPress's RichTextData: its own toString().
    const rich = { toString: () => '[Add a name]' };
    expect(holdsPlaceholder('core/quote', { citation: rich })).toBe(true);
    // A plain object isn't text ("[object Object]" mustn't count).
    expect(holdsPlaceholder('core/paragraph', { content: {} })).toBe(false);
    expect(holdsPlaceholder('core/group', {})).toBe(false);
  });
});
