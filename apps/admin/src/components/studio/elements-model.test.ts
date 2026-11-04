import { describe, expect, it } from 'vitest';
import {
  AUTO_SCROLL_EDGE,
  autoScrollSpeed,
  type ElementItem,
  elementGroupOf,
  groupElements,
  type InsertSelectors,
  insertionPlace,
} from './elements-model';

const item = (id: string, category: string, extra: Partial<ElementItem> = {}): ElementItem => ({
  id,
  name: id.split('/').slice(0, 2).join('/'),
  title: id.split('/').at(-1) ?? id,
  category,
  ...extra,
});

/** What getInserterItems() gives for a page, abridged, in its order (core first). */
const ITEMS: ElementItem[] = [
  item('core/paragraph', 'text', { title: 'Paragraph', keywords: ['text'] }),
  item('core/heading', 'text', { title: 'Heading', keywords: ['title', 'subtitle'] }),
  item('core/image', 'media', { title: 'Image', keywords: ['img', 'photo', 'picture'] }),
  item('core/group', 'design', { title: 'Group' }),
  item('core/group/group-row', 'design', { title: 'Row' }),
  item('core/group/group-search-only', 'design', { title: 'Hidden', isSearchOnly: true }),
  item('core/columns', 'design', { title: 'Columns' }),
  item('core/embed', 'embed', { title: 'Embed' }),
  item('core/embed/youtube', 'embed', { title: 'YouTube', keywords: ['music', 'video'] }),
  item('core/site-logo', 'theme', { title: 'Site Logo' }),
  item('core/search', 'widgets', { title: 'Search' }),
  item('core/block/12', 'reusable', { name: 'core/block', title: 'My saved pattern' }),
  item('acme/map', 'widgets', { title: 'Map', description: 'A map of where you are.' }),
  item('acme/form', 'acme-forms', { title: 'Contact form' }),
];

describe('elementGroupOf', () => {
  it('files core blocks by category and every plugin block under Plugins', () => {
    expect(elementGroupOf({ name: 'core/paragraph', category: 'text' })).toBe('text');
    expect(elementGroupOf({ name: 'core/image', category: 'media' })).toBe('media');
    expect(elementGroupOf({ name: 'core/embed', category: 'embed' })).toBe('media');
    expect(elementGroupOf({ name: 'core/group', category: 'design' })).toBe('layout');
    expect(elementGroupOf({ name: 'core/site-logo', category: 'theme' })).toBe('site');
    expect(elementGroupOf({ name: 'core/search', category: 'widgets' })).toBe('site');
    expect(elementGroupOf({ name: 'core/new-thing', category: 'unknown' })).toBe('site');
    expect(elementGroupOf({ name: 'acme/map', category: 'widgets' })).toBe('plugins');
  });

  it('leaves saved patterns to the Sections panel', () => {
    expect(elementGroupOf({ name: 'core/block', category: 'reusable' })).toBeNull();
  });
});

describe('groupElements', () => {
  it('lists the groups in order, without search-only variations and every embed service', () => {
    const groups = groupElements(ITEMS);
    expect(groups.map((g) => g.id)).toEqual(['text', 'media', 'layout', 'site', 'plugins']);
    expect(groups.map((g) => g.items.map((i) => i.title))).toEqual([
      ['Paragraph', 'Heading'],
      ['Image', 'Embed'],
      ['Group', 'Row', 'Columns'],
      ['Site Logo', 'Search'],
      ['Map', 'Contact form'],
    ]);
  });

  it('finds blocks by title, keyword, description and group, ignoring case and accents', () => {
    const titles = (search: string) =>
      groupElements(ITEMS, { search }).flatMap((g) => g.items.map((i) => i.title));
    expect(titles('PHOTO')).toEqual(['Image']);
    expect(titles('youtube')).toEqual(['YouTube']);
    expect(titles('hidden')).toEqual(['Hidden']);
    expect(titles('where you')).toEqual(['Map']);
    expect(titles('plugins')).toEqual(['Map', 'Contact form']);
    expect(titles('médià')).toEqual(['Image', 'Embed', 'YouTube']);
    expect(titles('nothing like this')).toEqual([]);
  });

  it('uses translated group names, for labels and search', () => {
    const groups = groupElements(ITEMS, {
      search: 'erweiterungen',
      labels: { plugins: 'Erweiterungen' },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('Erweiterungen');
  });
});

/** A tiny block tree: page root > [heading, columns > [column (empty), column > [paragraph]]]. */
function store(selected: string | null, rules: Record<string, string[]> = {}): InsertSelectors {
  const parents: Record<string, string> = {
    page: '',
    heading: 'page',
    columns: 'page',
    col1: 'columns',
    col2: 'columns',
    para: 'col2',
  };
  const order: Record<string, string[]> = {
    '': ['page'],
    page: ['heading', 'columns'],
    columns: ['col1', 'col2'],
    col1: [],
    col2: ['para'],
    heading: [],
    para: [],
  };
  // What each block takes: the page and columns' columns take anything; columns only columns.
  const takes: Record<string, string[] | 'any'> = {
    '': [],
    page: 'any',
    columns: ['core/column'],
    col1: 'any',
    col2: 'any',
    heading: [],
    para: [],
    ...rules,
  };
  return {
    getSelectedBlockClientId: () => selected,
    getBlockRootClientId: (id) => parents[id] ?? null,
    getBlockIndex: (id) => (order[parents[id] ?? ''] ?? []).indexOf(id),
    getBlockOrder: (root = '') => order[root] ?? [],
    canInsertBlockType: (name, root) => {
      const rule = takes[root ?? ''];
      return rule === 'any' || (rule ?? []).includes(name);
    },
  };
}

describe('insertionPlace', () => {
  it('goes after the selected block', () => {
    expect(insertionPlace(store('heading'), 'core/image', 'page')).toEqual({
      rootClientId: 'page',
      index: 1,
      where: 'after',
      anchor: 'heading',
    });
    expect(insertionPlace(store('para'), 'core/image', 'page')).toEqual({
      rootClientId: 'col2',
      index: 1,
      where: 'after',
      anchor: 'para',
    });
  });

  it('goes inside an empty block that takes it (a column)', () => {
    expect(insertionPlace(store('col1'), 'core/image', 'page')).toEqual({
      rootClientId: 'col1',
      index: 0,
      where: 'inside',
      anchor: 'col1',
    });
  });

  it('climbs to the nearest container that takes it', () => {
    // A column with content selected: an image can't go in Columns, so after the Columns.
    expect(insertionPlace(store('col2'), 'core/image', 'page')).toEqual({
      rootClientId: 'page',
      index: 2,
      where: 'after',
      anchor: 'columns',
    });
  });

  it('goes at the end of the page with nothing selected', () => {
    expect(insertionPlace(store(null), 'core/image', 'page')).toEqual({
      rootClientId: 'page',
      index: 2,
      where: 'end',
    });
  });

  it('is null when the page can’t take the block', () => {
    expect(insertionPlace(store(null, { page: [] }), 'core/image', 'page')).toBeNull();
    expect(insertionPlace(store(null), 'core/image', null)).toBeNull();
  });
});

describe('autoScrollSpeed', () => {
  it('scrolls only near the edges, faster closer to them', () => {
    expect(autoScrollSpeed(400, 800)).toBe(0);
    expect(autoScrollSpeed(AUTO_SCROLL_EDGE + 1, 800)).toBe(0);
    expect(autoScrollSpeed(0, 800)).toBe(-18);
    expect(autoScrollSpeed(50, 800)).toBeLessThan(0);
    expect(autoScrollSpeed(50, 800)).toBeGreaterThan(autoScrollSpeed(10, 800));
    expect(autoScrollSpeed(800, 800)).toBe(18);
    expect(autoScrollSpeed(760, 800)).toBeGreaterThan(0);
  });

  it('never scrolls a canvas too short to have edges', () => {
    expect(autoScrollSpeed(10, 100)).toBe(0);
  });
});
