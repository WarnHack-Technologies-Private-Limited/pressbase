import type { AttributeSchema, SchemaType } from './types';

/**
 * The parts of rest_validate_value_from_schema() and
 * rest_sanitize_value_from_schema() (wordpress/wp-includes/rest-api.php) that
 * block attributes use: type (or a list of types), enum, items, properties,
 * additionalProperties, minimum and maximum.
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function matchesType(value: unknown, type: SchemaType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
  }
}

const typesOf = (schema: AttributeSchema): SchemaType[] | undefined =>
  schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type : [schema.type];

/**
 * Returns an error message, or `null` when `value` is valid. `path` names the
 * value in messages, e.g. `attributes[postsToShow]`.
 */
export function validateValueFromSchema(
  value: unknown,
  schema: AttributeSchema,
  path = 'value',
): string | null {
  const types = typesOf(schema);
  if (types) {
    const type = types.find((t) => matchesType(value, t));
    if (!type) return `${path} is not of type ${types.join(',')}.`;
    if (type === 'array' && schema.items) {
      for (const [i, item] of (value as unknown[]).entries()) {
        const error = validateValueFromSchema(item, schema.items, `${path}[${i}]`);
        if (error) return error;
      }
    }
    if (type === 'object') {
      const object = value as Record<string, unknown>;
      for (const [key, item] of Object.entries(object)) {
        const property = schema.properties?.[key];
        if (property) {
          const error = validateValueFromSchema(item, property, `${path}[${key}]`);
          if (error) return error;
        } else if (schema.additionalProperties === false) {
          return `${key} is not a valid property of Object.`;
        } else if (isObject(schema.additionalProperties)) {
          const error = validateValueFromSchema(
            item,
            schema.additionalProperties,
            `${path}[${key}]`,
          );
          if (error) return error;
        }
      }
    }
    if ((type === 'number' || type === 'integer') && typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        return `${path} must be greater than or equal to ${schema.minimum}`;
      }
      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        return `${path} must be less than or equal to ${schema.maximum}`;
      }
    }
  }
  if (schema.enum && !schema.enum.some((option) => Object.is(option, value) || option === value)) {
    return `${path} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}.`;
  }
  return null;
}

function coerce(value: unknown, type: SchemaType): unknown {
  switch (type) {
    case 'number':
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
        return Number(value);
      return value;
    case 'integer':
      if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
      return value;
    case 'boolean':
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0' || value === '') return false;
      return value;
    case 'string':
      return typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
    case 'null':
      return value === '' ? null : value;
    default:
      return value;
  }
}

/**
 * Coerces loosely typed input (query strings arrive as text) to the schema's
 * types: "5" → 5 for numbers, "true"/"1" → true for booleans, and so on
 * through arrays and objects. Validate afterwards.
 */
export function sanitizeValueFromSchema(value: unknown, schema: AttributeSchema): unknown {
  const types = typesOf(schema);
  if (!types) return value;
  if (types.some((t) => matchesType(value, t))) {
    if (Array.isArray(value) && schema.items) {
      const items = schema.items;
      return value.map((v) => sanitizeValueFromSchema(v, items));
    }
    if (isObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const property =
          schema.properties?.[key] ??
          (isObject(schema.additionalProperties) ? schema.additionalProperties : undefined);
        out[key] = property ? sanitizeValueFromSchema(item, property) : item;
      }
      return out;
    }
    return value;
  }
  // Query strings send arrays as objects keyed "0", "1"…
  if (types.includes('array') && isObject(value)) {
    const keys = Object.keys(value);
    if (keys.every((k, i) => k === String(i))) {
      return sanitizeValueFromSchema(Object.values(value), schema);
    }
  }
  for (const type of types) {
    const coerced = coerce(value, type);
    if (matchesType(coerced, type)) return coerced;
  }
  return value;
}
