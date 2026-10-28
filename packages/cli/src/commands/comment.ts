import type { Comment } from '@pressbase/core/src/comments/service';
import type { CommandSpec, Context } from '../command';
import { localDate, service, siteTimeZone } from './shared';

/**
 * `pressbase comment`: wp-cli's comment-command, on kernel.comments
 * (get_comments(), wp_set_comment_status(), wp_spam_comment(),
 * wp_trash_comment(), wp_delete_comment()). Moderation fires the same hooks,
 * comment counts and notifications as the Comments screen.
 */

const FIELDS = [
  'comment_ID',
  'comment_post_ID',
  'comment_date',
  'comment_approved',
  'comment_author',
  'comment_author_email',
  'comment_author_url',
  'comment_author_IP',
  'comment_content',
  'comment_parent',
  'comment_type',
  'user_id',
];
const LIST_FIELDS = [
  'comment_ID',
  'comment_post_ID',
  'comment_date',
  'comment_approved',
  'comment_author',
  'comment_author_email',
];

function toRow(comment: Comment, timeZone: string) {
  return {
    comment_ID: comment.id,
    comment_post_ID: comment.postId,
    comment_date: localDate(comment.date, timeZone),
    comment_approved: comment.approved,
    comment_author: comment.author,
    comment_author_email: comment.authorEmail,
    comment_author_url: comment.authorUrl,
    comment_author_IP: comment.authorIp,
    comment_content: comment.content,
    comment_parent: comment.parentId ?? 0,
    comment_type: comment.type,
    user_id: comment.userId ?? 0,
  };
}

async function loadAll(ctx: Context): Promise<Comment[]> {
  const comments: Comment[] = [];
  for (const id of ctx.positionalIds()) {
    const comment = await ctx.kernel.comments.get(id);
    if (!comment) ctx.error(`There’s no comment with the ID ${id}.`);
    if (ctx.user && !(await ctx.kernel.comments.canEdit(ctx.user, comment))) {
      ctx.error(`${ctx.user.login} isn’t allowed to moderate comment ${id}.`);
    }
    comments.push(comment);
  }
  return comments;
}

export const commentCommands: CommandSpec[] = [
  {
    name: 'comment list',
    shortdesc: 'Lists comments.',
    synopsis:
      '[--status=<status>] [--post_id=<id>] [--type=<type>] [--search=<text>] [--number=<number>] [--fields=<fields>] [--field=<field>] [--format=<format>]',
    options: {
      status: 'Which comments: all (approved and pending), approve, hold, spam, trash or any.',
      post_id: 'Only comments on this post.',
      type: 'Only comments of this type (comment, pingback…), or all.',
      search: 'Only comments containing this text.',
      number: 'At most this many.',
    },
    choices: { status: ['all', 'approve', 'hold', 'spam', 'trash', 'any'] },
    defaults: { status: 'all' },
    examples: [
      ['pressbase comment list --status=hold --fields=comment_ID,comment_author', 'List comments waiting for moderation'],
      ['pressbase comment list --status=spam --format=ids', 'IDs of spam comments'],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require('moderate_comments', undefined, `${ctx.user?.login} isn’t allowed to moderate comments.`);
      const postId = ctx.int('post_id');
      const { comments } = await ctx.kernel.comments.query({
        status: ctx.string('status') ?? 'all',
        post__in: postId === undefined ? undefined : [postId],
        type: ctx.string('type') ?? 'all',
        search: ctx.string('search'),
        number: ctx.int('number'),
        orderby: 'date',
        order: 'DESC',
      });
      const timeZone = await siteTimeZone(ctx.kernel);
      ctx.formatItems(
        comments.map((c) => toRow(c, timeZone)),
        LIST_FIELDS,
        { all: FIELDS, idField: 'comment_ID' },
      );
    },
  },
  {
    name: 'comment approve',
    shortdesc: 'Approves comments.',
    synopsis: '<id>...',
    options: { id: 'The comments’ IDs.' },
    examples: [['pressbase comment approve 7 8', 'Approve two comments']],
    needs: 'installed',
    async run(ctx) {
      for (const comment of await loadAll(ctx)) {
        await service(() => ctx.kernel.comments.setStatus(comment.id, 'approve'));
        ctx.success(`Approved comment ${comment.id}.`);
      }
    },
  },
  {
    name: 'comment spam',
    shortdesc: 'Marks comments as spam.',
    synopsis: '<id>...',
    options: { id: 'The comments’ IDs.' },
    examples: [['pressbase comment spam 9', 'Mark a comment as spam']],
    needs: 'installed',
    async run(ctx) {
      for (const comment of await loadAll(ctx)) {
        await service(() => ctx.kernel.comments.spam(comment.id));
        ctx.success(`Marked comment ${comment.id} as spam.`);
      }
    },
  },
  {
    name: 'comment delete',
    shortdesc: 'Moves comments to the Trash, or deletes them with --force.',
    synopsis: '<id>... [--force]',
    options: {
      id: 'The comments’ IDs.',
      force: 'Delete permanently instead of moving to the Trash. Asks first, unless --yes.',
    },
    examples: [
      ['pressbase comment delete 9', 'Move a comment to the Trash'],
      ['pressbase comment delete $(pressbase comment list --status=spam --format=ids) --force --yes', 'Delete all spam'],
    ],
    needs: 'installed',
    async run(ctx) {
      const comments = await loadAll(ctx);
      const force = ctx.flag('force');
      if (force) {
        await ctx.confirm(
          `Permanently delete ${comments.length === 1 ? `comment ${comments[0]?.id}` : `${comments.length} comments`}? This can’t be undone.`,
        );
      }
      let failed = 0;
      for (const comment of comments) {
        if (force) {
          await service(() => ctx.kernel.comments.delete(comment.id));
          ctx.success(`Deleted comment ${comment.id}.`);
        } else if (comment.approved === 'trash') {
          ctx.warning(`Comment ${comment.id} is already in the Trash. Add --force to delete it permanently.`);
          failed += 1;
        } else {
          await service(() => ctx.kernel.comments.trash(comment.id));
          ctx.success(`Trashed comment ${comment.id}.`);
        }
      }
      if (failed) ctx.error(`${failed} of ${comments.length} comments weren’t deleted.`);
    },
  },
];
