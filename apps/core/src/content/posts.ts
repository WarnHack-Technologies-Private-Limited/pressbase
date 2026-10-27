import { schema } from '@pressbase/db';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Kernel } from '../kernel';
import { sanitizePostContent, sanitizePostTitle, sanitizeSlug } from './sanitize';

/**
 * Posts — WordPress's wp_insert_post(), wp_update_post(), wp_trash_post(),
 * wp_untrash_post(), wp_delete_post() and wp_save_post_revision()
 * (wordpress/wp-includes/post.php, revision.php).
 *
 * Hooks fired, with WordPress's names:
 * transition_post_status (new, old, post) · save_post (id, post, update) ·
 * wp_insert_post (id, post, update) · wp_trash_post / trashed_post (id) ·
 * untrashed_post (id) · before_delete_post / deleted_post (id).
 */

export type Post = typeof schema.posts.$inferSelect;

export interface PostInput {
  title?: string;
  content?: string;
  excerpt?: string;
  status?: string;
  slug?: string;
  date?: Date;
  authorId?: number | null;
  parentId?: number | null;
  menuOrder?: number;
  commentStatus?: 'open' | 'closed';
  pingStatus?: 'open' | 'closed';
  password?: string;
  /** Term IDs per taxonomy; replaces the existing terms of each listed taxonomy. */
  terms?: Record<string, number[]>;
  /** Run content through kses (for users without unfiltered_html). */
  filterHtml?: boolean;
}

export class PostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 410 | 500 = 400,
  ) {
    super(message);
  }
}

const NON_UNIQUE_STATUSES = new Set(['auto-draft', 'inherit']);

export class PostsService {
  constructor(private readonly kernel: Kernel) {}

  get #db() {
    return this.kernel.db;
  }

  async get(id: number): Promise<Post | undefined> {
    const [post] = await this.#db.select().from(schema.posts).where(eq(schema.posts.id, id));
    return post;
  }

  /** wp_unique_post_slug(): unique per type, and per parent for hierarchical types. */
  async uniqueSlug(
    slug: string,
    type: string,
    parentId: number | null,
    exceptId?: number,
  ): Promise<string> {
    const hierarchical = this.kernel.postTypes.get(type)?.hierarchical ?? false;
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? slug : `${slug}-${n}`;
      const [clash] = await this.#db
        .select({ id: schema.posts.id })
        .from(schema.posts)
        .where(
          and(
            eq(schema.posts.slug, candidate),
            eq(schema.posts.type, type),
            exceptId ? sql`${schema.posts.id} <> ${exceptId}` : undefined,
            hierarchical
              ? parentId
                ? eq(schema.posts.parentId, parentId)
                : sql`${schema.posts.parentId} is null`
              : undefined,
          ),
        )
        .limit(1);
      if (!clash) return candidate;
    }
  }

  /** Publish wins over a future date only when the date has arrived, and vice versa. */
  #resolveStatus(status: string, date: Date): string {
    const now = Date.now();
    if (status === 'publish' && date.getTime() > now) return 'future';
    if (status === 'future' && date.getTime() <= now) return 'publish';
    return status;
  }

  /** wp_insert_post() for new posts. */
  async insert(type: string, input: PostInput): Promise<Post> {
    const postType = this.kernel.postTypes.get(type);
    if (!postType) throw new PostError('invalid_post_type', 'Invalid post type.');

    const date = input.date ?? new Date();
    const status = this.#resolveStatus(input.status ?? 'draft', date);
    const title = input.filterHtml ? sanitizePostTitle(input.title ?? '') : (input.title ?? '');
    const parentId = postType.hierarchical ? (input.parentId ?? null) : null;
    await this.#assertParent(parentId, type);
    const slugBase = sanitizeSlug(input.slug ?? '') || sanitizeSlug(title);

    const [created] = await this.#db
      .insert(schema.posts)
      .values({
        type,
        status,
        date,
        modified: new Date(),
        title,
        content: input.filterHtml
          ? sanitizePostContent(input.content ?? '')
          : (input.content ?? ''),
        excerpt: input.filterHtml ? sanitizePostTitle(input.excerpt ?? '') : (input.excerpt ?? ''),
        authorId: input.authorId ?? null,
        parentId,
        menuOrder: input.menuOrder ?? 0,
        commentStatus: input.commentStatus ?? (await this.#defaultCommentStatus(type)),
        pingStatus: input.pingStatus ?? 'closed',
        password: input.password ?? '',
      })
      .returning();
    if (!created)
      throw new PostError('db_insert_error', 'Could not insert post into the database.', 500);

    const home = await this.kernel.options.get<string>('home', '');
    const slug = NON_UNIQUE_STATUSES.has(status)
      ? slugBase
      : await this.uniqueSlug(slugBase || String(created.id), type, parentId, created.id);
    const guid = `${home}/?${type === 'page' ? 'page_id' : 'p'}=${created.id}`;
    await this.#db.update(schema.posts).set({ slug, guid }).where(eq(schema.posts.id, created.id));

    const terms = { ...input.terms };
    if (this.kernel.taxonomies.get('category')?.objectTypes.has(type) && !terms.category?.length) {
      const fallback = await this.kernel.options.get<number>('default_category', 0);
      if (fallback) terms.category = [fallback];
    }
    await this.#setTerms(created.id, terms);

    const post = (await this.get(created.id)) as Post;
    await this.#afterSave(post, 'new', false);
    return post;
  }

  /** wp_update_post(): only the given fields change. */
  async update(id: number, input: PostInput): Promise<Post> {
    const current = await this.get(id);
    if (!current) throw new PostError('rest_post_invalid_id', 'Invalid post ID.', 404);
    const postType = this.kernel.postTypes.get(current.type);

    const set: Partial<typeof schema.posts.$inferInsert> = { modified: new Date() };
    if (input.title !== undefined)
      set.title = input.filterHtml ? sanitizePostTitle(input.title) : input.title;
    if (input.content !== undefined) {
      set.content = input.filterHtml ? sanitizePostContent(input.content) : input.content;
    }
    if (input.excerpt !== undefined) {
      set.excerpt = input.filterHtml ? sanitizePostTitle(input.excerpt) : input.excerpt;
    }
    if (input.authorId !== undefined) set.authorId = input.authorId;
    if (input.menuOrder !== undefined) set.menuOrder = input.menuOrder;
    if (input.commentStatus !== undefined) set.commentStatus = input.commentStatus;
    if (input.pingStatus !== undefined) set.pingStatus = input.pingStatus;
    if (input.password !== undefined) set.password = input.password;
    if (input.parentId !== undefined && postType?.hierarchical) {
      if (input.parentId === id)
        throw new PostError('rest_post_invalid_parent', 'A post cannot be its own parent.');
      await this.#assertParent(input.parentId, current.type, id);
      set.parentId = input.parentId;
    }

    const date = input.date ?? current.date;
    if (input.date !== undefined) set.date = input.date;
    const status = this.#resolveStatus(input.status ?? current.status, date);
    if (status !== current.status) set.status = status;

    const parentId = set.parentId !== undefined ? set.parentId : current.parentId;
    if (input.slug !== undefined || current.slug === '' || set.parentId !== undefined) {
      const base =
        sanitizeSlug(input.slug ?? current.slug) ||
        sanitizeSlug(set.title ?? current.title) ||
        String(id);
      set.slug = NON_UNIQUE_STATUSES.has(status)
        ? base
        : await this.uniqueSlug(base, current.type, parentId ?? null, id);
    }

    await this.#db.update(schema.posts).set(set).where(eq(schema.posts.id, id));
    if (input.terms) await this.#setTerms(id, input.terms);

    const post = (await this.get(id)) as Post;
    const contentChanged =
      post.title !== current.title ||
      post.content !== current.content ||
      post.excerpt !== current.excerpt;
    await this.#afterSave(post, current.status, true, contentChanged);
    return post;
  }

  /** wp_trash_post(): remembers the status so untrash and capability checks can use it. */
  async trash(id: number): Promise<Post> {
    const post = await this.get(id);
    if (!post) throw new PostError('rest_post_invalid_id', 'Invalid post ID.', 404);
    if (post.status === 'trash')
      throw new PostError('rest_already_trashed', 'The post has already been deleted.', 410);
    await this.kernel.hooks.doAction('wp_trash_post', id);
    await this.#setMeta(id, '_wp_trash_meta_status', post.status);
    await this.#setMeta(id, '_wp_trash_meta_time', Math.floor(Date.now() / 1000));
    // Free the slug for new content, as WordPress does with its __trashed suffix.
    const slug = post.slug.endsWith('__trashed') ? post.slug : `${post.slug}__trashed`;
    await this.#db
      .update(schema.posts)
      .set({ status: 'trash', slug })
      .where(eq(schema.posts.id, id));
    const trashed = (await this.get(id)) as Post;
    await this.kernel.hooks.doAction('transition_post_status', 'trash', post.status, trashed);
    await this.kernel.terms.recountForObject(id);
    await this.kernel.hooks.doAction('trashed_post', id);
    return trashed;
  }

  /**
   * wp_untrash_post(): since WordPress 5.6, restored posts come back as drafts
   * so nothing is republished by accident.
   */
  async untrash(id: number): Promise<Post> {
    const post = await this.get(id);
    if (post?.status !== 'trash') {
      throw new PostError('rest_post_invalid_id', 'Invalid post ID.', 404);
    }
    const slug = post.slug.replace(/__trashed$/, '');
    await this.#db
      .update(schema.posts)
      .set({ status: 'draft', slug: await this.uniqueSlug(slug, post.type, post.parentId, id) })
      .where(eq(schema.posts.id, id));
    await this.#db
      .delete(schema.postmeta)
      .where(
        and(
          eq(schema.postmeta.postId, id),
          inArray(schema.postmeta.key, ['_wp_trash_meta_status', '_wp_trash_meta_time']),
        ),
      );
    const restored = (await this.get(id)) as Post;
    await this.kernel.hooks.doAction('transition_post_status', 'draft', 'trash', restored);
    await this.kernel.hooks.doAction('untrashed_post', id);
    return restored;
  }

  /** wp_delete_post(..., true): removes the post, its revisions, meta and term links. */
  async delete(id: number): Promise<Post> {
    const post = await this.get(id);
    if (!post) throw new PostError('rest_post_invalid_id', 'Invalid post ID.', 404);
    await this.kernel.hooks.doAction('before_delete_post', id, post);
    await this.kernel.terms.clearObject(id);
    await this.#db.transaction(async (tx) => {
      await tx
        .delete(schema.posts)
        .where(and(eq(schema.posts.parentId, id), eq(schema.posts.type, 'revision')));
      // Children of hierarchical posts move up to the deleted post's parent.
      await tx
        .update(schema.posts)
        .set({ parentId: post.parentId })
        .where(eq(schema.posts.parentId, id));
      await tx.delete(schema.posts).where(eq(schema.posts.id, id));
    });
    await this.kernel.hooks.doAction('deleted_post', id, post);
    return post;
  }

  async revisions(id: number): Promise<Post[]> {
    return this.#db
      .select()
      .from(schema.posts)
      .where(and(eq(schema.posts.parentId, id), eq(schema.posts.type, 'revision')))
      .orderBy(sql`${schema.posts.date} desc, ${schema.posts.id} desc`);
  }

  /**
   * Publishes scheduled posts whose time has come — what wp-cron's
   * publish_future_post does. Called before content queries until the job
   * queue arrives in v0.5.
   */
  async publishDue(): Promise<void> {
    const due = await this.#db
      .update(schema.posts)
      .set({ status: 'publish' })
      .where(and(eq(schema.posts.status, 'future'), lte(schema.posts.date, new Date())))
      .returning();
    for (const post of due) {
      await this.kernel.terms.recountForObject(post.id);
      await this.kernel.hooks.doAction('transition_post_status', 'publish', 'future', post);
    }
  }

  async getMeta(id: number, key: string): Promise<unknown> {
    const [row] = await this.#db
      .select({ value: schema.postmeta.value })
      .from(schema.postmeta)
      .where(and(eq(schema.postmeta.postId, id), eq(schema.postmeta.key, key)));
    return row?.value;
  }

  async #setMeta(id: number, key: string, value: unknown): Promise<void> {
    await this.#db
      .delete(schema.postmeta)
      .where(and(eq(schema.postmeta.postId, id), eq(schema.postmeta.key, key)));
    await this.#db.insert(schema.postmeta).values({ postId: id, key, value });
  }

  async #assertParent(parentId: number | null, type: string, selfId?: number): Promise<void> {
    if (!parentId) return;
    const parent = await this.get(parentId);
    if (!parent || parent.type !== type) {
      throw new PostError('rest_post_invalid_parent', 'Invalid post parent ID.');
    }
    // Refuse loops: the new parent must not be a descendant of this post.
    for (
      let cursor: Post | undefined = parent;
      cursor?.parentId;
      cursor = await this.get(cursor.parentId)
    ) {
      if (cursor.parentId === selfId) {
        throw new PostError(
          'rest_post_invalid_parent',
          'A page cannot be moved under one of its own children.',
        );
      }
    }
  }

  async #defaultCommentStatus(type: string): Promise<'open' | 'closed'> {
    if (type !== 'post') return 'closed';
    return (await this.kernel.options.get<string>('default_comment_status', 'open')) === 'open'
      ? 'open'
      : 'closed';
  }

  async #setTerms(id: number, terms: Record<string, number[]>): Promise<void> {
    for (const [taxonomy, ids] of Object.entries(terms)) {
      await this.kernel.terms.setObjectTerms(id, taxonomy, ids);
    }
  }

  async #afterSave(
    post: Post,
    oldStatus: string,
    update: boolean,
    contentChanged = true,
  ): Promise<void> {
    if (oldStatus !== post.status) {
      await this.kernel.terms.recountForObject(post.id);
      await this.kernel.hooks.doAction('transition_post_status', post.status, oldStatus, post);
    }
    if (contentChanged && this.kernel.postTypes.get(post.type)?.supports.has('revisions')) {
      await this.#saveRevision(post);
    }
    await this.kernel.hooks.doAction('save_post', post.id, post, update);
    await this.kernel.hooks.doAction(`save_post_${post.type}`, post.id, post, update);
    await this.kernel.hooks.doAction('wp_insert_post', post.id, post, update);
  }

  /** wp_save_post_revision(): a copy of the saved state, for history and restore. */
  async #saveRevision(post: Post): Promise<void> {
    if (post.status === 'auto-draft') return;
    const [{ n } = { n: 0 }] = await this.#db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.posts)
      .where(and(eq(schema.posts.parentId, post.id), eq(schema.posts.type, 'revision')));
    await this.#db.insert(schema.posts).values({
      type: 'revision',
      status: 'inherit',
      parentId: post.id,
      authorId: post.authorId,
      title: post.title,
      content: post.content,
      excerpt: post.excerpt,
      slug: `${post.id}-revision-v${n + 1}`,
      date: new Date(),
      modified: new Date(),
      commentStatus: 'closed',
      pingStatus: 'closed',
    });
  }
}
