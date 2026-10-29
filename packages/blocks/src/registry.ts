import type { WPBlock } from './block';
import { validateValueFromSchema } from './schema';
import type { AttributeSchema, BlockAttributes } from './types';

/**
 * Block types — WP_Block_Type and WP_Block_Type_Registry
 * (wordpress/wp-includes/class-wp-block-type.php, class-wp-block-type-registry.php).
 *
 * Keys follow block.json (camelCase), so a block.json file can be spread into
 * `register()`. A block with a `render` callback is dynamic: its output is
 * produced on the server every time it is displayed.
 */

/** render_callback: ( $attributes, $content, $block ) */
export type RenderCallback<S = unknown> = (
  attributes: BlockAttributes,
  content: string,
  block: WPBlock<S>,
) => string | undefined | null | Promise<string | undefined | null>;

export type BlockSupports = Record<string, unknown>;

export interface BlockStyle {
  name: string;
  label: string;
  isDefault?: boolean;
}

export interface BlockTypeArgs<S = unknown> {
  apiVersion?: number;
  title?: string;
  description?: string;
  category?: string | null;
  icon?: string | null;
  keywords?: string[];
  parent?: string[] | null;
  ancestor?: string[] | null;
  allowedBlocks?: string[] | null;
  attributes?: Record<string, AttributeSchema>;
  /** Context names this block reads from its ancestors (block.json `usesContext`). */
  usesContext?: string[];
  /** Context name → attribute name this block provides to its descendants. */
  providesContext?: Record<string, string>;
  supports?: BlockSupports;
  styles?: BlockStyle[];
  selectors?: Record<string, unknown>;
  example?: unknown;
  variations?: unknown[];
  textdomain?: string | null;
  /**
   * Script and style handles (WP_Block_Type's `editor_script_handles`,
   * `style_handles`, `editor_style_handles`). The host enqueues
   * `styleHandles` on pages that show the block, as WP_Block::render() does.
   */
  editorScriptHandles?: string[];
  styleHandles?: string[];
  editorStyleHandles?: string[];
  /** Makes the block dynamic. Called with prepared attributes, rendered inner content and the block. */
  render?: RenderCallback<S>;
}

/** WP_Block_Type::GLOBAL_ATTRIBUTES — every block may carry these. */
const GLOBAL_ATTRIBUTES: Record<string, AttributeSchema> = {
  lock: { type: 'object' },
  metadata: { type: 'object' },
};

/** block_has_support(): reads `supports` by path, e.g. ['color', 'link']. */
export function blockHasSupport(
  supports: BlockSupports | undefined,
  feature: string | string[],
  defaultValue = false,
): boolean {
  let value: unknown = supports;
  for (const key of Array.isArray(feature) ? feature : [feature]) {
    if (!value || typeof value !== 'object') return defaultValue;
    value = (value as Record<string, unknown>)[key];
  }
  if (value === undefined) return defaultValue;
  return value !== false && value !== null;
}

/**
 * The attributes block supports add — the register_attribute callbacks in
 * wordpress/wp-includes/block-supports/*.php (align, anchor, border, colors,
 * custom-classname, layout, spacing, typography).
 */
function addSupportAttributes(
  attributes: Record<string, AttributeSchema>,
  supports: BlockSupports | undefined,
): void {
  const add = (name: string, schema: AttributeSchema) => {
    if (!(name in attributes)) attributes[name] = schema;
  };
  if (blockHasSupport(supports, 'align')) {
    add('align', { type: 'string', enum: ['left', 'center', 'right', 'wide', 'full', ''] });
  }
  if (blockHasSupport(supports, 'anchor')) add('anchor', { type: 'string' });
  if (blockHasSupport(supports, 'customClassName', true)) add('className', { type: 'string' });

  const color = blockHasSupport(supports, 'color');
  if (color) {
    add('style', { type: 'object' });
    if (blockHasSupport(supports, ['color', 'background'], true))
      add('backgroundColor', { type: 'string' });
    if (blockHasSupport(supports, ['color', 'text'], true)) add('textColor', { type: 'string' });
    if (blockHasSupport(supports, ['color', 'gradients'])) add('gradient', { type: 'string' });
  }
  if (blockHasSupport(supports, '__experimentalBorder')) {
    add('style', { type: 'object' });
    if (blockHasSupport(supports, ['__experimentalBorder', 'color']))
      add('borderColor', { type: 'string' });
  }
  if (blockHasSupport(supports, 'spacing')) add('style', { type: 'object' });
  if (blockHasSupport(supports, 'layout') || blockHasSupport(supports, '__experimentalLayout')) {
    add('layout', { type: 'object' });
  }
  if (blockHasSupport(supports, 'typography')) {
    add('style', { type: 'object' });
    if (blockHasSupport(supports, ['typography', 'fontSize'])) add('fontSize', { type: 'string' });
    if (blockHasSupport(supports, ['typography', '__experimentalFontFamily']))
      add('fontFamily', { type: 'string' });
  }
}

export class BlockType<S = unknown> {
  readonly name: string;
  readonly apiVersion: number;
  readonly title: string;
  readonly description: string;
  readonly category: string | null;
  readonly icon: string | null;
  readonly keywords: string[];
  readonly parent: string[] | null;
  readonly ancestor: string[] | null;
  readonly allowedBlocks: string[] | null;
  readonly attributes: Record<string, AttributeSchema>;
  readonly usesContext: string[];
  readonly providesContext: Record<string, string>;
  readonly supports: BlockSupports;
  readonly styles: BlockStyle[];
  readonly selectors: Record<string, unknown>;
  readonly example: unknown;
  readonly variations: unknown[];
  readonly textdomain: string | null;
  readonly editorScriptHandles: string[];
  readonly styleHandles: string[];
  readonly editorStyleHandles: string[];
  readonly render: RenderCallback<S> | undefined;

  constructor(name: string, args: BlockTypeArgs<S>) {
    this.name = name;
    this.apiVersion = args.apiVersion ?? 1;
    this.title = args.title ?? '';
    this.description = args.description ?? '';
    this.category = args.category ?? null;
    this.icon = args.icon ?? null;
    this.keywords = args.keywords ?? [];
    this.parent = args.parent ?? null;
    this.ancestor = args.ancestor ?? null;
    this.allowedBlocks = args.allowedBlocks ?? null;
    this.usesContext = args.usesContext ?? [];
    this.providesContext = args.providesContext ?? {};
    this.supports = args.supports ?? {};
    this.styles = args.styles ?? [];
    this.selectors = args.selectors ?? {};
    this.example = args.example ?? null;
    this.variations = args.variations ?? [];
    this.textdomain = args.textdomain ?? null;
    this.editorScriptHandles = args.editorScriptHandles ?? [];
    this.styleHandles = args.styleHandles ?? [];
    this.editorStyleHandles = args.editorStyleHandles ?? [];
    this.render = args.render;

    const attributes: Record<string, AttributeSchema> = { ...args.attributes };
    for (const [key, schema] of Object.entries(GLOBAL_ATTRIBUTES)) {
      if (!(key in attributes)) attributes[key] = schema;
    }
    addSupportAttributes(attributes, this.supports);
    this.attributes = attributes;
  }

  /** WP_Block_Type::is_dynamic() */
  isDynamic(): boolean {
    return typeof this.render === 'function';
  }

  /**
   * WP_Block_Type::prepare_attributes_for_render(): drops values that don't
   * match their schema, then fills in defaults for anything missing.
   * Attributes the type doesn't define pass through untouched.
   */
  prepareAttributesForRender(attributes: BlockAttributes): BlockAttributes {
    const out: BlockAttributes = { ...attributes };
    for (const [name, value] of Object.entries(out)) {
      const schema = this.attributes[name];
      if (schema && validateValueFromSchema(value, schema, name) !== null) delete out[name];
    }
    for (const [name, schema] of Object.entries(this.attributes)) {
      if (!(name in out) && schema.default !== undefined && schema.default !== null) {
        out[name] = JSON.parse(JSON.stringify(schema.default));
      }
    }
    return out;
  }
}

/** Block names are `namespace/name`, lowercase letters, digits and dashes. */
const BLOCK_NAME = /^[a-z0-9-]+\/[a-z0-9-]+$/;

export class BlockTypeRegistry<S = unknown> {
  #types = new Map<string, BlockType<S>>();

  /** WP_Block_Type_Registry::register(). Throws on an invalid or duplicate name. */
  register(name: string, args: BlockTypeArgs<S> = {}): BlockType<S> {
    if (!BLOCK_NAME.test(name)) {
      throw new Error(
        `Block type names must contain a namespace prefix and use lowercase letters, digits and dashes, e.g. "my-plugin/my-custom-block": "${name}".`,
      );
    }
    if (this.#types.has(name)) throw new Error(`Block type "${name}" is already registered.`);
    const type = new BlockType<S>(name, args);
    this.#types.set(name, type);
    return type;
  }

  unregister(name: string): BlockType<S> | undefined {
    const type = this.#types.get(name);
    this.#types.delete(name);
    return type;
  }

  get(name: string | null | undefined): BlockType<S> | undefined {
    return name ? this.#types.get(name) : undefined;
  }

  isRegistered(name: string): boolean {
    return this.#types.has(name);
  }

  all(): BlockType<S>[] {
    return [...this.#types.values()];
  }
}
