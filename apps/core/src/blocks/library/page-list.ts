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
import { currentPage } from '../../frontend/page';
import type { CoreBlock } from '../helpers';
import { SUBMENU_ICON, submenuColors, submenuVisibility } from './navigation';

/**
 * core/page-list — render_block_core_page_list() and
 * block_core_page_list_render_nested_page_list()
 * (wordpress/wp-includes/blocks/page-list.php).
 *
 * The page being shown gets `current-menu-item` and `aria-current="page"`,
 * its ancestors `current-menu-ancestor`. Inside a Navigation block, nested
 * levels take the block's overlay colours, so dropdowns stay readable.
 */

interface PageItem {
  id: number;
  title: string;
  link: string;
  active: boolean;
  children: PageItem[];
}

interface NestedOptions {
  frontPage: number;
  navigation: boolean;
  visibility: string;
  showIcons: boolean;
  /** Pages above the current one (get_post_ancestors()). */
  ancestors: Set<number>;
  /** core/isInsideSubmenu: this list is itself inside a submenu. */
  nested: boolean;
  overlay: { classes: string[]; styles: string[] };
}

function renderNested(pages: PageItem[], options: NestedOptions, depth = 0): string {
  let markup = '';
  const onClick = options.visibility === 'click';
  for (const page of pages) {
    let css = page.active ? ' current-menu-item' : '';
    if (options.ancestors.has(page.id)) css += ' current-menu-ancestor';
    if (page.children.length) css += ' has-child';
    if (options.navigation) {
      css += ' wp-block-navigation-item';
      if (onClick) css += ' open-on-click';
      else if (options.visibility === 'hover' && options.showIcons) css += ' open-on-hover-click';
      else if (options.visibility === 'always') css += ' open-always';
    }
    // The first level of submenus (and deeper) takes the overlay colours.
    let style = '';
    if ((depth > 0 && !options.nested) || options.nested) {
      if (options.overlay.classes.length) css += ` ${options.overlay.classes.join(' ')}`;
      if (options.overlay.styles.length)
        style = ` style="${escAttr(options.overlay.styles.join(' '))}"`;
    }
    if (page.id === options.frontPage) css += ' menu-item-home';
    const contentClass = options.navigation ? ' wp-block-navigation-item__content' : '';
    const title = page.title || '(no title)';
    const ariaLabel = `${stripAllTags(title)} submenu`;

    markup += `<li class="wp-block-pages-list__item${escAttr(css)}"${style}>`;
    if (page.children.length && options.navigation && onClick) {
      markup += `<button aria-label="${escAttr(ariaLabel)}" class="${escAttr(contentClass)} wp-block-navigation-submenu__toggle" aria-expanded="false">${title}</button><span class="wp-block-page-list__submenu-icon wp-block-navigation__submenu-icon">${SUBMENU_ICON}</span>`;
    } else {
      markup += `<a class="wp-block-pages-list__item__link${escAttr(contentClass)}" href="${escUrl(page.link)}"${page.active ? ' aria-current="page"' : ''}>${title}</a>`;
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
  const queried = currentPage()?.main.queriedObject;
  const currentId = queried?.kind === 'post' ? queried.post.id : 0;
  const items = new Map<number, PageItem>();
  for (const post of posts) {
    items.set(post.id, {
      id: post.id,
      title: sanitizePostTitle(post.title),
      link: await permalink(kernel, post, links),
      active: post.id === currentId,
      children: [],
    });
  }
  // get_post_ancestors() of the page being shown.
  const ancestors = new Set<number>();
  const byId = new Map(posts.map((p) => [p.id, p]));
  for (let p = byId.get(currentId)?.parentId; p && !ancestors.has(p); p = byId.get(p)?.parentId) {
    ancestors.add(p);
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
    ancestors,
    nested: Boolean(block.context['core/isInsideSubmenu']),
    overlay: submenuColors(block.context),
  });
  if (block.context['core/isInsideSubmenu']) return markup;
  return `<ul ${getBlockWrapperAttributes(block)}>${markup}</ul>`;
}
