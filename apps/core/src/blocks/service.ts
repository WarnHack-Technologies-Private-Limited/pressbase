import {
  type BlockContext,
  type BlockType,
  type BlockTypeArgs,
  BlockTypeRegistry,
  type ParsedBlock,
  renderBlock,
  renderBlocks,
} from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { and, eq } from 'drizzle-orm';
import type { CurrentUser } from '../auth/users';
import type { Post } from '../content/posts';
import type { Kernel } from '../kernel';
import type { BlockServices } from './helpers';
import { registerCoreBlocks } from './library';
import {
  type BlockPattern,
  type BlockPatternCategory,
  CORE_PATTERN_CATEGORIES,
  CORE_PATTERNS,
} from './patterns';

/**
 * kernel.blocks — the block engine inside core: the block type registry
 * (WP_Block_Type_Registry), the pattern registries, and do_blocks() wired to
 * the kernel's hook bus and data.
 *
 *   kernel.blocks.registerBlockType('my-plugin/notice', {
 *     title: 'Notice',
 *     attributes: { tone: { type: 'string', default: 'info' } },
 *     render: (attributes, content, block) => `<div class="notice">${content}</div>`,
 *   });
 *   const html = await kernel.blocks.render(post.content, { context: { postId, postType } });
 */

export interface RenderInput {
  /** Top-level context, normally { postId, postType } of the post being shown. */
  context?: BlockContext;
  /** The visitor the content is rendered for (core/loginout reads it). */
  user?: CurrentUser | null;
  /** True when rendering for a REST response (wp_is_serving_rest_request()). */
  rest?: boolean;
  /** Query variables of the page being rendered (`cpage`, `replytocom`…), for the comment blocks. */
  query?: Record<string, string>;
}

/** wp_pattern_sync_status: '' (synced, the default), 'partial' or 'unsynced'. */
export const PATTERN_SYNC_STATUSES = ['partial', 'unsynced', ''] as const;

export class BlocksService {
  readonly registry = new BlockTypeRegistry<BlockServices>();
  readonly #patterns = new Map<string, BlockPattern>();
  readonly #categories = new Map<string, BlockPatternCategory>();

  constructor(private readonly kernel: Kernel) {
    registerCoreBlocks(this.registry);
    for (const category of CORE_PATTERN_CATEGORIES) {
      this.registerBlockPatternCategory(category.name, category);
    }
    for (const pattern of CORE_PATTERNS) this.registerBlockPattern(pattern.name, pattern);
    this.#registerSyncedPatternFields();
  }

  /* ----------------------------------------------------------- block types */

  /** register_block_type(): add a block. A `render` callback makes it dynamic. */
  registerBlockType(name: string, args: BlockTypeArgs<BlockServices>): BlockType<BlockServices> {
    return this.registry.register(name, args);
  }

  unregisterBlockType(name: string): BlockType<BlockServices> | undefined {
    return this.registry.unregister(name);
  }

  /* -------------------------------------------------------------- patterns */

  /** register_block_pattern() */
  registerBlockPattern(name: string, pattern: Omit<BlockPattern, 'name'>): void {
    if (!name) throw new Error('Pattern name must be a string.');
    if (typeof pattern.title !== 'string') throw new Error('Pattern title must be a string.');
    if (typeof pattern.content !== 'string') throw new Error('Pattern content must be a string.');
    this.#patterns.set(name, { ...pattern, name });
  }

  unregisterBlockPattern(name: string): boolean {
    return this.#patterns.delete(name);
  }

  patterns(): BlockPattern[] {
    return [...this.#patterns.values()];
  }

  /** register_block_pattern_category() */
  registerBlockPatternCategory(name: string, category: Omit<BlockPatternCategory, 'name'>): void {
    if (typeof category.label !== 'string') {
      throw new Error('Block pattern category label must be a string.');
    }
    this.#categories.set(name, { ...category, name });
  }

  unregisterBlockPatternCategory(name: string): boolean {
    return this.#categories.delete(name);
  }

  patternCategories(): BlockPatternCategory[] {
    return [...this.#categories.values()];
  }

  /* ------------------------------------------------------------- rendering */

  #options(input: RenderInput) {
    return {
      registry: this.registry,
      hooks: this.kernel.hooks,
      services: {
        kernel: this.kernel,
        user: input.user ?? null,
        rest: input.rest ?? false,
        query: input.query ?? {},
      },
      context: input.context,
    };
  }

  /** do_blocks(): render post content, running dynamic blocks and the render filters. */
  render(content: string, input: RenderInput = {}): Promise<string> {
    return renderBlocks(content, this.#options(input));
  }

  /** render_block() for one parsed block. */
  renderBlock(block: ParsedBlock, input: RenderInput = {}): Promise<string> {
    return renderBlock(block, this.#options(input));
  }

  /** Context for rendering a post's content: render_block()'s $post globals. */
  contextFor(post: Pick<Post, 'id' | 'type'>): BlockContext {
    return { postId: post.id, postType: post.type };
  }

  /* -------------------------------------------------------- synced patterns */

  /**
   * WP_REST_Blocks_Controller (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-blocks-controller.php)
   * on top of the posts controller: raw title and content in every context,
   * no rendered fields, and the wp_pattern_sync_status meta as a top-level
   * field. The meta is saved from `meta.wp_pattern_sync_status`.
   */
  #registerSyncedPatternFields(): void {
    const { hooks } = this.kernel;
    hooks.addFilter('rest_prepare_wp_block', async (value: unknown, post: unknown) => {
      const item = value as Record<string, unknown>;
      const { id, content, title } = post as Post;
      const sync = await this.kernel.posts.getMeta(id, 'wp_pattern_sync_status');
      const contentField: Record<string, unknown> = {
        ...(item.content as Record<string, unknown>),
        raw: content,
      };
      delete contentField.rendered;
      const home = (await this.kernel.options.get<string>('home', '')).replace(/\/+$/, '');
      const links = { ...(item._links as Record<string, unknown>) };
      delete links.author;
      const out: Record<string, unknown> = {
        ...item,
        link: `${home}/?post_type=wp_block&p=${id}`,
        title: { raw: title },
        content: contentField,
        meta: item.meta ?? {},
        wp_pattern_sync_status: typeof sync === 'string' ? sync : '',
        _links: links,
      };
      // wp_block supports title, editor and revisions only.
      for (const field of [
        'excerpt',
        'author',
        'featured_media',
        'comment_status',
        'ping_status',
      ]) {
        delete out[field];
      }
      return out;
    });

    hooks.addAction('rest_insert_wp_block', async (post: unknown, body: unknown) => {
      const meta = (body as { meta?: Record<string, unknown> } | undefined)?.meta;
      const value = meta?.wp_pattern_sync_status;
      if (typeof value !== 'string') return;
      const { id } = post as Post;
      await this.kernel.db
        .delete(schema.postmeta)
        .where(
          and(eq(schema.postmeta.postId, id), eq(schema.postmeta.key, 'wp_pattern_sync_status')),
        );
      if (value) {
        await this.kernel.db
          .insert(schema.postmeta)
          .values({ postId: id, key: 'wp_pattern_sync_status', value });
      }
    });
  }
}
