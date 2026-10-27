/**
 * The shape of a parsed block — WP_Block_Parser_Block
 * (wordpress/wp-includes/class-wp-block-parser-block.php), as parse_blocks()
 * returns it. Freeform (classic) HTML between blocks has `blockName: null`.
 */
export interface ParsedBlock {
  /** `namespace/name`; `core/` is added when the delimiter has no namespace. Null for freeform HTML. */
  blockName: string | null;
  /** Attributes decoded from the delimiter's JSON. */
  attrs: BlockAttributes;
  innerBlocks: ParsedBlock[];
  /** The block's own HTML, with inner blocks removed. */
  innerHTML: string;
  /** HTML fragments, with `null` wherever an inner block sits (in order). */
  innerContent: (string | null)[];
}

export type BlockAttributes = Record<string, unknown>;

/** Values a block passes down to its descendants (`providesContext` / `usesContext`). */
export type BlockContext = Record<string, unknown>;

/**
 * A JSON Schema subset, as block.json attribute definitions use it and as
 * rest_validate_value_from_schema() understands it.
 */
export interface AttributeSchema {
  type?: SchemaType | SchemaType[];
  enum?: unknown[];
  default?: unknown;
  items?: AttributeSchema;
  properties?: Record<string, AttributeSchema>;
  additionalProperties?: boolean | AttributeSchema;
  minimum?: number;
  maximum?: number;
  /** block.json keys the server ignores but the editor reads (source, selector, attribute, role…). */
  [key: string]: unknown;
}

export type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
