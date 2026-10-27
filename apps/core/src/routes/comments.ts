import { schema } from '@pressbase/db';
import { count, inArray } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { type CurrentUser, loadUser, userCan } from '../auth/users';
import { avatarUrls, commentText } from '../comments/format';
import { commentLink } from '../comments/links';
import type { DiscussionOptions } from '../comments/options';
import {
  type Comment,
  type CommentData,
  CommentError,
  type CommentQueryArgs,
  commentStatusName,
  isEmail,
} from '../comments/service';
import { parseRestDate, toGmtString, toLocalString } from '../content/dates';
import { type PermalinkContext, permalinkContext } from '../content/permalinks';
import type { Post } from '../content/posts';
import { type AppEnv, clientIp, invalidParams, readJson, restError } from '../http';
import type { Kernel } from '../kernel';
import {
  authStatus,
  boolParam,
  contextParam,
  intList,
  pageParam,
  perPageParam,
  queryObject,
  rawText,
  setPaginationHeaders,
} from './rest-util';

/**
 * /wp/v2/comments — a port of WP_REST_Comments_Controller
 * (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-comments-controller.php).
 * Same parameters, fields, permission checks and error codes. Differences:
 *
 * - Visitors may comment without logging in, as on WordPress's comment form;
 *   WordPress's REST API needs the `rest_allow_anonymous_comments` filter for
 *   that. Pressbase's filter defaults to true; return false to require login.
 * - `author_email` as a list filter needs `moderate_comments` (WordPress:
 *   `edit_posts`), so contributors can't probe who commented.
 * - Updates don't overwrite the stored IP address with the editor's.
 *
 * Filters: `rest_allow_anonymous_comments`, `rest_preprocess_comment`,
 * `rest_pre_insert_comment`, `rest_comment_query`, `rest_prepare_comment`.
 * Actions: `rest_insert_comment`, `rest_after_insert_comment`, `rest_delete_comment`.
 */

type RestContext = 'view' | 'edit' | 'embed';

interface Prepared {
  kernel: Kernel;
  user: CurrentUser | null;
  context: RestContext;
  timeZone: string;
  links: PermalinkContext;
  options: DiscussionOptions;
  posts: Map<number, Post>;
  children: Map<number, number>;
}

async function prepareContext(
  kernel: Kernel,
  user: CurrentUser | null,
  context: RestContext,
  comments: Comment[],
): Promise<Prepared> {
  const postIds = [...new Set(comments.map((c) => c.postId))];
  const ids = comments.map((c) => c.id);
  const posts = new Map<number, Post>();
  if (postIds.length) {
    const rows = await kernel.db
      .select()
      .from(schema.posts)
      .where(inArray(schema.posts.id, postIds));
    for (const row of rows) posts.set(row.id, row);
  }
  const children = new Map<number, number>();
  if (ids.length) {
    const rows = await kernel.db
      .select({ parent: schema.comments.parentId, n: count() })
      .from(schema.comments)
      .where(inArray(schema.comments.parentId, ids))
      .groupBy(schema.comments.parentId);
    for (const row of rows) if (row.parent) children.set(row.parent, row.n);
  }
  return {
    kernel,
    user,
    context,
    timeZone: await kernel.options.get<string>('timezone_string', 'UTC'),
    links: await permalinkContext(kernel),
    options: await kernel.comments.options(),
    posts,
    children,
  };
}

async function prepareItem(comment: Comment, p: Prepared): Promise<Record<string, unknown>> {
  const edit = p.context === 'edit';
  const post = p.posts.get(comment.postId);
  const item: Record<string, unknown> = {
    id: comment.id,
    post: comment.postId,
    parent: comment.parentId ?? 0,
    author: comment.userId ?? 0,
    author_name: comment.author,
    ...(edit ? { author_email: comment.authorEmail } : {}),
    author_url: comment.authorUrl,
    ...(edit ? { author_ip: comment.authorIp, author_user_agent: comment.agent } : {}),
    date: toLocalString(comment.date, p.timeZone),
    date_gmt: toGmtString(comment.date),
    content: {
      rendered: await p.kernel.hooks.applyFilters(
        'comment_text',
        commentText(comment.content),
        comment,
      ),
      ...(edit ? { raw: comment.content } : {}),
    },
    link: post ? await commentLink(p.kernel, comment, post, p.options, p.links) : '',
    status: commentStatusName(comment.approved),
    type: comment.type || 'comment',
    author_avatar_urls: avatarUrls(comment.authorEmail, {
      default: p.options.avatar_default,
      rating: p.options.avatar_rating,
    }),
    meta: {},
  };
  const restBase = post ? p.kernel.postTypes.get(post.type)?.restBase : undefined;
  item._links = {
    self: [{ href: `/wp-json/wp/v2/comments/${comment.id}` }],
    collection: [{ href: '/wp-json/wp/v2/comments' }],
    ...(comment.userId
      ? { author: [{ embeddable: true, href: `/wp-json/wp/v2/users/${comment.userId}` }] }
      : {}),
    ...(post && restBase
      ? {
          up: [
            {
              embeddable: true,
              post_type: post.type,
              href: `/wp-json/wp/v2/${restBase}/${post.id}`,
            },
          ],
        }
      : {}),
    ...(comment.parentId
      ? {
          'in-reply-to': [
            { embeddable: true, href: `/wp-json/wp/v2/comments/${comment.parentId}` },
          ],
        }
      : {}),
    ...(p.children.get(comment.id)
      ? {
          children: [{ embeddable: true, href: `/wp-json/wp/v2/comments?parent=${comment.id}` }],
        }
      : {}),
  };
  if (p.context === 'embed') {
    const { id, author, author_name, author_url, date, content, link, type, _links } = item;
    return {
      id,
      author,
      author_name,
      author_url,
      date,
      content,
      link,
      type,
      author_avatar_urls: item.author_avatar_urls,
      _links,
    };
  }
  return (await p.kernel.hooks.applyFilters(
    'rest_prepare_comment',
    item,
    comment,
    p.context,
  )) as Record<string, unknown>;
}

/**
 * check_read_post_permission(): the post's own read rules; a password-protected
 * post needs its password (or edit rights).
 */
async function canReadPost(
  kernel: Kernel,
  user: CurrentUser | null,
  post: Post,
  password?: string,
): Promise<boolean> {
  if (post.password && password !== post.password) {
    return currentUserCan(kernel, user, 'edit_post', post.id);
  }
  if (post.status === 'publish' && kernel.postTypes.get(post.type)?.public) return true;
  return currentUserCan(kernel, user, 'read_post', post.id);
}

/** check_read_permission() for one comment. */
async function canReadComment(
  kernel: Kernel,
  user: CurrentUser | null,
  comment: Comment,
  post: Post | undefined,
  password?: string,
): Promise<boolean> {
  if (post && comment.approved === '1' && (await canReadPost(kernel, user, post, password))) {
    return true;
  }
  if (!user) return false;
  if (comment.userId && comment.userId === user.id) return true;
  return kernel.comments.canEdit(user, comment);
}

function commentError(c: Context, error: unknown) {
  if (error instanceof CommentError) return restError(c, error.status, error.code, error.message);
  throw error;
}

const COLLECTION_ARRAYS = [
  'author',
  'author_exclude',
  'include',
  'exclude',
  'parent',
  'parent_exclude',
  'post',
  'status',
  'type',
] as const;

const collectionSchema = z.object({
  context: contextParam,
  page: pageParam,
  per_page: perPageParam,
  search: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  author: intList,
  author_exclude: intList,
  author_email: z.email({ message: 'Enter a valid email address.' }).optional(),
  include: intList,
  exclude: intList,
  offset: z.coerce.number().int().min(0).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  orderby: z
    .enum(['date', 'date_gmt', 'id', 'include', 'post', 'parent', 'type'])
    .default('date_gmt'),
  parent: intList,
  parent_exclude: intList,
  post: intList,
  status: z.array(z.string().min(1).max(20)).default(['approve']),
  type: z.array(z.string().min(1).max(20)).default(['comment']),
  password: z.string().optional(),
});

const bodySchema = z.object({
  author: z.number().int().min(0).optional(),
  author_email: z
    .string()
    .trim()
    .max(100)
    .refine((v) => v === '' || isEmail(v), { message: 'Enter a valid email address.' })
    .optional(),
  author_ip: z.union([z.ipv4(), z.ipv6()], { message: 'Enter a valid IP address.' }).optional(),
  author_name: z.string().optional(),
  author_url: z.string().optional(),
  author_user_agent: z.string().optional(),
  content: rawText.optional(),
  date: z.string().optional(),
  date_gmt: z.string().optional(),
  parent: z.number().int().min(0).optional(),
  post: z.number().int().min(0).optional(),
  status: z.string().max(20).optional(),
  type: z.string().max(20).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** handle_status_param(): moves a comment to another status; false when nothing changed. */
async function handleStatus(kernel: Kernel, status: string, comment: Comment): Promise<boolean> {
  const current = commentStatusName(comment.approved);
  switch (status) {
    case 'approved':
    case 'approve':
    case '1':
      if (current === 'approved') return false;
      await kernel.comments.setStatus(comment.id, 'approve');
      return true;
    case 'hold':
    case '0':
      if (current === 'hold') return false;
      await kernel.comments.setStatus(comment.id, 'hold');
      return true;
    case 'spam':
      if (current === 'spam') return false;
      await kernel.comments.spam(comment.id);
      return true;
    case 'unspam':
      if (current !== 'spam') return false;
      await kernel.comments.unspam(comment.id);
      return true;
    case 'trash':
      if (current === 'trash') return false;
      await kernel.comments.trash(comment.id);
      return true;
    case 'untrash':
      if (current !== 'trash') return false;
      await kernel.comments.untrash(comment.id);
      return true;
    default:
      return false;
  }
}

const VALID_STATUSES = new Set([
  'approved',
  'approve',
  '1',
  'hold',
  '0',
  'spam',
  'unspam',
  'trash',
  'untrash',
]);

export function commentsRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  /* ------------------------------------------------------------ list */

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const raw = queryObject(c, COLLECTION_ARRAYS);
    const parsed = collectionSchema.safeParse(raw);
    if (!parsed.success) return invalidParams(c, parsed.error);
    const q = parsed.data;

    // get_items_permissions_check()
    for (const postId of q.post ?? []) {
      const post = postId ? await kernel.posts.get(postId) : undefined;
      if (post && !(await canReadPost(kernel, user, post, q.password))) {
        return restError(
          c,
          authStatus(c),
          'rest_cannot_read_post',
          'Sorry, you are not allowed to read the post for this comment.',
        );
      }
      if (postId === 0 && !userCan(user, 'moderate_comments')) {
        return restError(
          c,
          authStatus(c),
          'rest_cannot_read',
          'Sorry, you are not allowed to read comments without a post.',
        );
      }
    }
    if (q.context === 'edit' && !userCan(user, 'moderate_comments')) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden_context',
        'Sorry, you are not allowed to edit comments.',
      );
    }
    const forbidden: string[] = [];
    if (!userCan(user, 'edit_posts')) {
      if (q.author?.length) forbidden.push('author');
      if (q.author_exclude?.length) forbidden.push('author_exclude');
      if (q.type.some((t) => t !== 'comment')) forbidden.push('type');
      if (q.status.some((s) => s !== 'approve')) forbidden.push('status');
    }
    if (q.author_email && !userCan(user, 'moderate_comments')) forbidden.push('author_email');
    if (forbidden.length) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden_param',
        `Query parameter not permitted: ${forbidden.join(', ')}`,
      );
    }

    const timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
    const date = (value?: string) => (value ? parseRestDate(value, timeZone, false) : undefined);
    let args: CommentQueryArgs = {
      post__in: q.post?.filter((id) => id > 0),
      parent__in: q.parent,
      parent__not_in: q.parent_exclude,
      author__in: q.author,
      author__not_in: q.author_exclude,
      author_email: q.author_email,
      comment__in: q.include,
      comment__not_in: q.exclude,
      status: q.status,
      type: q.type,
      search: q.search,
      date_after: date(q.after),
      date_before: date(q.before),
      orderby: q.orderby,
      order: q.order === 'asc' ? 'ASC' : 'DESC',
      number: q.per_page,
      offset: q.offset ?? (q.page - 1) * q.per_page,
    };
    args = (await kernel.hooks.applyFilters('rest_comment_query', args, raw)) as CommentQueryArgs;
    const { comments, found } = await kernel.comments.query(args);

    const posts = new Map<number, Post>();
    const readable: Comment[] = [];
    for (const comment of comments) {
      if (!posts.has(comment.postId)) {
        const post = await kernel.posts.get(comment.postId);
        if (post) posts.set(post.id, post);
      }
      if (await canReadComment(kernel, user, comment, posts.get(comment.postId), q.password)) {
        readable.push(comment);
      }
    }
    const prepared = await prepareContext(kernel, user, q.context, readable);
    const items = [];
    for (const comment of readable) items.push(await prepareItem(comment, prepared));
    setPaginationHeaders(c, found, Math.ceil(found / q.per_page), q.page);
    return c.json(items);
  });

  /* ------------------------------------------------------------ read */

  const load = async (c: Context<AppEnv>): Promise<Comment | Response> => {
    const kernel = c.get('kernel');
    const comment = await kernel.comments.get(Number(c.req.param('id')));
    if (!comment) return restError(c, 404, 'rest_comment_invalid_id', 'Invalid comment ID.');
    if (!(await kernel.posts.get(comment.postId))) {
      return restError(c, 404, 'rest_post_invalid_id', 'Invalid post ID.');
    }
    return comment;
  };

  app.get('/:id{[0-9]+}', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const parsed = z
      .object({ context: contextParam, password: z.string().optional() })
      .safeParse(c.req.query());
    if (!parsed.success) return invalidParams(c, parsed.error);
    const comment = await load(c);
    if (comment instanceof Response) return comment;
    if (parsed.data.context === 'edit' && !(await kernel.comments.canEdit(user, comment))) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden_context',
        'Sorry, you are not allowed to edit comments.',
      );
    }
    const post = await kernel.posts.get(comment.postId);
    if (!(await canReadComment(kernel, user, comment, post, parsed.data.password))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_read',
        'Sorry, you are not allowed to read this comment.',
      );
    }
    if (post && !(await canReadPost(kernel, user, post, parsed.data.password))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_read_post',
        'Sorry, you are not allowed to read the post for this comment.',
      );
    }
    const prepared = await prepareContext(kernel, user, parsed.data.context, [comment]);
    return c.json(await prepareItem(comment, prepared));
  });

  /* ---------------------------------------------------------- create */

  app.post('/', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const json = await readJson(c);
    const parsed = bodySchema.safeParse(json ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    const body = parsed.data;
    const isModerator = userCan(user, 'moderate_comments');
    const options = await kernel.comments.options();
    const ip = clientIp(c) || '127.0.0.1';

    // create_item_permissions_check()
    if (!user) {
      const anonymous = await kernel.hooks.applyFilters(
        'rest_allow_anonymous_comments',
        true,
        body,
      );
      if (options.comment_registration || !anonymous) {
        return restError(
          c,
          401,
          'rest_comment_login_required',
          'Sorry, you must be logged in to comment.',
        );
      }
    }
    if (body.author !== undefined && body.author !== (user?.id ?? 0) && !isModerator) {
      return restError(
        c,
        authStatus(c),
        'rest_comment_invalid_author',
        "Sorry, you are not allowed to edit 'author' for comments.",
      );
    }
    if (body.author_ip !== undefined && !isModerator && body.author_ip !== ip) {
      return restError(
        c,
        authStatus(c),
        'rest_comment_invalid_author_ip',
        "Sorry, you are not allowed to edit 'author_ip' for comments.",
      );
    }
    if (body.status !== undefined && !isModerator) {
      return restError(
        c,
        authStatus(c),
        'rest_comment_invalid_status',
        "Sorry, you are not allowed to edit 'status' for comments.",
      );
    }
    const post = body.post ? await kernel.posts.get(body.post) : undefined;
    if (!post || !kernel.postTypes.get(post.type)?.showInRest) {
      return restError(
        c,
        403,
        'rest_comment_invalid_post_id',
        'Sorry, you are not allowed to create this comment without a post.',
      );
    }
    if (post.status === 'draft') {
      return restError(
        c,
        403,
        'rest_comment_draft_post',
        'Sorry, you are not allowed to create a comment on this post.',
      );
    }
    if (post.status === 'trash') {
      return restError(
        c,
        403,
        'rest_comment_trash_post',
        'Sorry, you are not allowed to create a comment on this post.',
      );
    }
    if (!(await canReadPost(kernel, user, post, undefined))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_read_post',
        'Sorry, you are not allowed to read the post for this comment.',
      );
    }
    if (!(await kernel.comments.commentsOpen(post, options))) {
      return restError(c, 403, 'rest_comment_closed', 'Sorry, comments are closed for this item.');
    }

    // create_item()
    if ((body.type ?? 'comment') !== 'comment') {
      return restError(
        c,
        400,
        'rest_invalid_comment_type',
        'Cannot create a comment with that type.',
      );
    }
    const data = await prepareForDatabase(c, body, isModerator, ip);
    if (data instanceof Response) return data;
    data.postId = post.id;
    data.content ??= '';
    const allowEmpty = await kernel.hooks.applyFilters('allow_empty_comment', false, data);
    if (!allowEmpty && data.content.trim() === '') {
      return restError(c, 400, 'rest_comment_content_invalid', 'Invalid comment content.');
    }
    if (user && !data.userId && !data.author && !data.authorEmail && !data.authorUrl) {
      data.userId = user.id;
      data.author = user.displayName || user.login;
      data.authorEmail = user.email;
    }
    if (options.require_name_email && (!data.author?.trim() || !data.authorEmail?.trim())) {
      return restError(
        c,
        400,
        'rest_comment_author_data_required',
        'Creating a comment requires valid author name and email values.',
      );
    }

    let comment: Comment;
    try {
      const filtered = (await kernel.hooks.applyFilters(
        'rest_pre_insert_comment',
        data,
        body,
      )) as CommentData;
      comment = await kernel.comments.newComment(filtered, { user });
      if (body.status !== undefined) await handleStatus(kernel, body.status, comment);
    } catch (error) {
      if (error instanceof CommentError) {
        if (error.code === 'comment_flood') {
          return restError(c, 400, error.code, error.message);
        }
        if (error.code.endsWith('_column_length')) {
          return restError(c, 400, error.code, 'Comment field exceeds maximum length allowed.');
        }
      }
      return commentError(c, error);
    }
    comment = (await kernel.comments.get(comment.id)) as Comment;
    await kernel.hooks.doAction('rest_insert_comment', comment, body, true);
    await kernel.hooks.doAction('rest_after_insert_comment', comment, body, true);
    const prepared = await prepareContext(kernel, user, isModerator ? 'edit' : 'view', [comment]);
    c.header('Location', `/wp-json/wp/v2/comments/${comment.id}`);
    return c.json(await prepareItem(comment, prepared), 201);
  });

  /* ---------------------------------------------------------- update */

  const update = async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const existing = await load(c);
    if (existing instanceof Response) return existing;
    if (!(await kernel.comments.canEdit(user, existing))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_edit',
        'Sorry, you are not allowed to edit this comment.',
      );
    }
    const parsed = bodySchema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    const body = parsed.data;
    const isModerator = userCan(user, 'moderate_comments');
    if ((body.author !== undefined || body.author_ip !== undefined) && !isModerator) {
      return restError(
        c,
        authStatus(c),
        'rest_comment_invalid_author',
        "Sorry, you are not allowed to edit 'author' for comments.",
      );
    }
    if (body.post !== undefined && body.post !== existing.postId) {
      const target = await kernel.posts.get(body.post);
      if (!target) {
        return restError(c, 403, 'rest_comment_invalid_post_id', 'Invalid post ID.');
      }
      if (!(await canReadPost(kernel, user, target))) {
        return restError(
          c,
          authStatus(c),
          'rest_cannot_read_post',
          'Sorry, you are not allowed to read the post for this comment.',
        );
      }
    }
    if (body.type !== undefined && body.type !== (existing.type || 'comment')) {
      return restError(
        c,
        404,
        'rest_comment_invalid_type',
        'Sorry, you are not allowed to change the comment type.',
      );
    }
    if (body.status !== undefined && !VALID_STATUSES.has(body.status)) {
      return restError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): status', {
        params: { status: 'Use approved, hold, spam, unspam, trash or untrash.' },
      });
    }
    if (body.content !== undefined && body.content.trim() === '') {
      const allowEmpty = await kernel.hooks.applyFilters('allow_empty_comment', false, body);
      if (!allowEmpty) {
        return restError(c, 400, 'rest_comment_content_invalid', 'Invalid comment content.');
      }
    }
    if (body.parent !== undefined && body.parent > 0) {
      const parent = await kernel.comments.get(body.parent);
      if (
        !parent ||
        parent.postId !== (body.post ?? existing.postId) ||
        parent.id === existing.id
      ) {
        return restError(c, 400, 'rest_comment_invalid_parent', 'Invalid comment parent ID.');
      }
    }
    const data = await prepareForDatabase(c, body, isModerator, undefined);
    if (data instanceof Response) return data;
    try {
      if (Object.values(data).some((v) => v !== undefined)) {
        await kernel.comments.update(existing.id, data, { user });
      }
      if (body.status !== undefined) {
        const fresh = (await kernel.comments.get(existing.id)) as Comment;
        await handleStatus(kernel, body.status, fresh);
      }
    } catch (error) {
      if (error instanceof CommentError && error.code.endsWith('_column_length')) {
        return restError(c, 400, error.code, 'Comment field exceeds maximum length allowed.');
      }
      return commentError(c, error);
    }
    const comment = (await kernel.comments.get(existing.id)) as Comment;
    await kernel.hooks.doAction('rest_insert_comment', comment, body, false);
    await kernel.hooks.doAction('rest_after_insert_comment', comment, body, false);
    const prepared = await prepareContext(kernel, user, 'edit', [comment]);
    return c.json(await prepareItem(comment, prepared));
  };
  app.post('/:id{[0-9]+}', update);
  app.put('/:id{[0-9]+}', update);
  app.patch('/:id{[0-9]+}', update);

  /* ---------------------------------------------------------- delete */

  app.delete('/:id{[0-9]+}', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const comment = await load(c);
    if (comment instanceof Response) return comment;
    if (!(await kernel.comments.canEdit(user, comment))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_delete',
        'Sorry, you are not allowed to delete this comment.',
      );
    }
    const force = boolParam.safeParse(c.req.query('force') ?? 'false');
    const prepared = await prepareContext(kernel, user, 'edit', [comment]);
    try {
      if (force.success && force.data) {
        const previous = await prepareItem(comment, prepared);
        await kernel.comments.delete(comment.id);
        const response = { deleted: true, previous };
        await kernel.hooks.doAction('rest_delete_comment', comment, response);
        return c.json(response);
      }
      const trashed = await kernel.comments.trash(comment.id);
      const response = await prepareItem(trashed, prepared);
      await kernel.hooks.doAction('rest_delete_comment', trashed, response);
      return c.json(response);
    } catch (error) {
      return commentError(c, error);
    }
  });

  return app;
}

/**
 * prepare_item_for_database(): request fields → comment data. Returns a REST
 * error for an unknown author ID or an invalid date.
 */
async function prepareForDatabase(
  c: Context<AppEnv>,
  body: z.infer<typeof bodySchema>,
  isModerator: boolean,
  ip: string | undefined,
): Promise<CommentData | Response> {
  const kernel = c.get('kernel');
  const data: Partial<CommentData> = {};
  if (body.content !== undefined) data.content = body.content.trim();
  if (body.post !== undefined) data.postId = body.post;
  if (body.parent !== undefined) data.parentId = body.parent || null;
  if (body.author !== undefined) {
    const author = body.author ? await loadUser(kernel, body.author) : null;
    if (!author) {
      return restError(c, 400, 'rest_comment_author_invalid', 'Invalid comment author ID.');
    }
    data.userId = author.id;
    data.author = author.displayName || author.login;
    data.authorEmail = author.email;
  }
  if (body.author_name !== undefined) data.author = body.author_name;
  if (body.author_email !== undefined) data.authorEmail = body.author_email;
  if (body.author_url !== undefined) data.authorUrl = body.author_url;
  if (body.author_ip !== undefined && isModerator) data.authorIp = body.author_ip;
  else if (ip !== undefined) data.authorIp = ip;
  if (body.author_user_agent) data.agent = body.author_user_agent;
  else if (ip !== undefined) data.agent = c.req.header('user-agent') ?? '';
  const timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
  if (body.date || body.date_gmt) {
    const date = body.date
      ? parseRestDate(body.date, timeZone, false)
      : parseRestDate(body.date_gmt as string, timeZone, true);
    if (!date) return restError(c, 400, 'rest_invalid_date', 'Invalid date.');
    data.date = date;
  }
  return (await kernel.hooks.applyFilters('rest_preprocess_comment', data, body)) as CommentData;
}

/** GET /pressbase/v1/comment-counts — wp_count_comments(), for the admin's status tabs. */
export function commentCountRoutes() {
  const app = new Hono<AppEnv>({ strict: false });
  app.get('/', async (c) => {
    const user = c.get('user');
    if (!userCan(user, 'moderate_comments')) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden',
        'Sorry, you are not allowed to do that.',
      );
    }
    const kernel = c.get('kernel');
    const postId = Number(c.req.query('post') ?? 0);
    const counts = await kernel.comments.counts(postId > 0 ? postId : undefined);
    const mine = user
      ? (await kernel.comments.query({ author__in: [user.id], status: 'all', number: 1 })).found
      : 0;
    return c.json({ ...counts, mine });
  });
  return app;
}
