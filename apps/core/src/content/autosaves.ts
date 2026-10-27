import { schema } from '@pressbase/db';
import { and, eq, like, sql } from 'drizzle-orm';
import type { Kernel } from '../kernel';
import type { Post } from './posts';
import { sanitizePostContent, sanitizePostTitle } from './sanitize';

/**
 * Autosaves — WordPress's wp_get_post_autosave() (wp-includes/revision.php)
 * and WP_REST_Autosaves_Controller::create_post_autosave()
 * (wp-includes/rest-api/endpoints/class-wp-rest-autosaves-controller.php).
 *
 * An autosave is a revision row (type `revision`, status `inherit`) whose slug
 * is `{postId}-autosave-v1`. There is at most one per user per post, and it is
 * updated in place. Hook fired: wp_creating_autosave (data, isUpdate).
 */

/** The fields an autosave stores: _wp_post_revision_fields(). */
export interface AutosaveInput {
  title?: string;
  content?: string;
  excerpt?: string;
  /** Run the fields through kses (for users without unfiltered_html). */
  filterHtml?: boolean;
}

export const autosaveSlug = (postId: number) => `${postId}-autosave-v1`;

/** All autosaves of a post, newest first (any user). */
export async function listAutosaves(kernel: Kernel, postId: number): Promise<Post[]> {
  return kernel.db
    .select()
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.parentId, postId),
        eq(schema.posts.type, 'revision'),
        like(schema.posts.slug, `${postId}-autosave%`),
      ),
    )
    .orderBy(sql`${schema.posts.date} desc, ${schema.posts.id} desc`);
}

/** wp_get_post_autosave(): the newest autosave, optionally for one user only. */
export async function getAutosave(
  kernel: Kernel,
  postId: number,
  userId?: number,
): Promise<Post | undefined> {
  const [row] = await kernel.db
    .select()
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.parentId, postId),
        eq(schema.posts.type, 'revision'),
        eq(schema.posts.status, 'inherit'),
        eq(schema.posts.slug, autosaveSlug(postId)),
        userId ? eq(schema.posts.authorId, userId) : undefined,
      ),
    )
    .orderBy(sql`${schema.posts.date} desc, ${schema.posts.id} desc`)
    .limit(1);
  return row;
}

/** normalize_whitespace(): trims, unifies line endings and collapses runs of spaces. */
export function normalizeWhitespace(value: string): string {
  return value
    .trim()
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, '\n')
    .replace(/[ \t]+/g, ' ');
}

/**
 * create_post_autosave(): stores the user's autosave of `post`, creating it or
 * updating it in place. When nothing differs from the saved post and an
 * autosave already exists, the existing one is returned untouched.
 */
export async function createPostAutosave(
  kernel: Kernel,
  post: Post,
  userId: number,
  input: AutosaveInput,
): Promise<Post> {
  const clean = (value: string | undefined, current: string, kind: 'title' | 'content') => {
    if (value === undefined) return current;
    if (!input.filterHtml) return value;
    return kind === 'content' ? sanitizePostContent(value) : sanitizePostTitle(value);
  };
  const fields = {
    title: clean(input.title, post.title, 'title'),
    content: clean(input.content, post.content, 'content'),
    excerpt: clean(input.excerpt, post.excerpt, 'title'),
  };

  const isDifferent = (['title', 'content', 'excerpt'] as const).some(
    (key) => normalizeWhitespace(fields[key]) !== normalizeWhitespace(post[key]),
  );
  const existing = await getAutosave(kernel, post.id, userId);
  if (!isDifferent && existing) return existing;

  const now = new Date();
  if (existing) {
    await kernel.hooks.doAction(
      'wp_creating_autosave',
      { ...fields, id: existing.id, authorId: userId },
      true,
    );
    const [updated] = await kernel.db
      .update(schema.posts)
      .set({ ...fields, authorId: userId, modified: now })
      .where(eq(schema.posts.id, existing.id))
      .returning();
    return updated as Post;
  }

  const [created] = await kernel.db
    .insert(schema.posts)
    .values({
      ...fields,
      type: 'revision',
      status: 'inherit',
      parentId: post.id,
      authorId: userId,
      slug: autosaveSlug(post.id),
      date: now,
      modified: now,
      commentStatus: 'closed',
      pingStatus: 'closed',
    })
    .returning();
  return created as Post;
}
