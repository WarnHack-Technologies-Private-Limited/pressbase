import { parseBlocks } from '@pressbase/blocks';
import {
  extractSlots,
  isPlaceholder,
  richTextToPlain,
  type Slot,
  type SlotDeclarations,
} from '@pressbase/slots';

/**
 * *Ask AI* on a section or on selected text (#63), the pure part: which
 * texts to send (`sectionTexts()`, `selectionText()`), and how the answer
 * becomes an `updateSlots` operation (`slotsUpdate()`), applied with Keep
 * and Undo like any AI edit (use-ai-edits.ts). Slots are read as the
 * applier reads them: `extractSlots()` on the section with its pattern's
 * declarations. See docs/architecture/ai-edits.md#ask-ai.
 */

export const REWRITE_ACTIONS = [
  'rewrite',
  'shorten',
  'expand',
  'tone',
  'translate',
  'fix_spelling',
] as const;
export type RewriteAction = (typeof REWRITE_ACTIONS)[number];
export const TONES = ['friendly', 'formal', 'confident', 'simple', 'playful'] as const;
export type Tone = (typeof TONES)[number];

/** Where a text is among a section's slots: a slot ID, then item indexes and IDs within groups. */
export type SlotAddress = (string | number)[];

export interface SlotText {
  /** The address joined with dots (`title`, `items.2.title`, `list.1`): the request's ID. */
  id: string;
  address: SlotAddress;
  kind: 'heading' | 'text' | 'button';
  /** Plain text. */
  text: string;
  /** The block's path from the section's root list (the section is `[0]`). */
  path: number[];
}

/** The section's root blocks from its markup (whitespace between blocks dropped). */
const rootsOf = (markup: string) => parseBlocks(markup).filter((b) => b.blockName !== null);

/** The section's slots, as the applier reads them. */
export function sectionSlots(markup: string, declarations?: SlotDeclarations): Slot[] {
  return extractSlots(rootsOf(markup), { declarations });
}

function collect(slots: Slot[], prefix: SlotAddress, out: SlotText[]): void {
  for (const slot of slots) {
    const address = [...prefix, slot.id];
    if (slot.kind === 'group') {
      slot.items.forEach((item, index) => {
        if (slot.flat && item.length === 1 && item[0]) {
          const inner: SlotText[] = [];
          collect(item, [...prefix, slot.id, index], inner);
          // A flat item is addressed by its index alone.
          for (const t of inner) {
            t.address = [...prefix, slot.id, index];
            t.id = t.address.join('.');
          }
          out.push(...inner);
        } else collect(item, [...prefix, slot.id, index], out);
      });
      continue;
    }
    if (slot.kind === 'image') continue;
    const raw = slot.kind === 'button' ? slot.value.text : slot.value;
    const text = richTextToPlain(raw).trim();
    // Placeholders stay for the person to fill: AI doesn't make up what goes there.
    if (!text || isPlaceholder(text)) continue;
    out.push({ id: address.join('.'), address, kind: slot.kind, text, path: slot.path });
  }
}

/** Every text in a section a rewrite can change: headings, paragraphs, list items, buttons. */
export function sectionTexts(markup: string, declarations?: SlotDeclarations): SlotText[] {
  const out: SlotText[] = [];
  collect(sectionSlots(markup, declarations), [], out);
  return out;
}

/** Every text slot, placeholders included (to find the one a block holds). */
function allTexts(slots: Slot[], prefix: SlotAddress = []): SlotText[] {
  const out: SlotText[] = [];
  for (const slot of slots) {
    const address = [...prefix, slot.id];
    if (slot.kind === 'group') {
      slot.items.forEach((item, index) => {
        const inner = allTexts(item, [...prefix, slot.id, index]);
        if (slot.flat && item.length === 1) {
          for (const t of inner) {
            t.address = [...prefix, slot.id, index];
            t.id = t.address.join('.');
          }
        }
        out.push(...inner);
      });
    } else if (slot.kind !== 'image') {
      const raw = slot.kind === 'button' ? slot.value.text : slot.value;
      out.push({
        id: address.join('.'),
        address,
        kind: slot.kind,
        text: richTextToPlain(raw).trim(),
        path: slot.path,
      });
    }
  }
  return out;
}

const samePath = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((n, i) => n === b[i]);

/**
 * The text a selection asks about: the slot of the block at `path` (from the
 * section's root list), and the selected part of `text` (the block's plain
 * text as the editor holds it). Null when the block isn't one of the
 * section's texts.
 */
export function selectionText(
  markup: string,
  declarations: SlotDeclarations | undefined,
  path: number[],
  text: string,
  range: { start: number; end: number } | null,
): (SlotText & { full: string; start: number; end: number }) | null {
  const found = allTexts(sectionSlots(markup, declarations)).find((t) => samePath(t.path, path));
  if (!found) return null;
  const start = range && range.end > range.start ? Math.max(0, range.start) : 0;
  const end = range && range.end > range.start ? Math.min(text.length, range.end) : text.length;
  const selected = text.slice(start, end).trim();
  if (!selected) return null;
  return { ...found, text: selected, full: text, start, end };
}

/** A selection's text with its new version in place of the selected part. */
export function spliceSelection(
  selection: { full: string; start: number; end: number },
  replacement: string,
): string {
  const { full, start, end } = selection;
  // Keep the spaces around the selection as they were.
  const before = full.slice(0, start);
  const selected = full.slice(start, end);
  const lead = selected.match(/^\s*/)?.[0] ?? '';
  const trail = selected.match(/\s*$/)?.[0] ?? '';
  return `${before}${lead}${replacement}${trail}${full.slice(end)}`;
}

type Values = Record<string, unknown>;

function place(values: Values, address: SlotAddress, value: unknown, slots: Slot[]): void {
  const [id, ...rest] = address;
  const slot = slots.find((s) => s.id === id);
  if (!slot || typeof id !== 'string') return;
  if (!rest.length) {
    values[id] = slot.kind === 'button' ? { text: value } : value;
    return;
  }
  if (slot.kind !== 'group') return;
  const [index, ...inner] = rest;
  if (typeof index !== 'number') return;
  // The whole group, its other items left as they are (null).
  const items = Array.isArray(values[id])
    ? (values[id] as unknown[])
    : Array.from({ length: slot.items.length }, () => null);
  values[id] = items;
  const item = slot.items[index];
  if (!item) return;
  if (slot.flat && item.length === 1 && !inner.length) {
    const only = item[0] as Slot;
    items[index] = only.kind === 'button' ? { text: value } : value;
    return;
  }
  const itemValues = (items[index] as Values | null) ?? {};
  items[index] = itemValues;
  place(itemValues, inner, value, item);
}

/**
 * The `slots` of an `updateSlots` operation that writes `changes` (plain
 * text by address) and leaves the rest of the section as it is: a group's
 * other items are `null`, so they keep their own text and formatting.
 */
export function slotsUpdate(
  markup: string,
  declarations: SlotDeclarations | undefined,
  changes: readonly { address: SlotAddress; text: string }[],
): Values {
  const slots = sectionSlots(markup, declarations);
  const values: Values = {};
  for (const change of changes) place(values, change.address, change.text, slots);
  return values;
}

/** The language names offered for Translate, in English (the model reads them). */
export const LANGUAGES = [
  'English',
  'French',
  'German',
  'Spanish',
  'Italian',
  'Portuguese',
  'Dutch',
  'Polish',
  'Swedish',
  'Hindi',
  'Japanese',
  'Chinese',
  'Arabic',
] as const;
