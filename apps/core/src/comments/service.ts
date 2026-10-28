import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { schema } from '@pressbase/db';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { currentUserCan } from '../auth/meta-caps';
import { type CurrentUser, loadUser, userCan } from '../auth/users';
import { addCacheTags, CacheTag } from '../cache/tags';
import type { Post } from '../content/posts';
import type { Kernel } from '../kernel';
import { ksesComment, plainText, relUgc } from './format';
import { type DiscussionOptions, discussionOptions, registerDiscussionSettings } from './options';

/**
 * kernel.comments — WordPress's comment API (wordpress/wp-includes/comment.php):
 * wp_new_comment(), wp_allow_comment(), check_comment(),
 * wp_check_comment_disallowed_list(), wp_insert_comment(), wp_update_comment(),
 * wp_set_comment_status(), wp_trash_comment() / wp_untrash_comment(),
 * wp_spam_comment() / wp_unspam_comment(), wp_delete_comment(),
 * wp_update_comment_count() and wp_count_comments(), plus WP_Comment_Query
 * (class-wp-comment-query.php) as `query()`.
 *
 * `approved` holds WordPress's values: '1' approved, '0' pending, 'spam', 'trash'.
 */

export type Comment = typeof schema.comments.$inferSelect;

/** The comment fields wp_new_comment() takes (WordPress's $commentdata). */
export interface CommentData {
  postId: number;
  parentId?: number | null;
  content: string;
  author?: string;
  authorEmail?: string;
  authorUrl?: string;
  authorIp?: string;
  agent?: string;
  type?: string;
  userId?: number | null;
  date?: Date;
}

export interface NewCommentOptions {
  /** Who is submitting: null for a visitor. Decides kses and flood exemption. */
  user: CurrentUser | null;
  /** Filter HTML even when the user has unfiltered_html (the public comment form). */
  forceKses?: boolean;
  /** Skip duplicate, flood and moderation checks; use this status (moderators via REST). */
  approved?: '0' | '1' | 'spam' | 'trash';
}

export class CommentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 500 = 400,
  ) {
    super(message);
  }
}

/** wp_get_comment_fields_max_lengths() */
export const COMMENT_MAX_LENGTHS = {
  author: 245,
  authorEmail: 100,
  authorUrl: 200,
  content: 65_525,
} as const;

/** The status names REST and the admin use, and the stored values behind them. */
export type CommentStatus = 'approved' | 'hold' | 'spam' | 'trash';

/** wp_get_comment_status() */
export function commentStatusName(approved: string): CommentStatus | 'unapproved' {
  if (approved === '1') return 'approved';
  if (approved === '0') return 'hold';
  if (approved === 'spam' || approved === 'trash') return approved;
  return 'unapproved';
}

/** The names wp_transition_comment_status() fires with. */
function transitionName(status: string): string {
  if (status === '1' || status === 'approve' || status === 'approved') return 'approved';
  if (status === '0' || status === 'hold') return 'unapproved';
  return status;
}

export interface CommentQueryArgs {
  post__in?: number[];
  /** Only comments on posts with these statuses (latest comments: ['publish']). */
  post_status?: string[];
  /** 0 means top-level comments. */
  parent__in?: number[];
  parent__not_in?: number[];
  author__in?: number[];
  author__not_in?: number[];
  author_email?: string;
  comment__in?: number[];
  comment__not_in?: number[];
  /** 'approve', 'hold', 'spam', 'trash', 'all' (approved or pending), 'any'; or raw values. */
  status?: string | string[];
  /** 'comment' (the default type; '' counts too), 'all', or others. */
  type?: string | string[];
  search?: string;
  /** Pending comments by these user IDs or emails are included too. */
  include_unapproved?: (number | string)[];
  date_after?: Date;
  date_before?: Date;
  orderby?: 'date' | 'date_gmt' | 'id' | 'include' | 'post' | 'parent' | 'type' | 'none';
  order?: 'ASC' | 'DESC';
  number?: number;
  offset?: number;
}

/** A comment with its replies, for threaded display. */
export interface CommentNode {
  comment: Comment;
  depth: number;
  children: CommentNode[];
}

/** WordPress's flood interval (wp_throttle_comment_flood()): 15 seconds. */
const FLOOD_SECONDS = 15;
/** How long ?unapproved=…&moderation-hash=… shows a visitor their pending comment. */
const PREVIEW_MINUTES = 10;

export class CommentsService {
  constructor(private readonly kernel: Kernel) {
    registerDiscussionSettings(kernel.settings);
  }

  get #db() {
    return this.kernel.db;
  }

  options(): Promise<DiscussionOptions> {
    return discussionOptions(this.kernel);
  }

  async get(id: number): Promise<Comment | undefined> {
    if (!Number.isInteger(id) || id <= 0) return undefined;
    const [row] = await this.#db.select().from(schema.comments).where(eq(schema.comments.id, id));
    return row;
  }

  /* ------------------------------------------------------------ reading */

  #where(args: CommentQueryArgs): SQL | undefined {
    const c = schema.comments;
    const where: (SQL | undefined)[] = [];
    if (args.post__in?.length) where.push(inArray(c.postId, args.post__in));
    if (args.post_status?.length) {
      where.push(
        inArray(
          c.postId,
          this.#db
            .select({ id: schema.posts.id })
            .from(schema.posts)
            .where(inArray(schema.posts.status, args.post_status)),
        ),
      );
    }
    const parentClause = (ids: number[]) => {
      const real = ids.filter((id) => id > 0);
      const top = ids.includes(0);
      return or(
        real.length ? inArray(c.parentId, real) : undefined,
        top ? isNull(c.parentId) : undefined,
      );
    };
    if (args.parent__in?.length) where.push(parentClause(args.parent__in));
    if (args.parent__not_in?.length) {
      const real = args.parent__not_in.filter((id) => id > 0);
      if (real.length) where.push(or(isNull(c.parentId), notInArray(c.parentId, real)));
      if (args.parent__not_in.includes(0)) where.push(isNotNull(c.parentId));
    }
    if (args.author__in?.length) where.push(inArray(c.userId, args.author__in));
    if (args.author__not_in?.length) {
      where.push(or(isNull(c.userId), notInArray(c.userId, args.author__not_in)));
    }
    if (args.author_email)
      where.push(eq(sql`lower(${c.authorEmail})`, args.author_email.toLowerCase()));
    if (args.comment__in?.length) where.push(inArray(c.id, args.comment__in));
    if (args.comment__not_in?.length) where.push(notInArray(c.id, args.comment__not_in));

    // Statuses: 'approve' → '1', 'hold' → '0', 'all' → both, 'any' → no filter.
    const statuses = [args.status ?? 'all'].flat();
    if (!statuses.includes('any')) {
      const values = new Set<string>();
      for (const s of statuses) {
        if (s === 'approve' || s === 'approved' || s === '1') values.add('1');
        else if (s === 'hold' || s === '0') values.add('0');
        else if (s === 'all') {
          values.add('1');
          values.add('0');
        } else values.add(s);
      }
      let status: SQL | undefined = inArray(c.approved, [...values]);
      const ids = (args.include_unapproved ?? []).filter((v): v is number => typeof v === 'number');
      const emails = (args.include_unapproved ?? []).filter(
        (v): v is string => typeof v === 'string' && v !== '',
      );
      if (!values.has('0') && (ids.length || emails.length)) {
        status = or(
          status,
          and(
            eq(c.approved, '0'),
            or(
              ids.length ? inArray(c.userId, ids) : undefined,
              emails.length ? inArray(c.authorEmail, emails) : undefined,
            ),
          ),
        );
      }
      where.push(status);
    }

    const types = [args.type ?? 'all'].flat();
    if (!types.includes('all')) {
      const list = types.flatMap((t) => (t === 'comment' ? ['comment', ''] : [t]));
      where.push(inArray(c.type, list));
    }
    if (args.search?.trim()) {
      const like = `%${args.search.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(
        or(
          ilike(c.author, like),
          ilike(c.authorEmail, like),
          ilike(c.authorUrl, like),
          ilike(c.authorIp, like),
          ilike(c.content, like),
        ),
      );
    }
    if (args.date_after) where.push(gte(c.date, args.date_after));
    if (args.date_before) where.push(lte(c.date, args.date_before));
    return and(...where);
  }

  /** WP_Comment_Query: the matching comments and how many there are in all. */
  async query(args: CommentQueryArgs = {}): Promise<{ comments: Comment[]; found: number }> {
    const c = schema.comments;
    const where = this.#where(args);
    const dir = args.order === 'ASC' ? asc : desc;
    const orderby = args.orderby ?? 'date_gmt';
    const order: SQL[] = [];
    if (orderby === 'include' && args.comment__in?.length) {
      order.push(
        sql`array_position(${sql.raw(`ARRAY[${args.comment__in.map(Number).join(',')}]::bigint[]`)}, ${c.id})`,
      );
    } else if (orderby === 'post') order.push(dir(c.postId));
    else if (orderby === 'parent') order.push(dir(c.parentId));
    else if (orderby === 'type') order.push(dir(c.type));
    else if (orderby === 'date' || orderby === 'date_gmt') order.push(dir(c.date));
    if (orderby !== 'none') order.push(dir(c.id));

    let q = this.#db
      .select()
      .from(c)
      .where(where)
      .orderBy(...order)
      .$dynamic();
    if (args.number && args.number > 0) q = q.limit(args.number).offset(args.offset ?? 0);
    // A comment list across posts (latest comments, the comments feed); a
    // post's own comments are covered by its post:{id} tag.
    if (!args.post__in?.length) addCacheTags(CacheTag.comments);
    const [comments, [total]] = await Promise.all([
      q,
      this.#db.select({ n: count() }).from(c).where(where),
    ]);
    return { comments, found: total?.n ?? 0 };
  }

  /**
   * Threaded comments of a post, as WP_Comment_Query's `hierarchical =>
   * 'threaded'`: top-level comments are paged (oldest first), and each comes
   * with all its descendants. `depth` starts at 1.
   */
  async thread(
    postId: number,
    args: {
      includeUnapproved?: (number | string)[];
      perPage?: number;
      page?: number;
      threaded?: boolean;
    },
  ): Promise<{ nodes: CommentNode[]; topLevel: number; pages: number }> {
    const base: CommentQueryArgs = {
      post__in: [postId],
      status: 'approve',
      include_unapproved: args.includeUnapproved,
      type: 'comment',
      orderby: 'date_gmt',
      order: 'ASC',
    };
    const threaded = args.threaded ?? true;
    const perPage = args.perPage && args.perPage > 0 ? args.perPage : 0;
    const page = Math.max(1, args.page ?? 1);
    const top = await this.query({
      ...base,
      ...(threaded ? { parent__in: [0] } : {}),
      ...(perPage ? { number: perPage, offset: (page - 1) * perPage } : {}),
    });
    const pages = perPage ? Math.max(1, Math.ceil(top.found / perPage)) : 1;
    if (!threaded) {
      return {
        nodes: top.comments.map((comment) => ({ comment, depth: 1, children: [] })),
        topLevel: top.found,
        pages,
      };
    }

    const all = (await this.query(base)).comments;
    const byParent = new Map<number, Comment[]>();
    for (const comment of all) {
      if (!comment.parentId) continue;
      byParent.set(comment.parentId, [...(byParent.get(comment.parentId) ?? []), comment]);
    }
    const build = (comment: Comment, depth: number): CommentNode => ({
      comment,
      depth,
      children: (byParent.get(comment.id) ?? []).map((child) => build(child, depth + 1)),
    });
    return { nodes: top.comments.map((c) => build(c, 1)), topLevel: top.found, pages };
  }

  /** wp_count_comments(): per-status counts for the admin's tabs. */
  async counts(postId?: number): Promise<Record<string, number>> {
    const c = schema.comments;
    const rows = await this.#db
      .select({ approved: c.approved, n: count() })
      .from(c)
      .where(postId ? eq(c.postId, postId) : undefined)
      .groupBy(c.approved);
    const by = Object.fromEntries(rows.map((r) => [r.approved, r.n])) as Record<string, number>;
    const approved = by['1'] ?? 0;
    const moderated = by['0'] ?? 0;
    return {
      approved,
      moderated,
      spam: by.spam ?? 0,
      trash: by.trash ?? 0,
      'post-trashed': by['post-trashed'] ?? 0,
      total_comments: approved + moderated + (by.spam ?? 0),
      all: approved + moderated,
    };
  }

  /** Depth of a comment in its thread: 1 for top-level (comment-reply-link.php). */
  async depthOf(comment: Comment): Promise<number> {
    let depth = 1;
    let parentId = comment.parentId;
    for (let guard = 0; parentId && guard < 100; guard++) {
      depth++;
      parentId = (await this.get(parentId))?.parentId ?? null;
    }
    return depth;
  }

  /* --------------------------------------------------------- permissions */

  /**
   * comments_open() with _close_comments_for_old_posts(): the post's
   * comment_status, closed automatically after `close_comments_days_old`
   * days for posts when that option is on.
   */
  async commentsOpen(post: Post, options?: DiscussionOptions): Promise<boolean> {
    let open = post.commentStatus === 'open';
    const o = options ?? (await this.options());
    if (open && o.close_comments_for_old_posts && post.type === 'post') {
      const age = Date.now() - post.date.getTime();
      if (age > o.close_comments_days_old * 86_400_000) open = false;
    }
    return Boolean(await this.kernel.hooks.applyFilters('comments_open', open, post.id));
  }

  /**
   * The edit_comment meta capability (map_meta_cap()): whoever may edit the
   * post may edit its comments; moderate_comments covers every comment.
   */
  async canEdit(user: CurrentUser | null, comment: Comment): Promise<boolean> {
    if (!user) return false;
    if (userCan(user, 'moderate_comments')) return true;
    const post = await this.kernel.posts.get(comment.postId);
    if (!post) return userCan(user, 'edit_posts');
    return currentUserCan(this.kernel, user, 'edit_post', post.id);
  }

  /* ------------------------------------------------------------ writing */

  /**
   * wp_handle_comment_submission(): everything wp-comments-post.php checks
   * before wp_new_comment(): the post, its status, open comments,
   * registration, required name and email, and empty content.
   */
  async handleSubmission(data: CommentData, user: CurrentUser | null): Promise<Comment> {
    const post = await this.kernel.posts.get(data.postId);
    if (!post || !this.kernel.postTypes.get(post.type)) {
      throw new CommentError('comment_id_not_found', 'Sorry, that post could not be found.', 404);
    }
    const options = await this.options();
    if (!(await this.commentsOpen(post, options))) {
      await this.kernel.hooks.doAction('comment_closed', post.id);
      throw new CommentError('comment_closed', 'Sorry, comments are closed for this item.', 403);
    }
    if (post.status === 'trash') {
      throw new CommentError(
        'comment_on_trash',
        'Sorry, comments are not allowed on this post.',
        403,
      );
    }
    if (
      post.status !== 'publish' &&
      !(
        post.status === 'private' && (await currentUserCan(this.kernel, user, 'read_post', post.id))
      )
    ) {
      throw new CommentError(
        'comment_on_draft',
        'Sorry, comments are not allowed on this item.',
        403,
      );
    }
    if (post.password) {
      throw new CommentError(
        'comment_on_password_protected',
        'Sorry, comments are not allowed on this item.',
        403,
      );
    }
    if (!user && options.comment_registration) {
      throw new CommentError('not_logged_in', 'Sorry, you must be logged in to comment.', 403);
    }
    const input: CommentData = { ...data };
    if (user) {
      input.userId = user.id;
      input.author = user.displayName || user.login;
      input.authorEmail = user.email;
    } else if (options.require_name_email) {
      if (!input.author?.trim() || !input.authorEmail?.trim()) {
        throw new CommentError(
          'require_name_email',
          'Please fill in the required fields (name, email).',
          400,
        );
      }
      if (!isEmail(input.authorEmail)) {
        throw new CommentError('require_valid_email', 'Please enter a valid email address.', 400);
      }
    }
    if (!input.content.trim()) {
      throw new CommentError('require_valid_comment', 'Please type your comment text.', 400);
    }
    return this.newComment(input, { user, forceKses: true });
  }

  /**
   * wp_new_comment(): `preprocess_comment`, normalising and filtering the
   * fields (wp_filter_comment()), wp_allow_comment() (duplicates, flood,
   * moderation), wp_insert_comment(), then `comment_post`.
   */
  async newComment(data: CommentData, opts: NewCommentOptions): Promise<Comment> {
    const hooks = this.kernel.hooks;
    let input = (await hooks.applyFilters('preprocess_comment', { ...data })) as CommentData;

    const parentId = input.parentId ? Number(input.parentId) : 0;
    const parent = parentId ? await this.get(parentId) : undefined;
    // A reply must answer an approved or pending comment on the same post, else it becomes top-level.
    const validParent =
      parent && parent.postId === input.postId && ['0', '1'].includes(parent.approved);

    const filterHtml = opts.forceKses || !userCan(opts.user, 'unfiltered_html');
    input = {
      ...input,
      parentId: validParent ? parentId : null,
      // wp_filter_comment(): pre_comment_author_name (strip tags), _email, _url, pre_comment_content.
      author: plainText(input.author ?? '').slice(0, 1000),
      authorEmail: (input.authorEmail ?? '').trim(),
      authorUrl: normaliseUrl(input.authorUrl ?? ''),
      authorIp: (input.authorIp ?? '').replace(/[^0-9a-fA-F:., ]/g, ''),
      agent: (input.agent ?? '').slice(0, 254),
      content: relUgc(filterHtml ? ksesComment(input.content.trim()) : input.content.trim()),
      type: input.type || 'comment',
      userId: input.userId ?? null,
      date: input.date ?? new Date(),
    };
    checkMaxLengths(input);

    const approved = opts.approved ?? (await this.allowComment(input, opts.user));
    const comment = await this.insert(input, approved);
    await hooks.doAction('comment_post', comment.id, approved, comment);
    return comment;
  }

  /**
   * wp_allow_comment(): refuses duplicates (409) and floods (429), then
   * decides the status with wp_check_comment_data().
   */
  async allowComment(
    data: CommentData,
    user: CurrentUser | null,
  ): Promise<'0' | '1' | 'spam' | 'trash'> {
    const c = schema.comments;
    const hooks = this.kernel.hooks;

    const [dupe] = await this.#db
      .select({ id: c.id })
      .from(c)
      .where(
        and(
          eq(c.postId, data.postId),
          data.parentId ? eq(c.parentId, data.parentId) : isNull(c.parentId),
          ne(c.approved, 'trash'),
          or(
            eq(c.author, data.author ?? ''),
            data.authorEmail ? eq(c.authorEmail, data.authorEmail) : undefined,
          ),
          eq(c.content, data.content),
        ),
      )
      .limit(1);
    const dupeId = await hooks.applyFilters('duplicate_comment_id', dupe?.id ?? null, data);
    if (dupeId) {
      await hooks.doAction('comment_duplicate_trigger', data);
      throw new CommentError(
        'comment_duplicate',
        'Duplicate comment detected; it looks as though you’ve already said that!',
        409,
      );
    }

    const isFlood = await hooks.applyFilters(
      'wp_is_comment_flood',
      await this.#isFlood(data, user),
      data.authorIp ?? '',
      data.authorEmail ?? '',
      data.date ?? new Date(),
    );
    if (isFlood) {
      throw new CommentError(
        'comment_flood',
        'You are posting comments too quickly. Slow down.',
        429,
      );
    }
    return this.checkCommentData(data);
  }

  /** wp_check_comment_flood() with wp_throttle_comment_flood()'s 15 seconds. */
  async #isFlood(data: CommentData, user: CurrentUser | null): Promise<boolean> {
    if (userCan(user, 'manage_options') || userCan(user, 'moderate_comments')) return false;
    const c = schema.comments;
    const now = data.date ?? new Date();
    const who = user ? eq(c.userId, user.id) : eq(c.authorIp, data.authorIp ?? '');
    const [last] = await this.#db
      .select({ date: c.date })
      .from(c)
      .where(
        and(
          gte(c.date, new Date(now.getTime() - 3_600_000)),
          or(who, data.authorEmail ? eq(c.authorEmail, data.authorEmail) : undefined),
        ),
      )
      .orderBy(desc(c.date))
      .limit(1);
    if (!last) return false;
    return (now.getTime() - last.date.getTime()) / 1000 < FLOOD_SECONDS;
  }

  /**
   * wp_check_comment_data(): the post's author and moderators are approved;
   * everyone else goes through check_comment() and the disallowed list.
   * Ends with the `pre_comment_approved` filter.
   *
   * WordPress 7.1 sends disallowed comments to the Trash when
   * EMPTY_TRASH_DAYS is set; Pressbase marks them as spam so they stay
   * reviewable in the Spam tab, as WordPress did before 5.5.
   */
  async checkCommentData(data: CommentData): Promise<'0' | '1' | 'spam' | 'trash'> {
    let approved: '0' | '1' | 'spam' | 'trash';
    const post = await this.kernel.posts.get(data.postId);
    const user = data.userId ? await loadUser(this.kernel, data.userId) : null;
    if (user && (post?.authorId === user.id || userCan(user, 'moderate_comments'))) {
      approved = '1';
    } else {
      const options = await this.options();
      approved = (await this.#checkComment(data, options)) ? '1' : '0';
      if (await this.#isDisallowed(data, options)) approved = 'spam';
    }
    const filtered = await this.kernel.hooks.applyFilters('pre_comment_approved', approved, data);
    if (filtered instanceof Error) throw filtered;
    return String(filtered) as typeof approved;
  }

  /** check_comment(): manual moderation, link count, moderation keys, previously approved authors. */
  async #checkComment(data: CommentData, o: DiscussionOptions): Promise<boolean> {
    if (o.comment_moderation) return false;
    if (o.comment_max_links) {
      const links = (data.content.match(/<a [^>]*href/gi) ?? []).length;
      const counted = await this.kernel.hooks.applyFilters(
        'comment_max_links_url',
        links,
        data.authorUrl ?? '',
        data.content,
      );
      if (Number(counted) >= o.comment_max_links) return false;
    }
    const fields = [
      data.author,
      data.authorEmail,
      data.authorUrl,
      data.content,
      data.authorIp,
      data.agent,
    ];
    if (matchesWordList(o.moderation_keys, fields)) return false;

    if (o.comment_previously_approved) {
      if (data.type !== 'comment' || !data.author || !data.authorEmail) return false;
      const c = schema.comments;
      const [account] = await this.#db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(sql`lower(${schema.users.email})`, data.authorEmail.toLowerCase()));
      const [ok] = await this.#db
        .select({ id: c.id })
        .from(c)
        .where(
          and(
            eq(c.approved, '1'),
            account
              ? eq(c.userId, account.id)
              : and(eq(c.author, data.author), eq(c.authorEmail, data.authorEmail)),
          ),
        )
        .limit(1);
      return (
        Boolean(ok) &&
        !(o.moderation_keys.trim() && data.authorEmail.includes(o.moderation_keys.trim()))
      );
    }
    return true;
  }

  /** wp_check_comment_disallowed_list(): tags are stripped from the content first. */
  async #isDisallowed(data: CommentData, o: DiscussionOptions): Promise<boolean> {
    await this.kernel.hooks.doAction(
      'wp_check_comment_disallowed_list',
      data.author,
      data.authorEmail,
      data.authorUrl,
      data.content,
      data.authorIp,
      data.agent,
    );
    return matchesWordList(o.disallowed_keys, [
      data.author,
      data.authorEmail,
      data.authorUrl,
      plainText(data.content),
      data.authorIp,
      data.agent,
    ]);
  }

  /** wp_insert_comment(): stores the row, updates the post's count, fires `wp_insert_comment`. */
  async insert(data: CommentData, approved: string): Promise<Comment> {
    const [row] = await this.#db
      .insert(schema.comments)
      .values({
        postId: data.postId,
        parentId: data.parentId || null,
        author: data.author ?? '',
        authorEmail: data.authorEmail ?? '',
        authorUrl: data.authorUrl ?? '',
        authorIp: data.authorIp ?? '',
        agent: data.agent ?? '',
        content: data.content,
        type: data.type || 'comment',
        userId: data.userId ?? null,
        date: data.date ?? new Date(),
        approved,
      })
      .returning();
    if (!row)
      throw new CommentError('db_insert_error', 'Could not insert comment into the database.', 500);
    if (approved === '1') await this.updateCommentCount(row.postId);
    await this.kernel.hooks.doAction('wp_insert_comment', row.id, row);
    return row;
  }

  /**
   * wp_update_comment(): changes the given fields. Content is filtered as on
   * insert. Fires `edit_comment`, and the status hooks when the status changes.
   */
  async update(
    id: number,
    changes: Partial<Omit<CommentData, 'type'>> & { approved?: string },
    opts: { user: CurrentUser | null },
  ): Promise<Comment> {
    const old = await this.get(id);
    if (!old) throw new CommentError('rest_comment_invalid_id', 'Invalid comment ID.', 404);
    const set: Partial<typeof schema.comments.$inferInsert> = {};
    if (changes.content !== undefined) {
      const content = changes.content.trim();
      set.content = relUgc(userCan(opts.user, 'unfiltered_html') ? content : ksesComment(content));
    }
    if (changes.author !== undefined) set.author = plainText(changes.author);
    if (changes.authorEmail !== undefined) set.authorEmail = changes.authorEmail.trim();
    if (changes.authorUrl !== undefined) set.authorUrl = normaliseUrl(changes.authorUrl);
    if (changes.authorIp !== undefined) set.authorIp = changes.authorIp;
    if (changes.agent !== undefined) set.agent = changes.agent.slice(0, 254);
    if (changes.date !== undefined) set.date = changes.date;
    if (changes.userId !== undefined) set.userId = changes.userId;
    if (changes.postId !== undefined) set.postId = changes.postId;
    if (changes.parentId !== undefined) {
      if (changes.parentId === id) {
        throw new CommentError('rest_comment_invalid_parent', 'A comment cannot reply to itself.');
      }
      set.parentId = changes.parentId || null;
    }
    if (changes.approved !== undefined) set.approved = changes.approved;
    checkMaxLengths({
      author: set.author,
      authorEmail: set.authorEmail,
      authorUrl: set.authorUrl,
      content: set.content ?? old.content,
      postId: old.postId,
    });
    if (Object.keys(set).length) {
      await this.#db.update(schema.comments).set(set).where(eq(schema.comments.id, id));
    }
    const comment = (await this.get(id)) as Comment;
    await this.kernel.hooks.doAction('edit_comment', id, comment);
    if (comment.postId !== old.postId) await this.updateCommentCount(old.postId);
    if (comment.approved !== old.approved) {
      await this.#transition(comment.approved, old.approved, comment);
    }
    await this.updateCommentCount(comment.postId);
    return comment;
  }

  /** wp_set_comment_status(): 'approve', 'hold', 'spam' or 'trash'. */
  async setStatus(
    id: number,
    status: 'approve' | 'hold' | 'spam' | 'trash' | '1' | '0',
  ): Promise<Comment> {
    const old = await this.get(id);
    if (!old) throw new CommentError('rest_comment_invalid_id', 'Invalid comment ID.', 404);
    const value =
      status === 'approve' || status === '1'
        ? '1'
        : status === 'hold' || status === '0'
          ? '0'
          : status;
    await this.#db
      .update(schema.comments)
      .set({ approved: value })
      .where(eq(schema.comments.id, id));
    const comment = (await this.get(id)) as Comment;
    await this.kernel.hooks.doAction('wp_set_comment_status', id, status);
    await this.#transition(status, old.approved, comment);
    await this.updateCommentCount(comment.postId);
    return comment;
  }

  /** wp_trash_comment(): remembers the status in _wp_trash_meta_status. */
  async trash(id: number): Promise<Comment> {
    const comment = await this.get(id);
    if (!comment) throw new CommentError('rest_comment_invalid_id', 'Invalid comment ID.', 404);
    if (comment.approved === 'trash') {
      throw new CommentError('rest_already_trashed', 'The comment has already been trashed.', 410);
    }
    await this.kernel.hooks.doAction('trash_comment', id, comment);
    await this.#setMeta(id, '_wp_trash_meta_status', comment.approved);
    await this.#setMeta(id, '_wp_trash_meta_time', Math.floor(Date.now() / 1000));
    const trashed = await this.setStatus(id, 'trash');
    await this.kernel.hooks.doAction('trashed_comment', id, trashed);
    return trashed;
  }

  /** wp_untrash_comment(): back to the status it had, or pending. */
  async untrash(id: number): Promise<Comment> {
    const comment = await this.get(id);
    if (comment?.approved !== 'trash') {
      throw new CommentError(
        'rest_comment_invalid_status',
        'The comment is not in the Trash.',
        400,
      );
    }
    await this.kernel.hooks.doAction('untrash_comment', id, comment);
    const previous = String((await this.getMeta(id, '_wp_trash_meta_status')) ?? '0');
    await this.#deleteMeta(id, ['_wp_trash_meta_status', '_wp_trash_meta_time']);
    const restored = await this.setStatus(
      id,
      previous === '1' ? 'approve' : previous === 'spam' ? 'spam' : 'hold',
    );
    await this.kernel.hooks.doAction('untrashed_comment', id, restored);
    return restored;
  }

  /** wp_spam_comment() */
  async spam(id: number): Promise<Comment> {
    const comment = await this.get(id);
    if (!comment) throw new CommentError('rest_comment_invalid_id', 'Invalid comment ID.', 404);
    await this.kernel.hooks.doAction('spam_comment', id, comment);
    await this.#setMeta(id, '_wp_trash_meta_status', comment.approved);
    await this.#setMeta(id, '_wp_trash_meta_time', Math.floor(Date.now() / 1000));
    const spammed = await this.setStatus(id, 'spam');
    await this.kernel.hooks.doAction('spammed_comment', id, spammed);
    return spammed;
  }

  /** wp_unspam_comment(): back to the status it had, or pending. */
  async unspam(id: number): Promise<Comment> {
    const comment = await this.get(id);
    if (comment?.approved !== 'spam') {
      throw new CommentError(
        'rest_comment_invalid_status',
        'The comment is not marked as spam.',
        400,
      );
    }
    await this.kernel.hooks.doAction('unspam_comment', id, comment);
    const previous = String((await this.getMeta(id, '_wp_trash_meta_status')) ?? '0');
    await this.#deleteMeta(id, ['_wp_trash_meta_status', '_wp_trash_meta_time']);
    const restored = await this.setStatus(id, previous === '1' ? 'approve' : 'hold');
    await this.kernel.hooks.doAction('unspammed_comment', id, restored);
    return restored;
  }

  /**
   * wp_delete_comment(..., true): replies move up to the deleted comment's
   * parent, meta goes with it. Fires `delete_comment` and `deleted_comment`.
   */
  async delete(id: number): Promise<Comment> {
    const comment = await this.get(id);
    if (!comment) throw new CommentError('rest_comment_invalid_id', 'Invalid comment ID.', 404);
    await this.kernel.hooks.doAction('delete_comment', id, comment);
    await this.#db.transaction(async (tx) => {
      await tx
        .update(schema.comments)
        .set({ parentId: comment.parentId })
        .where(eq(schema.comments.parentId, id));
      await tx.delete(schema.comments).where(eq(schema.comments.id, id));
    });
    await this.kernel.hooks.doAction('deleted_comment', id, comment);
    if (comment.approved === '1') await this.updateCommentCount(comment.postId);
    await this.#transition('delete', comment.approved, comment);
    return comment;
  }

  /** wp_update_comment_count_now(): approved comments only (notes excluded). */
  async updateCommentCount(postId: number): Promise<number> {
    const c = schema.comments;
    const [row] = await this.#db
      .select({ n: count() })
      .from(c)
      .where(and(eq(c.postId, postId), eq(c.approved, '1'), ne(c.type, 'note')));
    const n = row?.n ?? 0;
    const post = await this.kernel.posts.get(postId);
    if (!post) return n;
    if (post.commentCount !== n) {
      await this.#db
        .update(schema.posts)
        .set({ commentCount: n })
        .where(eq(schema.posts.id, postId));
    }
    await this.kernel.hooks.doAction('wp_update_comment_count', postId, n, post.commentCount);
    return n;
  }

  /** wp_transition_comment_status() */
  async #transition(newStatus: string, oldStatus: string, comment: Comment): Promise<void> {
    const to = transitionName(newStatus);
    const from = transitionName(oldStatus);
    if (to === from) return;
    const hooks = this.kernel.hooks;
    await hooks.doAction('transition_comment_status', to, from, comment);
    await hooks.doAction(`comment_${from}_to_${to}`, comment);
    await hooks.doAction(`comment_${to}_${comment.type || 'comment'}`, comment.id, comment);
  }

  /* ------------------------------------------------------- previews */

  async #hashKey(): Promise<string> {
    let key = await this.kernel.options.get<string>('pressbase_comment_hash_key', '');
    if (!key) {
      key = randomBytes(32).toString('base64url');
      await this.kernel.options.set('pressbase_comment_hash_key', key, { autoload: false });
    }
    return key;
  }

  /**
   * The moderation-hash WordPress adds to the redirect after a pending
   * comment (wp_get_comment_redirect / wp_get_unapproved_comment_author_email),
   * so the visitor sees their own comment, for ten minutes.
   */
  async moderationHash(comment: Comment): Promise<string> {
    return createHmac('sha256', await this.#hashKey())
      .update(`${comment.id}:${comment.date.toISOString()}`)
      .digest('base64url')
      .slice(0, 22);
  }

  /** The email of the pending comment a `?unapproved=…&moderation-hash=…` link may show. */
  async unapprovedEmail(id: number, hash: string): Promise<string | undefined> {
    const comment = await this.get(id);
    if (comment?.approved !== '0') return undefined;
    if (Date.now() - comment.date.getTime() > PREVIEW_MINUTES * 60_000) return undefined;
    const expected = Buffer.from(await this.moderationHash(comment));
    const given = Buffer.from(hash);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    return comment.authorEmail || undefined;
  }

  /* ------------------------------------------------------------ meta */

  async getMeta(id: number, key: string): Promise<unknown> {
    const [row] = await this.#db
      .select({ value: schema.commentmeta.value })
      .from(schema.commentmeta)
      .where(and(eq(schema.commentmeta.commentId, id), eq(schema.commentmeta.key, key)));
    return row?.value;
  }

  async #setMeta(id: number, key: string, value: unknown): Promise<void> {
    await this.#deleteMeta(id, [key]);
    await this.#db.insert(schema.commentmeta).values({ commentId: id, key, value });
  }

  async #deleteMeta(id: number, keys: string[]): Promise<void> {
    await this.#db
      .delete(schema.commentmeta)
      .where(and(eq(schema.commentmeta.commentId, id), inArray(schema.commentmeta.key, keys)));
  }
}

/* --------------------------------------------------------------- helpers */

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** esc_url_raw() for author URLs: http(s) only, else nothing. */
function normaliseUrl(value: string): string {
  const url = value.trim();
  if (!url) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `http://${url}`;
  try {
    const parsed = new URL(withScheme);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString().slice(0, 200) : '';
  } catch {
    return '';
  }
}

/** wp_check_comment_data_max_lengths() */
function checkMaxLengths(data: Partial<CommentData>): void {
  const bytes = (s: string | undefined) => Buffer.byteLength(s ?? '', 'utf8');
  if (bytes(data.author) > COMMENT_MAX_LENGTHS.author) {
    throw new CommentError('comment_author_column_length', 'Your name is too long.');
  }
  if (bytes(data.authorEmail) > COMMENT_MAX_LENGTHS.authorEmail) {
    throw new CommentError('comment_author_email_column_length', 'Your email address is too long.');
  }
  if (bytes(data.authorUrl) > COMMENT_MAX_LENGTHS.authorUrl) {
    throw new CommentError('comment_author_url_column_length', 'Your URL is too long.');
  }
  if (bytes(data.content) > COMMENT_MAX_LENGTHS.content) {
    throw new CommentError('comment_content_column_length', 'Your comment is too long.');
  }
}

/**
 * The moderation and disallowed key match: each non-empty line is a
 * case-insensitive substring of any field (WordPress's "#$word#iu").
 */
export function matchesWordList(list: string, fields: (string | undefined)[]): boolean {
  const words = list
    .split('\n')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  if (!words.length) return false;
  const haystacks = fields.filter(Boolean).map((f) => (f as string).toLowerCase());
  return words.some((word) => haystacks.some((h) => h.includes(word)));
}
