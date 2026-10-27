import { schema } from '@pressbase/db';
import { and, count, eq, isNull, lt } from 'drizzle-orm';
import { type PermalinkContext, permalink, permalinkContext } from '../content/permalinks';
import type { Post } from '../content/posts';
import type { Kernel } from '../kernel';
import type { DiscussionOptions } from './options';
import type { Comment } from './service';

/**
 * Comment URLs — get_comment_link(), get_page_of_comment() and
 * get_comments_pagenum_link() (wordpress/wp-includes/comment-template.php,
 * comment.php, link-template.php).
 */

/** Adds the comment page to a post URL: /comment-page-2/ or ?cpage=2. */
export function commentsPageUrl(postUrl: string, page: number, pretty: boolean): string {
  if (pretty && !postUrl.includes('?')) {
    return `${postUrl.replace(/\/?$/, '/')}comment-page-${page}/`;
  }
  return `${postUrl}${postUrl.includes('?') ? '&' : '?'}cpage=${page}`;
}

/**
 * get_page_of_comment(): which page a comment lands on when comments are
 * paged. Pages count from the oldest top-level comment, whatever the order
 * they are shown in.
 */
export async function pageOfComment(
  kernel: Kernel,
  comment: Comment,
  options: DiscussionOptions,
): Promise<number> {
  if (!options.page_comments || options.comments_per_page < 1) return 1;
  let top = comment;
  if (options.thread_comments) {
    for (let guard = 0; top.parentId && guard < 100; guard++) {
      const parent = await kernel.comments.get(top.parentId);
      if (!parent) break;
      top = parent;
    }
  }
  const c = schema.comments;
  const [row] = await kernel.db
    .select({ n: count() })
    .from(c)
    .where(
      and(
        eq(c.postId, top.postId),
        eq(c.approved, '1'),
        lt(c.date, top.date),
        options.thread_comments ? isNull(c.parentId) : undefined,
      ),
    );
  return Math.floor((row?.n ?? 0) / options.comments_per_page) + 1;
}

/** get_comment_pages_count() for one post. */
export async function commentPagesCount(
  kernel: Kernel,
  postId: number,
  options: DiscussionOptions,
): Promise<number> {
  if (!options.page_comments || options.comments_per_page < 1) return 1;
  const c = schema.comments;
  const [row] = await kernel.db
    .select({ n: count() })
    .from(c)
    .where(
      and(
        eq(c.postId, postId),
        eq(c.approved, '1'),
        options.thread_comments ? isNull(c.parentId) : undefined,
      ),
    );
  return Math.max(1, Math.ceil((row?.n ?? 0) / options.comments_per_page));
}

/**
 * get_comment_link(): the post's permalink, the comment page when comments
 * are paged and it isn't the default page, and #comment-{id}.
 */
export async function commentLink(
  kernel: Kernel,
  comment: Comment,
  post: Post,
  options: DiscussionOptions,
  links?: PermalinkContext,
): Promise<string> {
  const ctx = links ?? (await permalinkContext(kernel));
  let url = await permalink(kernel, post, ctx);
  if (options.page_comments) {
    const page = await pageOfComment(kernel, comment, options);
    const isDefault =
      options.default_comments_page === 'newest'
        ? page === (await commentPagesCount(kernel, post.id, options))
        : page === 1;
    if (!isDefault)
      url = commentsPageUrl(url, page, ctx.structure !== '' && post.status === 'publish');
  }
  return `${url}#comment-${comment.id}`;
}
