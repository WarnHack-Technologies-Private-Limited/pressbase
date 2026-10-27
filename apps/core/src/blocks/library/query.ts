import {
  type BlockAttributes,
  escAttr,
  escHtml,
  escUrl,
  getBlockWrapperAttributes,
} from '@pressbase/blocks';
import type { Post } from '../../content/posts';
import { type QueryArgs, queryPosts, type TaxQueryClause } from '../../content/query';
import { currentPage, type PageRender } from '../../frontend/page';
import { featuredMediaIds } from '../../media/featured';
import { type CoreBlock, siteInfo, theDate } from '../helpers';

/**
 * The Query Loop and its parts — query.php, post-template.php,
 * query-pagination*.php, query-no-results.php, query-title.php and
 * term-description.php in wordpress/wp-includes/blocks/, with
 * build_query_vars_from_query_block(), paginate_links() and
 * get_query_pagination_arrow() from blocks.php and general-template.php.
 *
 * A query with `inherit: true` shows the page's main query (the posts of
 * the home page, an archive or the search). Other queries run their own,
 * paginated with `?query-{queryId}-page=N`.
 */

type QueryAttributes = Record<string, unknown>;

const queryOf = (block: CoreBlock): QueryAttributes =>
  (block.context.query && typeof block.context.query === 'object'
    ? block.context.query
    : {}) as QueryAttributes;

const inherits = (block: CoreBlock) => Boolean(queryOf(block).inherit) && Boolean(currentPage());

const pageKey = (block: CoreBlock) =>
  block.context.queryId !== undefined ? `query-${block.context.queryId}-page` : 'query-page';

/** The page number of a custom query, from `?query-N-page=`. */
function customPage(block: CoreBlock): number {
  const page = currentPage();
  if (!page) return 1;
  const value = new URL(page.path, 'http://x').searchParams.get(pageKey(block));
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

const ints = (value: unknown): number[] =>
  Array.isArray(value) ? value.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];

/** build_query_vars_from_query_block() */
export async function queryVarsFromBlock(block: CoreBlock, page: number): Promise<QueryArgs> {
  const { kernel } = block.services;
  const query = queryOf(block);
  const args: QueryArgs = { post_type: 'post', order: 'DESC', orderby: 'date', post__not_in: [] };
  const taxQuery: TaxQueryClause[] = [];
  if (typeof query.postType === 'string' && kernel.postTypes.get(query.postType)?.public) {
    args.post_type = query.postType;
  }
  if (typeof query.sticky === 'string' && query.sticky) {
    const sticky = await kernel.options.get<number[]>('sticky_posts', []);
    if (query.sticky === 'only') args.post__in = sticky.length ? sticky : [0];
    else if (query.sticky === 'exclude')
      args.post__not_in = [...(args.post__not_in ?? []), ...sticky];
  }
  args.post__not_in = [...(args.post__not_in ?? []), ...ints(query.exclude)];
  if (query.excludeCurrent) {
    const current = currentPage()?.main.queriedObject;
    if (current?.kind === 'post') args.post__not_in.push(current.post.id);
  }
  const perPage = Number(query.perPage);
  if (query.perPage !== undefined && query.perPage !== '' && Number.isFinite(perPage)) {
    const per = Math.abs(Math.trunc(perPage));
    const offset = Math.abs(Math.trunc(Number(query.offset) || 0));
    args.offset = per * (page - 1) + offset;
    args.posts_per_page = per;
  }
  for (const [taxonomy, ids] of [
    ['category', query.categoryIds],
    ['post_tag', query.tagIds],
  ] as const) {
    const terms = ints(ids);
    if (terms.length) taxQuery.push({ taxonomy, terms, include_children: false });
  }
  if (query.taxQuery && typeof query.taxQuery === 'object') {
    const input = query.taxQuery as Record<string, unknown>;
    const keys = Object.keys(input);
    const build = (terms: unknown, operator: 'IN' | 'NOT IN') => {
      if (!terms || typeof terms !== 'object') return;
      for (const [taxonomy, ids] of Object.entries(terms as Record<string, unknown>)) {
        const list = ints(ids);
        if (list.length && kernel.taxonomies.get(taxonomy)?.public) {
          taxQuery.push({ taxonomy, terms: list, operator, include_children: false });
        }
      }
    };
    if (keys.some((k) => k !== 'include' && k !== 'exclude')) build(input, 'IN');
    else {
      build(input.include, 'IN');
      build(input.exclude, 'NOT IN');
    }
  }
  if (taxQuery.length) args.tax_query = taxQuery;
  if (query.order === 'asc' || query.order === 'desc')
    args.order = query.order === 'asc' ? 'ASC' : 'DESC';
  if (typeof query.orderBy === 'string') {
    const map: Record<string, QueryArgs['orderby']> = {
      date: 'date',
      title: 'title',
      modified: 'modified',
      author: 'author',
      menu_order: 'menu_order',
      id: 'id',
      name: 'name',
      comment_count: 'comment_count',
    };
    if (map[query.orderBy]) args.orderby = map[query.orderBy];
  }
  if (query.author !== undefined && query.author !== '') {
    const authors = (Array.isArray(query.author) ? query.author : String(query.author).split(','))
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    if (authors.length) args.author__in = authors;
  }
  if (typeof query.search === 'string' && query.search) args.s = query.search;
  const parents = ints(query.parents);
  if (parents.length) args.post_parent__in = parents;
  // Readers see published posts only in custom queries, as WordPress's front end does.
  args.post_status = 'publish';
  return args;
}

interface LoopResult {
  posts: Post[];
  maxPages: number;
  page: number;
}

/** The posts a query block shows: the main query's, or its own. */
async function loopFor(block: CoreBlock): Promise<LoopResult> {
  const page = currentPage();
  if (inherits(block) && page) {
    return { posts: page.main.posts, maxPages: page.main.maxPages, page: page.main.paged };
  }
  const current = customPage(block);
  const args = await queryVarsFromBlock(block, current);
  const result = await queryPosts(block.services.kernel, args);
  const max = Number(queryOf(block).pages) || 0;
  return {
    posts: result.posts,
    maxPages: max && max < result.maxPages ? max : result.maxPages,
    page: current,
  };
}

/** render_block_core_query(): the wrapper and its saved inner blocks. */
export function renderQuery(_attributes: BlockAttributes, content: string): string {
  return content;
}

/** get_post_class() */
async function postClasses(block: CoreBlock, post: Post, thumbnail: boolean): Promise<string> {
  const { kernel } = block.services;
  const classes = [
    'wp-block-post',
    `post-${post.id}`,
    post.type,
    `type-${post.type}`,
    `status-${post.status}`,
  ];
  if (post.type === 'post') classes.push('format-standard');
  if (thumbnail) classes.push('has-post-thumbnail');
  classes.push('hentry');
  for (const [taxonomy, prefix] of [
    ['category', 'category'],
    ['post_tag', 'tag'],
  ] as const) {
    if (post.type !== 'post') continue;
    const { terms } = await kernel.terms.list(taxonomy, { post: post.id, perPage: 100 });
    for (const term of terms) classes.push(`${prefix}-${term.slug}`);
  }
  return classes.join(' ');
}

/** render_block_core_post_template() */
export async function renderPostTemplate(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { posts } = await loopFor(block);
  if (!posts.length) return '';
  let classes = '';
  const displayLayout = block.context.displayLayout as
    | { type?: string; columns?: number }
    | undefined;
  if (displayLayout?.type === 'flex' && block.context.query) {
    classes = `is-flex-container columns-${displayLayout.columns ?? 2}`;
  }
  const style = attributes.style as
    | { elements?: { link?: { color?: { text?: unknown } } } }
    | undefined;
  if (style?.elements?.link?.color?.text !== undefined) classes += ' has-link-color';
  const layout = attributes.layout as
    | { type?: string; columnCount?: number; minimumColumnWidth?: string }
    | undefined;
  if (layout?.type === 'grid' && layout.columnCount) {
    classes += ` columns-${layout.columnCount}`;
    if (layout.minimumColumnWidth) classes += ' has-native-responsive-grid';
  }
  const wrapper = getBlockWrapperAttributes(block, { class: classes.trim() });
  const thumbnails = await featuredMediaIds(
    block.services.kernel,
    posts.map((p) => p.id),
  );
  const template = block.parsedBlock.innerBlocks;
  let html = '';
  for (const post of posts) {
    // A fresh copy of the template per post, with the post as context.
    const inner = await block.renderInnerBlocks(structuredClone(template), {
      postId: post.id,
      postType: post.type,
    });
    html += `<li class="${escAttr(await postClasses(block, post, thumbnails.has(post.id)))}">${inner}</li>`;
  }
  return `<ul ${wrapper}>${html}</ul>`;
}

/** render_block_core_query_no_results() */
export async function renderQueryNoResults(
  attributes: BlockAttributes,
  content: string,
  block: CoreBlock,
): Promise<string> {
  if (!content.trim()) return '';
  const { posts } = await loopFor(block);
  if (posts.length) return '';
  const style = attributes.style as
    | { elements?: { link?: { color?: { text?: unknown } } } }
    | undefined;
  const classes = style?.elements?.link?.color?.text !== undefined ? 'has-link-color' : '';
  return `<div ${getBlockWrapperAttributes(block, { class: classes })}>${content}</div>`;
}

/** render_block_core_query_pagination() */
export function renderQueryPagination(
  attributes: BlockAttributes,
  content: string,
  block: CoreBlock,
): string {
  if (!content.trim()) return '';
  const style = attributes.style as
    | { elements?: { link?: { color?: { text?: unknown } } } }
    | undefined;
  const classes = style?.elements?.link?.color?.text !== undefined ? 'has-link-color' : '';
  return `<nav ${getBlockWrapperAttributes(block, { 'aria-label': 'Pagination', class: classes })}>${content}</nav>`;
}

/** get_query_pagination_arrow() */
function paginationArrow(block: CoreBlock, next: boolean): string {
  const arrows: Record<string, [string, string]> = { arrow: ['←', '→'], chevron: ['«', '»'] };
  const type =
    typeof block.context.paginationArrow === 'string' ? block.context.paginationArrow : '';
  const pair = arrows[type];
  if (!pair) return '';
  const kind = next ? 'next' : 'previous';
  return `<span class='wp-block-query-pagination-${kind}-arrow is-arrow-${type}' aria-hidden='true'>${next ? pair[1] : pair[0]}</span>`;
}

/** get_pagenum_link(): page N of the current listing. */
export function pagenumLink(page: PageRender, n: number, pretty: boolean): string {
  const url = new URL(page.path, 'http://x');
  url.searchParams.delete('paged');
  let pathname = url.pathname.replace(/\/page\/\d+\/?$/, '/');
  if (!pathname.endsWith('/')) pathname += '/';
  if (pretty) {
    if (n > 1) pathname += `page/${n}/`;
  } else if (n > 1) url.searchParams.set('paged', String(n));
  const query = url.searchParams.toString();
  return `${page.home}${pathname}${query ? `?${query}` : ''}`;
}

/** add_query_arg( $key, $value ) on the current URL. */
function customPageLink(page: PageRender, key: string, n: number): string {
  const url = new URL(page.path, 'http://x');
  url.searchParams.set(key, String(n));
  return `${page.home}${url.pathname}?${url.searchParams.toString()}`;
}

async function paginationLink(
  attributes: BlockAttributes,
  block: CoreBlock,
  next: boolean,
): Promise<string> {
  const page = currentPage();
  if (!page) return '';
  const showLabel = block.context.showLabel === undefined ? true : Boolean(block.context.showLabel);
  const labelText =
    typeof attributes.label === 'string' && attributes.label
      ? escHtml(attributes.label)
      : next
        ? 'Next Page'
        : 'Previous Page';
  let label = showLabel ? labelText : '';
  let wrapper = getBlockWrapperAttributes(block);
  if (!label) wrapper += ` aria-label="${labelText}"`;
  const arrow = paginationArrow(block, next);
  if (arrow) label = next ? label + arrow : arrow + label;

  const site = await siteInfo(block.services.kernel);
  if (inherits(block)) {
    if (page.main.isSingular) return '';
    const max = Number(queryOf(block).pages) || 0;
    const total = max && max < page.main.maxPages ? max : page.main.maxPages;
    const target = next ? page.main.paged + 1 : page.main.paged - 1;
    if (next ? target > total : target < 1) return '';
    return `<a href="${escUrl(pagenumLink(page, target, site.pretty))}" ${wrapper}>${label}</a>`;
  }
  const { page: current, maxPages } = await loopFor(block);
  const target = next ? current + 1 : current - 1;
  if (next ? !maxPages || target > maxPages : target < 1 || current > maxPages) return '';
  return `<a href="${escUrl(customPageLink(page, pageKey(block), target))}" ${wrapper}>${label}</a>`;
}

/** render_block_core_query_pagination_previous() */
export function renderQueryPaginationPrevious(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  return paginationLink(attributes, block, false);
}

/** render_block_core_query_pagination_next() */
export function renderQueryPaginationNext(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  return paginationLink(attributes, block, true);
}

/** paginate_links( prev_next: false ) */
export function paginateLinks(
  current: number,
  total: number,
  link: (n: number) => string,
  midSize = 2,
  endSize = 1,
): string {
  if (total < 2) return '';
  const out: string[] = [];
  let dots = false;
  for (let n = 1; n <= total; n++) {
    if (n === current) {
      out.push(`<span aria-current="page" class="page-numbers current">${n}</span>`);
      dots = true;
    } else if (
      n <= endSize ||
      (n >= current - midSize && n <= current + midSize) ||
      n > total - endSize
    ) {
      out.push(`<a class="page-numbers" href="${escUrl(link(n))}">${n}</a>`);
      dots = true;
    } else if (dots) {
      out.push('<span class="page-numbers dots">&hellip;</span>');
      dots = false;
    }
  }
  return out.join('\n');
}

/** render_block_core_query_pagination_numbers() */
export async function renderQueryPaginationNumbers(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const page = currentPage();
  if (!page) return '';
  const midSize = typeof attributes.midSize === 'number' ? attributes.midSize : 2;
  const max = Number(queryOf(block).pages) || 0;
  let content: string;
  if (inherits(block)) {
    if (page.main.isSingular) return '';
    const site = await siteInfo(block.services.kernel);
    const total = max && max < page.main.maxPages ? max : page.main.maxPages;
    content = paginateLinks(
      page.main.paged,
      total,
      (n) => pagenumLink(page, n, site.pretty),
      midSize,
    );
  } else {
    const { page: current, maxPages } = await loopFor(block);
    content = paginateLinks(
      current,
      maxPages,
      (n) => customPageLink(page, pageKey(block), n),
      midSize,
    );
  }
  if (!content) return '';
  return `<div ${getBlockWrapperAttributes(block)}>${content}</div>`;
}

/** get_the_archive_title() */
async function archiveTitle(block: CoreBlock, page: PageRender, prefix: boolean): Promise<string> {
  const main = page.main;
  const object = main.queriedObject;
  const site = await siteInfo(block.services.kernel);
  let label = '';
  let title = 'Archives';
  if (main.isCategory && object?.kind === 'term') {
    label = 'Category:';
    title = escHtml(object.term.name);
  } else if (main.isTag && object?.kind === 'term') {
    label = 'Tag:';
    title = escHtml(object.term.name);
  } else if (main.isAuthor && object?.kind === 'author') {
    label = 'Author:';
    title = `<span class="vcard">${escHtml(object.author.displayName)}</span>`;
  } else if (main.isDate && main.date) {
    const { year, month = 1, day = 1 } = main.date;
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    if (main.isYear) {
      label = 'Year:';
      title = theDate({ ...site, timeZone: 'UTC' }, date, 'Y');
    } else if (main.isMonth) {
      label = 'Month:';
      title = theDate({ ...site, timeZone: 'UTC' }, date, 'F Y');
    } else {
      label = 'Day:';
      title = theDate({ ...site, timeZone: 'UTC' }, date);
    }
  }
  return prefix && label ? `${label} <span>${title}</span>` : title;
}

/** render_block_core_query_title() */
export async function renderQueryTitle(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const page = currentPage();
  const type = typeof attributes.type === 'string' ? attributes.type : '';
  if (!page || !type) return '';
  const { isArchive, isSearch } = page.main;
  if ((type === 'archive' && !isArchive) || (type === 'search' && !isSearch)) return '';
  let title = '';
  if (isArchive) title = await archiveTitle(block, page, attributes.showPrefix !== false);
  if (isSearch) {
    title = 'Search results';
    if (attributes.showSearchTerm) {
      title = `Search results for: &#8220;${escHtml(page.main.search ?? '')}&#8221;`;
    }
  }
  if (type === 'post-type') {
    const name =
      typeof queryOf(block).postType === 'string' ? String(queryOf(block).postType) : 'post';
    const postType = block.services.kernel.postTypes.get(name);
    if (!postType) return '';
    title =
      attributes.showPrefix === false
        ? escHtml(postType.singularLabel)
        : `Post Type: &#8220;${escHtml(postType.singularLabel)}&#8221;`;
  }
  const level = typeof attributes.level === 'number' ? attributes.level : 1;
  const tag = level === 0 ? 'p' : `h${Math.min(Math.max(level, 1), 6)}`;
  const align =
    typeof attributes.textAlign === 'string' ? `has-text-align-${attributes.textAlign}` : '';
  return `<${tag} ${getBlockWrapperAttributes(block, { class: align })}>${title}</${tag}>`;
}

/** render_block_core_term_description() */
export async function renderTermDescription(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  let description = '';
  const { kernel } = block.services;
  if (block.context.termId !== undefined && typeof block.context.taxonomy === 'string') {
    const term = await kernel.terms.get(block.context.taxonomy, Number(block.context.termId));
    description = term?.description ?? '';
  } else {
    const object = currentPage()?.main.queriedObject;
    if (object?.kind === 'term') description = object.term.description;
  }
  if (!description.trim()) return '';
  const classes: string[] = [];
  if (typeof attributes.textAlign === 'string')
    classes.push(`has-text-align-${attributes.textAlign}`);
  const style = attributes.style as
    | { elements?: { link?: { color?: { text?: unknown } } } }
    | undefined;
  if (style?.elements?.link?.color?.text !== undefined) classes.push('has-link-color');
  // term_description() runs wpautop() on the plain-text description; descriptions are escaped here.
  const paragraphs = description
    .split(/\n{2,}/)
    .map((p) => `<p>${escHtml(p.trim()).replace(/\n/g, '<br />\n')}</p>`)
    .join('\n');
  return `<div ${getBlockWrapperAttributes(block, { class: classes.join(' ') })}>${paragraphs}\n</div>`;
}
