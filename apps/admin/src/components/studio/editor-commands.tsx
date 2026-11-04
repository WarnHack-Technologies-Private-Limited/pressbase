'use client';

import { store as blockEditorStore } from '@wordpress/block-editor';
import { useSelect } from '@wordpress/data';
import { ArrowLeftRight, Blocks, LayoutPanelTop, Redo2, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useStudioCommands } from './command-palette';
import { type ElementItem, groupElements } from './elements-model';
import { useInsertElement } from './elements-panel';
import type { Section } from './sections-model';
import { contentRootId, loadSectionLibrary, sectionOf, useAddSection } from './sections-panel';
import { useSwapLayout } from './swap-layout';

const NO_ITEMS: ElementItem[] = [];

/**
 * The palette's commands that need the canvas (#33), registered from inside
 * the block editor: undo and redo, and *Add section: …* for every section
 * in the library (listed once the person types; added after the selected
 * section, or last, as a click in the Sections panel does), and Swap
 * layout for the selected section (#45): next, previous, or a layout by name;
 * and *Add block: …* for every block in the Elements panel (#35), put where
 * a click on its tile puts it.
 */
export function EditorCommands({
  canUndo,
  canRedo,
  undo,
  redo,
  onSectionAdded,
}: {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** Before a section goes in (History names the step), and after (a toast). */
  onSectionAdded: (title: string, phase: 'before' | 'after') => void;
}) {
  const { __, sprintf } = useI18n();
  const [sections, setSections] = useState<Section[]>([]);
  const addSection = useAddSection();
  const actions = useRef({ undo, redo, addSection, onSectionAdded });
  actions.current = { undo, redo, addSection, onSectionAdded };
  const canAdd = Boolean(addSection);
  // The section holding the selection, for Swap layout.
  const selectedSection = useSelect((select) => {
    const store = select(blockEditorStore) as unknown as Parameters<typeof contentRootId>[0] &
      Parameters<typeof sectionOf>[0] & { getSelectedBlockClientId: () => string | null };
    const root = contentRootId(store);
    const selected = store.getSelectedBlockClientId();
    return root && selected ? sectionOf(store, root, selected) : null;
  }, []);
  const swap = useSwapLayout(selectedSection);
  const swapRef = useRef(swap);
  swapRef.current = swap;
  const layouts = swap.layouts;
  const insertElement = useInsertElement();
  const insertRef = useRef(insertElement);
  insertRef.current = insertElement;
  const elementItems = useSelect((select) => {
    const store = select(blockEditorStore) as unknown as Parameters<typeof contentRootId>[0] & {
      getInserterItems: (root?: string | null) => ElementItem[];
    };
    const root = contentRootId(store);
    return root ? store.getInserterItems(root) : NO_ITEMS;
  }, []);
  // The inserter's list is rebuilt on every edit; the commands change only with the blocks in it.
  const itemsRef = useRef(elementItems);
  itemsRef.current = elementItems;
  const itemsKey = elementItems.map((item) => `${item.id}${item.isDisabled ? '!' : ''}`).join(',');
  const elements = useMemo(
    () => groupElements(itemsRef.current).flatMap((group) => group.items),
    [itemsKey],
  );

  useEffect(() => {
    let live = true;
    loadSectionLibrary()
      .then((library) => live && setSections(library.sections))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useStudioCommands(
    () => [
      {
        id: 'pressbase/undo',
        label: __('Undo', 'pressbase-admin'),
        group: 'actions',
        hint: 'Ctrl+Z',
        icon: <Undo2 size={16} />,
        disabled: !canUndo,
        run: () => actions.current.undo(),
      },
      {
        id: 'pressbase/redo',
        label: __('Redo', 'pressbase-admin'),
        group: 'actions',
        hint: 'Ctrl+Shift+Z',
        icon: <Redo2 size={16} />,
        disabled: !canRedo,
        run: () => actions.current.redo(),
      },
      ...(['next', 'previous'] as const).map((direction) => ({
        id: `pressbase/swap-layout/${direction}`,
        label:
          direction === 'next'
            ? __('Swap layout: next', 'pressbase-admin')
            : __('Swap layout: previous', 'pressbase-admin'),
        group: 'actions',
        keywords: [__('section', 'pressbase-admin'), __('design', 'pressbase-admin')],
        hint: layouts
          ? sprintf(
              __('%1$d of %2$d', 'pressbase-admin'),
              layouts.index + 1,
              layouts.layouts.length,
            )
          : selectedSection
            ? __('No other layouts for this section', 'pressbase-admin')
            : __('Select a section first', 'pressbase-admin'),
        icon: <ArrowLeftRight size={16} />,
        disabled: !layouts,
        run: () => swapRef.current.swap(direction === 'next' ? 1 : -1),
      })),
      ...(layouts
        ? layouts.layouts
            .filter((layout) => layout !== layouts.current)
            .map((layout) => ({
              id: `pressbase/swap-layout/to/${layout.name}`,
              label: sprintf(__('Swap layout to: %s', 'pressbase-admin'), layout.title),
              group: 'actions',
              keywords: [layout.description, ...layout.keywords],
              icon: <ArrowLeftRight size={16} />,
              searchOnly: true,
              run: () => swapRef.current.swap(layout.name),
            }))
        : []),
      ...elements.map((item) => ({
        id: `pressbase/add-block/${item.id}`,
        label: sprintf(__('Add block: %s', 'pressbase-admin'), item.title),
        group: 'blocks',
        keywords: [item.description ?? '', ...(item.keywords ?? [])],
        icon: <Blocks size={16} />,
        disabled: Boolean(item.isDisabled),
        searchOnly: true,
        run: () => {
          insertRef.current?.(item);
        },
      })),
      ...(canAdd
        ? sections.map((section) => ({
            id: `pressbase/add-section/${section.name}`,
            label: sprintf(__('Add section: %s', 'pressbase-admin'), section.title),
            group: 'sections',
            keywords: [section.description, section.category, ...section.keywords],
            icon: <LayoutPanelTop size={16} />,
            searchOnly: true,
            run: () => {
              const { addSection: add, onSectionAdded: added } = actions.current;
              if (!add) return;
              added(section.title, 'before');
              add(section);
              added(section.title, 'after');
            },
          }))
        : []),
    ],
    [canUndo, canRedo, canAdd, sections, layouts, selectedSection, elements, __, sprintf],
  );
  return null;
}
