import type { Slot, SlotDeclaration, SlotDeclarations } from './types';

/**
 * Declared slots: a pattern's own description of its slots, overriding what
 * the walk infers. In a theme's PHP pattern it's the `Slots:` header, one
 * line of JSON:
 *
 *   * Slots: {"hours":{"minItems":1,"maxItems":7,"facts":true},"hours.day":{"maxLength":24}}
 *
 * In a library pattern it's the `slots` object of its JSON file. Keys are
 * slot IDs (`group.child` inside a repeated group's items).
 */

export class SlotDeclarationError extends Error {}

const STRING_FIELDS = ['role', 'label', 'description', 'subject', 'placeholder'] as const;
const COUNT_FIELDS = ['maxLength', 'minItems', 'maxItems'] as const;
const BOOLEAN_FIELDS = ['facts', 'ignore'] as const;
const FIELDS = new Set<string>([...STRING_FIELDS, ...COUNT_FIELDS, ...BOOLEAN_FIELDS]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks and returns declarations given as JSON text or as a parsed object. */
export function parseSlotDeclarations(input: unknown): SlotDeclarations {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new SlotDeclarationError('slots must be a JSON object');
    }
  }
  if (!isObject(value)) throw new SlotDeclarationError('slots must be a JSON object');
  const out: SlotDeclarations = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(key)) {
      throw new SlotDeclarationError(`"${key}" is not a slot ID`);
    }
    if (!isObject(raw)) throw new SlotDeclarationError(`slots.${key} must be an object`);
    const declaration: SlotDeclaration = {};
    for (const [field, fieldValue] of Object.entries(raw)) {
      if (!FIELDS.has(field)) throw new SlotDeclarationError(`slots.${key}.${field} is not known`);
      const where = `slots.${key}.${field}`;
      if ((STRING_FIELDS as readonly string[]).includes(field)) {
        if (typeof fieldValue !== 'string' || !fieldValue.trim()) {
          throw new SlotDeclarationError(`${where} must be a non-empty string`);
        }
      } else if ((COUNT_FIELDS as readonly string[]).includes(field)) {
        if (typeof fieldValue !== 'number' || !Number.isInteger(fieldValue) || fieldValue < 0) {
          throw new SlotDeclarationError(`${where} must be a whole number`);
        }
      } else if (typeof fieldValue !== 'boolean') {
        throw new SlotDeclarationError(`${where} must be true or false`);
      }
      (declaration as Record<string, unknown>)[field] = fieldValue;
    }
    if (
      declaration.minItems !== undefined &&
      declaration.maxItems !== undefined &&
      declaration.minItems > declaration.maxItems
    ) {
      throw new SlotDeclarationError(`slots.${key}: minItems is more than maxItems`);
    }
    out[key] = declaration;
  }
  return out;
}

/**
 * Declaration keys that name no slot: a typo, or a slot whose block was
 * renamed. `slots` must be extracted without declarations (ignored slots
 * are gone otherwise).
 */
export function unknownDeclarations(slots: Slot[], declarations: SlotDeclarations): string[] {
  const ids = new Set<string>();
  const collect = (list: Slot[], prefix: string) => {
    for (const slot of list) {
      ids.add(prefix + slot.id);
      if (slot.kind === 'group') {
        for (const item of slot.items) collect(item, `${prefix}${slot.id}.`);
      }
    }
  };
  collect(slots, '');
  return Object.keys(declarations).filter((key) => !ids.has(key));
}
