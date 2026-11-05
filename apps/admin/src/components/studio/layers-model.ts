/**
 * Layers (#50): moving a block with the keyboard. Alt and the arrow keys
 * on a row, as in the Pages panel: up and down among its siblings, right
 * into the block above it (as its last block), left out of its parent
 * (just after it). Pure, tested in layers-model.test.ts; the panel checks
 * the block editor's rules (locking, allowed blocks, editing modes) before
 * it moves anything.
 */

import { POST_CONTENT, TEMPLATE_PART } from './canvas-model';

export type LayerMove = 'up' | 'down' | 'in' | 'out';

export const LAYER_MOVE_KEYS: Readonly<Record<string, LayerMove>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowRight: 'in',
  ArrowLeft: 'out',
};

/** Where a block is: its parent (`''` at the top), its siblings in order, and its parent's place. */
export interface LayerPlace {
  rootClientId: string;
  siblings: readonly string[];
  index: number;
  /** The parent's own place; absent at the top of the tree. */
  parent?: { rootClientId: string; index: number };
}

/** Where a move puts the block: the parent and the index in it (after the block leaves its place). */
export interface LayerTarget {
  rootClientId: string;
  index: number;
}

/**
 * The target of a keyboard move, or null when there's nowhere to go (the
 * first block can't go up; a block with nothing above can't go in).
 * `childCount` says how many blocks a block holds.
 */
export function layerTarget(
  move: LayerMove,
  place: LayerPlace,
  childCount: (clientId: string) => number,
): LayerTarget | null {
  const { rootClientId, siblings, index } = place;
  switch (move) {
    case 'up':
      return index > 0 ? { rootClientId, index: index - 1 } : null;
    case 'down':
      return index < siblings.length - 1 ? { rootClientId, index: index + 1 } : null;
    case 'in': {
      const above = siblings[index - 1];
      return above === undefined ? null : { rootClientId: above, index: childCount(above) };
    }
    case 'out':
      return place.parent
        ? { rootClientId: place.parent.rootClientId, index: place.parent.index + 1 }
        : null;
  }
}

/**
 * The blocks Layers doesn't rename or hide: the template's regions. Their
 * attributes belong to the template, which Studio shows but doesn't save.
 */
export const isRegionBlock = (name: string | null | undefined) =>
  name === TEMPLATE_PART || name === POST_CONTENT;
