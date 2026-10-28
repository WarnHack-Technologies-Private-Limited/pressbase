/**
 * Plugin blocks in the editor: the host side of
 * `window.pressbase.blocks.registerBlockType(name, { edit, save })`
 * (docs/architecture/plugins.md#blocks, ADR 0020).
 *
 * Plugin modules load on every admin screen, but Gutenberg only loads with
 * the editor. So this bridge is framework-free: it keeps what plugins'
 * editor modules register, and the editor (components/block-editor) connects
 * it to Gutenberg once it has loaded and read the server's block types from
 * /wp/v2/block-types. The block's server metadata (title, category,
 * attributes, supports, context) and the module's `edit`/`save` are merged
 * into one `registerBlockType()` call, as WordPress merges a block.json with
 * the settings passed to `registerBlockType( metadata, settings )`.
 *
 * The editor also provides the Gutenberg pieces an edit function needs
 * (`useBlockProps`, `RichText`, `PanelBody`…); the host API exposes them
 * through delegates that look them up when called.
 */

/** The fields of a /wp/v2/block-types item the editor reads (WP_REST_Block_Types_Controller). */
export interface ServerBlockType {
  name: string;
  title?: string;
  description?: string;
  category?: string | null;
  icon?: string | null;
  keywords?: string[];
  attributes?: Record<string, unknown> | null;
  supports?: Record<string, unknown>;
  uses_context?: string[];
  provides_context?: Record<string, string>;
  parent?: string[] | null;
  ancestor?: string[] | null;
  example?: unknown;
  is_dynamic?: boolean;
}

/** What an editor module passes: `edit`, optional `save`, and any client-only settings. */
export type ClientBlockSettings = Record<string, unknown> & {
  edit?: unknown;
  save?: unknown;
};

const BLOCK_NAME = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/** Keys the server owns: a module can't change the block's attributes or context. */
const SERVER_KEYS = new Set(['name', 'attributes', 'usesContext', 'providesContext']);

/**
 * The settings for Gutenberg's registerBlockType(): the server's metadata,
 * then the module's settings. Dynamic blocks without an `edit` preview through
 * `fallbackEdit` (ServerSideRender); without a `save` they save no HTML, only
 * the comment delimiter. Returns null when there is nothing to register: a
 * static block without an editor module.
 */
export function blockSettings(
  type: ServerBlockType,
  client: ClientBlockSettings | undefined,
  fallbackEdit: unknown,
): Record<string, unknown> | null {
  const dynamic = Boolean(type.is_dynamic);
  if (!client && !dynamic) return null;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(client ?? {})) {
    if (!SERVER_KEYS.has(key)) extra[key] = value;
  }
  const save = client?.save ?? (dynamic ? () => null : undefined);
  if (!save) return null;
  return {
    apiVersion: 3,
    title: type.title || type.name,
    description: type.description,
    category: type.category || 'widgets',
    icon: type.icon || 'block-default',
    keywords: type.keywords ?? [],
    attributes: type.attributes ?? {},
    // Without a save function of its own, a dynamic block has no HTML to edit.
    supports: client?.save ? { ...type.supports } : { ...type.supports, html: false },
    usesContext: [...new Set([...(type.uses_context ?? []), 'postId'])],
    providesContext: type.provides_context ?? {},
    parent: type.parent ?? undefined,
    ancestor: type.ancestor ?? undefined,
    ...(type.example ? { example: type.example } : {}),
    ...extra,
    edit: client?.edit ?? fallbackEdit,
    save,
  };
}

/**
 * Whether a block Gutenberg doesn't know (shown by `core/missing`) belongs to
 * a plugin: anything outside core's namespace. Its plugin is inactive (or
 * gone), since active plugins' blocks are registered before the post parses.
 */
export function isPluginBlockName(name: unknown): name is string {
  return typeof name === 'string' && BLOCK_NAME.test(name) && !name.startsWith('core/');
}

type Registrar = (name: string, settings: Record<string, unknown>) => boolean;

export class BlockBridge {
  #client = new Map<string, { owner: string | null; settings: ClientBlockSettings }>();
  #server = new Map<string, ServerBlockType>();
  #registrar: Registrar | null = null;
  #fallbackEdit: unknown = null;
  #impl: Record<string, unknown> | null = null;

  /**
   * `pressbase.blocks.registerBlockType()`. `owner` is the plugin whose module
   * is loading; the block must be in its namespace. Once the editor is
   * connected, the block is registered at once.
   */
  registerBlockType(name: string, settings: ClientBlockSettings, owner: string | null): void {
    if (typeof name !== 'string' || !BLOCK_NAME.test(name)) {
      throw new Error(
        `Block names are "namespace/name" in lowercase letters, digits and dashes: "${String(name)}".`,
      );
    }
    if (owner && !name.startsWith(`${owner}/`)) {
      throw new Error(
        `The ${owner} plugin can only register blocks named "${owner}/…": "${name}".`,
      );
    }
    if (!settings || typeof settings !== 'object') {
      throw new Error(`The "${name}" block needs its settings: { edit, save }.`);
    }
    for (const key of ['edit', 'save'] as const) {
      if (settings[key] !== undefined && typeof settings[key] !== 'function') {
        throw new Error(`The "${name}" block's \`${key}\` must be a function.`);
      }
    }
    this.#client.set(name, { owner, settings });
    const type = this.#server.get(name);
    if (this.#registrar && type) this.#register(type);
  }

  /** What a module registered for a block. */
  client(name: string): ClientBlockSettings | undefined {
    return this.#client.get(name)?.settings;
  }

  /**
   * Called by the editor once Gutenberg has loaded and the server's block
   * types are known: registers every server block the browser lacks, with
   * its module's settings. Blocks a module registers later register at once.
   * Returns the names registered.
   */
  connect(
    types: readonly ServerBlockType[],
    registrar: Registrar,
    fallbackEdit: unknown,
  ): string[] {
    this.#registrar = registrar;
    this.#fallbackEdit = fallbackEdit;
    const added: string[] = [];
    for (const type of types) {
      this.#server.set(type.name, type);
      if (this.#register(type)) added.push(type.name);
    }
    return added;
  }

  #register(type: ServerBlockType): boolean {
    const settings = blockSettings(type, this.client(type.name), this.#fallbackEdit);
    if (!settings || !this.#registrar) return false;
    try {
      return this.#registrar(type.name, settings);
    } catch (error) {
      console.error(`[block:${type.name}] couldn’t be registered:`, error);
      return false;
    }
  }

  /** The editor's Gutenberg pieces (useBlockProps, RichText, PanelBody…), set when it loads. */
  provide(impl: Record<string, unknown>): void {
    this.#impl = impl;
  }

  /** One of the editor's pieces, or an error saying it only exists in the editor. */
  impl<T = unknown>(name: string): T {
    const value = this.#impl?.[name];
    if (value === undefined) {
      throw new Error(`pressbase.blocks.${name} is only available in the block editor.`);
    }
    return value as T;
  }
}
