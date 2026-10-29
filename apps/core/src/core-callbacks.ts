import type { HookBus } from '@pressbase/hooks';

/**
 * Core's hook callbacks that carry WordPress's function names, so a plugin
 * can remove them by name the way WordPress plugins do:
 *
 *   remove_action( 'wp_head', 'rel_canonical' );          // WordPress
 *   api.hooks.removeAction('wp_head', 'rel_canonical');   // Pressbase
 *
 * In PHP a callback *is* its name; here core's callbacks are closures, so
 * this registry gives them names. Removing one switches it off in place
 * rather than detaching it, so restoring it (when the plugin that removed
 * it is deactivated) keeps its original position among same-priority
 * callbacks. A removed filter passes its value through unchanged.
 */

// biome-ignore lint/suspicious/noExplicitAny: callbacks of any shape.
type AnyCallback = (...args: any[]) => unknown;

interface Entry {
  hook: string;
  name: string;
  priority: number;
  filter: boolean;
  /** Who removed it; it runs again once every remover has restored it. */
  removedBy: Set<symbol>;
}

export class CoreCallbacks {
  #entries = new Map<string, Entry>();

  #id(hook: string, name: string) {
    return `${hook}\u0000${name}`;
  }

  /** add_action() for a named core callback. */
  addAction(
    hooks: HookBus,
    hook: string,
    name: string,
    callback: AnyCallback,
    priority = 10,
  ): () => void {
    return this.#add(hooks, hook, name, callback, priority, false);
  }

  /** add_filter() for a named core callback. */
  addFilter(
    hooks: HookBus,
    hook: string,
    name: string,
    callback: AnyCallback,
    priority = 10,
  ): () => void {
    return this.#add(hooks, hook, name, callback, priority, true);
  }

  #add(
    hooks: HookBus,
    hook: string,
    name: string,
    callback: AnyCallback,
    priority: number,
    filter: boolean,
  ): () => void {
    const id = this.#id(hook, name);
    if (this.#entries.has(id)) throw new Error(`Core callback ${name} is already on ${hook}.`);
    const entry: Entry = { hook, name, priority, filter, removedBy: new Set() };
    this.#entries.set(id, entry);
    const off = hooks.addFilter(
      hook,
      ((...args: unknown[]) => {
        if (entry.removedBy.size) return filter ? args[0] : undefined;
        return callback(...args);
      }) as never,
      priority,
    );
    return () => {
      off();
      this.#entries.delete(id);
    };
  }

  /** has_action( $hook, 'name' ): the callback's priority while it runs, or false. */
  has(hook: string, name: string): number | false {
    const entry = this.#entries.get(this.#id(hook, name));
    return entry && entry.removedBy.size === 0 ? entry.priority : false;
  }

  /**
   * remove_action( $hook, 'name' [, $priority] ). Returns a function that
   * restores it, or undefined when no such callback runs (wrong name or
   * priority, or already removed by the same owner).
   */
  remove(hook: string, name: string, priority?: number, owner = Symbol(name)) {
    const entry = this.#entries.get(this.#id(hook, name));
    if (!entry || (priority !== undefined && entry.priority !== priority)) return undefined;
    if (entry.removedBy.has(owner)) return undefined;
    entry.removedBy.add(owner);
    return () => {
      entry.removedBy.delete(owner);
    };
  }

  /** The named callbacks on a hook, in no particular order (for docs and debugging). */
  list(hook?: string): { hook: string; name: string; priority: number; removed: boolean }[] {
    return [...this.#entries.values()]
      .filter((e) => !hook || e.hook === hook)
      .map((e) => ({
        hook: e.hook,
        name: e.name,
        priority: e.priority,
        removed: e.removedBy.size > 0,
      }));
  }
}
