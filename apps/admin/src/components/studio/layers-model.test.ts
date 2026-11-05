import { describe, expect, it } from 'vitest';
import { isRegionBlock, LAYER_MOVE_KEYS, layerTarget } from './layers-model';

const place = {
  rootClientId: 'group',
  siblings: ['a', 'b', 'c'],
  index: 1,
  parent: { rootClientId: 'content', index: 4 },
};
const children = (id: string) => ({ a: 2, b: 0, c: 1 })[id] ?? 0;

describe('moving a layer with the keyboard', () => {
  it('maps Alt and the arrow keys to moves', () => {
    expect(LAYER_MOVE_KEYS).toEqual({
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowRight: 'in',
      ArrowLeft: 'out',
    });
  });

  it('moves up and down among siblings', () => {
    expect(layerTarget('up', place, children)).toEqual({ rootClientId: 'group', index: 0 });
    expect(layerTarget('down', place, children)).toEqual({ rootClientId: 'group', index: 2 });
    expect(layerTarget('up', { ...place, index: 0 }, children)).toBeNull();
    expect(layerTarget('down', { ...place, index: 2 }, children)).toBeNull();
  });

  it('moves into the block above, at its end', () => {
    expect(layerTarget('in', place, children)).toEqual({ rootClientId: 'a', index: 2 });
    expect(layerTarget('in', { ...place, index: 0 }, children)).toBeNull();
  });

  it('moves out of the parent, just after it', () => {
    expect(layerTarget('out', place, children)).toEqual({ rootClientId: 'content', index: 5 });
    expect(layerTarget('out', { ...place, parent: undefined }, children)).toBeNull();
  });

  it('leaves the template’s regions alone', () => {
    expect(isRegionBlock('core/template-part')).toBe(true);
    expect(isRegionBlock('core/post-content')).toBe(true);
    expect(isRegionBlock('core/group')).toBe(false);
  });
});
