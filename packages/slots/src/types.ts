/**
 * Slots: the editable content of a pattern (a section), as typed, ordered
 * values. See docs/architecture/patterns.md and ADR 0024.
 *
 * A slot is found by walking a pattern's blocks. Text is rich text, in the
 * same form the block editor stores it: inline HTML (`<em>`, `<strong>`,
 * `<a href>`, `<br>`), with `&`, `<` and `>` escaped.
 */

/** heading, text (paragraph, list item, summary, citation…), button, image or a repeated group. */
export type SlotKind = 'heading' | 'text' | 'button' | 'image' | 'group';

/**
 * What a slot is for. Inferred roles: `title` (the first heading of a
 * section or of a group item), `eyebrow` (a paragraph before the title),
 * `heading`, `body`, `item` (list item), `summary` (of a details block),
 * `citation`, `action` (button), `media` (image), and for groups `list`,
 * `actions`, `gallery` and `items`. A declaration can give any role, such
 * as `price` or `quote`.
 */
export type SlotRole = string;

interface SlotBase {
  /**
   * Unique among its siblings: the slug of the block's name (List View's
   * "Rename", `metadata.name`), else the role, with `-2`, `-3`… for repeats.
   */
  id: string;
  kind: SlotKind;
  role: SlotRole;
  /** The block's name, or a declared label. For people (Studio) and the model. */
  label?: string;
  /** Declared guidance for the model and the editor. */
  description?: string;
  /** Indexes from the pattern's root block list through `innerBlocks` to the slot's block. */
  path: number[];
  /**
   * Honest content: fill only from facts the person gave (prices, hours,
   * names, quotes…); otherwise use the placeholder.
   */
  facts?: boolean;
  /** Text to use when the value isn't known, such as `[Add a customer quote]`. */
  placeholder?: string;
}

export interface TextSlot extends SlotBase {
  kind: 'heading' | 'text';
  /** The block holding the text: `core/paragraph`, `core/heading`, `core/list-item`… */
  block: string;
  /** Rich text (inline HTML). */
  value: string;
  /** Characters of plain text in the pattern's own value. */
  length: number;
  /** A limit taken from the pattern's own text, or declared. */
  maxLength: number;
  /** For headings: 1–6. */
  level?: number;
}

export interface ButtonValue {
  /** Rich text. */
  text: string;
  /** The link; `#` or empty while it isn't known. */
  url: string;
}

export interface ButtonSlot extends SlotBase {
  kind: 'button';
  block: string;
  value: ButtonValue;
  length: number;
  maxLength: number;
}

export interface ImageValue {
  /** Empty while no image is chosen. Omitted when filling: the image is kept. */
  url?: string;
  /** Alternative text; empty for a decorative image. */
  alt?: string;
  /** The media item (attachment) ID, when the image is from the library. */
  id?: number;
  /** What the image should show, as a search for the media library or Openverse. */
  subject?: string;
}

export interface ImageSlot extends SlotBase {
  kind: 'image';
  block: string;
  value: ImageValue & { url: string; alt: string };
  /** What the image should show: declared, or taken from its alt text. */
  subject?: string;
}

export interface GroupSlot extends SlotBase {
  kind: 'group';
  /** The block whose inner blocks repeat (`core/columns`, `core/list`…). */
  block: string;
  /** The block that repeats (`core/column`, `core/list-item`…). */
  itemBlock: string;
  /** Each item's slots, in order. */
  items: Slot[][];
  /**
   * Items that hold a single slot (list items, buttons, gallery images) take
   * that slot's value directly: `["One site", "Five sites"]` rather than
   * `[{ "item": "One site" }, …]`.
   */
  flat: boolean;
  minItems: number;
  maxItems: number;
}

export type Slot = TextSlot | ButtonSlot | ImageSlot | GroupSlot;

/** Values keyed by slot ID: what fillSlots() writes and an AI model returns. */
export interface SlotValues {
  [id: string]: SlotValue;
}

export type SlotValue = string | ButtonValue | ImageValue | SlotValue[] | SlotValues;

/**
 * Overrides for the inferred slots, from a pattern's metadata (`Slots:`
 * header in a PHP pattern, `slots` in a library pattern's JSON). Keys are
 * slot IDs; a slot inside a group item is `group.child` (for example
 * `hours.day`).
 */
export type SlotDeclarations = Record<string, SlotDeclaration>;

export interface SlotDeclaration {
  role?: SlotRole;
  label?: string;
  description?: string;
  /** Text and buttons. */
  maxLength?: number;
  /** Groups. */
  minItems?: number;
  maxItems?: number;
  /** Images: what the picture should show. */
  subject?: string;
  facts?: boolean;
  placeholder?: string;
  /** Not a slot: leave the content as the pattern has it. */
  ignore?: boolean;
}

export interface SlotOptions {
  declarations?: SlotDeclarations;
}

export interface FillOptions extends SlotOptions {
  /**
   * `html` (default): text values are rich text and are written as given.
   * `text`: text values are plain text and are escaped (use it for a model's
   * output: `generateJson()` returns plain text).
   */
  format?: 'html' | 'text';
}
