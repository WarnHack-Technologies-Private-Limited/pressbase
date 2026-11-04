'use client';

import { BlockIcon, store as blockEditorStore } from '@wordpress/block-editor';
import {
  type Block as BlockInstance,
  createBlock,
  createBlocksFromInnerBlocksTemplate,
} from '@wordpress/blocks';
import { useDispatch, useRegistry, useSelect } from '@wordpress/data';
import { Blocks } from 'lucide-react';
import { type DragEvent, memo, useId, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import {
  ELEMENT_GROUPS,
  type ElementGroupId,
  type ElementItem,
  groupElements,
  type InsertionPlace,
  type InsertSelectors,
  insertionPlace,
} from './elements-model';
import { contentRootId, sectionLabel } from './sections-panel';
import styles from './studio.module.css';

interface Selectors extends InsertSelectors {
  getBlocks: () => BlockInstance[];
  getBlockName: (clientId: string) => string | null;
  getBlockAttributes: (clientId: string) => Record<string, unknown> | null;
  getInserterItems: (rootClientId?: string | null) => ElementItem[];
}

const EMPTY: ElementItem[] = [];

/** A new block for an inserter item, as WordPress's inserter makes it (useBlockTypesState). */
export function blockFor(item: ElementItem): BlockInstance {
  return createBlock(
    item.name,
    item.initialAttributes,
    createBlocksFromInnerBlocksTemplate(item.innerBlocks as never),
  );
}

/**
 * Inserts a block where a click puts it (elements-model.ts
 * insertionPlace()): after the selection, or inside an empty block the
 * person selected, or at the end of the page. The block editor's own
 * insertBlock(), so it's one undo step. Null when the canvas has no page
 * content (the latest posts). Shared by the panel and the command palette.
 */
export function useInsertElement(): ((item: ElementItem) => InsertionPlace | null) | null {
  const registry = useRegistry();
  const { insertBlock } = useDispatch(blockEditorStore) as unknown as {
    insertBlock: (
      block: BlockInstance,
      index?: number,
      rootClientId?: string,
      updateSelection?: boolean,
    ) => void;
  };
  const root = useSelect(
    (select) => contentRootId(select(blockEditorStore) as unknown as Selectors),
    [],
  );
  if (!root) return null;
  return (item) => {
    const select = registry.select(blockEditorStore) as unknown as Selectors;
    const place = insertionPlace(select, item.name, root);
    if (!place) return null;
    insertBlock(blockFor(item), place.index, place.rootClientId, true);
    return place;
  };
}

/**
 * The Elements panel (#35), like Elementor's Widgets panel: every block the
 * page can take, as large tiles in Text, Media, Layout, Site and Plugins,
 * with search. The list is the block editor's own (`getInserterItems()`),
 * so plugins' blocks appear by themselves. Click a tile (or press Enter on
 * it) to add the block after the selection; or drag it onto the page,
 * where a line shows the place and a container that will hold it lights up.
 */
export function ElementsPanel({ onInserted }: { onInserted?: (title: string) => void }) {
  const { __, sprintf } = useI18n();
  const [search, setSearch] = useState('');
  const searchId = useId();
  const insert = useInsertElement();
  const root = useSelect(
    (select) => contentRootId(select(blockEditorStore) as unknown as Selectors),
    [],
  );
  const items = useSelect(
    (select) =>
      root ? (select(blockEditorStore) as unknown as Selectors).getInserterItems(root) : EMPTY,
    [root],
  );
  // Where a click puts a paragraph now, said in words (most blocks go to the same place).
  const where = useSelect(
    (select) => {
      if (!root) return '';
      const s = select(blockEditorStore) as unknown as Selectors;
      const place = insertionPlace(s, 'core/paragraph', root);
      if (!place || place.where === 'end' || !place.anchor) return '';
      const name = sectionLabel(s, place.anchor);
      return place.where === 'inside'
        ? sprintf(__('Click a block to add it inside “%s”.', 'pressbase-admin'), name)
        : sprintf(__('Click a block to add it after “%s”.', 'pressbase-admin'), name);
    },
    [root, __, sprintf],
  );

  const labels = useMemo(
    () =>
      Object.fromEntries(
        ELEMENT_GROUPS.map((g) => [g.id, __(g.label, 'pressbase-admin') as string]),
      ) as Record<ElementGroupId, string>,
    [__],
  );
  const groups = useMemo(() => groupElements(items, { search, labels }), [items, search, labels]);
  const count = groups.reduce((n, g) => n + g.items.length, 0);

  if (!root || !insert) {
    return (
      <p className={styles.panelNote}>
        <Blocks size={16} aria-hidden="true" />
        <span>
          {__(
            'This page shows your latest posts, so it has no content of its own. Open a page to add blocks to it.',
            'pressbase-admin',
          )}
        </span>
      </p>
    );
  }

  const add = (item: ElementItem) => {
    if (insert(item)) onInserted?.(item.title);
  };

  return (
    <div className={styles.elementsPanel}>
      <div className={styles.sectionsFilters}>
        <label htmlFor={searchId} className="visually-hidden">
          {__('Search blocks', 'pressbase-admin')}
        </label>
        <input
          id={searchId}
          type="search"
          className={styles.sectionsSearch}
          placeholder={__('Search blocks', 'pressbase-admin')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <p className={styles.elementsWhere} role="status">
          {where || __('Click a block to add it at the end of the page.', 'pressbase-admin')}
        </p>
      </div>
      {search && (
        <p className="visually-hidden" role="status">
          {sprintf(__('%d blocks found.', 'pressbase-admin'), count)}
        </p>
      )}
      {groups.length === 0 && (
        <p className={styles.pagesEmpty}>{__('No blocks match. Try another word.', 'pressbase-admin')}</p>
      )}
      {groups.map((group) => (
        <section key={group.id} className={styles.sectionGroup} aria-labelledby={`${searchId}-${group.id}`}>
          <h3 id={`${searchId}-${group.id}`} className={styles.sectionGroupTitle}>
            {group.label}
          </h3>
          <ul className={styles.elementGrid}>
            {group.items.map((item) => (
              <ElementTile key={item.id} item={item} onAdd={add} />
            ))}
          </ul>
        </section>
      ))}
      <p className={styles.pagesHint}>
        {__(
          'Drag a block onto the page: a line shows where it goes, and a box lights up when it goes inside one. Or select a place on the page and click the block.',
          'pressbase-admin',
        )}
      </p>
    </div>
  );
}

/** One block: a large tile with its icon and name. A button to add it, and draggable onto the page. */
const ElementTile = memo(function ElementTile({
  item,
  onAdd,
}: {
  item: ElementItem;
  onAdd: (item: ElementItem) => void;
}) {
  const { __, sprintf } = useI18n();
  const descriptionId = useId();

  const onDragStart = (event: DragEvent) => {
    // What WordPress's inserter hands the canvas's drop zones (InserterDraggableBlocks).
    const block = blockFor(item);
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('wp-blocks', JSON.stringify({ type: 'inserter', blocks: [block] }));
    event.dataTransfer.items.add('', `wp-block:${block.name}`);
  };

  return (
    <li className={styles.elementTileItem} draggable={!item.isDisabled} onDragStart={onDragStart}>
      <button
        type="button"
        className={styles.elementTile}
        aria-label={sprintf(__('Add block: %s', 'pressbase-admin'), item.title)}
        aria-describedby={item.description ? descriptionId : undefined}
        aria-disabled={item.isDisabled || undefined}
        data-element={item.id}
        onClick={() => !item.isDisabled && onAdd(item)}
      >
        <span className={styles.elementIcon} aria-hidden="true">
          <BlockIcon icon={item.icon as never} showColors />
        </span>
        <span className={styles.elementTitle}>{item.title}</span>
      </button>
      {item.description && (
        <span id={descriptionId} className="visually-hidden">
          {item.isDisabled
            ? `${item.description} ${__('This page already has one.', 'pressbase-admin')}`
            : item.description}
        </span>
      )}
    </li>
  );
});
