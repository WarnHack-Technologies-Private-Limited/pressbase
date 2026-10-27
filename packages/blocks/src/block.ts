import { parseBlocks } from './parser';
import type { BlockType, BlockTypeRegistry } from './registry';
import type { BlockAttributes, BlockContext, ParsedBlock } from './types';

/**
 * WP_Block (wordpress/wp-includes/class-wp-block.php) and render_block() /
 * do_blocks() (wordpress/wp-includes/blocks.php).
 *
 * Rendering is async because render callbacks query the database. Instead of
 * WordPress's globals ($post, static counters), everything a render needs
 * travels in a per-render *session*: the registry, the hook bus, the
 * services the host injects, the recursion guard and the unique-ID counters.
 */

/** The part of a hook bus the renderer needs. `HookBus` from @pressbase/hooks fits. */
export interface FilterHooks {
  applyFilters(name: string, value: unknown, ...args: unknown[]): Promise<unknown>;
}

export interface RenderOptions<S = unknown> {
  registry: BlockTypeRegistry<S>;
  /** Filters: pre_render_block, render_block_data, render_block_context, render_block, render_block_{name}. */
  hooks?: FilterHooks;
  /** Whatever render callbacks need from the host (database access, the current user…). */
  services?: S;
  /** Context every top-level block starts with, e.g. { postId, postType } (render_block()'s global $post). */
  context?: BlockContext;
  /** Nesting limit, a last line of defence against runaway recursion. Default 100. */
  maxDepth?: number;
}

interface Session<S> {
  registry: BlockTypeRegistry<S>;
  hooks: FilterHooks | undefined;
  services: S;
  context: BlockContext;
  maxDepth: number;
  depth: number;
  /** Keys of renders in progress, for withRecursionGuard(). */
  active: Set<string>;
  /** wp_unique_id() counters, per prefix. */
  ids: Map<string, number>;
}

function createSession<S>(options: RenderOptions<S>): Session<S> {
  return {
    registry: options.registry,
    hooks: options.hooks,
    services: options.services as S,
    context: options.context ?? {},
    maxDepth: options.maxDepth ?? 100,
    depth: 0,
    active: new Set(),
    ids: new Map(),
  };
}

async function filter<T>(
  session: { hooks: FilterHooks | undefined },
  name: string,
  value: T,
  ...args: unknown[]
): Promise<T> {
  return session.hooks ? ((await session.hooks.applyFilters(name, value, ...args)) as T) : value;
}

export class WPBlock<S = unknown> {
  /** The parsed block, as parse_blocks() returned it (possibly changed by render_block_data). */
  parsedBlock: ParsedBlock;
  readonly name: string | null;
  readonly blockType: BlockType<S> | undefined;
  /** The context this block asked for (`usesContext`), from its ancestors. */
  context: BlockContext = {};
  /** All context available at this point of the tree. */
  availableContext: BlockContext;
  innerBlocks: WPBlock<S>[] = [];
  innerHTML = '';
  innerContent: (string | null)[] = [];
  /** The enclosing block, or null at the top level. */
  readonly parent: WPBlock<S> | null;
  readonly #session: Session<S>;
  #attributes: BlockAttributes | undefined;

  constructor(
    parsedBlock: ParsedBlock,
    availableContext: BlockContext,
    session: Session<S>,
    parent: WPBlock<S> | null = null,
  ) {
    this.parsedBlock = parsedBlock;
    this.name = parsedBlock.blockName;
    this.#session = session;
    this.blockType = session.registry.get(this.name);
    this.availableContext = availableContext;
    this.parent = parent;
    this.refreshContextDependents();
  }

  /** Attributes with the type's defaults applied and invalid values removed. */
  get attributes(): BlockAttributes {
    if (!this.#attributes) {
      const attrs = this.parsedBlock.attrs ?? {};
      this.#attributes = this.blockType ? this.blockType.prepareAttributesForRender(attrs) : attrs;
    }
    return this.#attributes;
  }

  set attributes(value: BlockAttributes) {
    this.#attributes = value;
  }

  /** The services the host passed to renderBlocks(). */
  get services(): S {
    return this.#session.services;
  }

  /** WP_Block::refresh_context_dependents() */
  refreshContextDependents(): void {
    this.availableContext = { ...this.availableContext, ...this.context };
    for (const name of this.blockType?.usesContext ?? []) {
      if (name in this.availableContext) this.context[name] = this.availableContext[name];
    }
    this.refreshParsedBlockDependents();
  }

  /** WP_Block::refresh_parsed_block_dependents() */
  refreshParsedBlockDependents(): void {
    this.#attributes = undefined;
    const inner = this.parsedBlock.innerBlocks ?? [];
    if (inner.length) {
      const childContext = { ...this.availableContext };
      for (const [contextName, attributeName] of Object.entries(
        this.blockType?.providesContext ?? {},
      )) {
        if (attributeName in this.attributes) {
          childContext[contextName] = this.attributes[attributeName];
        }
      }
      this.innerBlocks = inner.map((b) => new WPBlock<S>(b, childContext, this.#session, this));
    } else {
      this.innerBlocks = [];
    }
    this.innerHTML = this.parsedBlock.innerHTML ?? '';
    this.innerContent = this.parsedBlock.innerContent ?? [];
  }

  /**
   * WP_Block::render(): inner blocks (each through pre_render_block,
   * render_block_data and render_block_context), then the render callback for
   * dynamic blocks, then the render_block and render_block_{name} filters.
   */
  async render(options: { dynamic?: boolean } = {}): Promise<string> {
    const session = this.#session;
    if (session.depth >= session.maxDepth) return '';
    session.depth++;
    try {
      const dynamic = options.dynamic ?? true;
      let content = await this.#renderInner();
      const render = this.blockType?.render;
      if (dynamic && render) {
        content = String((await render(this.attributes, content, this)) ?? '');
      }
      content = await filter(session, 'render_block', content, this.parsedBlock, this);
      content = await filter(
        session,
        `render_block_${this.name ?? ''}`,
        content,
        this.parsedBlock,
        this,
      );
      return content;
    } finally {
      session.depth--;
    }
  }

  async #renderInner(): Promise<string> {
    const session = this.#session;
    let content = '';
    let index = 0;
    for (const chunk of this.innerContent) {
      if (typeof chunk === 'string') {
        content += chunk;
        continue;
      }
      const inner = this.innerBlocks[index++];
      if (!inner) continue;

      const pre = await filter<string | null>(
        session,
        'pre_render_block',
        null,
        inner.parsedBlock,
        this,
      );
      if (pre !== null && pre !== undefined) {
        content += pre;
        continue;
      }
      if (session.hooks) {
        const source = inner.parsedBlock;
        inner.parsedBlock = await filter(session, 'render_block_data', source, source, this);
        inner.context = await filter(
          session,
          'render_block_context',
          inner.context,
          inner.parsedBlock,
          this,
        );
        // Filters may change values in place, so refresh unconditionally.
        inner.refreshContextDependents();
      }
      content += await inner.render();
    }
    return content;
  }

  /**
   * Replaces this block's inner blocks and renders them in its context, as
   * render_block_core_block() does for a synced pattern's content. The render
   * callback and this block's own filters don't run.
   */
  async renderInnerBlocks(blocks: ParsedBlock[], context?: BlockContext): Promise<string> {
    this.parsedBlock = {
      ...this.parsedBlock,
      innerBlocks: blocks,
      innerContent: blocks.map(() => null),
    };
    // Extra context for the inner blocks, as core/post-template gives each
    // post's blocks { postId, postType } (its render_block_context filter).
    if (context) {
      this.availableContext = { ...this.availableContext, ...context };
      for (const key of Object.keys(context)) {
        if (key in this.context) this.context[key] = context[key];
      }
    }
    this.refreshContextDependents();
    return this.#renderInner();
  }

  /**
   * do_blocks() inside this render: renders other content (another post's,
   * for example) with a fresh top-level context. Shares the recursion guard.
   */
  async renderContent(content: string | ParsedBlock[], context?: BlockContext): Promise<string> {
    const blocks = typeof content === 'string' ? parseBlocks(content) : content;
    let out = '';
    for (const block of blocks) {
      out += await renderInSession(block, this.#session, context ?? this.#session.context);
    }
    return out;
  }

  /**
   * Runs `fn` unless a render with the same key is already in progress
   * further up the tree; then returns `fallback`. This is how a synced
   * pattern that contains itself stops (render_block_core_block's $seen_refs).
   */
  async withRecursionGuard<T>(key: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    const { active } = this.#session;
    if (active.has(key)) return fallback;
    active.add(key);
    try {
      return await fn();
    } finally {
      active.delete(key);
    }
  }

  /** wp_unique_id(): `prefix1`, `prefix2`… unique within this render. */
  uniqueId(prefix = ''): string {
    const next = (this.#session.ids.get(prefix) ?? 0) + 1;
    this.#session.ids.set(prefix, next);
    return `${prefix}${next}`;
  }
}

/** render_block() for a top-level block, within a session. */
async function renderInSession<S>(
  parsed: ParsedBlock,
  session: Session<S>,
  context: BlockContext,
): Promise<string> {
  const pre = await filter<string | null>(session, 'pre_render_block', null, parsed, null);
  if (pre !== null && pre !== undefined) return pre;
  const block = await filter(session, 'render_block_data', parsed, parsed, null);
  const filtered = await filter(session, 'render_block_context', { ...context }, block, null);
  return new WPBlock<S>(block, filtered, session, null).render();
}

/** render_block(): one parsed block, with every filter WordPress applies. */
export function renderBlock<S>(parsed: ParsedBlock, options: RenderOptions<S>): Promise<string> {
  const session = createSession(options);
  return renderInSession(parsed, session, session.context);
}

/**
 * do_blocks(): parses the content and renders every top-level block. Static
 * blocks give back their saved HTML; dynamic blocks run their render callback.
 */
export async function renderBlocks<S>(
  content: string | ParsedBlock[],
  options: RenderOptions<S>,
): Promise<string> {
  const session = createSession(options);
  const blocks = typeof content === 'string' ? parseBlocks(content) : content;
  let out = '';
  for (const block of blocks) out += await renderInSession(block, session, session.context);
  return out;
}
