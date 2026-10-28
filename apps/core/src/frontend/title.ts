import { escHtml, stripAllTags } from '@pressbase/blocks';
import { theTitle } from '../blocks/helpers';
import type { Kernel } from '../kernel';
import type { MainQuery } from './query';

/** wp_get_document_title() */
export async function documentTitle(kernel: Kernel, main: MainQuery): Promise<string> {
  const name = await kernel.options.get<string>('blogname', '');
  const tagline = await kernel.options.get<string>('blogdescription', '');
  const object = main.queriedObject;
  const parts: string[] = [];
  if (main.is404) parts.push('Page not found');
  else if (main.isSearch)
    parts.push(`Search Results for &#8220;${escHtml(main.search ?? '')}&#8221;`);
  else if (main.isFrontPage && !main.isPage) {
    parts.push(escHtml(name));
    if (tagline) parts.push(escHtml(tagline));
  } else if (object?.kind === 'post') parts.push(stripAllTags(theTitle(object.post)));
  else if (object?.kind === 'term') parts.push(escHtml(object.term.name));
  else if (object?.kind === 'author') parts.push(escHtml(object.author.displayName));
  else if (main.isDate && main.date) parts.push(String(main.date.year));
  if (main.paged > 1) parts.push(`Page ${main.paged}`);
  if (!(main.isFrontPage && !main.isPage)) parts.push(escHtml(name));
  return parts.filter(Boolean).join(' &#8211; ');
}
