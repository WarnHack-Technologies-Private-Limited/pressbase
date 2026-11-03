import { richTextToPlain } from './html';
import { placeholderFor } from './placeholders';
import type { Slot } from './types';

/**
 * slotsJsonSchema(slots): a JSON Schema for a pattern's slot values, for a
 * structured AI call (`prompt.asJsonResponse(schema).generateJson()`). The
 * model writes plain text; fill its answer with
 * `fillSlots(blocks, answer, { format: 'text' })`.
 *
 * Images ask for `alt` and `subject` only: choosing the picture (the
 * person's uploads, then Openverse) is done in code, never by the model.
 * Buttons ask for text and a URL.
 *
 * Uses only keywords that core's validator and the providers' structured
 * output understand: type, properties, required, additionalProperties,
 * items, minItems, maxItems, maxLength and description.
 */
export type JsonSchema = Record<string, unknown>;

const ROLE_HINTS: Record<string, string> = {
  title: 'The main heading',
  eyebrow: 'A short label above the heading',
  heading: 'A heading',
  body: 'Text',
  item: 'A list item',
  summary: 'A question or short title that opens to show more',
  citation: 'Who said it',
  action: 'A button',
  media: 'An image',
};

function describe(slot: Slot): string {
  const parts: string[] = [];
  const name = slot.label ?? ROLE_HINTS[slot.role] ?? slot.role;
  parts.push(slot.kind === 'heading' && slot.level ? `${name} (heading level ${slot.level}).` : `${name}.`);
  if (slot.description) parts.push(slot.description);
  if (slot.kind === 'heading' || slot.kind === 'text' || slot.kind === 'button') {
    const example = slot.kind === 'button' ? slot.value.text : slot.value;
    const plain = richTextToPlain(example);
    if (plain) parts.push(`About ${slot.length} characters, like: "${plain}".`);
  }
  if (slot.facts) {
    parts.push(
      `Only from facts you were given; otherwise exactly "${placeholderFor(slot)}". Never invent it.`,
    );
  }
  return parts.join(' ');
}

function leafSchema(slot: Exclude<Slot, { kind: 'group' }>): JsonSchema {
  const description = describe(slot);
  if (slot.kind === 'button') {
    return {
      type: 'object',
      description,
      properties: {
        text: { type: 'string', maxLength: slot.maxLength, description: 'The button text.' },
        url: {
          type: 'string',
          description:
            'Where it leads: a path on this site (/contact), a full https:// URL, tel: or mailto:. "#" when not known.',
        },
      },
      required: ['text', 'url'],
      additionalProperties: false,
    };
  }
  if (slot.kind === 'image') {
    return {
      type: 'object',
      description,
      properties: {
        alt: {
          type: 'string',
          maxLength: 150,
          description:
            'Alternative text: what the image shows, for people who can’t see it. Empty only for a decorative image.',
        },
        subject: {
          type: 'string',
          maxLength: 80,
          description: `What the photo should show, as a short image search${slot.subject ? ` (the pattern shows: ${slot.subject})` : ''}.`,
        },
      },
      required: ['alt', 'subject'],
      additionalProperties: false,
    };
  }
  return { type: 'string', maxLength: slot.maxLength, description };
}

function slotSchema(slot: Slot): JsonSchema {
  if (slot.kind !== 'group') return leafSchema(slot);
  // New items copy the last one, so it describes them all.
  const template = slot.items[slot.items.length - 1] ?? [];
  const items = slot.flat && template[0] ? slotSchema(template[0]) : objectSchema(template);
  return {
    type: 'array',
    description: [
      slot.label ?? (slot.role === 'items' ? 'Repeated items' : (ROLE_HINTS[slot.role] ?? slot.role)),
      `${slot.minItems === slot.maxItems ? slot.minItems : `${slot.minItems} to ${slot.maxItems}`} items; the pattern has ${slot.items.length}.`,
      slot.description ?? '',
    ]
      .filter(Boolean)
      .join('. ')
      .replace(/\.\./g, '.'),
    minItems: slot.minItems,
    maxItems: slot.maxItems,
    items,
  };
}

function objectSchema(slots: Slot[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const slot of slots) properties[slot.id] = slotSchema(slot);
  return {
    type: 'object',
    properties,
    required: slots.map((s) => s.id),
    additionalProperties: false,
  };
}

/** The JSON Schema of the values for these slots (an object keyed by slot ID). */
export function slotsJsonSchema(slots: Slot[]): JsonSchema {
  return objectSchema(slots);
}
