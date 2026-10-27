/**
 * Shapes used by the theme.json engine. theme.json is open-ended JSON, so the
 * tree is typed loosely (`JsonObject`) and read through the path helpers in
 * util.ts, the way WordPress reads it with _wp_array_get().
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** A theme.json document (schema version 2 or 3). */
export interface ThemeJsonData extends JsonObject {
  version?: number;
  settings?: JsonObject;
  styles?: JsonObject;
  templateParts?: JsonValue[];
  customTemplates?: JsonValue[];
  patterns?: JsonValue[];
  title?: string;
  slug?: string;
  blockTypes?: JsonValue[];
}

/** WP_Theme_JSON::VALID_ORIGINS */
export type Origin = 'default' | 'blocks' | 'theme' | 'custom';

/** What get_blocks_metadata() needs to know about a block type (from its block.json). */
export interface BlockStyleMetadata {
  supports: JsonObject;
  selectors?: JsonObject;
  /** Names of its registered style variations (block.json `styles`, register_block_style()). */
  styles?: string[];
}

/** One entry of WP_Theme_JSON::get_blocks_metadata(). */
export interface BlockMetadata {
  name: string;
  selector: string;
  selectors: JsonObject;
  elements: Record<string, string>;
  duotone?: string;
  styleVariations: Record<string, string>;
  states?: JsonObject;
  supports: JsonObject;
}

export type BlocksMetadata = Record<string, BlockMetadata>;

/** A CSS declaration, as WP_Theme_JSON builds them before to_ruleset(). */
export interface Declaration {
  name: string;
  value: string;
}

export interface StylesheetOptions {
  /** Prefix every selector with this one (WP_Theme_JSON::scope_selector()). */
  scope?: string;
  /** Replace `body` / `:root` as the root selector (the editor uses this). */
  rootSelector?: string;
  /** Leave out the root layout rules (block style variation instances). */
  skipRootLayoutStyles?: boolean;
  /** Include style variation nodes of blocks (per-instance variation styles). */
  includeBlockStyleVariations?: boolean;
}

export type StylesheetType = 'variables' | 'styles' | 'presets' | 'custom-css';
