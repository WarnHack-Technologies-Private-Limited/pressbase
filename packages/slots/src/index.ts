/**
 * @pressbase/slots — a pattern's editable content as typed slots, the base
 * of Studio's Swap layout and of building sections with AI. Pure functions
 * over parsed blocks (@pressbase/blocks); no I/O, so it runs in core and in
 * the browser. See docs/architecture/patterns.md and ADR 0024.
 *
 *   const blocks = parseBlocks(pattern.content);
 *   const slots = extractSlots(blocks, { declarations: pattern.slots });
 *   const schema = slotsJsonSchema(slots);               // for generateJson()
 *   const filled = fillSlots(blocks, answer, { declarations: pattern.slots, format: 'text' });
 *   const markup = serializeBlocks(filled);
 */
export { parseSlotDeclarations, SlotDeclarationError, unknownDeclarations } from './declarations';
export { plainToRichText, richTextToPlain } from './html';
export {
  findPlaceholders,
  isPlaceholder,
  PLACEHOLDER_PATTERN,
  type PlaceholderFound,
  placeholderFor,
} from './placeholders';
export { type JsonSchema, slotsJsonSchema } from './schema';
export { extractSlots, fillSlots, slotValues } from './slots';
export { type SlotTransfer, transferSlots, type UnusedValue } from './transfer';
export type {
  ButtonSlot,
  ButtonValue,
  FillOptions,
  GroupSlot,
  ImageSlot,
  ImageValue,
  Slot,
  SlotDeclaration,
  SlotDeclarations,
  SlotKind,
  SlotOptions,
  SlotRole,
  SlotValue,
  SlotValues,
  TextSlot,
} from './types';
