import type { MainQuery } from './query';

/**
 * The template hierarchy — template-loader.php's order of conditions and the
 * candidate lists of get_404_template(), get_search_template(),
 * get_front_page_template(), get_home_template(), get_single_template(),
 * get_page_template(), get_singular_template(), get_category_template(),
 * get_tag_template(), get_author_template(), get_date_template() and
 * get_archive_template() (wordpress/wp-includes/template.php).
 *
 * The first candidate the theme has a template for wins; `index` is always
 * last. `pageTemplate` is the custom template chosen for a post
 * (_wp_page_template meta), which comes first for singular views.
 */
export function templateHierarchy(main: MainQuery, pageTemplate?: string): string[] {
  const out: string[] = [];
  const add = (...slugs: string[]) => {
    for (const slug of slugs) if (slug && !out.includes(slug)) out.push(slug);
  };
  const object = main.queriedObject;
  const post = object?.kind === 'post' ? object.post : undefined;
  const term = object?.kind === 'term' ? object.term : undefined;
  const author = object?.kind === 'author' ? object.author : undefined;
  // Slugs with characters a file name can't hold are also tried URL-encoded, as WordPress does.
  const withEncoded = (prefix: string, slug: string) => {
    const encoded = encodeURIComponent(slug).toLowerCase();
    return encoded !== slug ? [`${prefix}-${encoded}`, `${prefix}-${slug}`] : [`${prefix}-${slug}`];
  };

  if (main.is404) add('404');
  if (main.isSearch) add('search');
  if (main.isFrontPage) add('front-page');
  if (main.isHome) add('home', 'index');
  if (main.isTax) add('taxonomy');
  if (main.isSingle && post) {
    if (pageTemplate) add(pageTemplate);
    add(...withEncoded(`single-${post.type}`, post.slug), `single-${post.type}`, 'single');
  }
  if (main.isPage && post) {
    if (pageTemplate) add(pageTemplate);
    add(...withEncoded('page', post.slug), `page-${post.id}`, 'page');
  }
  if (main.isSingular) add('singular');
  if (main.isCategory && term)
    add(...withEncoded('category', term.slug), `category-${term.id}`, 'category');
  if (main.isTag && term) add(...withEncoded('tag', term.slug), `tag-${term.id}`, 'tag');
  if (main.isAuthor && author) add(`author-${author.nicename}`, `author-${author.id}`, 'author');
  if (main.isDate) add('date');
  if (main.isArchive) add('archive');
  add('index');
  return out;
}
