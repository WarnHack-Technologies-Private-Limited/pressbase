import { describe, expect, it, vi } from 'vitest';
import { BlockBridge, blockSettings, isPluginBlockName, type ServerBlockType } from './blocks';

const TIP: ServerBlockType = {
  name: 'daily-tips/tip',
  title: 'Daily tip',
  category: 'widgets',
  icon: 'lightbulb',
  attributes: { accent: { type: 'string', default: '#3858e9' } },
  supports: { align: true },
  uses_context: ['postType'],
  is_dynamic: true,
};
const Fallback = () => null;

describe('blockSettings()', () => {
  it('merges the server metadata with the module’s edit; a dynamic block saves nothing', () => {
    const edit = () => null;
    const settings = blockSettings(TIP, { edit, title: 'Tip of the day' }, Fallback);
    expect(settings).toMatchObject({
      apiVersion: 3,
      title: 'Tip of the day',
      category: 'widgets',
      icon: 'lightbulb',
      attributes: TIP.attributes,
      supports: { align: true, html: false },
      usesContext: ['postType', 'postId'],
      edit,
    });
    expect((settings?.save as () => unknown)()).toBeNull();
  });

  it('keeps the server’s attributes and context, whatever the module passes', () => {
    const settings = blockSettings(
      TIP,
      { edit: () => null, attributes: { other: { type: 'number' } }, usesContext: [] },
      Fallback,
    );
    expect(settings?.attributes).toBe(TIP.attributes);
    expect(settings?.usesContext).toEqual(['postType', 'postId']);
  });

  it('previews a dynamic block without a module, and skips a static block without one', () => {
    expect(blockSettings(TIP, undefined, Fallback)?.edit).toBe(Fallback);
    expect(blockSettings({ name: 'a/static' }, undefined, Fallback)).toBeNull();
    const save = () => 'html';
    const statik = blockSettings({ name: 'a/static' }, { edit: () => null, save }, Fallback);
    expect(statik?.save).toBe(save);
    expect(statik?.supports).toEqual({});
  });
});

describe('BlockBridge', () => {
  it('registers modules’ blocks with their server metadata once the editor connects', () => {
    const bridge = new BlockBridge();
    const edit = () => null;
    bridge.registerBlockType('daily-tips/tip', { edit }, 'daily-tips');
    const registrar = vi.fn(() => true);
    const added = bridge.connect(
      [TIP, { name: 'other/static' }, { name: 'other/dynamic', is_dynamic: true }],
      registrar,
      Fallback,
    );
    expect(added).toEqual(['daily-tips/tip', 'other/dynamic']);
    expect(registrar).toHaveBeenCalledWith('daily-tips/tip', expect.objectContaining({ edit }));
    expect(registrar).toHaveBeenCalledWith(
      'other/dynamic',
      expect.objectContaining({ edit: Fallback }),
    );

    // A module registering after the editor connected registers at once.
    const late = () => null;
    bridge.registerBlockType('other/dynamic', { edit: late }, 'other');
    expect(registrar).toHaveBeenLastCalledWith(
      'other/dynamic',
      expect.objectContaining({ edit: late }),
    );
  });

  it('refuses blocks outside the loading plugin’s namespace and bad settings', () => {
    const bridge = new BlockBridge();
    expect(() => bridge.registerBlockType('Tip', {}, null)).toThrow(/namespace\/name/);
    expect(() => bridge.registerBlockType('core/tip', {}, 'daily-tips')).toThrow(
      /only register blocks named "daily-tips\/…"/,
    );
    expect(() =>
      bridge.registerBlockType('daily-tips/tip', { edit: 'x' }, 'daily-tips'),
    ).toThrow(/`edit` must be a function/);
  });

  it('contains a registration Gutenberg rejects', () => {
    const bridge = new BlockBridge();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      bridge.connect(
        [TIP],
        () => {
          throw new Error('bad');
        },
        Fallback,
      ),
    ).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('gives the editor’s pieces only once provided', () => {
    const bridge = new BlockBridge();
    expect(() => bridge.impl('RichText')).toThrow(/only available in the block editor/);
    const RichText = () => null;
    bridge.provide({ RichText });
    expect(bridge.impl('RichText')).toBe(RichText);
  });
});

describe('isPluginBlockName()', () => {
  it('is true for blocks outside core', () => {
    expect(isPluginBlockName('daily-tips/tip')).toBe(true);
    expect(isPluginBlockName('core/paragraph')).toBe(false);
    expect(isPluginBlockName(undefined)).toBe(false);
  });
});
