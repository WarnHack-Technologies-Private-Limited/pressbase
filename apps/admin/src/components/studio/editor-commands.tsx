'use client';

import { LayoutPanelTop, Redo2, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useStudioCommands } from './command-palette';
import type { Section } from './sections-model';
import { loadSectionLibrary, useAddSection } from './sections-panel';

/**
 * The palette's commands that need the canvas (#33), registered from inside
 * the block editor: undo and redo, and *Add section: …* for every section
 * in the library (listed once the person types; added after the selected
 * section, or last, as a click in the Sections panel does).
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
    [canUndo, canRedo, canAdd, sections, __, sprintf],
  );
  return null;
}
