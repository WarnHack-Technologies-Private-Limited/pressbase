import {
  type AttributeSchema,
  sanitizeValueFromSchema,
  validateValueFromSchema,
} from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Kernel } from '../kernel';

/**
 * Registered metadata: a port of register_meta(), register_post_meta(),
 * register_term_meta(), is_protected_meta(), sanitize_meta(),
 * get_registered_meta_keys() and the metadata API (get_metadata(),
 * add_metadata(), update_metadata(), delete_metadata()) from
 * wordpress/wp-includes/meta.php, post.php and taxonomy.php.
 *
 * Meta lives in `postmeta`, `termmeta`, `usermeta` and `commentmeta` (one
 * row per value, JSON values). Registering a key describes it: its type,
 * whether it holds one value or a list, a default, a schema, and whether the
 * REST API shows it under `meta` (routes/meta-fields.ts, WordPress's
 * WP_REST_Meta_Fields). As in WordPress, the sanitize and auth callbacks
 * become filters:
 *
 * - `sanitize_{type}_meta_{key}` (or `…_for_{subtype}`): value, key, type[, subtype]
 * - `auth_{type}_meta_{key}` (or `…_for_{subtype}`): allowed, key, objectId,
 *   userId, cap, caps. Read by map_meta_cap() for `edit_post_meta` & co.
 *   (auth/meta-caps.ts). Without a callback, a protected key (one starting
 *   with `_`) can't be edited through the REST API.
 *
 * Writes fire `added_{type}_meta`, `updated_{type}_meta` and
 * `deleted_{type}_meta`, which the page cache listens to.
 */

export type MetaObjectType = 'post' | 'term' | 'user' | 'comment';
export type MetaValueType = 'string' | 'boolean' | 'integer' | 'number' | 'array' | 'object';

const OBJECT_TYPES = new Set<MetaObjectType>(['post', 'term', 'user', 'comment']);
const VALUE_TYPES = new Set<MetaValueType>([
  'string',
  'boolean',
  'integer',
  'number',
  'array',
  'object',
]);

/** `show_in_rest` as an array: a different field name, a schema, a prepare callback. */
export interface MetaRestArgs {
  /** The name under `meta` (default: the meta key). */
  name?: string;
  /** JSON schema merged over the one built from `type`, `default`, `label`, `description`. */
  schema?: AttributeSchema;
  /** Turns a stored value into the response value (default: validate and coerce to the schema). */
  prepareCallback?: (value: unknown, field: RestMetaField) => unknown;
}

export interface RegisterMetaArgs {
  /** The post type or taxonomy; empty registers the key for every one. */
  objectSubtype?: string;
  /** Default `string`. */
  type?: MetaValueType;
  label?: string;
  description?: string;
  /** One value per object (true), or a list of values (default false). */
  single?: boolean;
  /** Returned while nothing is stored. Must match the type. */
  default?: unknown;
  /** `sanitize_callback`: runs on every write (sanitize_meta()). */
  sanitizeCallback?: (
    value: unknown,
    metaKey: string,
    objectType: string,
    objectSubtype?: string,
  ) => unknown;
  /**
   * `auth_callback`: may the user add, edit or delete this key on this object?
   * Called only when the user can already edit the object (`edit_post`,
   * `edit_term`…). Default: allowed for unprotected keys, refused for keys
   * starting with `_`.
   */
  authCallback?: (
    allowed: boolean,
    metaKey: string,
    objectId: number,
    userId: number,
    cap: string,
    caps: string[],
  ) => boolean | Promise<boolean>;
  /** Show the key under `meta` in the REST API (readable and writable). */
  showInRest?: boolean | MetaRestArgs;
}

export interface RegisteredMeta {
  key: string;
  objectType: MetaObjectType;
  objectSubtype: string;
  type: MetaValueType;
  label: string;
  description: string;
  single: boolean;
  default: unknown;
  hasDefault: boolean;
  showInRest: false | MetaRestArgs;
}

/** A REST field built from a registered key (WP_REST_Meta_Fields::get_registered_fields()). */
export interface RestMetaField {
  key: string;
  name: string;
  single: boolean;
  /** The value's schema; for a non-single key, `{ type: 'array', items }`. */
  schema: AttributeSchema;
  prepareCallback?: (value: unknown, field: RestMetaField) => unknown;
}

type AddFilter = (
  name: string,
  callback: (...args: never[]) => unknown,
  priority?: number,
) => () => void;

interface Storage {
  table: typeof schema.postmeta;
  column: typeof schema.postmeta.postId;
  field: string;
}

const STORAGE: Record<MetaObjectType, Storage> = {
  post: { table: schema.postmeta, column: schema.postmeta.postId, field: 'postId' },
  term: {
    table: schema.termmeta as unknown as typeof schema.postmeta,
    column: schema.termmeta.termId as unknown as typeof schema.postmeta.postId,
    field: 'termId',
  },
  user: {
    table: schema.usermeta as unknown as typeof schema.postmeta,
    column: schema.usermeta.userId as unknown as typeof schema.postmeta.postId,
    field: 'userId',
  },
  comment: {
    table: schema.commentmeta as unknown as typeof schema.postmeta,
    column: schema.commentmeta.commentId as unknown as typeof schema.postmeta.postId,
    field: 'commentId',
  },
};

/** WP_REST_Meta_Fields::get_empty_value_for_type() */
export function emptyValueForType(type: string | undefined): unknown {
  switch (type) {
    case 'string':
      return '';
    case 'boolean':
      return false;
    case 'integer':
    case 'number':
      return 0;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

/** rest_default_additional_properties_to_false() */
function closeObjects(s: AttributeSchema): AttributeSchema {
  const out: AttributeSchema = { ...s };
  const types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.includes('object')) {
    if (s.properties) {
      out.properties = Object.fromEntries(
        Object.entries(s.properties).map(([k, v]) => [k, closeObjects(v)]),
      );
    }
    if (out.additionalProperties === undefined) out.additionalProperties = false;
  }
  if (types.includes('array') && s.items) out.items = closeObjects(s.items);
  return out;
}

function assertType(objectType: string): asserts objectType is MetaObjectType {
  if (!OBJECT_TYPES.has(objectType as MetaObjectType)) {
    throw new Error(`Meta can be registered for post, term, user or comment, not "${objectType}".`);
  }
}

export class MetaService {
  /** $wp_meta_keys: object type → subtype ('' for all) → key → args. */
  #keys = new Map<MetaObjectType, Map<string, Map<string, RegisteredMeta>>>();

  constructor(private readonly kernel: Kernel) {}

  /* ------------------------------------------------------------ registry */

  /**
   * register_meta(). Returns a function that unregisters the key and removes
   * its callbacks (unregister_meta_key()). `addFilter` lets the plugin
   * runtime track and isolate the callbacks.
   */
  register(
    objectType: MetaObjectType,
    metaKey: string,
    args: RegisterMetaArgs = {},
    addFilter: AddFilter = (name, callback, priority) =>
      this.kernel.hooks.addFilter(name, callback as never, priority),
  ): () => void {
    assertType(objectType);
    if (typeof metaKey !== 'string' || !metaKey || metaKey.length > 255) {
      throw new Error('A meta key is a string of 1 to 255 characters.');
    }
    const type = args.type ?? 'string';
    if (!VALUE_TYPES.has(type)) throw new Error(`Unknown meta type "${type}".`);
    const subtype = args.objectSubtype ?? '';
    const showInRest: false | MetaRestArgs =
      args.showInRest === true ? {} : args.showInRest ? { ...args.showInRest } : false;
    // Require an item schema when registering array meta.
    if (showInRest && type === 'array' && !showInRest.schema?.items) {
      throw new Error(
        `When registering an "array" meta type to show in the REST API, you must specify the schema for each array item in "showInRest.schema.items" (${metaKey}).`,
      );
    }
    const hasDefault = 'default' in args && args.default !== undefined;
    if (hasDefault) {
      const check = validateValueFromSchema(
        args.default,
        { type, ...(showInRest ? showInRest.schema : {}) },
        'default',
      );
      if (check) {
        throw new Error(
          `When registering a default meta value the data must match the type provided (${metaKey}: ${check})`,
        );
      }
    }

    const entry: RegisteredMeta = {
      key: metaKey,
      objectType,
      objectSubtype: subtype,
      type,
      label: args.label ?? '',
      description: args.description ?? '',
      single: args.single ?? false,
      default: args.default,
      hasDefault,
      showInRest,
    };
    const offs: (() => void)[] = [];
    const suffix = subtype ? `_for_${subtype}` : '';
    if (args.sanitizeCallback) {
      offs.push(
        addFilter(
          `sanitize_${objectType}_meta_${metaKey}${suffix}`,
          args.sanitizeCallback as never,
        ),
      );
    }
    if (args.authCallback) {
      offs.push(
        addFilter(`auth_${objectType}_meta_${metaKey}${suffix}`, args.authCallback as never),
      );
    }

    const bySubtype = this.#keys.get(objectType) ?? new Map<string, Map<string, RegisteredMeta>>();
    this.#keys.set(objectType, bySubtype);
    const byKey = bySubtype.get(subtype) ?? new Map<string, RegisteredMeta>();
    bySubtype.set(subtype, byKey);
    byKey.set(metaKey, entry);

    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const off of offs) off();
      if (byKey.get(metaKey) === entry) byKey.delete(metaKey);
    };
  }

  /** get_registered_meta_keys(): keys for the whole type, then the subtype's (which win). */
  registered(objectType: MetaObjectType, subtype = ''): Map<string, RegisteredMeta> {
    const bySubtype = this.#keys.get(objectType);
    const keys = new Map(bySubtype?.get('') ?? []);
    if (subtype) for (const [k, v] of bySubtype?.get(subtype) ?? []) keys.set(k, v);
    return keys;
  }

  /** registered_meta_key_exists() / get_registered_metadata() for one key. */
  registeredKey(objectType: MetaObjectType, key: string, subtype = ''): RegisteredMeta | undefined {
    const bySubtype = this.#keys.get(objectType);
    return (
      (subtype ? bySubtype?.get(subtype)?.get(key) : undefined) ?? bySubtype?.get('')?.get(key)
    );
  }

  /** WP_REST_Meta_Fields::get_registered_fields(): the keys shown in REST, by field name. */
  restFields(objectType: MetaObjectType, subtype = ''): RestMetaField[] {
    const fields: RestMetaField[] = [];
    for (const meta of this.registered(objectType, subtype).values()) {
      if (!meta.showInRest) continue;
      const rest = meta.showInRest;
      let fieldSchema: AttributeSchema = {
        type: meta.type,
        title: meta.label,
        description: meta.description,
        default: meta.hasDefault ? meta.default : emptyValueForType(meta.type),
        ...rest.schema,
      };
      if (fieldSchema.default === undefined || fieldSchema.default === null) {
        fieldSchema.default = emptyValueForType(
          typeof fieldSchema.type === 'string' ? fieldSchema.type : meta.type,
        );
      }
      fieldSchema = closeObjects(fieldSchema);
      fields.push({
        key: meta.key,
        name: rest.name ?? meta.key,
        single: meta.single,
        schema: meta.single ? fieldSchema : { type: 'array', items: fieldSchema },
        prepareCallback: rest.prepareCallback,
      });
    }
    return fields;
  }

  /* ------------------------------------------------------------- helpers */

  /** is_protected_meta(): keys starting with `_` (filter `is_protected_meta`). */
  async isProtected(key: string, objectType: string): Promise<boolean> {
    const visible = key.replace(/[^\x20-\x7E\p{L}]/gu, '');
    const isProtected = visible.length > 0 && visible.startsWith('_');
    return Boolean(
      await this.kernel.hooks.applyFilters('is_protected_meta', isProtected, key, objectType),
    );
  }

  /** sanitize_meta() */
  async sanitize(
    key: string,
    value: unknown,
    objectType: MetaObjectType,
    subtype = '',
  ): Promise<unknown> {
    const specific = `sanitize_${objectType}_meta_${key}_for_${subtype}`;
    if (subtype && this.kernel.hooks.hasFilter(specific)) {
      return this.kernel.hooks.applyFilters(specific, value, key, objectType, subtype);
    }
    return this.kernel.hooks.applyFilters(
      `sanitize_${objectType}_meta_${key}`,
      value,
      key,
      objectType,
    );
  }

  /** get_object_subtype(): the post type, the taxonomy, or 'user' / 'comment'. */
  async subtypeOf(objectType: string, id: number): Promise<string> {
    const db = this.kernel.db;
    switch (objectType) {
      case 'post': {
        const [row] = await db
          .select({ type: schema.posts.type })
          .from(schema.posts)
          .where(eq(schema.posts.id, id));
        return row?.type ?? '';
      }
      case 'term': {
        const [row] = await db
          .select({ taxonomy: schema.termTaxonomy.taxonomy })
          .from(schema.termTaxonomy)
          .where(eq(schema.termTaxonomy.termId, id));
        return row?.taxonomy ?? '';
      }
      case 'user': {
        const [row] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.id, id));
        return row ? 'user' : '';
      }
      case 'comment': {
        const [row] = await db
          .select({ id: schema.comments.id })
          .from(schema.comments)
          .where(eq(schema.comments.id, id));
        return row ? 'comment' : '';
      }
      default:
        return '';
    }
  }

  /* -------------------------------------------------------------- reads */

  /**
   * Every value of the given keys (all keys when omitted) for several
   * objects at once: id → key → values, oldest first. One query.
   */
  async values(
    objectType: MetaObjectType,
    ids: number[],
    keys?: string[],
  ): Promise<Map<number, Map<string, unknown[]>>> {
    const out = new Map<number, Map<string, unknown[]>>();
    if (!ids.length || (keys && !keys.length)) return out;
    const { table, column } = STORAGE[objectType];
    const rows = await this.kernel.db
      .select({ objectId: column, key: table.key, value: table.value })
      .from(table)
      .where(keys ? and(inArray(column, ids), inArray(table.key, keys)) : inArray(column, ids))
      .orderBy(asc(table.id));
    for (const row of rows) {
      const byKey = out.get(row.objectId) ?? new Map<string, unknown[]>();
      out.set(row.objectId, byKey);
      const list = byKey.get(row.key) ?? [];
      list.push(row.value);
      byKey.set(row.key, list);
    }
    return out;
  }

  /**
   * get_metadata(): the first value (`single`) or every value of a key. A
   * registered default fills in when nothing is stored (filter_default_metadata());
   * otherwise `undefined` (single) or `[]`.
   */
  async get(objectType: MetaObjectType, id: number, key: string, single: true): Promise<unknown>;
  async get(
    objectType: MetaObjectType,
    id: number,
    key: string,
    single?: false,
  ): Promise<unknown[]>;
  async get(objectType: MetaObjectType, id: number, key: string, single = false): Promise<unknown> {
    assertType(objectType);
    const stored = (await this.values(objectType, [id], [key])).get(id)?.get(key) ?? [];
    if (stored.length) return single ? stored[0] : stored;
    const meta = this.#anyRegistration(objectType, key)
      ? this.registeredKey(objectType, key, await this.subtypeOf(objectType, id))
      : undefined;
    if (meta?.hasDefault) return single ? meta.default : [meta.default];
    return single ? undefined : [];
  }

  #anyRegistration(objectType: MetaObjectType, key: string): boolean {
    for (const byKey of this.#keys.get(objectType)?.values() ?? []) if (byKey.has(key)) return true;
    return false;
  }

  /* ------------------------------------------------------------- writes */

  /** add_metadata(): adds a value; with `unique`, only when the key has none yet. */
  async add(
    objectType: MetaObjectType,
    id: number,
    key: string,
    value: unknown,
    unique = false,
  ): Promise<number | false> {
    assertType(objectType);
    const subtype = await this.subtypeOf(objectType, id);
    if (!subtype) return false;
    const clean = await this.sanitize(key, value, objectType, subtype);
    const { table, column, field } = STORAGE[objectType];
    if (unique) {
      const [existing] = await this.kernel.db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(column, id), eq(table.key, key)))
        .limit(1);
      if (existing) return false;
    }
    const [row] = await this.kernel.db
      .insert(table)
      .values({ [field]: id, key, value: clean ?? null } as never)
      .returning({ id: table.id });
    if (!row) return false;
    await this.kernel.hooks.doAction(`added_${objectType}_meta`, row.id, id, key, clean);
    return row.id;
  }

  /**
   * update_metadata(): sets every value of the key (or only those equal to
   * `previous`) to `value`, adding it when the key has none.
   */
  async update(
    objectType: MetaObjectType,
    id: number,
    key: string,
    value: unknown,
    previous?: unknown,
  ): Promise<boolean> {
    assertType(objectType);
    const subtype = await this.subtypeOf(objectType, id);
    if (!subtype) return false;
    const clean = await this.sanitize(key, value, objectType, subtype);
    const { table, column } = STORAGE[objectType];
    const rows = await this.kernel.db
      .select({ id: table.id, value: table.value })
      .from(table)
      .where(and(eq(column, id), eq(table.key, key)));
    const targets =
      previous === undefined
        ? rows
        : rows.filter((r) => JSON.stringify(r.value) === JSON.stringify(previous));
    if (!targets.length) {
      if (previous !== undefined) return false;
      return (await this.add(objectType, id, key, value)) !== false;
    }
    // Unchanged: WordPress returns false and fires nothing.
    if (targets.every((r) => JSON.stringify(r.value) === JSON.stringify(clean))) return false;
    await this.kernel.db
      .update(table)
      .set({ value: clean ?? null })
      .where(
        inArray(
          table.id,
          targets.map((r) => r.id),
        ),
      );
    for (const row of targets) {
      await this.kernel.hooks.doAction(`updated_${objectType}_meta`, row.id, id, key, clean);
    }
    return true;
  }

  /** delete_metadata(): removes every value of the key, or only those equal to `value`. */
  async delete(
    objectType: MetaObjectType,
    id: number,
    key: string,
    value?: unknown,
  ): Promise<boolean> {
    assertType(objectType);
    const { table, column } = STORAGE[objectType];
    const rows = await this.kernel.db
      .select({ id: table.id, value: table.value })
      .from(table)
      .where(and(eq(column, id), eq(table.key, key)));
    const targets =
      value === undefined
        ? rows
        : rows.filter((r) => JSON.stringify(r.value) === JSON.stringify(value));
    if (!targets.length) return false;
    const metaIds = targets.map((r) => r.id);
    await this.kernel.db.delete(table).where(inArray(table.id, metaIds));
    await this.kernel.hooks.doAction(`deleted_${objectType}_meta`, metaIds, id, key, value);
    return true;
  }
}

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    is_protected_meta: [isProtected: boolean, metaKey: string, objectType: string];
  }
  interface ActionRegistry {
    added_post_meta: [metaId: number, postId: number, metaKey: string, value: unknown];
    updated_post_meta: [metaId: number, postId: number, metaKey: string, value: unknown];
    deleted_post_meta: [metaIds: number[], postId: number, metaKey: string, value: unknown];
    added_term_meta: [metaId: number, termId: number, metaKey: string, value: unknown];
    updated_term_meta: [metaId: number, termId: number, metaKey: string, value: unknown];
    deleted_term_meta: [metaIds: number[], termId: number, metaKey: string, value: unknown];
  }
}

/**
 * Validates a value against a field's schema the way the REST API does
 * (rest_validate_value_from_schema()), after coercing loose input
 * (rest_sanitize_value_from_schema()). Returns the coerced value or an error message.
 */
export function checkMetaValue(
  value: unknown,
  field: RestMetaField,
): { value: unknown } | { error: string } {
  const coerced = sanitizeValueFromSchema(value, field.schema);
  const error = validateValueFromSchema(coerced, field.schema, `meta.${field.name}`);
  return error ? { error } : { value: coerced };
}
