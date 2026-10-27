import {
  type BlockAttributes,
  escAttr,
  escHtml,
  escUrl,
  getBlockWrapperAttributes,
  stripAllTags,
} from '@pressbase/blocks';
import { permalink, permalinkContext } from '../../content/permalinks';
import type { Post } from '../../content/posts';
import { sanitizePostTitle } from '../../content/sanitize';
import {
  authorOf,
  authorPostsUrl,
  type CoreBlock,
  contextPost,
  siteInfo,
  termLink,
  theDate,
  theExcerpt,
  theTitle,
  trimWords,
} from '../helpers';

/**
 * Blocks that show a field of the post in their context (`postId`,
 * `postType`), in wordpress/wp-includes/blocks/: post-title.php,
 * post-date.php, post-excerpt.php, post-author-name.php and post-terms.php.
 */

async function linkOf(block: CoreBlock, post: Post): Promise<string> {
  const { kernel } = block.services;
  return permalink(kernel, post, await permalinkContext(kernel));
}

/** Classes WordPress's post blocks add themselves (textAlign, link colour). */
function alignmentClasses(attributes: BlockAttributes, extra: string[] = []): string {
  const classes = [...extra];
  if (typeof attributes.textAlign === 'string')
    classes.push(`has-text-align-${attributes.textAlign}`);
  const style = attributes.style as
    | { elements?: { link?: { color?: { text?: unknown } } } }
    | undefined;
  if (style?.elements?.link?.color?.text !== undefined) classes.push('has-link-color');
  return classes.join(' ');
}

/** render_block_core_post_title() */
export async function renderPostTitle(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const post = await contextPost(block);
  if (!post) return '';
  let title = theTitle(post);
  if (!title) return '';
  const level = attributes.level;
  const tag =
    typeof level === 'number' && Number.isInteger(level) && level >= 0 && level <= 6
      ? level === 0
        ? 'p'
        : `h${level}`
      : 'h2';
  if (attributes.isLink) {
    const rel = attributes.rel ? `rel="${escAttr(attributes.rel)}"` : '';
    title = `<a href="${escUrl(await linkOf(block, post))}" target="${escAttr(attributes.linkTarget ?? '_self')}" ${rel}>${title}</a>`;
  }
  return `<${tag} ${getBlockWrapperAttributes(block, { class: alignmentClasses(attributes) })}>${title}</${tag}>`;
}

/** human_time_diff() */
function humanTimeDiff(from: number, to: number): string {
  const diff = Math.abs(to - from) / 1000;
  const unit = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (diff < 3600) return unit(Math.max(1, Math.round(diff / 60)), 'min', 'mins');
  if (diff < 86_400) return unit(Math.max(1, Math.round(diff / 3600)), 'hour', 'hours');
  if (diff < 7 * 86_400) return unit(Math.max(1, Math.round(diff / 86_400)), 'day', 'days');
  if (diff < 30 * 86_400)
    return unit(Math.max(1, Math.round(diff / (7 * 86_400))), 'week', 'weeks');
  if (diff < 365 * 86_400)
    return unit(Math.max(1, Math.round(diff / (30 * 86_400))), 'month', 'months');
  return unit(Math.max(1, Math.round(diff / (365 * 86_400))), 'year', 'years');
}

/** render_block_core_post_date() */
export async function renderPostDate(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const site = await siteInfo(block.services.kernel);
  const extra: string[] = [];
  let date: Date | undefined;
  let datetime = typeof attributes.datetime === 'string' ? attributes.datetime : undefined;
  let post: Post | undefined;

  if (datetime === undefined) {
    // The core/post-data binding source: the post's date, or its last modified date.
    post = await contextPost(block);
    if (!post) return '';
    if (attributes.displayType === 'modified') {
      extra.push('wp-block-post-date__modified-date');
      if (post.modified.getTime() <= post.date.getTime()) return '';
      date = post.modified;
    } else {
      date = post.date;
    }
    datetime = theDate(site, date, 'c');
  } else {
    const parsed = new Date(datetime);
    if (Number.isNaN(parsed.getTime())) return '';
    date = parsed;
  }
  if (!datetime) return '';

  const format = typeof attributes.format === 'string' ? attributes.format : '';
  let formatted: string;
  if (format === 'human-diff') {
    const now = Date.now();
    const diff = humanTimeDiff(date.getTime(), now);
    formatted = date.getTime() > now ? `${diff} from now` : `${diff} ago`;
  } else {
    formatted = theDate(site, date, format);
  }

  let time = `<time datetime="${escAttr(datetime)}">${escHtml(formatted)}</time>`;
  if (attributes.isLink && block.context.postId !== undefined) {
    post ??= await contextPost(block);
    if (post) time = `<a href="${escUrl(await linkOf(block, post))}">${time}</a>`;
  }
  return `<div ${getBlockWrapperAttributes(block, { class: alignmentClasses(attributes, extra) })}>${time}</div>`;
}

/** render_block_core_post_excerpt() */
export async function renderPostExcerpt(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const post = await contextPost(block);
  if (!post) return '';
  const link = await linkOf(block, post);
  const moreText =
    typeof attributes.moreText === 'string' && attributes.moreText
      ? `<a class="wp-block-post-excerpt__more-link" href="${escUrl(link)}">${sanitizePostTitle(attributes.moreText)}</a>`
      : '';

  // get_the_excerpt() at 101 words (block_core_post_excerpt_excerpt_length()),
  // without the "[…]" marker when the block shows its own "more" link.
  let excerpt = theExcerpt(post, 101);
  if (moreText && excerpt.endsWith(' [&hellip;]')) excerpt = excerpt.slice(0, -11);
  if (typeof attributes.excerptLength === 'number') {
    excerpt = trimWords(stripAllTags(excerpt), attributes.excerptLength);
  }

  let content = `<p class="wp-block-post-excerpt__excerpt">${excerpt}`;
  const newLine =
    attributes.showMoreOnNewLine === undefined || Boolean(attributes.showMoreOnNewLine);
  if (newLine && moreText) {
    content += `</p><p class="wp-block-post-excerpt__more-text">${moreText}</p>`;
  } else {
    content += ` ${moreText}</p>`;
  }
  return `<div ${getBlockWrapperAttributes(block, { class: alignmentClasses(attributes) })}>${content}</div>`;
}

/** render_block_core_post_author_name() */
export async function renderPostAuthorName(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const post = await contextPost(block);
  if (!post?.authorId) return '';
  const postType = typeof block.context.postType === 'string' ? block.context.postType : post.type;
  if (!kernel.postTypes.get(postType)?.supports.has('author')) return '';
  const author = await authorOf(kernel, post.authorId);
  if (!author) return '';

  let name = escHtml(author.displayName);
  if (attributes.isLink) {
    const site = await siteInfo(kernel);
    name = `<a href="${escUrl(authorPostsUrl(site, author))}" target="${escAttr(attributes.linkTarget ?? '_self')}" class="wp-block-post-author-name__link">${name}</a>`;
  }
  return `<div ${getBlockWrapperAttributes(block, { class: alignmentClasses(attributes) })}>${name}</div>`;
}

/** render_block_core_post_terms(), with get_the_term_list(). */
export async function renderPostTerms(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const taxonomyName = typeof attributes.term === 'string' ? attributes.term : '';
  const post = await contextPost(block);
  if (!post || !taxonomyName) return '';
  const taxonomy = kernel.taxonomies.get(taxonomyName);
  // is_taxonomy_viewable()
  if (!taxonomy?.public) return '';

  const { terms } = await kernel.terms.list(taxonomyName, {
    post: post.id,
    orderby: 'name',
    perPage: 1000,
  });
  if (!terms.length) return '';

  const site = await siteInfo(kernel);
  const separator = attributes.separator ? String(attributes.separator) : ' ';
  const wrapper = getBlockWrapperAttributes(block, {
    class: alignmentClasses(attributes, [`taxonomy-${taxonomyName}`]),
  });
  let before = `<div ${wrapper}>`;
  if (attributes.prefix) {
    before += `<span class="wp-block-post-terms__prefix">${sanitizePostTitle(String(attributes.prefix))}</span>`;
  }
  let after = '</div>';
  if (attributes.suffix) {
    after = `<span class="wp-block-post-terms__suffix">${sanitizePostTitle(String(attributes.suffix))}</span>${after}`;
  }
  const links = terms.map(
    (term) => `<a href="${escUrl(termLink(site, term))}" rel="tag">${escHtml(term.name)}</a>`,
  );
  return (
    before +
    links.join(`<span class="wp-block-post-terms__separator">${escHtml(separator)}</span>`) +
    after
  );
}
