import {
  isPlaceholder,
  placeholderFor,
  type Slot,
  type SlotValue,
  type SlotValues,
} from '@pressbase/slots';

/**
 * Honest content (the plan's "Honest content", ADR 0024): the site states
 * as facts only what the person gave. The prompt asks for it; this module
 * makes sure of it after every answer, in code:
 *
 * - **Fact slots** (declared `facts`, and in sections about facts, such as
 *   testimonials, team, pricing, statistics, contact and opening hours,
 *   every slot of a repeated item and every citation) keep a value only
 *   when it is found in the facts; otherwise they get their placeholder.
 * - **Every other slot** is copy, and may say anything general, but a
 *   number, an email address, a phone number or a web address it gives
 *   must come from the facts too; otherwise the slot gets its placeholder.
 * - **Links**: `tel:` and `mailto:` links and addresses on other sites
 *   must be in the facts; otherwise the link becomes `#`, which the
 *   "Before you publish" checklist lists.
 *
 * "Found in the facts" is deliberately strict: the model may reword copy,
 * not facts. Pure functions, no I/O. See docs/architecture/site-builder.md.
 */

/** Categories whose sections are mostly facts: their items and citations are fact slots. */
export const FACT_CATEGORIES = new Set([
  'testimonials',
  'team',
  'pricing',
  'stats',
  'statistics',
  'contact',
  'opening-hours',
  'hours',
  'location',
]);

/** What the facts say, normalised for lookups. */
export interface Grounding {
  /** Every fact, lower-cased, with punctuation as spaces. */
  text: string;
  words: Set<string>;
  /** Digit runs, thousands separators removed: `1,200` → `1200`. */
  numbers: Set<string>;
  /** Email addresses and web addresses, lower-cased. */
  addresses: Set<string>;
  /** Each fact's digits run together, for phone numbers written another way. */
  digits: string[];
}

const normalise = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const numbersIn = (text: string) =>
  (text.normalize('NFKC').replace(/(\d)[,.](?=\d{3}\b)/g, '$1').match(/\d+/g) ?? []).map((n) =>
    n.replace(/^0+(?=\d)/, ''),
  );

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const WEB = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/giu;

const addressesIn = (text: string) =>
  [...(text.match(EMAIL) ?? []), ...(text.match(WEB) ?? [])].map((a) =>
    a
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[/.]+$/, ''),
  );

/** Content words: letters only, three or more of them. */
const wordsIn = (text: string) =>
  normalise(text)
    .split(' ')
    .filter((w) => w.length >= 3 && !/\d/.test(w));

export function groundingFrom(facts: string[]): Grounding {
  const all = facts.join('\n');
  return {
    text: ` ${normalise(all)} `,
    words: new Set(wordsIn(all)),
    numbers: new Set(numbersIn(all)),
    addresses: new Set(addressesIn(all)),
    digits: facts.map((f) => f.replace(/\D/g, '')).filter(Boolean),
  };
}

/** Numbers, email and web addresses in `text` that the facts don't have. */
export function unsupportedDetails(text: string, grounding: Grounding): string[] {
  const missing = numbersIn(text).filter((n) => !grounding.numbers.has(n));
  for (const address of addressesIn(text)) {
    if (!grounding.addresses.has(address) && !grounding.text.includes(normalise(address))) {
      missing.push(address);
    }
  }
  return missing;
}

/**
 * Whether `text` states only what the facts say: a placeholder, or text
 * whose numbers and addresses are all in the facts and whose words are
 * (nearly all) the facts' words.
 */
export function isGrounded(text: string, grounding: Grounding): boolean {
  const value = text.trim();
  if (!value || isPlaceholder(value)) return true;
  if (unsupportedDetails(value, grounding).length) return false;
  const normal = normalise(value);
  if (normal && grounding.text.includes(` ${normal} `)) return true;
  const words = wordsIn(value);
  if (!words.length) return numbersIn(value).length > 0;
  const known = words.filter((w) => grounding.words.has(w)).length;
  return known / words.length >= 0.8;
}

export interface HonestResult {
  values: SlotValues;
  /** Slot paths whose value was replaced by a placeholder (or a link by `#`). */
  replaced: string[];
}

interface Walk {
  grounding: Grounding;
  factSection: boolean;
  replaced: string[];
}

const textOf = (value: unknown) => (typeof value === 'string' ? value : '');

function checkLink(url: string, grounding: Grounding): boolean {
  const link = url.trim();
  if (!link || link === '#' || link.startsWith('/') || link.startsWith('#')) return true;
  if (/^tel:/i.test(link)) {
    const digits = link.replace(/\D/g, '').replace(/^0+/, '');
    return digits.length >= 3 && grounding.digits.some((d) => d.includes(digits));
  }
  if (/^mailto:/i.test(link)) {
    return grounding.addresses.has(link.slice(7).split('?')[0]?.toLowerCase() ?? '');
  }
  return unsupportedDetails(link, grounding).length === 0;
}

function walkLeaf(slot: Slot, value: SlotValue, path: string, strict: boolean, walk: Walk) {
  const { grounding } = walk;
  const strictHere = strict || Boolean(slot.facts) || (walk.factSection && slot.role === 'citation');
  switch (slot.kind) {
    case 'heading':
    case 'text': {
      const text = textOf(value);
      if (isPlaceholder(text)) return text;
      const ok = strictHere
        ? isGrounded(text, grounding)
        : unsupportedDetails(text, grounding).length === 0;
      if (ok) return text;
      walk.replaced.push(path);
      return placeholderFor(slot);
    }
    case 'button': {
      const button = (value && typeof value === 'object' ? value : {}) as {
        text?: string;
        url?: string;
      };
      const text = textOf(button.text);
      const url = textOf(button.url);
      const out = { text, url };
      const textOk =
        isPlaceholder(text) ||
        (strictHere ? isGrounded(text, grounding) : !unsupportedDetails(text, grounding).length);
      if (!textOk) {
        out.text = placeholderFor(slot);
        walk.replaced.push(path);
      }
      if (!checkLink(url, grounding)) {
        out.url = '#';
        if (textOk) walk.replaced.push(`${path}.url`);
      }
      return out;
    }
    case 'image': {
      const image = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
      const alt = textOf(image.alt);
      // Alt text describes the picture; it mustn't carry invented details either.
      if (alt && unsupportedDetails(alt, grounding).length) {
        walk.replaced.push(`${path}.alt`);
        return { ...image, alt: '' };
      }
      return image as SlotValue;
    }
    default:
      return value;
  }
}

function walkSlots(
  slots: Slot[],
  values: SlotValues,
  prefix: string,
  strict: boolean,
  walk: Walk,
): SlotValues {
  const out: SlotValues = {};
  for (const [id, value] of Object.entries(values)) {
    const slot = slots.find((s) => s.id === id);
    if (!slot || value === undefined) {
      out[id] = value;
      continue;
    }
    out[id] = walkSlot(slot, value, `${prefix}${id}`, strict, walk);
  }
  return out;
}

function walkSlot(slot: Slot, value: SlotValue, path: string, strict: boolean, walk: Walk) {
  if (slot.kind !== 'group') return walkLeaf(slot, value, path, strict, walk);
  if (!Array.isArray(value)) return value;
  const template = slot.items[slot.items.length - 1] ?? [];
  // In a section about facts, every item is a fact (a quote, a price, a person).
  const itemStrict = strict || Boolean(slot.facts) || walk.factSection;
  return value.map((item, index) => {
    if (slot.flat && template[0]) {
      return walkSlot(template[0], item, `${path}.${index}`, itemStrict, walk);
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return walkSlots(template, item as SlotValues, `${path}.${index}.`, itemStrict, walk);
  });
}

/**
 * The model's slot values for a section, made honest: what the facts don't
 * support becomes the slot's placeholder. `category` is the section's.
 */
export function enforceHonestContent(
  slots: Slot[],
  values: SlotValues,
  grounding: Grounding,
  category?: string,
): HonestResult {
  const walk: Walk = {
    grounding,
    factSection: category ? FACT_CATEGORIES.has(category) : false,
    replaced: [],
  };
  return { values: walkSlots(slots, values, '', false, walk), replaced: walk.replaced };
}

/**
 * Facts a model drew from the person's own words (the Brief stage): kept
 * only when the person's text supports them, so the model can't add one.
 */
export function groundedFacts(facts: string[], source: Grounding): string[] {
  return facts.filter((fact) => isGrounded(fact, source));
}
