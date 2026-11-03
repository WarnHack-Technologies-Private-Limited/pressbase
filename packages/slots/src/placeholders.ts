import { richTextToPlain } from './html';
import type { Slot } from './types';

/**
 * Honest content: what isn't known is never invented. A slot the person
 * gave no fact for holds a placeholder in square brackets, such as
 * `[Add a customer quote]`: plain text, so it's valid in any block and
 * visible on the page, and easy to find for the "Before you publish"
 * checklist. A button whose link is `#` or empty, and an image without a
 * URL, are placeholders too.
 */

/** Text that is a placeholder: `[Something to add]`, once trimmed. */
export const PLACEHOLDER_PATTERN = /^\[[^[\]]{1,120}\]$/;

/** Whether rich or plain text is a placeholder. */
export function isPlaceholder(text: string): boolean {
  return PLACEHOLDER_PATTERN.test(richTextToPlain(text).trim());
}

const ROLE_PLACEHOLDERS: Record<string, string> = {
  title: 'Add a heading',
  eyebrow: 'Add a short label',
  heading: 'Add a heading',
  body: 'Add text',
  item: 'Add an item',
  summary: 'Add a question',
  citation: 'Add a name',
  action: 'Add a button label',
  media: 'Add an image',
};

/** The slot's declared placeholder, or one made from its label or role. */
export function placeholderFor(slot: Pick<Slot, 'placeholder' | 'label' | 'role'>): string {
  if (slot.placeholder) return slot.placeholder;
  const text = slot.label ? `Add ${slot.label.toLowerCase()}` : ROLE_PLACEHOLDERS[slot.role];
  return `[${text ?? `Add ${slot.role}`}]`;
}

export interface PlaceholderFound {
  /** Dotted path of IDs and item indexes: `hours.2.time`, or `list.2` in a flat group. */
  path: string;
  slot: Slot;
  reason: 'text' | 'link' | 'image';
}

/** Every slot that still holds a placeholder, for the checklist and the publish warning. */
export function findPlaceholders(slots: Slot[], prefix = ''): PlaceholderFound[] {
  const found: PlaceholderFound[] = [];
  for (const slot of slots) {
    const path = prefix + slot.id;
    switch (slot.kind) {
      case 'group':
        slot.items.forEach((item, index) => {
          const inner = findPlaceholders(item, `${path}.${index}.`);
          // A flat item is addressed by its index alone: `list.2`.
          if (slot.flat) for (const f of inner) f.path = `${path}.${index}`;
          found.push(...inner);
        });
        break;
      case 'image':
        if (!slot.value.url) found.push({ path, slot, reason: 'image' });
        break;
      case 'button':
        if (isPlaceholder(slot.value.text)) found.push({ path, slot, reason: 'text' });
        else if (slot.value.url === '' || slot.value.url === '#') {
          found.push({ path, slot, reason: 'link' });
        }
        break;
      default:
        if (isPlaceholder(slot.value)) found.push({ path, slot, reason: 'text' });
    }
  }
  return found;
}
