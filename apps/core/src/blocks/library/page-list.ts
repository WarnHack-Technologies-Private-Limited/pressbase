import {
  type BlockAttributes,
  escAttr,
  escUrl,
  getBlockWrapperAttributes,
  stripAllTags,
} from '@pressbase/blocks';
import { permalink, permalinkContext } from '../../content/permalinks';
import { queryPosts } from '../../content/query';
import { sanitizePostTitle } from '../../content/sanitize';
import type { CoreBlock } from '../helpers';

/**
 * core/page-list — render_block_core_page_list() and
 * block_core_page_list_render_nested_page_list()
 * (wordpress/wp-includes/blocks/page-list.php).
 *
 * The public site arrives in v0.4, so no page is "current" yet, and the
 * Navigation block's colour context is not applied.
 */

interface PageItem {
  id: number;
  title: string;
  link: string;
  children: PageItem[];
}

const SUBMENU_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false"><path d="M1.50002 4L6.00002 8L10.5 4" stroke-width="1.5"></path></svg>';

function submenuVisibility(context: Record<string, unknown>): string {
  if (context.openSubmenusOnClick !== undefined && context.openSubmenusOnClick !== null) {
    return context.openSubmenusOnClick ? 'click' : 'hover';
  }
  return typeof context.submenuVisibility === 'string' ? context.submenuVisibility : 'hover';
}

function renderNested(
  pages: PageItem[],
  options: { frontPage: number; navigation: boolean; visibility: string; showIcons: boolean },
  depth = 0,
): string {
  let markup = '';
  const onClick = options.visibility === 'click';
  for (const page of pages) {
    let css = page.children.length ? ' has-child' : '';
    if (options.navigation) {
      css += ' wp-block-navigation-item';
      if (onClick) css += ' open-on-click';
      else if (options.visibility === 'hover' && options.showIcons) css += ' open-on-hover-click';
      else if (options.visibility === 'always') css += ' open-always';
    }
    if (page.id === options.frontPage) css += ' menu-item-home';
    const contentClass = options.navigation ? ' wp-block-navigation-item__content' : '';
    const title = page.title || '(no title)';
    const ariaLabel = `${stripAllTags(title)} submenu`;

    markup += `<li class="wp-block-pages-list__item${escAttr(css)}">`;
    if (page.children.length && options.navigation && onClick) {
      markup += `<button aria-label="${escAttr(ariaLabel)}" class="${escAttr(contentClass)} wp-block-navigation-submenu__toggle" aria-expanded="false">${title}</button><span class="wp-block-page-list__submenu-icon wp-block-navigation__submenu-icon">${SUBMENU_ICON}</span>`;
    } else {
      markup += `<a class="wp-block-pages-list__item__link${escAttr(contentClass)}" href="${escUrl(page.link)}">${title}</a>`;
    }
    if (page.children.length) {
      if (options.navigation && options.showIcons && !onClick) {
        markup += `<button aria-label="${escAttr(ariaLabel)}" class="wp-block-navigation__submenu-icon wp-block-navigation-submenu__toggle" aria-expanded="false">${SUBMENU_ICON}</button>`;
      }
      markup += '<ul class="wp-block-navigation__submenu-container">';
      if (depth < 50) markup += renderNested(page.children, options, depth + 1);
      markup += '</ul>';
    }
    markup += '</li>';
  }
  return markup;
}

export async function renderPageList(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const { posts } = await queryPosts(kernel, {
    post_type: 'page',
    post_status: 'publish',
    posts_per_page: -1,
    orderby: 'menu_order',
    order: 'ASC',
  });
  if (!posts.length) return '';
  // get_pages( sort_column => 'menu_order,post_title' )
  posts.sort((a, b) => a.menuOrder - b.menuOrder || a.title.localeCompare(b.title));

  const links = await permalinkContext(kernel);
  const items = new Map<number, PageItem>();
  for (const post of posts) {
    items.set(post.id, {
      id: post.id,
      title: sanitizePostTitle(post.title),
      link: await permalink(kernel, post, links),
      children: [],
    });
  }
  const topLevel: PageItem[] = [];
  for (const post of posts) {
    const item = items.get(post.id) as PageItem;
    const parent = post.parentId ? items.get(post.parentId) : undefined;
    if (parent) parent.children.push(item);
    else if (!post.parentId) topLevel.push(item);
  }

  let pages = topLevel;
  const parentId = Number(attributes.parentPageID) || 0;
  if (parentId !== 0) {
    const parent = items.get(parentId);
    if (!parent?.children.length) return '';
    pages = parent.children;
  }

  const navigation = 'showSubmenuIcon' in block.context;
  const markup = renderNested(pages, {
    frontPage: await kernel.options.get<number>('page_on_front', 0),
    navigation,
    visibility: navigation ? submenuVisibility(block.context) : 'hover',
    showIcons: Boolean(block.context.showSubmenuIcon),
  });
  if (block.context['core/isInsideSubmenu']) return markup;
  return `<ul ${getBlockWrapperAttributes(block)}>${markup}</ul>`;
}
