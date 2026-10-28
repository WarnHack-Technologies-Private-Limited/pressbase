import { describe, expect, it, vi } from 'vitest';
import { ExtensionStore, pageSlot } from './registry';

const render = () => null;

describe('ExtensionStore', () => {
  it('attributes registrations to the module being loaded, one module at a time', async () => {
    const store = new ExtensionStore();
    store.setPlugins([
      { plugin: 'daily-tips', title: 'Daily Tips' },
      { plugin: 'reports', title: 'Reports' },
    ]);
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = store.load('daily-tips', '/a.js', async () => {
      await slow;
      store.registerPlugin('tips-widget', { render });
      return {};
    });
    const second = store.load('reports', '/b.js', async () => {
      store.registerPlugin('charts', { render });
      return {};
    });
    release();
    await Promise.all([first, second]);
    expect(store.plugins().map((p) => [p.name, p.owner])).toEqual([
      ['tips-widget', 'daily-tips'],
      ['charts', 'reports'],
    ]);
    expect(store.isImported('/a.js')).toBe(true);
    // Outside a load, the name decides.
    expect(store.registerPlugin('reports-extra', { render }).owner).toBe('reports');
    expect(store.registerPlugin('stranger', { render }).owner).toBeNull();
  });

  it('hides plugins and fills of owners that are no longer active', () => {
    const store = new ExtensionStore();
    store.setPlugins([{ plugin: 'daily-tips', title: 'Daily Tips' }]);
    store.registerPlugin('daily-tips', { render });
    const id = store.addFill('dashboard', 'daily-tips', { title: 'Tip' }, 'content');
    expect(store.plugins()).toHaveLength(1);
    expect(store.fills('dashboard')).toHaveLength(1);

    store.setPlugins([]);
    expect(store.plugins()).toHaveLength(0);
    expect(store.fills('dashboard')).toHaveLength(0);

    // Reactivated: the module isn't imported again, its registrations come back.
    store.setPlugins([{ plugin: 'daily-tips', title: 'Daily Tips' }]);
    expect(store.fills('dashboard')).toHaveLength(1);
    store.removeFill(id);
    expect(store.fills('dashboard')).toHaveLength(0);
  });

  it('orders fills and keeps snapshots stable until something changes', () => {
    const store = new ExtensionStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const late = store.addFill('dashboard', null, { order: 20 }, 'late');
    store.addFill('dashboard', null, {}, 'default');
    store.addFill('dashboard', null, { order: 1 }, 'early');
    store.addFill(pageSlot('reports', 'stats'), null, {}, 'elsewhere');
    const snapshot = store.fills('dashboard');
    expect(snapshot.map((f) => f.children)).toEqual(['early', 'default', 'late']);
    expect(store.fills('dashboard')).toBe(snapshot);
    store.updateFill(late, { order: 0 }, 'now first');
    expect(store.fills('dashboard')).not.toBe(snapshot);
    expect(store.fills('dashboard')[0]?.children).toBe('now first');
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it('validates registerPlugin like @wordpress/plugins', () => {
    const store = new ExtensionStore();
    expect(() => store.registerPlugin('Bad Name', { render })).toThrow(/lowercase/);
    expect(() => store.registerPlugin('ok', {} as never)).toThrow(/render function/);
    store.registerPlugin('ok', { render });
    expect(store.unregisterPlugin('ok')?.name).toBe('ok');
    expect(store.plugins()).toEqual([]);
  });

  it('records a module that fails to load, naming the plugin, and clears it on success', async () => {
    const store = new ExtensionStore();
    store.setPlugins([{ plugin: 'daily-tips', title: 'Daily Tips' }]);
    await expect(
      store.load('daily-tips', '/broken.js', () => Promise.reject(new Error('404'))),
    ).rejects.toThrow('404');
    expect(store.errors()).toEqual([
      { owner: 'daily-tips', title: 'Daily Tips', message: 'Its admin script couldn’t load: 404' },
    ]);
    expect(store.isImported('/broken.js')).toBe(false);
    await store.load('daily-tips', '/fixed.js', async () => ({}));
    expect(store.errors()).toEqual([]);
    expect(store.title(null)).toBe('A plugin');
  });
});
