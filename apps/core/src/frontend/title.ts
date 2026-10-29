import { escHtml, stripAllTags } from '@pressbase/blocks';
import { theTitle } from '../blocks/helpers';
import type { Kernel } from '../kernel';
import type { MainQuery } from './query';

/** wp_get_document_title()'s parts, in its order. Values are text (escaped once, at the end). */
export interface DocumentTitleParts {
  title: string;
  page?: string;
  tagline?: string;
  site?: string;
}

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    /** Pressbase passes the main query as a second argument (WordPress reads the global $wp_query). */
    pre_get_document_title: [title: string, main: MainQuery];
    document_title_separator: [separator: string, main: MainQuery];
    document_title_parts: [parts: DocumentTitleParts, main: MainQuery];
    document_title: [title: string, main: MainQuery];
  }
}

/**
 * wp_get_document_title() (wordpress/wp-includes/general-template.php), with
 * its filters: `pre_get_document_title` (a non-empty string replaces the
 * whole title), `document_title_separator`, `document_title_parts` and
 * `document_title`. The result is escaped HTML, as WordPress's `esc_html`
 * on `document_title` leaves it. The separator defaults to `&#8211;`, what
 * wptexturize() makes of WordPress's `-`.
 */
export async function documentTitle(kernel: Kernel, main: MainQuery): Promise<string> {
  const hooks = kernel.hooks;
  const pre = await hooks.applyFilters('pre_get_document_title', '', main);
  if (typeof pre === 'string' && pre) return escHtml(pre);

  const name = await kernel.options.get<string>('blogname', '');
  const tagline = await kernel.options.get<string>('blogdescription', '');
  const object = main.queriedObject;
  // The blog's front page shows the site name and tagline; a static front page its title.
  const front = main.isFrontPage && !main.isPage;
  const parts: DocumentTitleParts = { title: '' };
  if (main.is404) parts.title = 'Page not found';
  else if (main.isSearch) parts.title = `Search Results for &#8220;${main.search ?? ''}&#8221;`;
  else if (front) parts.title = name;
  else if (object?.kind === 'post') parts.title = stripAllTags(theTitle(object.post));
  else if (object?.kind === 'term') parts.title = object.term.name;
  else if (object?.kind === 'author') parts.title = object.author.displayName;
  else if (main.isDate && main.date) parts.title = String(main.date.year);
  if (main.paged > 1 && !main.is404) parts.page = `Page ${main.paged}`;
  if (front) parts.tagline = tagline;
  else parts.site = name;

  const sep = await hooks.applyFilters('document_title_separator', '&#8211;', main);
  const filtered = await hooks.applyFilters('document_title_parts', parts, main);
  // implode( " $sep ", array_filter( $title ) ): in the parts' own order.
  const joined = Object.values(filtered ?? {})
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(` ${sep} `);
  return escHtml(await hooks.applyFilters('document_title', joined, main));
}
