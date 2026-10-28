/**
 * JSON Schema for abilities: a port of rest_validate_value_from_schema()
 * (wordpress/wp-includes/rest-api.php) with the keywords WordPress validates,
 * and of wp_prepare_json_schema_for_client() (wp-includes/json-schema.php),
 * which readies a schema for REST clients and AI providers.
 *
 * Messages and paths follow WordPress: `input[title] is a required property of input.`
 */

export type JsonSchema = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function matchesType(value: unknown, type: string): boolean {
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
    default:
      return true;
  }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** rest_find_matching_pattern_property_schema() */
function patternPropertySchema(key: string, schema: JsonSchema): JsonSchema | undefined {
  if (!isObject(schema.patternProperties)) return undefined;
  for (const [pattern, child] of Object.entries(schema.patternProperties)) {
    try {
      if (new RegExp(pattern, 'u').test(key) && isObject(child)) return child;
    } catch {
      // An invalid pattern never matches.
    }
  }
  return undefined;
}

/** The `required` list: draft-04's array, or v3's `required: true` on each property. */
function requiredProperties(schema: JsonSchema): string[] {
  if (Array.isArray(schema.required)) return schema.required.map(String);
  if (!isObject(schema.properties)) return [];
  return Object.entries(schema.properties)
    .filter(([, child]) => isObject(child) && child.required === true)
    .map(([key]) => key);
}

function validateFormat(value: string, format: string, path: string): string | null {
  switch (format) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : 'Invalid email address.';
    case 'uri':
      try {
        new URL(value);
        return null;
      } catch {
        return `${path} is not a valid URL.`;
      }
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        ? null
        : `${path} is not a valid UUID.`;
    case 'date-time':
      return Number.isNaN(Date.parse(value)) ? 'Invalid date.' : null;
    case 'hex-color':
      return /^#([0-9a-f]{3}){1,2}$/i.test(value) ? null : `${path} is not a valid hex color.`;
    default:
      return null;
  }
}

/**
 * rest_validate_value_from_schema(): an error message, or null when `value`
 * is valid. `path` names the value in messages (`input`).
 */
export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path = 'value',
): string | null {
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter(isObject);
    if (!branches.some((branch) => validateJsonSchema(value, branch, path) === null)) {
      return `${path} is invalid (failed to match any of the expected formats).`;
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf
      .filter(isObject)
      .filter((branch) => validateJsonSchema(value, branch, path) === null).length;
    if (matches === 0) return `${path} is invalid (failed to match any of the expected formats).`;
    if (matches > 1) return `${path} matches more than one of the expected formats.`;
  }

  const types =
    schema.type === undefined
      ? undefined
      : Array.isArray(schema.type)
        ? schema.type.map(String)
        : [String(schema.type)];
  let type: string | undefined;
  if (types) {
    type = types.find((t) => matchesType(value, t));
    if (!type) return `${path} is not of type ${types.join(',')}.`;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    return `${path} is not one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}.`;
  }

  if (isObject(value) && (type === 'object' || !types)) {
    for (const key of requiredProperties(schema)) {
      if (!(key in value)) return `${key} is a required property of ${path}.`;
    }
    const count = Object.keys(value).length;
    if (typeof schema.minProperties === 'number' && count < schema.minProperties) {
      return `${path} must contain at least ${schema.minProperties} ${plural(schema.minProperties, 'property', 'properties')}.`;
    }
    if (typeof schema.maxProperties === 'number' && count > schema.maxProperties) {
      return `${path} must contain at most ${schema.maxProperties} ${plural(schema.maxProperties, 'property', 'properties')}.`;
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [key, item] of Object.entries(value)) {
      const property = properties[key];
      const child = isObject(property) ? property : patternPropertySchema(key, schema);
      if (child) {
        const error = validateJsonSchema(item, child, `${path}[${key}]`);
        if (error) return error;
      } else if (schema.additionalProperties === false) {
        return `${key} is not a valid property of Object.`;
      } else if (isObject(schema.additionalProperties)) {
        const error = validateJsonSchema(item, schema.additionalProperties, `${path}[${key}]`);
        if (error) return error;
      }
    }
  }

  if (Array.isArray(value) && (type === 'array' || !types)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return `${path} must contain at least ${schema.minItems} ${plural(schema.minItems, 'item', 'items')}.`;
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return `${path} must contain at most ${schema.maxItems} ${plural(schema.maxItems, 'item', 'items')}.`;
    }
    if (isObject(schema.items)) {
      for (const [i, item] of value.entries()) {
        const error = validateJsonSchema(item, schema.items, `${path}[${i}]`);
        if (error) return error;
      }
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) return `${path} has duplicate items.`;
    }
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      return `${path} must be at least ${schema.minLength} ${plural(schema.minLength, 'character', 'characters')} long.`;
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      return `${path} must be at most ${schema.maxLength} ${plural(schema.maxLength, 'character', 'characters')} long.`;
    }
    if (typeof schema.pattern === 'string') {
      let matches = true;
      try {
        matches = new RegExp(schema.pattern, 'u').test(value);
      } catch {
        matches = false;
      }
      if (!matches) return `${path} does not match pattern ${schema.pattern}.`;
    }
    if (typeof schema.format === 'string') {
      const error = validateFormat(value, schema.format, path);
      if (error) return error;
    }
  }

  if (typeof value === 'number') {
    const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema;
    if (typeof minimum === 'number') {
      if (exclusiveMinimum === true && value <= minimum) {
        return `${path} must be greater than ${minimum}`;
      }
      if (value < minimum) return `${path} must be greater than or equal to ${minimum}`;
    }
    if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) {
      return `${path} must be greater than ${exclusiveMinimum}`;
    }
    if (typeof maximum === 'number') {
      if (exclusiveMaximum === true && value >= maximum) {
        return `${path} must be less than ${maximum}`;
      }
      if (value > maximum) return `${path} must be less than or equal to ${maximum}`;
    }
    if (typeof exclusiveMaximum === 'number' && value >= exclusiveMaximum) {
      return `${path} must be less than ${exclusiveMaximum}`;
    }
    if (typeof multipleOf === 'number' && multipleOf > 0) {
      const quotient = value / multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        return `${path} must be a multiple of ${multipleOf}.`;
      }
    }
  }

  return null;
}

/** rest_get_allowed_schema_keywords() plus draft-04's own (wp_get_json_schema_allowed_keywords('draft-04')). */
const ALLOWED_KEYWORDS = new Set([
  '$schema',
  'id',
  '$ref',
  'title',
  'description',
  'default',
  'type',
  'format',
  'enum',
  'items',
  'properties',
  'additionalProperties',
  'patternProperties',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'anyOf',
  'oneOf',
  'required',
  'allOf',
  'not',
  'definitions',
  'dependencies',
  'additionalItems',
]);

/**
 * wp_prepare_json_schema_for_client(): keeps draft-04 keywords only, and turns
 * WordPress's `required: true` on properties into a `required` list, so REST
 * clients and AI providers get a standard schema.
 */
export function prepareJsonSchemaForClient(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (ALLOWED_KEYWORDS.has(key)) out[key] = value;
  }
  if (isObject(out.properties)) {
    const hasList = Array.isArray(out.required);
    const required: string[] = [];
    const properties: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(out.properties)) {
      if (isObject(child)) {
        if (!hasList && child.required === true) required.push(key);
        properties[key] = prepareJsonSchemaForClient(child);
      } else {
        properties[key] = child;
      }
    }
    out.properties = properties;
    if (!hasList && required.length) out.required = required;
  }
  if (typeof out.required === 'boolean') delete out.required;
  for (const keyword of ['patternProperties', 'definitions'] as const) {
    const map = out[keyword];
    if (isObject(map)) {
      out[keyword] = Object.fromEntries(
        Object.entries(map).map(([k, v]) => [k, isObject(v) ? prepareJsonSchemaForClient(v) : v]),
      );
    }
  }
  for (const keyword of ['not', 'additionalProperties', 'additionalItems'] as const) {
    const child = out[keyword];
    if (isObject(child)) out[keyword] = prepareJsonSchemaForClient(child);
  }
  if (isObject(out.items)) out.items = prepareJsonSchemaForClient(out.items);
  else if (Array.isArray(out.items)) {
    out.items = out.items.map((v) => (isObject(v) ? prepareJsonSchemaForClient(v) : v));
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = out[keyword];
    if (Array.isArray(list)) {
      out[keyword] = list.map((v) => (isObject(v) ? prepareJsonSchemaForClient(v) : v));
    }
  }
  return out;
}
