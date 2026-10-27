import {
  type BlockAttributes,
  escAttr,
  escHtml,
  escUrl,
  getBlockWrapperAttributes,
} from '@pressbase/blocks';
import { permalink, permalinkContext } from '../../content/permalinks';
import { type OrderBy, queryPosts } from '../../content/query';
import { sanitizeSlug } from '../../content/sanitize';
import { authorOf, type CoreBlock, siteInfo, theDate, theExcerpt, theTitle } from '../helpers';

/**
 * core/latest-posts — render_block_core_latest_posts()
 * (wordpress/wp-includes/blocks/latest-posts.php).
 *
 * Featured images are not rendered yet: they arrive with the Media library.
 */
export async function renderLatestPosts(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const site = await siteInfo(kernel);
  const links = await permalinkContext(kernel);

  // block_core_latest_posts_migrate_categories(): old content stored one ID as a string.
  let categories = attributes.categories;
  if (typeof categories === 'string' && categories) categories = [{ id: Number(categories) }];
  const categoryIds = Array.isArray(categories)
    ? categories
        .map((c) => Number((c as { id?: unknown })?.id))
        .filter((id) => Number.isInteger(id) && id > 0)
    : [];

  const { posts } = await queryPosts(kernel, {
    post_type: 'post',
    post_status: 'publish',
    posts_per_page: Math.max(1, Math.min(100, Number(attributes.postsToShow) || 5)),
    order: String(attributes.order).toLowerCase() === 'asc' ? 'ASC' : 'DESC',
    orderby: (['date', 'title', 'modified'].includes(String(attributes.orderBy))
      ? String(attributes.orderBy)
      : 'date') as OrderBy,
    // category__in: exact categories, children not included.
    tax_query: categoryIds.length
      ? [{ taxonomy: 'category', terms: categoryIds, include_children: false }]
      : [],
    author: typeof attributes.selectedAuthor === 'number' ? attributes.selectedAuthor : undefined,
    no_found_rows: true,
  });

  const excerptLength = Number(attributes.excerptLength) || 55;
  let items = '';
  for (const post of posts) {
    const link = await permalink(kernel, post, links);
    const title = theTitle(post) || '(no title)';
    items += '<li>';
    items += `<a class="wp-block-latest-posts__post-title" href="${escUrl(link)}">${title}</a>`;

    if (attributes.displayAuthor) {
      const author = await authorOf(kernel, post.authorId);
      if (author?.displayName) {
        items += `<div class="wp-block-latest-posts__post-author">by ${escHtml(author.displayName)}</div>`;
      }
    }

    if (attributes.displayPostDate) {
      items += `<time datetime="${escAttr(theDate(site, post.date, 'c'))}" class="wp-block-latest-posts__post-date">${escHtml(theDate(site, post.date))}</time>`;
    }

    if (attributes.displayPostContent && attributes.displayPostContentRadio === 'excerpt') {
      let excerpt = theExcerpt(post, excerptLength);
      if (excerpt.endsWith(' [&hellip;]')) {
        excerpt = `${excerpt.slice(0, -11)}… <a class="wp-block-latest-posts__read-more" href="${escUrl(link)}" rel="noopener">Read more<span class="screen-reader-text">: ${escHtml(title)}</span></a>`;
      }
      if (post.password) excerpt = 'This content is password protected.';
      items += `<div class="wp-block-latest-posts__post-excerpt">${excerpt}</div>`;
    }

    if (attributes.displayPostContent && attributes.displayPostContentRadio === 'full_post') {
      let full = 'This content is password protected.';
      if (!post.password) {
        // A post that lists itself in full would never finish rendering.
        full = await block.withRecursionGuard(
          `post:${post.id}`,
          () => block.renderContent(post.content, { postId: post.id, postType: post.type }),
          '',
        );
      }
      items += `<div class="wp-block-latest-posts__post-full-content">${full.replace(/\]\]>/g, ']]&gt;')}</div>`;
    }
    items += '</li>\n';
  }

  const layout = (attributes.layout ?? {}) as {
    type?: string;
    columnCount?: number;
    minimumColumnWidth?: string;
  };
  const layoutType = layout.type ?? (attributes.postLayout === 'grid' ? 'grid' : 'default');
  const columns = layout.columnCount ?? (attributes.columns as number | undefined);
  const classes = ['wp-block-latest-posts__list'];
  if (layoutType === 'grid') classes.push('is-grid');
  if (layoutType === 'grid' && columns) classes.push(sanitizeSlug(`columns-${columns}`));
  if (layoutType === 'grid' && columns && layout.minimumColumnWidth) {
    classes.push('has-native-responsive-grid');
  }
  if (attributes.displayPostDate) classes.push('has-dates');
  if (attributes.displayAuthor) classes.push('has-author');

  return `<ul ${getBlockWrapperAttributes(block, { class: classes.join(' ') })}>${items}</ul>`;
}
