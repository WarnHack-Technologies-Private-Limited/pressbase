import { type Database, schema } from '@pressbase/db';
import type { HookBus } from '@pressbase/hooks';
import { eq } from 'drizzle-orm';

/**
 * The Options API — get_option() / update_option() / delete_option().
 *
 * Autoloaded options are read in one query on boot and served from memory.
 * The cache is per process; multi-process invalidation (LISTEN/NOTIFY) is on
 * the roadmap, so run a single core process per site for now.
 *
 * Hooks:
 * - filter `option_{name}` (value, name) — runs on every read.
 * - action `updated_option` (name, oldValue, newValue) — after a write.
 * - action `deleted_option` (name) — after a delete.
 */
export class Options {
  #cache = new Map<string, unknown>();
  #loaded = false;

  constructor(
    private readonly db: Database,
    private readonly hooks: HookBus,
  ) {}

  async load(): Promise<void> {
    const rows = await this.db
      .select({ name: schema.options.name, value: schema.options.value })
      .from(schema.options)
      .where(eq(schema.options.autoload, true));
    this.#cache = new Map(rows.map((r) => [r.name, r.value]));
    this.#loaded = true;
  }

  async get<T = unknown>(name: string, fallback?: T): Promise<T> {
    if (!this.#loaded) await this.load();
    let value: unknown;
    if (this.#cache.has(name)) {
      value = this.#cache.get(name);
    } else {
      const [row] = await this.db
        .select({ value: schema.options.value })
        .from(schema.options)
        .where(eq(schema.options.name, name));
      value = row?.value;
      if (row) this.#cache.set(name, value);
    }
    if (value === undefined) return fallback as T;
    return (await this.hooks.applyFilters(`option_${name}`, value, name)) as T;
  }

  async set(name: string, value: unknown, options: { autoload?: boolean } = {}): Promise<void> {
    const old = await this.get(name);
    const autoload = options.autoload ?? true;
    await this.db
      .insert(schema.options)
      .values({ name, value, autoload })
      .onConflictDoUpdate({
        target: schema.options.name,
        set: options.autoload === undefined ? { value } : { value, autoload },
      });
    this.#cache.set(name, value);
    await this.hooks.doAction('updated_option', name, old, value);
  }

  async delete(name: string): Promise<void> {
    await this.db.delete(schema.options).where(eq(schema.options.name, name));
    this.#cache.delete(name);
    await this.hooks.doAction('deleted_option', name);
  }
}
