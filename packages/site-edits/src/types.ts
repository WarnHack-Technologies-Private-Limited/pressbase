import type { DesignChoice } from '@pressbase/design';

/**
 * Studio's edit operations: the plan's "edits after generation". A model
 * (or a person's command) proposes a set; core checks it against the site,
 * and the admin applies it to the editor as one undo step with Keep and
 * Undo. See docs/architecture/ai-edits.md and ADR 0024.
 *
 * Section operations count sections from 0 and read each index after the
 * operations before them, as `core/update-page-sections` does. `page` names
 * the page by ID or slug; without it, the page open in Studio.
 */

/** Slot values by slot ID, in plain text (see @pressbase/slots). */
export type SlotValuesInput = Record<string, unknown>;

/** Which page a section operation changes: its ID or slug; the open page when left out. */
export type PageRef = number | string;

export interface InsertSection {
  type: 'insertSection';
  page?: PageRef;
  pattern: string;
  slots?: SlotValuesInput;
  /** Where it goes; at the end by default. */
  index?: number;
}

export interface ReplaceSection {
  type: 'replaceSection';
  page?: PageRef;
  index: number;
  pattern: string;
  slots?: SlotValuesInput;
  /** Move the section's content into the new pattern (Swap layout). True by default. */
  keep_content?: boolean;
}

export interface MoveSection {
  type: 'moveSection';
  page?: PageRef;
  index: number;
  to: number;
}

export interface RemoveSection {
  type: 'removeSection';
  page?: PageRef;
  index: number;
}

export interface UpdateSlots {
  type: 'updateSlots';
  page?: PageRef;
  index: number;
  slots: SlotValuesInput;
}

/**
 * Block attributes that hold presets: a colour, gradient, font size or font
 * family by slug, alignment, and `style` values that are preset references
 * (`var:preset|color|accent`) or keywords. `null` removes one.
 */
export interface PresetAttributes {
  backgroundColor?: string | null;
  textColor?: string | null;
  gradient?: string | null;
  borderColor?: string | null;
  fontSize?: string | null;
  fontFamily?: string | null;
  align?: string | null;
  textAlign?: string | null;
  style?: Record<string, unknown> | null;
}

export interface UpdateBlockAttributes {
  type: 'updateBlockAttributes';
  page?: PageRef;
  /** The section. */
  index: number;
  /** The block inside it, by the index of each inner block on the way down; the section itself when empty. */
  block?: number[];
  attributes: PresetAttributes;
}

export interface SetGlobalStyles {
  type: 'setGlobalStyles';
  /** A design direction: code makes the palette, fonts, corners and spacing from it. */
  design?: DesignChoice;
  /** theme.json styles to merge in, with presets only. `null` removes a value. */
  styles?: Record<string, unknown>;
}

export interface UpdateTemplatePart {
  type: 'updateTemplatePart';
  /** `header`, `footer`… */
  slug: string;
  /** Rebuild the part from this pattern… */
  pattern?: string;
  /** …and/or fill these slots (of the part as it is, without a pattern). */
  slots?: SlotValuesInput;
}

export interface NewSection {
  pattern: string;
  slots?: SlotValuesInput;
}

export interface CreatePage {
  type: 'createPage';
  title: string;
  /** Made from the title when left out. */
  slug?: string;
  sections: NewSection[];
  /** What the page becomes when the draft is published. */
  status?: 'publish' | 'draft';
}

export interface MenuItem {
  label: string;
  /** A page by slug (one this set creates, too)… */
  page?: string;
  /** …or an address: a path on the site, or an http(s) link. */
  url?: string;
}

export interface UpdateMenu {
  type: 'updateMenu';
  /** The menu's links, in order: they replace the header menu's. */
  items: MenuItem[];
}

export type SectionOperation =
  | InsertSection
  | ReplaceSection
  | MoveSection
  | RemoveSection
  | UpdateSlots;

export type EditOperation =
  | SectionOperation
  | UpdateBlockAttributes
  | SetGlobalStyles
  | UpdateTemplatePart
  | CreatePage
  | UpdateMenu;

export type EditOperationType = EditOperation['type'];

/** Operations that change sections of a page, and so name one. */
export type PageOperation = SectionOperation | UpdateBlockAttributes;
