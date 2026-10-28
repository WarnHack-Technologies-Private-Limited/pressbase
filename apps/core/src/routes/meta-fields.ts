import {
  type AttributeSchema,
  sanitizeValueFromSchema,
  validateValueFromSchema,
} from '@pressbase/blocks';
import type { Context } from 'hono';
import { currentUserCan } from '../auth/meta-caps';
import {
  checkMetaValue,
  emptyValueForType,
  type MetaObjectType,
  type RestMetaField,
} from '../content/meta';
import { type AppEnv, restError } from '../http';
import type { Kernel } from '../kernel';
import { authStatus } from './rest-util';

/**
 * The `meta` field of posts, pages and terms in the REST API: a port of
 * WP_REST_Meta_Fields (wordpress/wp-includes/rest-api/fields/class-wp-rest-meta-fields.php)
 * over the keys registered with `showInRest` (content/meta.ts).
 *
 * - Reading: every registered key, by its REST name. A single key gives its
 *   value or the default; a multi key gives a list. Values are coerced to
 *   the schema, and a stored value that doesn't fit is `null` (prepare_value()).
 *   Like WordPress, `meta` shows in the `view` context too: registering a key
 *   with `showInRest` makes it public for anyone who can read the object.
 * - Writing: `{ meta: { key: value } }`. Unregistered names are ignored.
 *   `null` (or `[]` for a multi key) deletes. Each value is validated
 *   against the schema (`rest_invalid_param`, 400), and the user needs
 *   `edit_{type}_meta` / `delete_{type}_meta` for the key: the object's edit
 *   capability plus the key's auth callback, or an unprotected key
 *   (`rest_cannot_update` / `rest_cannot_delete`, 401 or 403).
 *
 * One difference from WordPress: values and permissions are checked before
 * the object is saved, so a refused meta write doesn't leave a half-saved
 * update. (A new post or term is created first, since the auth callback
 * receives its ID.)
 */

export interface MetaWrite {
  field: RestMetaField;
  /** The coerced value; null deletes. */
  value: unknown;
}

/** WP_REST_Meta_Fields::prepare_value() */
function prepareValue(value: unknown, field: RestMetaField): unknown {
  if (field.prepareCallback) return field.prepareCallback(value, field);
  const schema: AttributeSchema = field.single
    ? field.schema
    : ((field.schema.items as AttributeSchema | undefined) ?? {});
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  let v = value;
  if (v === '' && (type === 'boolean' || type === 'integer' || type === 'number')) {
    v = emptyValueForType(type);
  }
  const coerced = sanitizeValueFromSchema(v, schema);
  return validateValueFromSchema(coerced, schema) ? null : coerced;
}

/** The registered REST fields for an object type and subtype (post type or taxonomy). */
export function metaFields(kernel: Kernel, objectType: MetaObjectType, subtype: string) {
  return kernel.meta.restFields(objectType, subtype);
}

/**
 * WP_REST_Meta_Fields::get_value() for several objects. Returns undefined
 * when no key is registered, so callers keep their empty `meta`.
 */
export async function readRestMeta(
  kernel: Kernel,
  objectType: MetaObjectType,
  subtype: string,
  ids: number[],
): Promise<Map<number, Record<string, unknown>> | undefined> {
  const fields = metaFields(kernel, objectType, subtype);
  if (!fields.length) return undefined;
  const stored = await kernel.meta.values(
    objectType,
    ids,
    fields.map((f) => f.key),
  );
  const out = new Map<number, Record<string, unknown>>();
  for (const id of ids) {
    const meta: Record<string, unknown> = {};
    for (const field of fields) {
      const values = stored.get(id)?.get(field.key) ?? [];
      if (field.single) {
        meta[field.name] = prepareValue(values.length ? values[0] : field.schema.default, field);
      } else {
        meta[field.name] = values.map((v) => prepareValue(v, field));
      }
    }
    out.set(id, meta);
  }
  return out;
}

/**
 * Validates a request's `meta` (WP_REST_Meta_Fields::update_value(), the
 * validation half). Returns the writes, or an error response.
 */
export function parseRestMeta(
  c: Context<AppEnv>,
  objectType: MetaObjectType,
  subtype: string,
  input: unknown,
): MetaWrite[] | Response {
  if (input === undefined) return [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return restError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): meta', {
      params: { meta: 'meta is not of type object.' },
    });
  }
  const values = input as Record<string, unknown>;
  const writes: MetaWrite[] = [];
  for (const field of metaFields(c.get('kernel'), objectType, subtype)) {
    if (!Object.hasOwn(values, field.name)) continue;
    const value = values[field.name];
    if (value === null || (!field.single && Array.isArray(value) && value.length === 0)) {
      writes.push({ field, value: null });
      continue;
    }
    if (!field.single && Array.isArray(value) && value.some((v) => v === null)) {
      return restError(
        c,
        500,
        'rest_invalid_stored_value',
        `The ${field.name} property has an invalid stored value, and cannot be updated to null.`,
      );
    }
    const checked = checkMetaValue(value, field);
    if ('error' in checked) {
      return restError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): meta', {
        params: { meta: checked.error },
      });
    }
    writes.push({ field, value: checked.value });
  }
  return writes;
}

/** The permission half: `edit_{type}_meta` or `delete_{type}_meta` for each key. */
export async function authorizeRestMeta(
  c: Context<AppEnv>,
  objectType: MetaObjectType,
  objectId: number,
  writes: MetaWrite[],
): Promise<Response | undefined> {
  const kernel = c.get('kernel');
  const user = c.get('user');
  for (const { field, value } of writes) {
    const deleting = value === null;
    const cap = `${deleting ? 'delete' : 'edit'}_${objectType}_meta`;
    if (!(await currentUserCan(kernel, user, cap, objectId, field.key))) {
      return restError(
        c,
        authStatus(c),
        deleting ? 'rest_cannot_delete' : 'rest_cannot_update',
        `Sorry, you are not allowed to edit the ${field.name} custom field.`,
        { key: field.name },
      );
    }
  }
  return undefined;
}

/** Stores validated, authorised writes (update_meta_value(), update_multi_meta_value(), delete_meta_value()). */
export async function writeRestMeta(
  kernel: Kernel,
  objectType: MetaObjectType,
  objectId: number,
  writes: MetaWrite[],
): Promise<void> {
  for (const { field, value } of writes) {
    if (value === null) {
      await kernel.meta.delete(objectType, objectId, field.key);
    } else if (field.single) {
      await kernel.meta.update(objectType, objectId, field.key, value);
    } else {
      await kernel.meta.delete(objectType, objectId, field.key);
      for (const item of value as unknown[]) {
        await kernel.meta.add(objectType, objectId, field.key, item);
      }
    }
  }
}
