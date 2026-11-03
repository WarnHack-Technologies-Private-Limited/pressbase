/**
 * The Pages panel (#29): the site's pages as the draft leaves them, and the
 * changeset entries that add, rename, move, nest and template them, or make
 * one the home page. Pure functions over REST data, tested in
 * pages-model.test.ts. See docs/architecture/studio.md#the-pages-panel.
 *
 * Every change is a `page:{id}` entry with the REST fields WordPress's page
 * attributes use (`title`, `status`, `parent`, `menu_order`, `template`), or
 * `option:show_on_front` and `option:page_on_front` for the home page. A page
 * Studio adds is `page:{slug}` (core creates it on Publish), and a page put
 * under it names it by slug in `parent`.
 */

import { pageKey, parseKey } from './changes-model';
import {
  isNewPage,
  type PageRef,
  pageTree,
  type ReadingSettings,
  type StudioPage,
} from './site-model';

/** The page fields Studio changes through the draft (a changeset page entry). */
export interface PageFields {
  title?: string;
  status?: string;
  parent?: PageRef;
  menu_order?: number;
  template?: string;
  content?: string;
}

/** Fields to set; `undefined` takes a field out of the entry (back to the live value). */
export type FieldChanges = Record<string, unknown>;

type Entries = Readonly<Record<string, { value: unknown }>>;

/** The changeset key for a page, by ID or (for a page the draft adds) slug. */
export const pageRefKey = (ref: PageRef) => pageKey(ref as number);

const fieldsOf = (value: unknown): PageFields =>
  value && typeof value === 'object' ? (value as PageFields) : {};

/** An entry's page reference: its numeric ID, or a new page's slug. */
export function refOfKey(key: string): PageRef | null {
  const { type, id } = parseKey(key);
  if (type !== 'page' || !id) return null;
  return /^\d+$/.test(id) ? Number(id) : id;
}

/**
 * The site's pages as the draft leaves them: live pages with the draft's
 * title, status, parent, order and template, then the pages the draft adds.
 */
export function draftPages(live: readonly StudioPage[], entries: Entries): StudioPage[] {
  const out: StudioPage[] = live.map((page) => {
    const fields = fieldsOf(entries[pageRefKey(page.id)]?.value);
    return {
      ...page,
      ...(fields.title !== undefined ? { title: { raw: fields.title } } : {}),
      ...(fields.status !== undefined ? { status: fields.status } : {}),
      ...(fields.parent !== undefined ? { parent: fields.parent } : {}),
      ...(fields.menu_order !== undefined ? { menu_order: fields.menu_order } : {}),
      ...(fields.template !== undefined ? { template: fields.template } : {}),
    };
  });
  for (const key of Object.keys(entries)) {
    const ref = refOfKey(key);
    if (ref === null || !isNewPage(ref)) continue;
    const fields = fieldsOf(entries[key]?.value);
    out.push({
      id: ref,
      slug: ref,
      title: { raw: fields.title ?? ref },
      status: fields.status ?? 'publish',
      link: '',
      parent: fields.parent ?? 0,
      menu_order: fields.menu_order ?? 0,
      template: fields.template ?? '',
    });
  }
  return out;
}

/** The reading settings as the draft leaves them (a new home page). */
export function draftReading(reading: ReadingSettings, entries: Entries): ReadingSettings {
  const show = entries['option:show_on_front']?.value;
  const front = entries['option:page_on_front']?.value;
  return {
    show_on_front: typeof show === 'string' ? show : reading.show_on_front,
    page_on_front: front !== undefined ? Number(front) || 0 : Number(reading.page_on_front) || 0,
  };
}

/* ------------------------------------------------------------------ slugs */

/** sanitize_title() for a new page's address: "Our team!" → "our-team". */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 190);
}

/**
 * A slug for a page the draft adds, unique among the site's pages: a number
 * is added when it's taken (wp_unique_post_slug()). Slugs of only digits get
 * one too, so the entry key never reads as an ID.
 */
export function newPageSlug(title: string, pages: readonly Pick<StudioPage, 'slug'>[]): string {
  const base = slugify(title) || 'page';
  const taken = new Set(pages.map((page) => page.slug));
  if (!taken.has(base) && !/^\d+$/.test(base)) return base;
  for (let n = 2; ; n++) {
    const slug = `${base}-${n}`;
    if (!taken.has(slug)) return slug;
  }
}

/* ------------------------------------------------------------ arrangement */

/** Where a page goes: under `parent` (0: the top level), at `index` among its siblings. */
export interface Placement {
  parent: PageRef;
  index: number;
}

/** A page's new parent and order. */
export interface Arranged {
  parent: PageRef;
  menu_order: number;
}

type TreePage = Pick<StudioPage, 'id' | 'parent' | 'menu_order' | 'title'>;

/** Each parent's children, in the order the tree shows them. */
function childrenOf<T extends TreePage>(pages: readonly T[]): Map<PageRef, T[]> {
  const tree = pageTree(pages);
  const ids = new Set<PageRef>(pages.map((p) => p.id));
  const out = new Map<PageRef, T[]>();
  for (const { page } of tree) {
    const parent = ids.has(page.parent) ? page.parent : 0;
    out.set(parent, [...(out.get(parent) ?? []), page]);
  }
  return out;
}

/** The parent the tree shows a page under (0 when its parent isn't listed). */
function parentOf(pages: readonly TreePage[], ref: PageRef): PageRef {
  const page = pages.find((p) => p.id === ref);
  if (!page) return 0;
  return pages.some((p) => p.id === page.parent) ? page.parent : 0;
}

/** True when `ref` is `ancestor` or sits somewhere under it. */
export function isWithin(pages: readonly TreePage[], ref: PageRef, ancestor: PageRef): boolean {
  let current: PageRef = ref;
  for (let depth = 0; depth < 100 && current !== 0; depth++) {
    if (current === ancestor) return true;
    current = parentOf(pages, current);
  }
  return false;
}

/**
 * Moves a page: its new place among its new siblings, which are numbered
 * again in order (`menu_order` 0, 1, 2…) so the order holds whatever their
 * old numbers. Returns the pages whose parent or order changes, or null for
 * a move that can't be (under itself or its own child page).
 */
export function movePage<T extends TreePage>(
  pages: readonly T[],
  ref: PageRef,
  to: Placement,
): Map<PageRef, Arranged> | null {
  const page = pages.find((p) => p.id === ref);
  if (!page) return null;
  if (to.parent !== 0 && isWithin(pages, to.parent, ref)) return null;
  if (to.parent !== 0 && !pages.some((p) => p.id === to.parent)) return null;
  const siblings = (childrenOf(pages).get(to.parent) ?? []).filter((p) => p.id !== ref);
  const index = Math.max(0, Math.min(to.index, siblings.length));
  siblings.splice(index, 0, page);
  const out = new Map<PageRef, Arranged>();
  siblings.forEach((sibling, order) => {
    const parent = sibling.id === ref ? to.parent : parentOf(pages, sibling.id);
    if (sibling.menu_order !== order || parentOf(pages, sibling.id) !== parent) {
      out.set(sibling.id, { parent, menu_order: order });
    }
  });
  return out;
}

export type PageMove = 'up' | 'down' | 'in' | 'out';

/**
 * The keyboard moves: up and down among its siblings, in (under the page
 * above it, last) and out (after its parent). Null when the move isn't
 * possible from where the page is.
 */
export function placementFor(
  pages: readonly TreePage[],
  ref: PageRef,
  move: PageMove,
): Placement | null {
  if (!pages.some((p) => p.id === ref)) return null;
  const parent = parentOf(pages, ref);
  const children = childrenOf(pages);
  const siblings = children.get(parent) ?? [];
  const index = siblings.findIndex((p) => p.id === ref);
  switch (move) {
    case 'up':
      return index > 0 ? { parent, index: index - 1 } : null;
    case 'down':
      return index < siblings.length - 1 ? { parent, index: index + 1 } : null;
    case 'in': {
      const above = siblings[index - 1];
      return above ? { parent: above.id, index: (children.get(above.id) ?? []).length } : null;
    }
    case 'out': {
      if (parent === 0) return null;
      const grandparent = parentOf(pages, parent);
      const aunts = (children.get(grandparent) ?? []).filter((p) => p.id !== ref);
      return { parent: grandparent, index: aunts.findIndex((p) => p.id === parent) + 1 };
    }
  }
}

/** Where a drop puts a page: before or after the row it's dropped on, or inside it (last). */
export function dropPlacement(
  pages: readonly TreePage[],
  dragged: PageRef,
  onto: PageRef,
  where: 'before' | 'after' | 'inside',
): Placement | null {
  if (dragged === onto) return null;
  const children = childrenOf(pages);
  if (where === 'inside') {
    const inside = (children.get(onto) ?? []).filter((p) => p.id !== dragged);
    return { parent: onto, index: inside.length };
  }
  const parent = parentOf(pages, onto);
  const siblings = (children.get(parent) ?? []).filter((p) => p.id !== dragged);
  const index = siblings.findIndex((p) => p.id === onto);
  return { parent, index: where === 'before' ? index : index + 1 };
}

/* ---------------------------------------------------------------- entries */

/**
 * The page entry changes for an arrangement: each field differing from the
 * live page is set, one equal to it is taken out of the entry. A page the
 * draft adds always says where it goes.
 */
export function arrangementChanges(
  arranged: ReadonlyMap<PageRef, Arranged>,
  live: readonly StudioPage[],
): Map<string, FieldChanges> {
  const out = new Map<string, FieldChanges>();
  for (const [ref, { parent, menu_order }] of arranged) {
    const before = live.find((p) => p.id === ref);
    out.set(pageRefKey(ref), {
      parent: before && (before.parent || 0) === parent ? undefined : parent,
      menu_order: before && before.menu_order === menu_order ? undefined : menu_order,
    });
  }
  return out;
}

/** One field of one page, set or (when it equals the live page's) taken out of the entry. */
export function fieldChange(
  ref: PageRef,
  field: 'title' | 'template' | 'status',
  value: string,
  live: readonly StudioPage[],
): Map<string, FieldChanges> {
  const before = live.find((p) => p.id === ref);
  const current =
    before === undefined
      ? undefined
      : field === 'title'
        ? (before.title.raw ?? before.title.rendered ?? '')
        : field === 'template'
          ? before.template || ''
          : before.status;
  return new Map([[pageRefKey(ref), { [field]: current === value ? undefined : value }]]);
}

/**
 * The entries that make a page the home page (`show_on_front: page` and
 * `page_on_front`), taken out again where they equal the live settings.
 */
export function homePageEntries(id: number, live: ReadingSettings): Map<string, unknown> {
  return new Map<string, unknown>([
    ['option:show_on_front', live.show_on_front === 'page' ? null : 'page'],
    ['option:page_on_front', Number(live.page_on_front) === id ? null : id],
  ]);
}

/** A new page's entry: its title, published with the draft, placed last at the top level. */
export function newPageEntry(
  title: string,
  pages: readonly StudioPage[],
): { key: string; slug: string; value: PageFields } {
  const slug = newPageSlug(title, pages);
  const top = pages.filter((p) => !p.parent || !pages.some((q) => q.id === p.parent));
  const last = top.reduce((max, p) => Math.max(max, p.menu_order), -1);
  return {
    key: pageRefKey(slug),
    slug,
    value: { title, status: 'publish', parent: 0, menu_order: last + 1 },
  };
}

/**
 * The address a page will have: its parents' slugs and its own under the
 * site's address (get_page_uri()). For a page the draft adds, whose REST
 * `link` doesn't exist yet; a preview finds it there.
 */
export function newPageLink(
  siteUrl: string,
  pages: readonly Pick<StudioPage, 'id' | 'parent' | 'slug'>[],
  ref: PageRef,
): string {
  const slugs: string[] = [];
  let current = pages.find((p) => p.id === ref);
  for (let depth = 0; current && depth < 50; depth++) {
    slugs.unshift(current.slug);
    const parent = current.parent;
    current = parent ? pages.find((p) => p.id === parent) : undefined;
  }
  return `${siteUrl.replace(/\/+$/, '')}/${slugs.join('/')}/`;
}

/** Which pages someone may open: all of them, or (without `edit_others_pages`) their own. */
export function editablePages<T extends StudioPage>(
  pages: readonly T[],
  user: { id: number; editOthers: boolean },
): T[] {
  if (user.editOthers) return [...pages];
  return pages.filter((p) => isNewPage(p.id) || p.author === user.id);
}
