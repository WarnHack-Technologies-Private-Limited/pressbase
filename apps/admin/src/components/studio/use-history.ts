'use client';

import { useCallback, useRef, useState } from 'react';
import {
  type HistoryEntry,
  type HistoryState,
  historyGo,
  historyInit,
  historyRecord,
} from './history-model';

/** How long a name given before a step waits for that step (a click, then the store's change). */
const LABEL_WAIT = 1000;

export interface StudioHistory<T> {
  value: T;
  /** As @wordpress/compose's useStateWithHistory: a staged change joins the current step. */
  setValue: (value: T, isStaged?: boolean) => void;
  undo: () => void;
  redo: () => void;
  hasUndo: boolean;
  hasRedo: boolean;
  /** Every point, the opening first; `index` is where the canvas is now. */
  entries: readonly HistoryEntry<T>[];
  index: number;
  /** Steps back (or forward) to a point: History's click (#34). */
  go: (index: number) => void;
  /** Names the next step ("Added section “Pricing”"), instead of working it out. */
  labelNext: (label: string) => void;
}

/**
 * Studio's undo history (#34): useStateWithHistory with the steps kept as
 * a list (history-model.ts), so the History panel can show them and jump
 * to any of them.
 */
export function useStudioHistory<T>(initial: T): StudioHistory<T> {
  const [state, setState] = useState<HistoryState<T>>(() => historyInit(initial));
  const pending = useRef<{ label: string; until: number } | null>(null);

  const setValue = useCallback((value: T, isStaged = false) => {
    let label: string | undefined;
    if (!isStaged && pending.current) {
      if (pending.current.until >= Date.now()) label = pending.current.label;
      pending.current = null;
    }
    setState((current) => historyRecord(current, value, { staged: isStaged, label }));
  }, []);
  const go = useCallback((index: number) => setState((current) => historyGo(current, index)), []);
  const undo = useCallback(() => setState((current) => historyGo(current, current.index - 1)), []);
  const redo = useCallback(() => setState((current) => historyGo(current, current.index + 1)), []);
  const labelNext = useCallback((label: string) => {
    pending.current = { label, until: Date.now() + LABEL_WAIT };
  }, []);

  return {
    value: (state.entries[state.index] as HistoryEntry<T>).value,
    setValue,
    undo,
    redo,
    hasUndo: state.index > 0,
    hasRedo: state.index < state.entries.length - 1,
    entries: state.entries,
    index: state.index,
    go,
    labelNext,
  };
}
