/**
 * Which page Studio opens and which template shows it. Pure functions over
 * REST data, tested in site-model.test.ts.
 *
 * The template choice follows core's template hierarchy for a page
 * (apps/core/src/frontend/hierarchy.ts: get_front_page_template(),
 * get_page_template() and get_singular_template() in
 * wordpress/wp-includes/template.php), applied to the templates
 * /wp/v2/templates lists, as WordPress's editor picks a page's template in
 * the browser (the editor store's getCurrentTemplateId()).
 */

/**
 * A page's reference: its ID, or, for a page the draft adds (#29), its slug.
 * Such a page is `page:{slug}` in the changeset and gets its ID on Publish.
 */
export type PageRef = number | string;

/** True for a page the draft adds: it has no ID until Publish. */
export const isNewPage = (ref: PageRef): ref is string => typeof ref === 'string';

/** The /wp/v2/pages fields Studio reads. */
export interface StudioPage {
  id: PageRef;
  title: { raw?: string; rendered?: string };
  slug: string;
  status: string;
  link: string;
  /** The parent's reference; 0 at the top level. */
  parent: PageRef;
  menu_order: number;
  /** The custom template chosen for the page ('' for the default). */
  template: string;
  /** Who wrote it (people without `edit_others_pages` open only their own). */
  author?: number;
}

/** The /wp/v2/settings fields about the front page. */
export interface ReadingSettings {
  show_on_front: 'posts' | 'page' | string;
  /** A page's ID; in a draft, also the slug of a page the draft adds (the site builder sets one, #60). */
  page_on_front: PageRef;
}

/** The home page: an ID, a new page's slug, or 0 for none. */
export function frontPage(reading: Pick<ReadingSettings, 'page_on_front'>): PageRef {
  const value = reading.page_on_front;
  if (typeof value === 'string' && value && !/^\d+$/.test(value)) return value;
  return Number(value) || 0;
}

/** What the canvas shows: a page, or the latest posts (a blog home page). */
export type CanvasTarget = { kind: 'page'; id: PageRef } | { kind: 'posts' };

/** Whether two targets are the same page (or both the latest posts). */
export const sameTarget = (a: CanvasTarget, b: CanvasTarget) =>
  a.kind === b.kind && (a.kind === 'posts' || (b.kind === 'page' && a.id === b.id));

/**
 * The page Studio opens: the one asked for (`?page=`), else the home page:
 * the static front page, or the latest posts when the site shows those.
 */
export function initialTarget(
  requested: PageRef | undefined,
  reading: ReadingSettings,
  pages: readonly Pick<StudioPage, 'id'>[],
): CanvasTarget {
  if (requested && pages.some((page) => page.id === requested)) {
    return { kind: 'page', id: requested };
  }
  const front = frontPage(reading);
  if (reading.show_on_front === 'page' && front && pages.some((page) => page.id === front)) {
    return { kind: 'page', id: front };
  }
  return { kind: 'posts' };
}

/** True when the target is what visitors see at the site's address. */
export function isHome(target: CanvasTarget, reading: ReadingSettings): boolean {
  if (target.kind === 'posts') return reading.show_on_front !== 'page' || !reading.page_on_front;
  return reading.show_on_front === 'page' && frontPage(reading) === target.id;
}

/** Slugs with characters a file name can't hold are also tried URL-encoded, as WordPress does. */
function withEncoded(prefix: string, slug: string): string[] {
  const encoded = encodeURIComponent(slug).toLowerCase();
  return encoded !== slug ? [`${prefix}-${encoded}`, `${prefix}-${slug}`] : [`${prefix}-${slug}`];
}

/** The template slugs that could show the target, best first; `index` is always last. */
export function templateCandidates(
  target: CanvasTarget,
  reading: ReadingSettings,
  page?: Pick<StudioPage, 'id' | 'slug' | 'template'>,
): string[] {
  const out: string[] = [];
  const add = (...slugs: string[]) => {
    for (const slug of slugs) if (slug && !out.includes(slug)) out.push(slug);
  };
  if (target.kind === 'posts') {
    // is_front_page() and is_home(): front-page, then home.
    add('front-page', 'home', 'index');
    return out;
  }
  if (isHome(target, reading)) add('front-page');
  if (page) {
    if (page.template && page.template !== 'default') add(page.template);
    if (page.slug) add(...withEncoded('page', page.slug));
    add(`page-${page.id}`);
  }
  add('page', 'singular', 'index');
  return out;
}

/** The first candidate the theme (or the site) has a template for. */
export function pickTemplate<T extends { slug: string }>(
  candidates: readonly string[],
  templates: readonly T[],
): T | undefined {
  for (const slug of candidates) {
    const found = templates.find((template) => template.slug === slug);
    if (found) return found;
  }
  return undefined;
}

/** A page's title for people: the raw title, else "(no title)". */
export function pageTitle(page: Pick<StudioPage, 'title'> | undefined): string {
  const title = page?.title.raw ?? page?.title.rendered ?? '';
  return title.trim() || '(no title)';
}

/**
 * Pages in tree order (parents first, children after their parent, each
 * level by menu_order then title), with their depth: the page picker and the
 * Pages panel (#29, pages-model.ts) show them in this order.
 */
export function pageTree<T extends Pick<StudioPage, 'id' | 'parent' | 'menu_order' | 'title'>>(
  pages: readonly T[],
): { page: T; depth: number }[] {
  const ids = new Set<PageRef>(pages.map((page) => page.id));
  const children = new Map<PageRef, T[]>();
  for (const page of pages) {
    // A page whose parent isn't listed (trashed, private) shows at the top level.
    const parent = ids.has(page.parent) ? page.parent : 0;
    children.set(parent, [...(children.get(parent) ?? []), page]);
  }
  const order = (a: T, b: T) =>
    a.menu_order - b.menu_order || pageTitle(a).localeCompare(pageTitle(b));
  const out: { page: T; depth: number }[] = [];
  const visit = (parent: PageRef, depth: number, seen: Set<PageRef>) => {
    for (const page of [...(children.get(parent) ?? [])].sort(order)) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      out.push({ page, depth });
      visit(page.id, depth + 1, seen);
    }
  };
  const seen = new Set<PageRef>();
  visit(0, 0, seen);
  // Pages caught in a parent loop still show, at the top level.
  for (const page of [...pages].sort(order)) {
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    out.push({ page, depth: 0 });
    visit(page.id, 1, seen);
  }
  return out;
}
