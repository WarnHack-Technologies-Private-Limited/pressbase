import {
  type BlockAttributes,
  escAttr,
  escHtml,
  escUrl,
  getBlockWrapperAttributes,
  parseBlocks,
} from '@pressbase/blocks';
import { autop, avatarUrl, commentExcerpt, commentText, plainText } from '../../comments/format';
import { commentLink, commentPagesCount, commentsPageUrl } from '../../comments/links';
import type { DiscussionOptions } from '../../comments/options';
import type { Comment, CommentNode } from '../../comments/service';
import { permalink, permalinkContext } from '../../content/permalinks';
import type { Post } from '../../content/posts';
import { sanitizePostTitle } from '../../content/sanitize';
import {
  authorOf,
  authorPostsUrl,
  type CoreBlock,
  contextPost,
  loginUrl,
  logoutUrl,
  siteInfo,
  theDate,
  theTitle,
} from '../helpers';

/**
 * The comment blocks, ported from wordpress/wp-includes/blocks/: comments.php,
 * comment-template.php, comment-author-name.php, comment-content.php,
 * comment-date.php, comment-edit-link.php, comment-reply-link.php,
 * comments-title.php, comments-pagination*.php, post-comments-form.php and
 * latest-comments.php. Markup and class names match WordPress so themes
 * style them unchanged. Every value printed is escaped.
 *
 * The query variables of the page being rendered (`cpage`, `replytocom`,
 * `unapproved`, `moderation-hash`) come from `block.services.query`.
 */

/* --------------------------------------------------------------- helpers */

/** Classes WordPress's comment blocks add themselves (textAlign, link colour). */
function alignClasses(attributes: BlockAttributes, extra: string[] = []): string {
  const classes = [...extra];
  if (typeof attributes.textAlign === 'string') {
    classes.push(`has-text-align-${attributes.textAlign}`);
  }
  const style = attributes.style as
    | { elements?: { link?: { color?: { text?: unknown } } } }
    | undefined;
  if (style?.elements?.link?.color?.text !== undefined) classes.push('has-link-color');
  return classes.join(' ');
}

async function contextComment(block: CoreBlock): Promise<Comment | undefined> {
  const id = Number(block.context.commentId);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return block.services.kernel.comments.get(id);
}

function queryVar(block: CoreBlock, name: string): string {
  return block.services.query?.[name] ?? '';
}

/** post_password_required(): the services don't carry a post password cookie yet. */
function passwordRequired(post: Post | undefined): boolean {
  return Boolean(post?.password);
}

/** get_comment_author(): the stored name, the user's name, or "Anonymous". */
async function commentAuthor(block: CoreBlock, comment: Comment): Promise<string> {
  if (comment.author) return comment.author;
  if (comment.userId) {
    const user = await authorOf(block.services.kernel, comment.userId);
    if (user) return user.displayName;
  }
  return 'Anonymous';
}

interface QueryVars {
  postId: number;
  includeUnapproved: (number | string)[];
  perPage: number;
  page: number;
  pages: number;
  threaded: boolean;
}

/** build_comment_query_vars_from_block() (wordpress/wp-includes/blocks.php). */
async function commentQueryVars(
  block: CoreBlock,
  postId: number,
  options: DiscussionOptions,
): Promise<QueryVars> {
  const { kernel, user } = block.services;
  const includeUnapproved: (number | string)[] = [];
  if (user) includeUnapproved.push(user.id);
  else {
    // wp_get_unapproved_comment_author_email()
    const id = Number(queryVar(block, 'unapproved'));
    const hash = queryVar(block, 'moderation-hash');
    if (id && hash) {
      const email = await kernel.comments.unapprovedEmail(id, hash);
      if (email) includeUnapproved.push(email);
    }
  }
  const perPage = options.page_comments ? options.comments_per_page : 0;
  const pages = perPage ? await commentPagesCount(kernel, postId, options) : 1;
  let page = Number.parseInt(queryVar(block, 'cpage'), 10) || 0;
  if (!page) page = options.default_comments_page === 'newest' ? pages : 1;
  return {
    postId,
    includeUnapproved,
    perPage,
    page: Math.min(Math.max(page, 1), Math.max(pages, 1)),
    pages,
    threaded: options.thread_comments,
  };
}

/** get_comments_pagenum_link(): the post URL for comment page `page`, then #comments. */
async function commentsPageLink(
  block: CoreBlock,
  post: Post,
  page: number,
  maxPage: number,
  options: DiscussionOptions,
): Promise<string> {
  const { kernel } = block.services;
  const links = await permalinkContext(kernel);
  let url = await permalink(kernel, post, links);
  const isDefault = options.default_comments_page === 'newest' ? page === maxPage : page === 1;
  if (!isDefault) url = commentsPageUrl(url, page, links.structure !== '');
  return `${url}#comments`;
}

/* ------------------------------------------------------- core/comments */

/** A classic comments section, for the legacy block (WordPress renders comments.php). */
const LEGACY_TEMPLATE = `<!-- wp:comments-title /-->
<!-- wp:comment-template -->
<!-- wp:comment-author-name /-->
<!-- wp:comment-date /-->
<!-- wp:comment-content /-->
<!-- wp:comment-reply-link /-->
<!-- wp:comment-edit-link /-->
<!-- /wp:comment-template -->
<!-- wp:comments-pagination -->
<!-- wp:comments-pagination-previous /-->
<!-- wp:comments-pagination-numbers /-->
<!-- wp:comments-pagination-next /-->
<!-- /wp:comments-pagination -->
<!-- wp:post-comments-form /-->`;

/** render_block_core_comments() */
export async function renderComments(
  attributes: BlockAttributes,
  content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const post = await contextPost(block);
  if (!post) return '';
  if (!(await kernel.comments.commentsOpen(post)) && post.commentCount === 0) return '';
  const legacy = block.name === 'core/post-comments' || Boolean(attributes.legacy);
  // The block's saved markup with its inner blocks rendered: render( array( 'dynamic' => false ) ).
  if (!legacy) return content;

  const classes: string[] = [];
  if (attributes.legacy !== undefined) classes.push('wp-block-post-comments');
  if (typeof attributes.textAlign === 'string') {
    classes.push(`has-text-align-${attributes.textAlign}`);
  }
  const inner = await block.renderContent(parseBlocks(LEGACY_TEMPLATE), {
    ...block.availableContext,
    postId: post.id,
    postType: post.type,
  });
  return `<div ${getBlockWrapperAttributes(block, { class: classes.join(' ') })}>${inner}</div>`;
}

/* ----------------------------------------------- core/comment-template */

interface ThreadState {
  odd: number;
  threadOdd: number;
  nicenames: Map<number, string>;
}

/** get_comment_class() */
async function commentClass(
  block: CoreBlock,
  node: CommentNode,
  post: Post,
  state: ThreadState,
): Promise<string> {
  const { comment, depth } = node;
  const classes = [comment.type || 'comment'];
  if (comment.userId) {
    let nicename = state.nicenames.get(comment.userId);
    if (nicename === undefined) {
      nicename = (await authorOf(block.services.kernel, comment.userId))?.nicename ?? '';
      state.nicenames.set(comment.userId, nicename);
    }
    classes.push('byuser');
    if (nicename) classes.push(`comment-author-${nicename}`);
    if (comment.userId === post.authorId) classes.push('bypostauthor');
  }
  state.odd++;
  classes.push(state.odd % 2 ? 'odd' : 'even');
  if (state.odd % 2) classes.push('alt');
  if (depth === 1) {
    state.threadOdd++;
    classes.push(state.threadOdd % 2 ? 'thread-odd' : 'thread-even');
    if (state.threadOdd % 2) classes.push('thread-alt');
  }
  classes.push(`depth-${depth}`);
  if (node.children.length) classes.push('parent');
  if (comment.approved === '0') classes.push('unapproved');
  return `class="${escAttr(classes.join(' '))}"`;
}

/** block_core_comment_template_render_comments() */
async function renderCommentList(
  block: CoreBlock,
  nodes: CommentNode[],
  post: Post,
  options: DiscussionOptions,
  state: ThreadState,
  depth: number,
): Promise<string> {
  let out = '';
  for (const node of nodes) {
    // The inner blocks render once per comment, with commentId in their context.
    let html = await block.renderContent(block.parsedBlock.innerBlocks ?? [], {
      ...block.availableContext,
      commentId: node.comment.id,
    });
    const classes = await commentClass(block, { ...node, depth }, post, state);
    if (node.children.length && options.thread_comments) {
      if (depth < options.thread_comments_depth) {
        html += `<ol>${await renderCommentList(block, node.children, post, options, state, depth + 1)}</ol>`;
      } else {
        // Past the deepest level, replies are listed at that level.
        html += await renderCommentList(block, node.children, post, options, state, depth);
      }
    }
    out += `<li id="comment-${node.comment.id}" ${classes}>${html}</li>`;
  }
  return out;
}

/** render_block_core_comment_template() */
export async function renderCommentTemplate(
  _attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const post = await contextPost(block);
  if (!post || passwordRequired(post)) return '';
  const options = await kernel.comments.options();
  const vars = await commentQueryVars(block, post.id, options);
  const { nodes } = await kernel.comments.thread(post.id, {
    includeUnapproved: vars.includeUnapproved,
    perPage: vars.perPage,
    page: vars.page,
    threaded: vars.threaded,
  });
  if (!nodes.length) return '';
  if (options.comment_order === 'desc') nodes.reverse();
  const list = await renderCommentList(
    block,
    nodes,
    post,
    options,
    { odd: 0, threadOdd: 0, nicenames: new Map() },
    1,
  );
  return `<ol ${getBlockWrapperAttributes(block)}>${list}</ol>`;
}

/* ---------------------------------------------- the comment's own fields */

/** render_block_core_comment_author_name() */
export async function renderCommentAuthorName(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const comment = await contextComment(block);
  if (!comment) return '';
  const wrapper = getBlockWrapperAttributes(block, { class: alignClasses(attributes) });
  let author = escHtml(await commentAuthor(block, comment));
  // Pending comments never link out (no $show_pending_links without commenter cookies).
  if (comment.authorUrl && attributes.isLink && attributes.linkTarget && comment.approved !== '0') {
    author = `<a rel="external nofollow ugc" href="${escUrl(comment.authorUrl)}" target="${escAttr(attributes.linkTarget)}" >${author}</a>`;
  }
  return `<div ${wrapper}>${author}</div>`;
}

/** render_block_core_comment_content() */
export async function renderCommentContent(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel, user } = block.services;
  const comment = await contextComment(block);
  if (!comment) return '';
  let text = String(
    await kernel.hooks.applyFilters('comment_text', commentText(comment.content), comment),
  );
  if (!text.trim()) return '';
  let note = '';
  if (comment.approved === '0') {
    note = `<p><em class="comment-awaiting-moderation">${
      user
        ? 'Your comment is awaiting moderation.'
        : 'Your comment is awaiting moderation. This is a preview; your comment will be visible after it has been approved.'
    }</em></p>`;
    // wp_kses( $comment_text, array() ): no markup in a pending comment.
    text = plainText(text);
  }
  const wrapper = getBlockWrapperAttributes(block, { class: alignClasses(attributes) });
  return `<div ${wrapper}>${note}${text}</div>`;
}

/** human_time_diff() */
function humanTimeDiff(from: number, to: number): string {
  const diff = Math.abs(to - from) / 1000;
  const unit = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (diff < 3600) return unit(Math.max(1, Math.round(diff / 60)), 'min', 'mins');
  if (diff < 86_400) return unit(Math.max(1, Math.round(diff / 3600)), 'hour', 'hours');
  if (diff < 7 * 86_400) return unit(Math.max(1, Math.round(diff / 86_400)), 'day', 'days');
  if (diff < 30 * 86_400) {
    return unit(Math.max(1, Math.round(diff / (7 * 86_400))), 'week', 'weeks');
  }
  if (diff < 365 * 86_400) {
    return unit(Math.max(1, Math.round(diff / (30 * 86_400))), 'month', 'months');
  }
  return unit(Math.max(1, Math.round(diff / (365 * 86_400))), 'year', 'years');
}

/** render_block_core_comment_date() */
export async function renderCommentDate(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const comment = await contextComment(block);
  if (!comment) return '';
  const site = await siteInfo(kernel);
  const wrapper = getBlockWrapperAttributes(block, { class: alignClasses(attributes) });
  const format = typeof attributes.format === 'string' ? attributes.format : '';
  let formatted =
    format === 'human-diff'
      ? `${humanTimeDiff(comment.date.getTime(), Date.now())} ago`
      : escHtml(theDate(site, comment.date, format));
  if (attributes.isLink) {
    const post = await kernel.posts.get(comment.postId);
    if (post) {
      const link = await commentLink(kernel, comment, post, await kernel.comments.options());
      formatted = `<a href="${escUrl(link)}">${formatted}</a>`;
    }
  }
  return `<div ${wrapper}><time datetime="${escAttr(theDate(site, comment.date, 'c'))}">${formatted}</time></div>`;
}

/** get_edit_comment_link(): the admin's Comments screen, focused on this comment. */
function editCommentLink(siteUrl: string, id: number): string {
  return `${siteUrl}/admin/comments?c=${id}`;
}

/** render_block_core_comment_edit_link() */
export async function renderCommentEditLink(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel, user } = block.services;
  const comment = await contextComment(block);
  if (!comment || !(await kernel.comments.canEdit(user, comment))) return '';
  const site = await siteInfo(kernel);
  const target =
    typeof attributes.linkTarget === 'string' && attributes.linkTarget
      ? `target="${escAttr(attributes.linkTarget)}"`
      : '';
  const wrapper = getBlockWrapperAttributes(block, { class: alignClasses(attributes) });
  return `<div ${wrapper}><a href="${escUrl(editCommentLink(site.siteUrl, comment.id))}" ${target}>Edit</a></div>`;
}

/** get_comment_reply_link() */
async function commentReplyLink(
  block: CoreBlock,
  comment: Comment,
  depth: number,
  options: DiscussionOptions,
): Promise<string> {
  const { kernel, user } = block.services;
  if (depth === 0 || options.thread_comments_depth <= depth) return '';
  const post = await kernel.posts.get(comment.postId);
  if (!post || !(await kernel.comments.commentsOpen(post, options))) return '';
  const site = await siteInfo(kernel);
  const links = await permalinkContext(kernel);
  const postUrl = await permalink(kernel, post, links);
  if (options.comment_registration && !user) {
    return `<a rel="nofollow" class="comment-reply-login" href="${escUrl(loginUrl(site, postUrl))}">Log in to Reply</a>`;
  }
  const base = options.page_comments
    ? (await commentLink(kernel, comment, post, options, links)).replace(/#comment-\d+$/, '')
    : postUrl;
  const [path = ''] = base.split('#');
  const href = `${path}${path.includes('?') ? '&' : '?'}replytocom=${comment.id}#respond`;
  const replyTo = `Reply to ${await commentAuthor(block, comment)}`;
  const data = {
    commentid: comment.id,
    postid: post.id,
    belowelement: `comment-${comment.id}`,
    respondelement: 'respond',
    replyto: replyTo,
  };
  const dataAttributes = Object.entries(data)
    .map(([name, value]) => `data-${name}="${escAttr(String(value))}"`)
    .join(' ');
  return `<a rel="nofollow" class="comment-reply-link" href="${escUrl(href)}" ${dataAttributes} aria-label="${escAttr(replyTo)}">Reply</a>`;
}

/** render_block_core_comment_reply_link() */
export async function renderCommentReplyLink(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const comment = await contextComment(block);
  if (!comment) return '';
  const options = await kernel.comments.options();
  if (!options.thread_comments) return '';
  const depth = await kernel.comments.depthOf(comment);
  const link = await commentReplyLink(block, comment, depth, options);
  if (!link) return '';
  const wrapper = getBlockWrapperAttributes(block, { class: alignClasses(attributes) });
  return `<div ${wrapper}>${link}</div>`;
}

/* ------------------------------------------------- core/comments-title */

/** render_block_core_comments_title() */
export async function renderCommentsTitle(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const post = await contextPost(block);
  if (!post || passwordRequired(post)) return '';
  const count = post.commentCount;
  if (count === 0) return '';
  const showPostTitle = Boolean(attributes.showPostTitle);
  const showCount = Boolean(attributes.showCommentsCount);
  const title = theTitle(post);
  const n = count.toLocaleString('en-US');
  let text: string;
  if (showCount) {
    if (showPostTitle) {
      text =
        count === 1
          ? `One response to &#8220;${title}&#8221;`
          : `${n} responses to &#8220;${title}&#8221;`;
    } else text = count === 1 ? 'One response' : `${n} responses`;
  } else if (showPostTitle) {
    text =
      count === 1 ? `Response to &#8220;${title}&#8221;` : `Responses to &#8220;${title}&#8221;`;
  } else text = count === 1 ? 'Response' : 'Responses';
  const level = Number(attributes.level);
  const tag = Number.isInteger(level) && level >= 1 && level <= 6 ? `h${level}` : 'h2';
  const align =
    typeof attributes.textAlign === 'string' ? `has-text-align-${attributes.textAlign}` : '';
  return `<${tag} id="comments" ${getBlockWrapperAttributes(block, { class: align })}>${text}</${tag}>`;
}

/* -------------------------------------------- core/comments-pagination */

/** render_block_core_comments_pagination() */
export async function renderCommentsPagination(
  attributes: BlockAttributes,
  content: string,
  block: CoreBlock,
): Promise<string> {
  if (!content.trim()) return '';
  const post = await contextPost(block);
  if (passwordRequired(post)) return '';
  return `<nav ${getBlockWrapperAttributes(block, {
    'aria-label': 'Comments pagination',
    class: alignClasses({ style: attributes.style }),
  })}>${content}</nav>`;
}

/** get_comments_pagination_arrow() */
function paginationArrow(block: CoreBlock, type: 'next' | 'previous'): string {
  const arrows: Record<string, Record<string, string>> = {
    arrow: { next: '→', previous: '←' },
    chevron: { next: '»', previous: '«' },
  };
  const name = String(block.context['comments/paginationArrow'] ?? '');
  const arrow = arrows[name]?.[type];
  if (!arrow) return '';
  return `<span class='wp-block-comments-pagination-${type}-arrow is-arrow-${escAttr(name)}' aria-hidden='true'>${arrow}</span>`;
}

async function paginationSetup(block: CoreBlock) {
  const { kernel } = block.services;
  const post = await contextPost(block);
  if (!post) return undefined;
  const options = await kernel.comments.options();
  if (!options.page_comments) return undefined;
  const vars = await commentQueryVars(block, post.id, options);
  return { post, options, vars };
}

/** render_block_core_comments_pagination_next() with get_next_comments_link(). */
export async function renderCommentsPaginationNext(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const setup = await paginationSetup(block);
  if (!setup) return '';
  const { post, options, vars } = setup;
  const next = vars.page + 1;
  if (next > vars.pages) return '';
  const label =
    (typeof attributes.label === 'string' && attributes.label
      ? sanitizePostTitle(attributes.label)
      : 'Newer Comments') + paginationArrow(block, 'next');
  const href = await commentsPageLink(block, post, next, vars.pages, options);
  return `<a href="${escUrl(href)}" ${getBlockWrapperAttributes(block)}>${label}</a>`;
}

/** render_block_core_comments_pagination_previous() with get_previous_comments_link(). */
export async function renderCommentsPaginationPrevious(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const setup = await paginationSetup(block);
  if (!setup) return '';
  const { post, options, vars } = setup;
  if (vars.page <= 1) return '';
  const label =
    paginationArrow(block, 'previous') +
    (typeof attributes.label === 'string' && attributes.label
      ? sanitizePostTitle(attributes.label)
      : 'Older Comments');
  const href = await commentsPageLink(block, post, vars.page - 1, vars.pages, options);
  return `<a href="${escUrl(href)}" ${getBlockWrapperAttributes(block)}>${label}</a>`;
}

/** render_block_core_comments_pagination_numbers() with paginate_comments_links(). */
export async function renderCommentsPaginationNumbers(
  _attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const setup = await paginationSetup(block);
  if (!setup) return '';
  const { post, options, vars } = setup;
  if (vars.pages < 2) return '';
  // paginate_links(): end_size 1, mid_size 2, dots between the gaps.
  const items: string[] = [];
  let dots = false;
  for (let n = 1; n <= vars.pages; n++) {
    if (n === vars.page) {
      items.push(`<span aria-current="page" class="page-numbers current">${n}</span>`);
      dots = true;
    } else if (n <= 1 || (n >= vars.page - 2 && n <= vars.page + 2) || n > vars.pages - 1) {
      const href = await commentsPageLink(block, post, n, vars.pages, options);
      items.push(`<a class="page-numbers" href="${escUrl(href)}">${n}</a>`);
      dots = true;
    } else if (dots) {
      items.push('<span class="page-numbers dots">&hellip;</span>');
      dots = false;
    }
  }
  return `<div ${getBlockWrapperAttributes(block)}>${items.join('\n')}</div>`;
}

/* ---------------------------------------------- core/post-comments-form */

/** comment_form() with the block-theme submit button (post_comments_form_block_form_defaults()). */
async function commentForm(block: CoreBlock, post: Post): Promise<string> {
  const { kernel, user } = block.services;
  const options = await kernel.comments.options();
  if (!(await kernel.comments.commentsOpen(post, options))) {
    await kernel.hooks.doAction('comment_form_comments_closed', post.id);
    return '';
  }
  const site = await siteInfo(kernel);
  const postUrl = await permalink(kernel, post, await permalinkContext(kernel));
  const req = options.require_name_email;
  const indicator = ' <span class="required">*</span>';
  const requiredText =
    ' <span class="required-field-message">Required fields are marked <span class="required">*</span></span>';
  const required = req ? ' required' : '';

  // comment_form_title(): replying to a comment named in ?replytocom=.
  const replyTo = Number(queryVar(block, 'replytocom')) || 0;
  const parent = replyTo ? await kernel.comments.get(replyTo) : undefined;
  const replying = parent && parent.postId === post.id && parent.approved === '1';
  const titleText = replying
    ? `Leave a Reply to <a href="#comment-${parent.id}">${escHtml(await commentAuthor(block, parent))}</a>`
    : 'Leave a Reply';
  const cancel = options.thread_comments
    ? ` <small><a rel="nofollow" id="cancel-comment-reply-link" href="${escUrl(`${postUrl}#respond`)}"${replying ? '' : ' style="display:none;"'}>Cancel reply</a></small>`
    : '';

  let html = '<div id="respond" class="comment-respond">';
  html += `<h3 id="reply-title" class="comment-reply-title">${titleText}${cancel}</h3>`;

  if (options.comment_registration && !user) {
    html += `<p class="must-log-in">You must be <a href="${escUrl(loginUrl(site, postUrl))}">logged in</a> to post a comment.</p>`;
    return `${html}</div>`;
  }

  html += `<form action="${escUrl(`${site.siteUrl}/wp-comments-post`)}" method="post" id="commentform" class="comment-form">`;
  if (user) {
    html += `<p class="logged-in-as">Logged in as ${escHtml(user.displayName || user.login)}. <a href="${escUrl(`${site.siteUrl}/admin/profile`)}">Edit your profile</a>. <a href="${escUrl(logoutUrl(site, postUrl))}">Log out?</a>${requiredText}</p>`;
  } else {
    html += `<p class="comment-notes"><span id="email-notes">Your email address will not be published.</span>${requiredText}</p>`;
  }
  html += `<p class="comment-form-comment"><label for="comment">Comment${indicator}</label> <textarea id="comment" name="comment" cols="45" rows="8" maxlength="65525" required></textarea></p>`;
  if (!user) {
    let fields: Record<string, string> = {
      author: `<p class="comment-form-author"><label for="author">Name${req ? indicator : ''}</label> <input id="author" name="author" type="text" value="" size="30" maxlength="245" autocomplete="name"${required} /></p>`,
      email: `<p class="comment-form-email"><label for="email">Email${req ? indicator : ''}</label> <input id="email" name="email" type="email" value="" size="30" maxlength="100" aria-describedby="email-notes" autocomplete="email"${required} /></p>`,
      url: '<p class="comment-form-url"><label for="url">Website</label> <input id="url" name="url" type="url" value="" size="30" maxlength="200" autocomplete="url" /></p>',
    };
    fields = (await kernel.hooks.applyFilters('comment_form_default_fields', fields)) as Record<
      string,
      string
    >;
    html += Object.values(fields).join('\n');
  }
  html += `<p class="form-submit wp-block-button"><input name="submit" type="submit" id="submit" class="wp-block-button__link wp-element-button" value="Post Comment" /> <input type='hidden' name='comment_post_ID' value='${post.id}' id='comment_post_ID' />
<input type='hidden' name='comment_parent' id='comment_parent' value='${replying ? parent.id : 0}' />
</p>`;
  html += '</form></div>';
  return html;
}

/** render_block_core_post_comments_form() */
export async function renderPostCommentsForm(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const post = await contextPost(block);
  if (!post || passwordRequired(post)) return '';
  const form = await commentForm(block, post);
  if (!form) return '';
  const wrapper = getBlockWrapperAttributes(block, {
    class: alignClasses(attributes, ['comment-respond']),
  });
  // The outer div carries the block's wrapper attributes, as WordPress injects them.
  return form.replace('class="comment-respond"', wrapper);
}

/* ------------------------------------------------ core/latest-comments */

/** render_block_core_latest_comments() */
export async function renderLatestComments(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const display =
    attributes.displayExcerpt !== undefined
      ? attributes.displayExcerpt
        ? 'excerpt'
        : 'none'
      : String(attributes.displayContent ?? 'excerpt');
  const number = Number(attributes.commentsToShow ?? 5);
  const args = await kernel.hooks.applyFilters('widget_comments_args', {
    number: Number.isInteger(number) && number > 0 ? Math.min(number, 100) : 5,
    status: 'approve',
    post_status: ['publish'],
    type: 'comment',
  });
  const { comments } = await kernel.comments.query(
    args as Parameters<typeof kernel.comments.query>[0],
  );
  const options = await kernel.comments.options();
  const site = await siteInfo(kernel);
  const links = await permalinkContext(kernel);
  const displayAvatar = Boolean(attributes.displayAvatar) && options.show_avatars;

  let items = '';
  for (const comment of comments) {
    const post = await kernel.posts.get(comment.postId);
    if (!post) continue;
    items += '<li class="wp-block-latest-comments__comment">';
    if (displayAvatar) {
      const avatarOptions = { default: options.avatar_default, rating: options.avatar_rating };
      const src = avatarUrl(comment.authorEmail, 48, avatarOptions);
      const src2x = avatarUrl(comment.authorEmail, 96, avatarOptions);
      items += `<img alt='' src='${escAttr(escUrl(src))}' srcset='${escAttr(escUrl(src2x))} 2x' class='avatar avatar-48 photo wp-block-latest-comments__comment-avatar' height='48' width='48' loading='lazy' decoding='async'/>`;
    }
    items += '<article><footer class="wp-block-latest-comments__comment-meta">';
    let authorUrl = comment.authorUrl;
    if (!authorUrl && comment.userId) {
      const author = await authorOf(kernel, comment.userId);
      if (author) authorUrl = authorPostsUrl(site, author);
    }
    const name = escHtml(await commentAuthor(block, comment));
    const author = authorUrl
      ? `<a class="wp-block-latest-comments__comment-author" href="${escUrl(authorUrl)}">${name}</a>`
      : `<span class="wp-block-latest-comments__comment-author">${name}</span>`;
    const title = theTitle(post) || '(no title)';
    const link = await commentLink(kernel, comment, post, options, links);
    items += `${author} on <a class="wp-block-latest-comments__comment-link" href="${escUrl(link)}">${title}</a>`;
    if (attributes.displayDate) {
      items += `<time datetime="${escAttr(theDate(site, comment.date, 'c'))}" class="wp-block-latest-comments__comment-date">${escHtml(theDate(site, comment.date))}</time>`;
    }
    items += '</footer>';
    if (display === 'full') {
      const text = post.password ? '<p>Password protected</p>\n' : commentText(comment.content);
      items += `<div class="wp-block-latest-comments__comment-excerpt">${text}</div>`;
    } else if (display === 'excerpt') {
      items += `<div class="wp-block-latest-comments__comment-excerpt">${autop(commentExcerpt(comment.content))}</div>`;
    }
    items += '</article></li>';
  }

  const classes: string[] = [];
  if (attributes.displayAvatar) classes.push('has-avatars');
  if (attributes.displayDate) classes.push('has-dates');
  if (display !== 'none') classes.push('has-excerpts');
  if (!items) classes.push('no-comments');
  const wrapper = getBlockWrapperAttributes(block, { class: classes.join(' ') });
  return items ? `<ol ${wrapper}>${items}</ol>` : `<div ${wrapper}>No comments to show.</div>`;
}
