import { describe, expect, it, vi } from 'vitest';
import { HookBus } from './index';

describe('filters', () => {
  it('returns the value unchanged when nothing is attached', async () => {
    const hooks = new HookBus();
    expect(await hooks.applyFilters('the_title', 'Hello')).toBe('Hello');
  });

  it('runs callbacks by priority, then insertion order', async () => {
    const hooks = new HookBus();
    hooks.addFilter('t', (v) => `${v}b`, 20);
    hooks.addFilter('t', (v) => `${v}a1`);
    hooks.addFilter('t', (v) => `${v}a2`);
    hooks.addFilter('t', (v) => `${v}0`, 5);
    expect(await hooks.applyFilters('t', '')).toBe('0a1a2b');
  });

  it('passes extra arguments to every callback', async () => {
    const hooks = new HookBus();
    const seen: unknown[] = [];
    hooks.addFilter('t', (v, id) => {
      seen.push(id);
      return v;
    });
    await hooks.applyFilters('t', 'x', 42);
    expect(seen).toEqual([42]);
  });

  it('awaits async callbacks in order', async () => {
    const hooks = new HookBus();
    hooks.addFilter('t', async (v) => {
      await Promise.resolve();
      return `${v}1`;
    });
    hooks.addFilter('t', (v) => `${v}2`);
    expect(await hooks.applyFilters('t', '')).toBe('12');
  });

  it('applyFiltersSync rejects async callbacks with a clear error', () => {
    const hooks = new HookBus();
    hooks.addFilter('t', async (v) => v);
    expect(() => hooks.applyFiltersSync('t', 1)).toThrow(/synchronously/);
  });

  it('removes callbacks by reference, by priority, and through the returned unsubscribe', async () => {
    const hooks = new HookBus();
    const upper = (v: unknown) => String(v).toUpperCase();
    hooks.addFilter('t', upper, 10);
    hooks.addFilter('t', upper, 20);
    expect(hooks.removeFilter('t', upper, 20)).toBe(true);
    expect(hooks.hasFilter('t', upper)).toBe(true);
    expect(hooks.removeFilter('t', upper)).toBe(true);
    expect(hooks.hasFilter('t')).toBe(false);

    const off = hooks.addFilter('t', (v) => `${v}!`);
    off();
    expect(await hooks.applyFilters('t', 'a')).toBe('a');
  });

  it('removeAllFilters can target a single priority', () => {
    const hooks = new HookBus();
    hooks.addFilter('t', (v) => v, 5);
    hooks.addFilter('t', (v) => v, 10);
    hooks.removeAllFilters('t', 5);
    expect(hooks.hasFilter('t')).toBe(true);
    hooks.removeAllFilters('t');
    expect(hooks.hasFilter('t')).toBe(false);
  });

  it('uses a snapshot: callbacks added during a run apply from the next run', async () => {
    const hooks = new HookBus();
    hooks.addFilter('t', (v) => {
      hooks.addFilter('t', (w) => `${w}late`);
      return `${v}first`;
    });
    expect(await hooks.applyFilters('t', '')).toBe('first');
  });

  it('rejects non-finite priorities', () => {
    const hooks = new HookBus();
    expect(() => hooks.addFilter('t', (v) => v, Number.NaN)).toThrow(RangeError);
  });
});

describe('actions', () => {
  it('calls every callback with the arguments and counts runs', async () => {
    const hooks = new HookBus();
    const a = vi.fn();
    const b = vi.fn();
    hooks.addAction('save_post', a);
    hooks.addAction('save_post', b, 1);
    await hooks.doAction('save_post', 7, { draft: true });
    expect(b).toHaveBeenCalledBefore(a);
    expect(a).toHaveBeenCalledWith(7, { draft: true });
    expect(hooks.didAction('save_post')).toBe(1);
    expect(hooks.didAction('never')).toBe(0);
  });

  it('counts an action even when nothing is attached', async () => {
    const hooks = new HookBus();
    await hooks.doAction('init');
    hooks.doActionSync('init');
    expect(hooks.didAction('init')).toBe(2);
  });

  it('propagates errors from callbacks', async () => {
    const hooks = new HookBus();
    hooks.addAction('boom', () => {
      throw new Error('nope');
    });
    await expect(hooks.doAction('boom')).rejects.toThrow('nope');
  });
});
