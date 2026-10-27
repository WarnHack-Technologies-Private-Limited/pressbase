/**
 * Actions and filters — Pressbase's equivalent of WordPress's WP_Hook / plugin.php.
 *
 * A *filter* passes a value through every callback and returns the result.
 * An *action* calls every callback for its side effects and returns nothing.
 * Callbacks run in ascending priority order (default 10); callbacks with the
 * same priority run in the order they were added.
 *
 * Differences from WordPress, on purpose:
 * - Callbacks may be async. `applyFilters` / `doAction` await each one in turn.
 *   Use the `*Sync` variants where a hook must stay synchronous.
 * - `addFilter` returns an unsubscribe function, so closures can be removed.
 * - There is no `accepted_args`; JavaScript callbacks ignore extra arguments.
 * - Each run iterates over a snapshot: callbacks added or removed while a hook
 *   is running take effect from the next run.
 *
 * Hook names can be typed by plugins through declaration merging:
 *
 *   declare module '@pressbase/hooks' {
 *     interface FilterRegistry { the_title: [title: string, postId: number] }
 *     interface ActionRegistry { save_post: [postId: number] }
 *   }
 */

// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging.
export interface FilterRegistry {}
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging.
export interface ActionRegistry {}

type AnyArgs = [unknown, ...unknown[]];

export type FilterArgs<K extends string> = K extends keyof FilterRegistry
  ? FilterRegistry[K] extends AnyArgs
    ? FilterRegistry[K]
    : AnyArgs
  : AnyArgs;

export type ActionArgs<K extends string> = K extends keyof ActionRegistry
  ? ActionRegistry[K] extends unknown[]
    ? ActionRegistry[K]
    : unknown[]
  : unknown[];

export type FilterCallback<K extends string> = (
  ...args: FilterArgs<K>
) => FilterArgs<K>[0] | Promise<FilterArgs<K>[0]>;

export type ActionCallback<K extends string> = (...args: ActionArgs<K>) => unknown;

export const DEFAULT_PRIORITY = 10;

// biome-ignore lint/suspicious/noExplicitAny: storage is untyped; the public API is typed.
type StoredCallback = (...args: any[]) => unknown;

interface Entry {
  callback: StoredCallback;
  priority: number;
  /** Insertion order, used to keep same-priority callbacks stable. */
  seq: number;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export class HookBus {
  #hooks = new Map<string, Entry[]>();
  #actionCounts = new Map<string, number>();
  #seq = 0;

  /* ---------------------------------------------------------------- filters */

  addFilter<K extends string>(
    name: K,
    callback: FilterCallback<K>,
    priority = DEFAULT_PRIORITY,
  ): () => void {
    return this.#add(name, callback as StoredCallback, priority);
  }

  /** Removes a callback. Without `priority`, removes it at every priority. */
  removeFilter(name: string, callback: StoredCallback, priority?: number): boolean {
    const entries = this.#hooks.get(name);
    if (!entries) return false;
    const kept = entries.filter(
      (e) => !(e.callback === callback && (priority === undefined || e.priority === priority)),
    );
    if (kept.length === entries.length) return false;
    if (kept.length === 0) this.#hooks.delete(name);
    else this.#hooks.set(name, kept);
    return true;
  }

  removeAllFilters(name: string, priority?: number): void {
    if (priority === undefined) {
      this.#hooks.delete(name);
      return;
    }
    const kept = this.#hooks.get(name)?.filter((e) => e.priority !== priority) ?? [];
    if (kept.length === 0) this.#hooks.delete(name);
    else this.#hooks.set(name, kept);
  }

  /** With a callback, reports whether that callback is attached; otherwise whether any is. */
  hasFilter(name: string, callback?: StoredCallback): boolean {
    const entries = this.#hooks.get(name);
    if (!entries) return false;
    return callback ? entries.some((e) => e.callback === callback) : entries.length > 0;
  }

  async applyFilters<K extends string>(name: K, ...args: FilterArgs<K>): Promise<FilterArgs<K>[0]> {
    const [initial, ...rest] = args;
    let value: unknown = initial;
    for (const entry of this.#snapshot(name)) {
      value = await entry.callback(value, ...rest);
    }
    return value as FilterArgs<K>[0];
  }

  /** Synchronous variant. Throws if a callback returns a promise. */
  applyFiltersSync<K extends string>(name: K, ...args: FilterArgs<K>): FilterArgs<K>[0] {
    const [initial, ...rest] = args;
    let value: unknown = initial;
    for (const entry of this.#snapshot(name)) {
      value = entry.callback(value, ...rest);
      if (isThenable(value)) {
        throw new TypeError(
          `Filter "${name}" is applied synchronously, but a callback returned a promise.`,
        );
      }
    }
    return value as FilterArgs<K>[0];
  }

  /* ---------------------------------------------------------------- actions */

  addAction<K extends string>(
    name: K,
    callback: ActionCallback<K>,
    priority = DEFAULT_PRIORITY,
  ): () => void {
    return this.#add(name, callback as StoredCallback, priority);
  }

  removeAction(name: string, callback: StoredCallback, priority?: number): boolean {
    return this.removeFilter(name, callback, priority);
  }

  removeAllActions(name: string, priority?: number): void {
    this.removeAllFilters(name, priority);
  }

  hasAction(name: string, callback?: StoredCallback): boolean {
    return this.hasFilter(name, callback);
  }

  async doAction<K extends string>(name: K, ...args: ActionArgs<K>): Promise<void> {
    this.#countAction(name);
    for (const entry of this.#snapshot(name)) {
      await entry.callback(...args);
    }
  }

  /** Synchronous variant. Throws if a callback returns a promise. */
  doActionSync<K extends string>(name: K, ...args: ActionArgs<K>): void {
    this.#countAction(name);
    for (const entry of this.#snapshot(name)) {
      if (isThenable(entry.callback(...args))) {
        throw new TypeError(
          `Action "${name}" is run synchronously, but a callback returned a promise.`,
        );
      }
    }
  }

  /** How many times an action has fired, like WordPress's did_action(). */
  didAction(name: string): number {
    return this.#actionCounts.get(name) ?? 0;
  }

  /* --------------------------------------------------------------- internal */

  #add(name: string, callback: StoredCallback, priority: number): () => void {
    if (!Number.isFinite(priority)) {
      throw new RangeError(`Hook priority must be a finite number, got ${priority}.`);
    }
    const entries = this.#hooks.get(name) ?? [];
    entries.push({ callback, priority, seq: this.#seq++ });
    entries.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    this.#hooks.set(name, entries);
    return () => {
      this.removeFilter(name, callback, priority);
    };
  }

  #snapshot(name: string): readonly Entry[] {
    return this.#hooks.get(name)?.slice() ?? [];
  }

  #countAction(name: string): void {
    this.#actionCounts.set(name, this.didAction(name) + 1);
  }
}
