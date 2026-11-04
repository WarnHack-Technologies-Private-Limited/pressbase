/**
 * The Elements panel (#35): blocks as tiles, grouped the way a site owner
 * thinks of them, with search; and where a click puts a block. Pure
 * functions over the block editor's inserter items
 * (`getInserterItems()`), tested in elements-model.test.ts. See
 * docs/architecture/studio.md#the-elements-panel.
 */

import { msgid } from '../../lib/i18n/locale';

/** An inserter item, as `getInserterItems()` gives it (the fields the panel reads). */
export interface ElementItem {
  /** `core/image`, or `core/group/group-row` for a variation. */
  id: string;
  name: string;
  title: string;
  description?: string;
  category?: string;
  keywords?: readonly string[];
  isDisabled?: boolean;
  /** Variations listed only when searching. */
  isSearchOnly?: boolean;
  icon?: unknown;
  initialAttributes?: Record<string, unknown>;
  innerBlocks?: unknown;
}

export type ElementGroupId = 'text' | 'media' | 'layout' | 'site' | 'plugins';

export const ELEMENT_GROUPS: readonly { id: ElementGroupId; label: string }[] = [
  { id: 'text', label: msgid('Text') },
  { id: 'media', label: msgid('Media') },
  { id: 'layout', label: msgid('Layout') },
  { id: 'site', label: msgid('Site') },
  { id: 'plugins', label: msgid('Plugins') },
];

/** WordPress's block categories, in the panel's groups. */
const CATEGORY_GROUPS: Record<string, ElementGroupId> = {
  text: 'text',
  media: 'media',
  embed: 'media',
  design: 'layout',
  theme: 'site',
  widgets: 'site',
};

/**
 * The group a block is shown in: plugins' blocks (any namespace but
 * `core/`) under Plugins, core blocks by their category. Saved patterns
 * (`core/block`) are in the Sections panel instead.
 */
export function elementGroupOf(item: Pick<ElementItem, 'name' | 'category'>): ElementGroupId | null {
  if (item.name === 'core/block' || item.category === 'reusable') return null;
  if (!item.name.startsWith('core/')) return 'plugins';
  return CATEGORY_GROUPS[item.category ?? ''] ?? 'site';
}

const normalize = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Whether a block matches every word of a search, in its title, keywords, description or group. */
export function elementMatches(item: ElementItem, search: string, groupLabel = ''): boolean {
  const words = normalize(search).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = normalize(
    [item.title, item.description ?? '', ...(item.keywords ?? []), groupLabel, item.name].join(' '),
  );
  return words.every((word) => haystack.includes(word));
}

/**
 * Listed without a search? Embeds (forty-odd services) and search-only
 * variations wait for a search; the plain Embed block stays.
 */
const listedUpFront = (item: ElementItem) =>
  !item.isSearchOnly && !(item.name === 'core/embed' && item.id !== 'core/embed');

export interface ElementGroup {
  id: ElementGroupId;
  label: string;
  items: ElementItem[];
}

/**
 * The blocks by group, in the groups' order and, within each, the order the
 * block editor gives (core blocks first, then plugins', registration order).
 * `labels` translates group names, for search.
 */
export function groupElements(
  items: readonly ElementItem[],
  { search = '', labels = {} }: { search?: string; labels?: Partial<Record<ElementGroupId, string>> } = {},
): ElementGroup[] {
  const groups = new Map<ElementGroupId, ElementItem[]>();
  const searching = search.trim() !== '';
  for (const item of items) {
    const group = elementGroupOf(item);
    if (!group) continue;
    if (!searching && !listedUpFront(item)) continue;
    const label = labels[group] ?? ELEMENT_GROUPS.find((g) => g.id === group)?.label ?? '';
    if (!elementMatches(item, search, label)) continue;
    const list = groups.get(group) ?? [];
    list.push(item);
    groups.set(group, list);
  }
  return ELEMENT_GROUPS.filter((g) => groups.has(g.id)).map((g) => ({
    id: g.id,
    label: labels[g.id] ?? g.label,
    items: groups.get(g.id) as ElementItem[],
  }));
}

/* ------------------------------------------------------------- insertion */

/** The block-editor selectors insertion needs (the store's own, so a test can fake them). */
export interface InsertSelectors {
  getSelectedBlockClientId: () => string | null;
  getBlockRootClientId: (clientId: string) => string | null;
  getBlockIndex: (clientId: string) => number;
  getBlockOrder: (rootClientId?: string) => string[];
  canInsertBlockType: (name: string, rootClientId?: string | null) => boolean;
}

export interface InsertionPlace {
  rootClientId: string;
  index: number;
  /** `inside`: into an empty block the person selected; `after`: after the selection; `end`: last on the page. */
  where: 'inside' | 'after' | 'end';
  /** The block it goes after or inside. */
  anchor?: string;
}

/**
 * Where a click on a tile puts a block, as WordPress's inserter does: after
 * the selected block, in the nearest container that takes it (an image
 * picked with a paragraph in a column selected goes into the column). An
 * empty block that takes it (a column, a group, an empty section) gets it
 * inside. With nothing selected, or nowhere that takes it, it goes at the
 * end of the page. Null when the page can't take it at all.
 */
export function insertionPlace(
  select: InsertSelectors,
  name: string,
  pageRoot: string | null,
): InsertionPlace | null {
  const selected = select.getSelectedBlockClientId();
  if (selected) {
    if (select.getBlockOrder(selected).length === 0 && select.canInsertBlockType(name, selected)) {
      return { rootClientId: selected, index: 0, where: 'inside', anchor: selected };
    }
    let current = selected;
    for (;;) {
      const parent = select.getBlockRootClientId(current);
      if (parent === null) break;
      if (select.canInsertBlockType(name, parent)) {
        return {
          rootClientId: parent,
          index: select.getBlockIndex(current) + 1,
          where: 'after',
          anchor: current,
        };
      }
      if (parent === '' || parent === pageRoot) break;
      current = parent;
    }
  }
  if (!pageRoot || !select.canInsertBlockType(name, pageRoot)) return null;
  return { rootClientId: pageRoot, index: select.getBlockOrder(pageRoot).length, where: 'end' };
}
