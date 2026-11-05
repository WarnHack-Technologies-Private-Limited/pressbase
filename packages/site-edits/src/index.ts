/**
 * @pressbase/site-edits — Studio's edit operations (the plan's "edits after
 * generation"): `insertSection`, `replaceSection`, `moveSection`,
 * `removeSection`, `updateSlots`, `updateBlockAttributes` (presets only),
 * `setGlobalStyles`, `updateTemplatePart`, `createPage` and `updateMenu`.
 * Their types, the JSON Schema a model answers with, and the checks that
 * need only the set, shared by core (which checks them against the site)
 * and the admin (which applies them with Keep and Undo).
 * See docs/architecture/ai-edits.md.
 *
 *   const { operations, problems } = checkOperations(answer.operations);
 *   if (problems.length) return problems[0].message;
 */
export {
  checkOperations,
  type EditProblem,
  isPageOperation,
  isSafeLink,
  presetProblem,
} from './check';
export {
  EDIT_OPERATION_SCHEMA,
  EDIT_OPERATION_TYPES,
  EDIT_SET_SCHEMA,
  INDEX_INPUT,
  MAX_MENU_ITEMS,
  MAX_OPERATIONS,
  PATTERN_INPUT,
  PRESET_ATTRIBUTES_SCHEMA,
  SECTION_OPERATION_SCHEMA,
  SLOTS_INPUT,
} from './schema';
export type {
  CreatePage,
  EditOperation,
  EditOperationType,
  InsertSection,
  MenuItem,
  MoveSection,
  NewSection,
  PageOperation,
  PageRef,
  PresetAttributes,
  RemoveSection,
  ReplaceSection,
  SectionOperation,
  SetGlobalStyles,
  SlotValuesInput,
  UpdateBlockAttributes,
  UpdateMenu,
  UpdateSlots,
  UpdateTemplatePart,
} from './types';
