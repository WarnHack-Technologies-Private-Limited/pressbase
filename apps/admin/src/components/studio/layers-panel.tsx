'use client';

/**
 * Layers (#50): everything on the page as a tree, Elementor's Navigator.
 * It is the block editor's list view, which already drags to reorder and
 * nest, follows the canvas's selection (and selects on the canvas), and
 * shows a hidden block's icon. Studio adds:
 *
 * - moving with the keyboard: Alt and the arrow keys on a row (layers-model.ts);
 * - the selected block's name (`metadata.name`) and where it shows
 *   (`metadata.blockVisibility`, #49), under the tree.
 *
 * See docs/architecture/studio.md#layers.
 */

import {
  store as blockEditorStore,
  __experimentalListView as ListView,
  useBlockDisplayInformation,
} from '@wordpress/block-editor';
import { getBlockType, hasBlockSupport } from '@wordpress/blocks';
import { useDispatch, useRegistry, useSelect } from '@wordpress/data';
import {
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useState,
} from 'react';
import { useI18n } from '@/lib/i18n/context';
import { lightScope } from '../block-editor';
import { Button } from '../ui/button';
import { isRegionBlock, LAYER_MOVE_KEYS, type LayerPlace, layerTarget } from './layers-model';
import styles from './layers-panel.module.css';
import { VisibilityChoice } from './responsive';
import studioStyles from './studio.module.css';

type Select = {
  getSelectedBlockClientId: () => string | null;
  getBlockName: (id: string) => string | null;
  getBlockAttributes: (id: string) => Record<string, unknown> | null;
  getBlockRootClientId: (id: string) => string | null;
  getBlockOrder: (rootClientId?: string) => string[];
  getBlockIndex: (id: string) => number;
  getBlockEditingMode: (id: string) => string;
  canMoveBlock: (id: string) => boolean;
  canInsertBlockType: (name: string, rootClientId?: string) => boolean;
};

type Dispatch = {
  moveBlocksToPosition: (
    clientIds: string[],
    fromRootClientId: string,
    toRootClientId: string,
    index: number,
  ) => void;
  updateBlockAttributes: (clientId: string, attributes: Record<string, unknown>) => void;
};

/** The block's name for people: its own name in Layers, or its block type's title. */
function blockLabel(store: Select, clientId: string): string {
  const name = store.getBlockAttributes(clientId)?.metadata as { name?: string } | undefined;
  if (name?.name) return name.name;
  const type = getBlockType(store.getBlockName(clientId) ?? '');
  return (type?.title as string | undefined) ?? '';
}

export function LayersPanel() {
  const { __, sprintf } = useI18n();
  const registry = useRegistry();
  const { moveBlocksToPosition } = useDispatch(blockEditorStore) as unknown as Dispatch;
  const [announcement, setAnnouncement] = useState('');
  const selected = useSelect(
    (select) => (select(blockEditorStore) as unknown as Select).getSelectedBlockClientId(),
    [],
  );
  const hintId = useId();

  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const move = LAYER_MOVE_KEYS[event.key];
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !move) return;
    const row = (event.target as Element).closest<HTMLElement>('[role="row"][data-block]');
    const clientId = row?.dataset.block;
    if (!clientId) return;
    event.preventDefault();
    event.stopPropagation();

    const store = registry.select(blockEditorStore) as unknown as Select;
    const rootClientId = store.getBlockRootClientId(clientId) ?? '';
    const siblings = store.getBlockOrder(rootClientId);
    const parentRoot = rootClientId ? (store.getBlockRootClientId(rootClientId) ?? '') : '';
    const place: LayerPlace = {
      rootClientId,
      siblings,
      index: siblings.indexOf(clientId),
      parent: rootClientId
        ? { rootClientId: parentRoot, index: store.getBlockOrder(parentRoot).indexOf(rootClientId) }
        : undefined,
    };
    const target = layerTarget(move, place, (id) => store.getBlockOrder(id).length);
    const name = store.getBlockName(clientId) ?? '';
    const label = blockLabel(store, clientId);
    const allowed =
      target &&
      store.canMoveBlock(clientId) &&
      (target.rootClientId === rootClientId || store.canInsertBlockType(name, target.rootClientId));
    if (!target || !allowed) {
      setAnnouncement(sprintf(__('%s can’t move there.', 'pressbase-admin'), label));
      return;
    }
    // Into or out of a block: name it ("Heading moved into Group").
    const other = move === 'in' ? target.rootClientId : rootClientId;
    moveBlocksToPosition([clientId], rootClientId, target.rootClientId, target.index);
    const otherLabel = blockLabel(store, other);
    setAnnouncement(
      {
        up: () => sprintf(__('%s moved up.', 'pressbase-admin'), label),
        down: () => sprintf(__('%s moved down.', 'pressbase-admin'), label),
        in: () => sprintf(__('%1$s moved into %2$s.', 'pressbase-admin'), label, otherLabel),
        out: () => sprintf(__('%1$s moved out of %2$s.', 'pressbase-admin'), label, otherLabel),
      }[move](),
    );
    focusRow(clientId, event.currentTarget);
  };

  return (
    <div className={styles.panel}>
      <p id={hintId} className={styles.hint}>
        {__(
          'Drag a block to move it, or onto a group to put it inside. With the keyboard: the arrow keys go through the list, and Alt with the arrow keys moves the block.',
          'pressbase-admin',
        )}
      </p>
      <div
        className={`${lightScope} ${studioStyles.wpPanel} ${styles.tree}`}
        onKeyDownCapture={onKeyDownCapture}
        data-layers-tree
      >
        <ListView
          isExpanded
          showBlockMovers
          description={__('Blocks on this page', 'pressbase-admin')}
        />
      </div>
      {selected && <SelectedLayer clientId={selected} />}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

/** After a move, focus goes back to the block's row once the tree has redrawn. */
function focusRow(clientId: string, tree: HTMLElement) {
  let tries = 0;
  const attempt = () => {
    const target = tree.querySelector<HTMLElement>(
      `[role="row"][data-block="${CSS.escape(clientId)}"] .block-editor-list-view-block-select-button`,
    );
    if (target) {
      target.focus();
      return;
    }
    if (++tries < 20) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/** Under the tree: the selected block's name and where it shows. */
function SelectedLayer({ clientId }: { clientId: string }) {
  const { __ } = useI18n();
  const { name, metadata, editable } = useSelect(
    (select) => {
      const store = select(blockEditorStore) as unknown as Select;
      const blockName = store.getBlockName(clientId);
      return {
        name: blockName,
        metadata: store.getBlockAttributes(clientId)?.metadata as
          | Record<string, unknown>
          | undefined,
        editable: store.getBlockEditingMode(clientId) === 'default' && !isRegionBlock(blockName),
      };
    },
    [clientId],
  );
  const info = useBlockDisplayInformation(clientId);
  const { updateBlockAttributes } = useDispatch(blockEditorStore) as unknown as Dispatch;
  const current = typeof metadata?.name === 'string' ? metadata.name : '';
  const [value, setValue] = useState(current);
  const fieldId = useId();
  useEffect(() => setValue(current), [current]);

  if (!editable || !name) return null;
  const typeTitle = (getBlockType(name)?.title as string | undefined) ?? '';
  const canRename = hasBlockSupport(name, 'renaming', true);

  const rename = (event: FormEvent | FocusEvent<HTMLInputElement>) => {
    event.preventDefault();
    const next = value.trim();
    if (next === current) return;
    const rest = { ...(metadata ?? {}) };
    if (next && next !== typeTitle) rest.name = next;
    else delete rest.name;
    updateBlockAttributes(clientId, { metadata: Object.keys(rest).length ? rest : undefined });
  };

  return (
    <section className={styles.selected} aria-label={__('Selected block', 'pressbase-admin')}>
      <p className={styles.selectedTitle}>{info?.title ?? typeTitle}</p>
      {canRename && (
        <form className={styles.rename} onSubmit={rename}>
          <label htmlFor={fieldId} className={styles.label}>
            {__('Name in Layers', 'pressbase-admin')}
          </label>
          <div className={styles.renameRow}>
            <input
              id={fieldId}
              className={styles.input}
              value={value}
              placeholder={typeTitle}
              onChange={(event) => setValue(event.target.value)}
              onBlur={rename}
            />
            <Button type="submit" size="sm" variant="secondary">
              {__('Rename', 'pressbase-admin')}
            </Button>
          </div>
        </form>
      )}
      <VisibilityChoice clientId={clientId} compact />
    </section>
  );
}
