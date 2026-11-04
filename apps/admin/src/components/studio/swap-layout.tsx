'use client';

import { placeholderFor, type Slot, type UnusedValue } from '@pressbase/slots';
import { store as blockEditorStore } from '@wordpress/block-editor';
import { type Block as BlockInstance, parse, serialize } from '@wordpress/blocks';
import { useDispatch, useRegistry, useSelect } from '@wordpress/data';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useI18n } from '@/lib/i18n/context';
import type { Section } from './sections-model';
import { loadSectionLibrary, sectionLabel } from './sections-panel';
import styles from './studio.module.css';
import {
  personalName,
  type SectionLayouts,
  type SwapMemory,
  sectionLayouts,
  sectionName,
  swapLayout,
  swapSource,
  unusedText,
} from './swap-model';

/* ------------------------------------------------------------ memory */

/**
 * What each swapped section remembers (swap-model.ts `SwapMemory`), by
 * client ID. Undo brings back the earlier block, with its own ID and
 * memory, so the map only grows while the page is open.
 */
const memories = new Map<string, SwapMemory>();
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function remember(clientId: string, memory: SwapMemory) {
  memories.set(clientId, memory);
  version++;
  for (const listener of listeners) listener();
}

/* ------------------------------------------------------------ context */

/** What the canvas's own controls tell the editor (Swap layout, Elements). */
export interface CanvasEvents {
  /** Names the next History step ("Swapped layout of “Hero”"). */
  labelNext: (label: string) => void;
  /** After a swap: says which layout it is now, and what didn't fit. */
  onSwapped: (message: string, unused: number) => void;
}

const CanvasEventsContext = createContext<CanvasEvents | null>(null);

export function CanvasEventsProvider({
  value,
  children,
}: {
  value: CanvasEvents;
  children: ReactNode;
}) {
  return <CanvasEventsContext.Provider value={value}>{children}</CanvasEventsContext.Provider>;
}

export const useCanvasEvents = () => useContext(CanvasEventsContext);

/** The section library, once it has loaded (shared with the Sections panel). */
function useLibrary(): Section[] | null {
  const [sections, setSections] = useState<Section[] | null>(null);
  useEffect(() => {
    let live = true;
    loadSectionLibrary()
      .then((library) => live && setSections(library.sections))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return sections;
}

interface Selectors {
  getBlock: (clientId: string) => BlockInstance | null;
  getBlockName: (clientId: string) => string | null;
  getBlockAttributes: (clientId: string) => Record<string, unknown> | null;
}

export interface SwapState {
  /** Where the section is among its layouts; null when it has no others (or isn't from a pattern). */
  layouts: SectionLayouts<Section> | null;
  /** Content the current layout leaves out, kept so swapping back brings it again. */
  kept: UnusedValue[];
  /** Whether swapping can bring `kept` back (the section wasn't edited since). */
  restorable: boolean;
  /** What the section is called: its name in Layers, else its layout's title. */
  label: string;
  /** Changes to the next (1) or previous (-1) layout, or to one by name. */
  swap: (to: 1 | -1 | string) => void;
}

/**
 * Swap layout (#45) for one section: its layouts (‹ 2/5 ›) and the swap
 * itself. A swap replaces the section with the next pattern of its
 * category, holding the section's text, links and images
 * (`transferSlots()`), as one undo step named "Swapped layout of “Hero”".
 */
export function useSwapLayout(clientId: string | null): SwapState {
  const { __, sprintf, _n } = useI18n();
  const events = useCanvasEvents();
  const registry = useRegistry();
  const { replaceBlocks, selectBlock } = useDispatch(blockEditorStore) as unknown as {
    replaceBlocks: (
      clientIds: string | string[],
      blocks: BlockInstance[],
      indexToSelect?: number,
      initialPosition?: number | null,
    ) => void;
    selectBlock: (clientId: string, initialPosition?: number | null) => void;
  };
  const library = useLibrary();
  const block = useSelect(
    (select) =>
      clientId ? (select(blockEditorStore) as unknown as Selectors).getBlock(clientId) : null,
    [clientId],
  );
  const markup = useMemo(() => (block ? serialize([block]) : ''), [block]);
  const layouts = useMemo(
    () => (library && markup ? sectionLayouts(markup, library) : null),
    [library, markup],
  );
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  const memory = clientId ? memories.get(clientId) : undefined;
  const nameInLayers = markup ? sectionName(markup) : '';
  const label =
    (layouts ? personalName(markup, layouts.current) : nameInLayers) ||
    layouts?.current.title ||
    (clientId
      ? sectionLabel(registry.select(blockEditorStore) as unknown as Selectors, clientId)
      : '');
  const kept = memory?.kept ?? [];
  // Edited since the swap: what was left out can't come back by swapping, only by undo.
  const restorable = Boolean(memory && memory.produced === markup);

  const swap = (to: 1 | -1 | string) => {
    if (!clientId || !layouts || layouts.layouts.length < 2) return;
    const { layouts: list, index, current } = layouts;
    const target =
      typeof to === 'string'
        ? list.find((p) => p.name === to)
        : list[(index + to + list.length) % list.length];
    if (!target || target === current) return;
    const { from, carried } = swapSource(memories.get(clientId), markup, current);
    // A name the person gave the section stays; one that was only the old pattern's title goes.
    // Placeholders for what the section had nothing for, in the person's language.
    const placeholders: Record<string, string> = {
      title: __('[Add a heading]', 'pressbase-admin'),
      heading: __('[Add a heading]', 'pressbase-admin'),
      eyebrow: __('[Add a short label]', 'pressbase-admin'),
      body: __('[Add text]', 'pressbase-admin'),
      item: __('[Add an item]', 'pressbase-admin'),
      summary: __('[Add a question]', 'pressbase-admin'),
      citation: __('[Add a name]', 'pressbase-admin'),
      action: __('[Add a button label]', 'pressbase-admin'),
    };
    const swapped = swapLayout(from, target, {
      name: personalName(markup, current),
      placeholder: (slot: Slot) =>
        slot.placeholder || placeholders[slot.role] || placeholderFor(slot),
    });
    const blocks = parse(swapped.markup);
    const next = blocks[0];
    if (!next) return;
    const unused = [...swapped.unused, ...carried];
    events?.labelNext(sprintf(__('Swapped layout of “%s”', 'pressbase-admin'), label));
    registry.batch(() => {
      // Select the section first, so the new one is selected after, without moving focus.
      selectBlock(clientId, null);
      replaceBlocks(clientId, blocks, 0, null);
    });
    remember(next.clientId, { origin: from, produced: serialize([next]), kept: unused });
    const position = list.indexOf(target) + 1;
    let message: string = sprintf(
      __('Layout %1$d of %2$d: %3$s.', 'pressbase-admin'),
      position,
      list.length,
      target.title,
    );
    if (unused.length) {
      message += ` ${sprintf(
        _n(
          '%d piece of content doesn’t fit this layout. It’s kept: swap back to see it again.',
          '%d pieces of content don’t fit this layout. They’re kept: swap back to see them again.',
          unused.length,
          'pressbase-admin',
        ),
        unused.length,
      )}`;
    }
    events?.onSwapped(message, unused.length);
  };

  return {
    layouts: layouts && layouts.layouts.length > 1 ? layouts : null,
    kept,
    restorable,
    label,
    swap,
  };
}

/* ------------------------------------------------------------ controls */

/** ‹ 2/5 › : previous and next layout, and where the section is among them. */
export function SwapArrows({
  state,
  buttonClassName,
  counterClassName,
}: {
  state: SwapState;
  buttonClassName: string | undefined;
  counterClassName: string | undefined;
}) {
  const { __, sprintf } = useI18n();
  const { layouts } = state;
  if (!layouts) return null;
  const position = sprintf(
    __('Layout %1$d of %2$d', 'pressbase-admin'),
    layouts.index + 1,
    layouts.layouts.length,
  );
  return (
    <>
      <button
        type="button"
        className={buttonClassName}
        aria-label={sprintf(__('Previous layout (%s)', 'pressbase-admin'), position)}
        title={__('Previous layout', 'pressbase-admin')}
        data-swap="previous"
        onClick={() => state.swap(-1)}
      >
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
      <span className={counterClassName} aria-hidden="true" data-swap-position>
        {`${layouts.index + 1}/${layouts.layouts.length}`}
      </span>
      <button
        type="button"
        className={buttonClassName}
        aria-label={sprintf(__('Next layout (%s)', 'pressbase-admin'), position)}
        title={__('Next layout', 'pressbase-admin')}
        data-swap="next"
        onClick={() => state.swap(1)}
      >
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </>
  );
}

/**
 * In the inspector, for a selected section: Swap layout ‹ 2/5 ›, the
 * layout's name, and what it leaves out.
 */
export function SwapLayoutBox({ clientId }: { clientId: string }) {
  const { __, sprintf } = useI18n();
  const state = useSwapLayout(clientId);
  const { layouts, kept, restorable } = state;
  if (!layouts) return null;
  return (
    <section className={styles.swapBox} aria-labelledby={`swap-${clientId}`}>
      <div className={styles.swapRow}>
        <h3 id={`swap-${clientId}`} className={styles.swapTitle}>
          {__('Swap layout', 'pressbase-admin')}
        </h3>
        <div className={styles.swapArrows}>
          <SwapArrows
            state={state}
            buttonClassName={styles.sectionToolbarButton}
            counterClassName={styles.swapCounter}
          />
        </div>
      </div>
      <p className={styles.muted}>
        {sprintf(
          __('%s. Your text and images move with you.', 'pressbase-admin'),
          layouts.current.title,
        )}
      </p>
      {kept.length > 0 && (
        <div className={styles.swapKept}>
          <p>{__('Not shown in this layout, but kept:', 'pressbase-admin')}</p>
          <ul>
            {kept.map((item) => (
              <li key={item.path}>{unusedText(item) || __('(empty)', 'pressbase-admin')}</li>
            ))}
          </ul>
          <p className={styles.muted}>
            {restorable
              ? __(
                  'Swap to a layout with more room to show it again, or undo the swap.',
                  'pressbase-admin',
                )
              : __(
                  'You’ve edited the section since, so swapping won’t bring it back. Undo to get it, or copy it from here.',
                  'pressbase-admin',
                )}
          </p>
        </div>
      )}
    </section>
  );
}
