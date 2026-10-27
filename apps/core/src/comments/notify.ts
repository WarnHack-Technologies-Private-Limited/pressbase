import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import { type RoleMap, resolveCapabilities } from '../auth/capabilities';
import type { Kernel } from '../kernel';
import { renderHtml, renderText } from '../mail/template';
import { plainText } from './format';

/**
 * Comment emails — wp_notify_moderator() and wp_notify_postauthor()
 * (wordpress/wp-includes/pluggable.php), sent through kernel.mail.
 *
 * - A held comment emails the site's admin address and the post's author
 *   (when they can moderate), if `moderation_notify` is on.
 * - An approved comment emails the post's author, if `comments_notify` is
 *   on, unless they wrote the comment themselves.
 *
 * Filters, with WordPress's names: notify_moderator, notify_post_author
 * (boolean, to turn either off), comment_moderation_recipients and
 * comment_notification_recipients (the address lists).
 *
 * Sending never delays the visitor: emails go out after the response.
 */

interface CommentLike {
  id: number;
  postId: number;
  author: string;
  authorEmail: string;
  authorUrl: string;
  content: string;
  userId: number | null;
}

async function postAuthor(kernel: Kernel, authorId: number | null) {
  if (!authorId) return undefined;
  const [user] = await kernel.db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, authorId));
  if (!user) return undefined;
  const [grants] = await kernel.db
    .select({ value: schema.usermeta.value })
    .from(schema.usermeta)
    .where(eq(schema.usermeta.userId, user.id));
  const roles = await kernel.options.get<RoleMap>('user_roles', {});
  const { capabilities } = resolveCapabilities(
    (grants?.value as Record<string, boolean>) ?? {},
    roles,
  );
  return { ...user, canModerate: Boolean(capabilities.moderate_comments) };
}

async function send(kernel: Kernel, comment: CommentLike, held: boolean): Promise<void> {
  const { options, hooks } = kernel;
  const enabled = await options.get<boolean>(held ? 'moderation_notify' : 'comments_notify', true);
  const allowed = await hooks.applyFilters(
    held ? 'notify_moderator' : 'notify_post_author',
    enabled,
    comment.id,
  );
  if (!allowed) return;

  const post = await kernel.posts.get(comment.postId);
  if (!post) return;
  const author = await postAuthor(kernel, post.authorId);

  let recipients: string[];
  if (held) {
    const admin = await options.get<string>('admin_email', '');
    recipients = [admin, ...(author?.canModerate ? [author.email] : [])];
  } else {
    // The author wrote the comment themselves: nothing to tell them.
    if (!author || (comment.userId && comment.userId === author.id)) return;
    recipients = [author.email];
  }
  recipients = (await hooks.applyFilters(
    held ? 'comment_moderation_recipients' : 'comment_notification_recipients',
    [...new Set(recipients.filter(Boolean))],
    comment.id,
  )) as string[];
  if (!recipients.length) return;

  const siteName = await options.get<string>('blogname', 'Pressbase');
  const admin = (await options.get<string>('siteurl', '')).replace(/\/+$/, '');
  const title = plainText(post.title) || '(no title)';
  const who = [
    `Author: ${comment.author || 'Anonymous'}${comment.authorEmail ? ` (${comment.authorEmail})` : ''}`,
    ...(comment.authorUrl ? [`Website: ${comment.authorUrl}`] : []),
  ];
  const excerpt = plainText(comment.content).slice(0, 2000);
  const content = held
    ? {
        siteName,
        heading: `A new comment on “${title}” is waiting for your approval`,
        paragraphs: [...who, `Comment: ${excerpt}`],
        action: { label: 'Review the comment', url: `${admin}/admin/comments?c=${comment.id}` },
      }
    : {
        siteName,
        heading: `New comment on your post “${title}”`,
        paragraphs: [...who, `Comment: ${excerpt}`],
        action: { label: 'See all comments', url: `${admin}/admin/comments` },
      };

  await kernel.mail.send({
    to: recipients,
    subject: held
      ? `[${siteName}] Please moderate: “${title}”`
      : `[${siteName}] Comment: “${title}”`,
    text: renderText(content),
    html: renderHtml(content),
    ...(comment.authorEmail && !held ? { replyTo: comment.authorEmail } : {}),
  });
}

export function registerCommentNotifications(kernel: Kernel): void {
  kernel.hooks.addAction('comment_post', (_id: unknown, approved: unknown, comment: unknown) => {
    if (approved !== '0' && approved !== '1') return; // Spam and trash send nothing.
    // Fire and forget: the visitor's request shouldn't wait for SMTP.
    void send(kernel, comment as CommentLike, approved === '0').catch((error) =>
      console.error('Comment notification failed', error),
    );
  });
}
