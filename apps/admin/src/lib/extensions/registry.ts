/**
 * The admin's extension registry: plugins registered by browser modules
 * (`registerPlugin`, as in @wordpress/plugins) and the fills they render into
 * named slots (as @wordpress/components' SlotFill). Framework-free so it can
 * be tested; the React side is components/extensions/host.tsx.
 *
 * Every registration is attributed to the Pressbase plugin ("owner") whose
 * module registered it: modules are imported one at a time and the owner is
 * whatever was loading. Owners that are no longer active are hidden, so a
 * deactivated plugin's fills disappear without a reload (a module can't be
 * unloaded; reactivating shows it again). See docs/architecture/plugins.md#ui-modules.
 */

/** Slot names the admin renders. */
export const SLOTS = {
  /** Dashboard widgets. Fill props: `title`, `size` ("small" | "large"). */
  dashboard: 'dashboard',
  /** Panels in the post editor's Post tab. Fill props: `title`. Fill gets { postId, postType }. */
  editorDocumentSettings: 'editor.document-settings',
} as const;

/** The body of a plugin's admin page: `plugin-page/{plugin}/{page}`. */
export function pageSlot(plugin: string, page: string): string {
  return `plugin-page/${plugin}/${page}`;
}

// biome-ignore lint/suspicious/noExplicitAny: components of any props.
type Component = (props: any) => unknown;

export interface PluginSettings {
  /** A React component; it renders Fills. */
  render: Component;
  /** Accepted for @wordpress/plugins compatibility; not shown yet. */
  icon?: unknown;
}

export interface RegisteredPlugin {
  name: string;
  /** The Pressbase plugin whose module registered it, if known. */
  owner: string | null;
  render: Component;
}

export interface FillEntry {
  id: number;
  slot: string;
  owner: string | null;
  /** Props given to <Fill> other than name and children (title, size, order…). */
  props: Record<string, unknown>;
  children: unknown;
}

const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

export class ExtensionStore {
  #plugins = new Map<string, RegisteredPlugin>();
  #fills = new Map<number, FillEntry>();
  #active: Set<string> | null = null;
  #titles = new Map<string, string>();
  #errors = new Map<string, string>();
  #loading: string | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #imported = new Set<string>();
  #listeners = new Set<() => void>();
  #nextId = 1;
  #cache = new Map<string, unknown>();

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #emit() {
    this.#cache.clear();
    for (const listener of [...this.#listeners]) listener();
  }

  /** Stable snapshots for useSyncExternalStore: the same array until something changes. */
  #cached<T>(key: string, compute: () => T): T {
    if (!this.#cache.has(key)) this.#cache.set(key, compute());
    return this.#cache.get(key) as T;
  }

  #visible(owner: string | null): boolean {
    return owner === null || this.#active === null || this.#active.has(owner);
  }

  /** The active plugins and their titles, from /pressbase/v1/admin-extensions. */
  setPlugins(plugins: { plugin: string; title: string }[]) {
    this.#active = new Set(plugins.map((p) => p.plugin));
    for (const p of plugins) this.#titles.set(p.plugin, p.title);
    this.#emit();
  }

  title(owner: string | null): string {
    return (owner && this.#titles.get(owner)) || owner || 'A plugin';
  }

  /** The Pressbase plugin a registration belongs to: the loading module's, or by name. */
  ownerFor(name: string): string | null {
    if (this.#loading) return this.#loading;
    for (const owner of this.#titles.keys()) {
      if (name === owner || name.startsWith(`${owner}-`) || name.startsWith(`${owner}/`))
        return owner;
    }
    return null;
  }

  registerPlugin(name: string, settings: PluginSettings): RegisteredPlugin {
    if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) {
      throw new Error(
        'Plugin names must start with a lowercase letter and use lowercase letters, numbers and dashes.',
      );
    }
    if (!settings || typeof settings.render !== 'function') {
      throw new Error(`The "${name}" plugin needs a render function.`);
    }
    const plugin = { name, owner: this.ownerFor(name), render: settings.render };
    this.#plugins.set(name, plugin);
    this.#emit();
    return plugin;
  }

  unregisterPlugin(name: string): RegisteredPlugin | undefined {
    const plugin = this.#plugins.get(name);
    if (plugin) {
      this.#plugins.delete(name);
      this.#emit();
    }
    return plugin;
  }

  /** Registered plugins of active owners, in registration order. */
  plugins(): RegisteredPlugin[] {
    return this.#cached('plugins', () =>
      [...this.#plugins.values()].filter((p) => this.#visible(p.owner)),
    );
  }

  addFill(slot: string, owner: string | null, props: Record<string, unknown>, children: unknown) {
    const id = this.#nextId++;
    this.#fills.set(id, { id, slot, owner, props, children });
    this.#emit();
    return id;
  }

  updateFill(id: number, props: Record<string, unknown>, children: unknown) {
    const fill = this.#fills.get(id);
    if (!fill) return;
    this.#fills.set(id, { ...fill, props, children });
    this.#emit();
  }

  removeFill(id: number) {
    if (this.#fills.delete(id)) this.#emit();
  }

  /** A slot's fills from active owners, by their `order` prop (default 10), then age. */
  fills(slot: string): FillEntry[] {
    return this.#cached(`fills:${slot}`, () =>
      [...this.#fills.values()]
        .filter((f) => f.slot === slot && this.#visible(f.owner))
        .sort((a, b) => order(a) - order(b) || a.id - b.id),
    );
  }

  setError(owner: string | null, message: string) {
    this.#errors.set(owner ?? '', message);
    this.#emit();
  }

  clearError(owner: string | null) {
    if (this.#errors.delete(owner ?? '')) this.#emit();
  }

  /** Problems loading or running modules, by owner, for active owners. */
  errors(): { owner: string | null; title: string; message: string }[] {
    return this.#cached('errors', () =>
      [...this.#errors.entries()]
        .map(([owner, message]) => ({ owner: owner || null, title: this.title(owner), message }))
        .filter((e) => this.#visible(e.owner)),
    );
  }

  /**
   * Imports a module once, one at a time, with `owner` as the loading plugin
   * so its registrations are attributed. A failure is recorded and rethrown.
   */
  load<T>(owner: string, url: string, importer: (url: string) => Promise<T>): Promise<T> {
    const run = async () => {
      this.#loading = owner;
      try {
        const module = await importer(url);
        this.#imported.add(url);
        this.clearError(owner);
        return module;
      } catch (error) {
        this.setError(
          owner,
          `Its admin script couldn’t load: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      } finally {
        this.#loading = null;
      }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  isImported(url: string): boolean {
    return this.#imported.has(url);
  }
}

function order(fill: FillEntry): number {
  const value = fill.props.order;
  return typeof value === 'number' && Number.isFinite(value) ? value : 10;
}
