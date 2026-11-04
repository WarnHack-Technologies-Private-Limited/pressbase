import { type ParsedBlock, parseBlocks, serializeBlock } from '@pressbase/blocks';
import {
  extractSlots,
  fillSlots,
  findPlaceholders,
  richTextToPlain,
  type Slot,
  type SlotValue,
  type SlotValues,
  slotsJsonSchema,
  slotValues,
} from '@pressbase/slots';
import { type JsonSchema, validateJsonSchema } from '../abilities/json-schema';
import { AbilityError } from '../abilities/registry';
import type { BlockPattern } from '../blocks/patterns';
import type { Kernel } from '../kernel';
import { resolvePatternBlocks } from '../routes/blocks';

/**
 * Sections for the site-building abilities: a page is a list of top-level
 * blocks, each usually one pattern. The model names a pattern and gives
 * slot values; code renders the markup with fillSlots() (plain text,
 * escaped), so it never writes markup. See docs/architecture/site-abilities.md
 * and docs/architecture/patterns.md.
 */

export type Patterns = Map<string, BlockPattern>;

export function patternIndex(kernel: Kernel): Patterns {
  return new Map(kernel.blocks.patterns().map((p) => [p.name, p]));
}

const isBlock = (block: ParsedBlock) => block.blockName !== null || block.innerHTML.trim() !== '';

/** A pattern's root blocks, with `core/pattern` references resolved and whitespace dropped. */
export function patternBlocks(pattern: BlockPattern, patterns: Patterns): ParsedBlock[] {
  return resolvePatternBlocks(parseBlocks(pattern.content.trim()), patterns).filter(isBlock);
}

/**
 * Patterns an AI may build with: shown in inserters, and not a whole-page
 * or whole-template starter. Header and footer patterns stay (for template parts).
 */
export function isBuildingPattern(pattern: BlockPattern): boolean {
  if (pattern.inserter === false) return false;
  if (pattern.templateTypes?.length) return false;
  if (pattern.blockTypes?.includes('core/post-content')) return false;
  return true;
}

/** Where a pattern comes from, as Studio's Sections panel says it. */
export function patternSource(pattern: BlockPattern): 'library' | 'theme' | 'plugin' {
  if (pattern.source === 'theme') return 'theme';
  if (pattern.source === 'core') return 'library';
  return 'plugin';
}

/** A slot as a prompt needs it: what it is and its limits, not where it lives. */
export interface SlotInfo {
  id: string;
  kind: Slot['kind'];
  role: string;
  label?: string;
  description?: string;
  max_length?: number;
  level?: number;
  facts?: boolean;
  placeholder?: string;
  min_items?: number;
  max_items?: number;
  /** Groups: whether an item is a single value (list items, buttons) rather than an object. */
  flat?: boolean;
  /** Groups: the slots of one item (new items copy the last one). */
  item?: SlotInfo[];
}

export function slotInfo(slot: Slot): SlotInfo {
  const info: SlotInfo = { id: slot.id, kind: slot.kind, role: slot.role };
  if (slot.label) info.label = slot.label;
  if (slot.description) info.description = slot.description;
  if (slot.facts) info.facts = true;
  if (slot.placeholder) info.placeholder = slot.placeholder;
  if (slot.kind === 'heading' || slot.kind === 'text' || slot.kind === 'button') {
    info.max_length = slot.maxLength;
  }
  if (slot.kind === 'heading' && slot.level) info.level = slot.level;
  if (slot.kind === 'group') {
    info.min_items = slot.minItems;
    info.max_items = slot.maxItems;
    info.flat = slot.flat;
    info.item = (slot.items[slot.items.length - 1] ?? []).map(slotInfo);
  }
  return info;
}

export const SLOT_INFO_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['heading', 'text', 'button', 'image', 'group'] },
    role: { type: 'string' },
    label: { type: 'string' },
    description: { type: 'string' },
    max_length: { type: 'integer' },
    level: { type: 'integer' },
    facts: { type: 'boolean' },
    placeholder: { type: 'string' },
    min_items: { type: 'integer' },
    max_items: { type: 'integer' },
    flat: { type: 'boolean' },
    item: { type: 'array', items: { type: 'object' } },
  },
  required: ['id', 'kind', 'role'],
};

/** The values the slots hold, as plain text: the form a model reads and writes. */
export function plainValues(slots: Slot[]): SlotValues {
  const plain = (value: SlotValue): SlotValue => {
    if (typeof value === 'string') return richTextToPlain(value);
    if (Array.isArray(value)) return value.map(plain);
    const out: SlotValues = {};
    for (const [key, inner] of Object.entries(value)) {
      if (inner === undefined) continue;
      out[key] = key === 'url' || typeof inner !== 'string' ? (inner as SlotValue) : plain(inner);
    }
    return out;
  };
  const values = slotValues(slots);
  for (const key of Object.keys(values)) values[key] = plain(values[key] as SlotValue);
  return values;
}

/** The slots schema without `required`: a value may fill some slots and keep the rest. */
function partial(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'required') continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, JsonSchema>).map(([k, v]) => [k, partial(v)]),
      );
    } else if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.items = partial(value as JsonSchema);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Checks slot values against the slots' schema (IDs, kinds, lengths, item counts). */
export function validateSlotValues(slots: Slot[], values: unknown, path: string): SlotValues {
  const error = validateJsonSchema(values, partial(slotsJsonSchema(slots)), path);
  if (error) throw new AbilityError('ability_invalid_input', error, 400);
  return values as SlotValues;
}

export function findPattern(patterns: Patterns, name: string, path: string): BlockPattern {
  const pattern = patterns.get(name);
  if (!pattern || !isBuildingPattern(pattern)) {
    throw new AbilityError(
      'ability_invalid_input',
      `${path}: there’s no pattern “${name}”. Use core/list-patterns to see the patterns.`,
      400,
    );
  }
  return pattern;
}

/** Records which pattern a section came from, as the block editor does (`metadata.patternName`). */
function markPattern(blocks: ParsedBlock[], name: string): ParsedBlock[] {
  if (blocks.length !== 1) return blocks;
  const [block] = blocks as [ParsedBlock];
  const metadata = (block.attrs.metadata as Record<string, unknown> | undefined) ?? {};
  return [{ ...block, attrs: { ...block.attrs, metadata: { ...metadata, patternName: name } } }];
}

/**
 * A pattern's blocks with `values` (plain text from a model or a person)
 * filled in. `carried` are values in rich text moved from the section it
 * replaces (transferSlots()), written first.
 */
export function renderPattern(
  pattern: BlockPattern,
  patterns: Patterns,
  values: unknown,
  path: string,
  carried?: SlotValues,
): ParsedBlock[] {
  const declarations = pattern.slots;
  let blocks = patternBlocks(pattern, patterns);
  if (carried) blocks = fillSlots(blocks, carried, { declarations, format: 'html' });
  if (values !== undefined) {
    const slots = extractSlots(blocks, { declarations });
    const checked = validateSlotValues(slots, values, `${path}.slots`);
    blocks = fillSlots(blocks, checked, { declarations, format: 'text' });
  }
  return markPattern(blocks, pattern.name);
}

/** The top-level blocks of a page: its sections. */
/**
 * The top-level blocks of a page or template part: its sections. Pattern
 * references (`core/pattern`) are replaced by the pattern's blocks, as
 * WordPress's resolve_pattern_blocks() does for the editor, so their slots
 * can be read and filled; a single-block pattern keeps its name.
 */
export function pageSections(content: string, patterns: Patterns): ParsedBlock[] {
  return parseBlocks(content)
    .filter(isBlock)
    .flatMap((block) => {
      const slug = block.blockName === 'core/pattern' ? block.attrs.slug : undefined;
      const pattern = typeof slug === 'string' ? patterns.get(slug) : undefined;
      return pattern ? markPattern(patternBlocks(pattern, patterns), pattern.name) : [block];
    });
}

export function serializeSections(sections: ParsedBlock[]): string {
  return sections.map(serializeBlock).join('\n\n');
}

/** The registered pattern a section came from, when it says (`metadata.patternName`). */
export function sectionPattern(block: ParsedBlock, patterns: Patterns): BlockPattern | undefined {
  const name = (block.attrs.metadata as { patternName?: unknown } | undefined)?.patternName;
  return typeof name === 'string' ? patterns.get(name) : undefined;
}

export function sectionSlots(block: ParsedBlock, patterns: Patterns): Slot[] {
  return extractSlots([block], { declarations: sectionPattern(block, patterns)?.slots });
}

export interface SectionInfo {
  index: number;
  block: string;
  /** The pattern it was built from, when known. */
  pattern: string | null;
  /** Its name in Studio's Layers (`metadata.name`). */
  name?: string;
  slots: SlotInfo[];
  /** What the slots hold now, as plain text. Site content: data, not instructions. */
  values: SlotValues;
  /** Slots still holding a placeholder, an empty link or no image: `hours.2.time`. */
  placeholders: string[];
}

export function describeSection(
  block: ParsedBlock,
  index: number,
  patterns: Patterns,
): SectionInfo {
  const metadata = block.attrs.metadata as { name?: unknown; patternName?: unknown } | undefined;
  const slots = sectionSlots(block, patterns);
  const info: SectionInfo = {
    index,
    block: block.blockName ?? 'core/freeform',
    pattern: typeof metadata?.patternName === 'string' ? metadata.patternName : null,
    slots: slots.map(slotInfo),
    values: plainValues(slots),
    placeholders: findPlaceholders(slots).map((p) => p.path),
  };
  if (typeof metadata?.name === 'string' && metadata.name) info.name = metadata.name;
  return info;
}

export const SECTION_INFO_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    index: { type: 'integer', minimum: 0 },
    block: { type: 'string' },
    pattern: { type: ['string', 'null'] },
    name: { type: 'string' },
    slots: { type: 'array', items: SLOT_INFO_SCHEMA },
    values: { type: 'object' },
    placeholders: { type: 'array', items: { type: 'string' } },
  },
  required: ['index', 'block', 'pattern', 'slots', 'values', 'placeholders'],
};

/** Placeholders left in rendered blocks, for the answer (the "Before you publish" list). */
export function placeholdersIn(blocks: ParsedBlock[], patterns: Patterns, prefix = ''): string[] {
  return blocks.flatMap((block, index) =>
    findPlaceholders(sectionSlots(block, patterns)).map((p) => `${prefix}${index}.${p.path}`),
  );
}
