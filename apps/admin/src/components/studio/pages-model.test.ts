import { describe, expect, it } from 'vitest';
import { describeChange, mergeFields } from './changes-model';
import {
  arrangementChanges,
  draftPages,
  draftReading,
  dropPlacement,
  editablePages,
  fieldChange,
  homePageEntries,
  movePage,
  newPageEntry,
  newPageLink,
  newPageSlug,
  placementFor,
  refOfKey,
  slugify,
} from './pages-model';
import { pageTree, type StudioPage } from './site-model';

const page = (
  id: number | string,
  title: string,
  parent: number | string = 0,
  menu_order = 0,
  extra: Partial<StudioPage> = {},
): StudioPage => ({
  id,
  title: { raw: title },
  slug: typeof id === 'string' ? id : title.toLowerCase().replace(/\s+/g, '-'),
  status: 'publish',
  link: `https://example.com/${title.toLowerCase()}/`,
  parent,
  menu_order,
  template: '',
  ...extra,
});

/** About (with Team under it), Contact, Home: all menu_order 0, so they sort by title. */
const site = () => [page(1, 'Home'), page(2, 'About'), page(3, 'Team', 2), page(4, 'Contact')];

const titles = (pages: StudioPage[]) =>
  pageTree(pages).map(({ page: p, depth }) => `${'-'.repeat(depth)}${p.title.raw}`);

/** Applies an arrangement to the pages, as the draft would. */
function apply(pages: StudioPage[], arranged: ReturnType<typeof movePage>): StudioPage[] {
  if (!arranged) throw new Error('No move.');
  return pages.map((p) => ({ ...p, ...(arranged.get(p.id) ?? {}) }));
}

describe('the draft’s pages', () => {
  it('lays the draft’s fields over live pages and adds the pages it creates', () => {
    const pages = draftPages(site(), {
      'page:2': { value: { title: 'About us', menu_order: 5, content: '<p>x</p>' } },
      'page:opening-hours': { value: { title: 'Opening hours', parent: 2, menu_order: 1 } },
      'option:blogname': { value: 'Bakery' },
    });
    expect(pages.find((p) => p.id === 2)).toMatchObject({
      title: { raw: 'About us' },
      menu_order: 5,
    });
    expect(pages.find((p) => p.id === 'opening-hours')).toMatchObject({
      slug: 'opening-hours',
      status: 'publish',
      parent: 2,
      menu_order: 1,
      link: '',
    });
    expect(titles(pages)).toEqual(['Contact', 'Home', 'About us', '-Team', '-Opening hours']);
  });

  it('reads the home page from the draft, else the live settings', () => {
    const live = { show_on_front: 'posts', page_on_front: 0 };
    expect(draftReading(live, {})).toEqual(live);
    expect(
      draftReading(live, {
        'option:show_on_front': { value: 'page' },
        'option:page_on_front': { value: 4 },
      }),
    ).toEqual({ show_on_front: 'page', page_on_front: 4 });
  });

  it('tells page keys apart: IDs, new pages by slug, other entries', () => {
    expect(refOfKey('page:12')).toBe(12);
    expect(refOfKey('page:our-team')).toBe('our-team');
    expect(refOfKey('wp_template_part:header')).toBeNull();
  });
});

describe('new pages', () => {
  it('get an address from their title, unique among the site’s pages', () => {
    expect(slugify('Our Team!')).toBe('our-team');
    expect(slugify('Café & Crème')).toBe('cafe-creme');
    expect(newPageSlug('About', site())).toBe('about-2');
    expect(newPageSlug('Prices', site())).toBe('prices');
    expect(newPageSlug('2026', site())).toBe('2026-2');
    expect(newPageSlug('!!!', site())).toBe('page');
  });

  it('are published with the draft, last among the main pages', () => {
    const pages = [page(1, 'Home', 0, 0), page(2, 'About', 0, 3), page(3, 'Team', 2, 9)];
    expect(newPageEntry('Prices', pages)).toEqual({
      key: 'page:prices',
      slug: 'prices',
      value: { title: 'Prices', status: 'publish', parent: 0, menu_order: 4 },
    });
  });

  it('have an address under their parents before they exist', () => {
    const pages = [...site(), page('hours', 'Hours', 2)];
    expect(newPageLink('https://example.com/', pages, 'hours')).toBe(
      'https://example.com/about/hours/',
    );
  });
});

describe('moving pages', () => {
  it('moves up and down among siblings, numbering them so the order holds', () => {
    let pages = site();
    pages = apply(
      pages,
      movePage(pages, 1, placementFor(pages, 1, 'up') ?? { parent: 0, index: 0 }),
    );
    expect(titles(pages)).toEqual(['About', '-Team', 'Home', 'Contact']);
    const down = placementFor(pages, 2, 'down');
    expect(down).toEqual({ parent: 0, index: 1 });
    pages = apply(pages, movePage(pages, 2, down ?? { parent: 0, index: 0 }));
    expect(titles(pages)).toEqual(['Home', 'About', '-Team', 'Contact']);
    // The first can't go up; the last can't go down.
    expect(placementFor(pages, 1, 'up')).toBeNull();
    expect(placementFor(pages, 4, 'down')).toBeNull();
  });

  it('puts a page under the one above it, and back out after its parent', () => {
    let pages = site(); // About › Team, Contact, Home
    const into = placementFor(pages, 1, 'in');
    expect(into).toEqual({ parent: 4, index: 0 });
    pages = apply(pages, movePage(pages, 1, into ?? { parent: 0, index: 0 }));
    expect(titles(pages)).toEqual(['About', '-Team', 'Contact', '-Home']);
    const out = placementFor(pages, 1, 'out');
    expect(out).toEqual({ parent: 0, index: 2 });
    pages = apply(pages, movePage(pages, 1, out ?? { parent: 0, index: 0 }));
    expect(titles(pages)).toEqual(['About', '-Team', 'Contact', 'Home']);
    // A main page can't move out; the first page has nothing above to go under.
    expect(placementFor(pages, 4, 'out')).toBeNull();
    expect(placementFor(pages, 2, 'in')).toBeNull();
  });

  it('only changes pages whose place changes', () => {
    const pages = [page(1, 'A', 0, 0), page(2, 'B', 0, 1), page(3, 'C', 0, 2)];
    const moved = movePage(pages, 3, { parent: 0, index: 1 });
    expect(moved).toEqual(
      new Map([
        [3, { parent: 0, menu_order: 1 }],
        [2, { parent: 0, menu_order: 2 }],
      ]),
    );
  });

  it('never puts a page under itself or its own child', () => {
    const pages = site();
    expect(movePage(pages, 2, { parent: 3, index: 0 })).toBeNull();
    expect(movePage(pages, 2, { parent: 2, index: 0 })).toBeNull();
    expect(movePage(pages, 2, { parent: 99, index: 0 })).toBeNull();
  });

  it('drops a page before, after or onto another', () => {
    const pages = site(); // About › Team, Contact, Home
    expect(dropPlacement(pages, 4, 2, 'after')).toEqual({ parent: 0, index: 1 });
    expect(dropPlacement(pages, 1, 2, 'before')).toEqual({ parent: 0, index: 0 });
    expect(dropPlacement(pages, 1, 2, 'inside')).toEqual({ parent: 2, index: 1 });
    expect(dropPlacement(pages, 1, 3, 'before')).toEqual({ parent: 2, index: 0 });
    expect(dropPlacement(pages, 1, 1, 'inside')).toBeNull();
    const moved = apply(
      pages,
      movePage(pages, 4, dropPlacement(pages, 4, 3, 'inside') ?? { parent: 0, index: 0 }),
    );
    expect(titles(moved)).toEqual(['About', '-Team', '--Contact', 'Home']);
  });

  it('nests a page under a page the draft adds, naming it by slug', () => {
    const pages = [...site(), page('visit', 'Visit', 0, 5)];
    const moved = movePage(pages, 4, { parent: 'visit', index: 0 });
    expect(arrangementChanges(moved ?? new Map(), site())).toEqual(
      new Map([['page:4', { parent: 'visit', menu_order: undefined }]]),
    );
  });
});

describe('page entries', () => {
  it('keep only fields that differ from the live page', () => {
    const live = site();
    const changes = arrangementChanges(
      new Map([
        [1, { parent: 0, menu_order: 1 }],
        [3, { parent: 0, menu_order: 0 }],
        ['new-page', { parent: 2, menu_order: 1 }],
      ]),
      live,
    );
    expect(changes.get('page:1')).toEqual({ parent: undefined, menu_order: 1 });
    expect(changes.get('page:3')).toEqual({ parent: 0, menu_order: undefined });
    expect(changes.get('page:new-page')).toEqual({ parent: 2, menu_order: 1 });
    expect(fieldChange(2, 'title', 'About', live).get('page:2')).toEqual({ title: undefined });
    expect(fieldChange(2, 'template', 'page-no-title', live).get('page:2')).toEqual({
      template: 'page-no-title',
    });
  });

  it('merge into what the entry holds: the canvas’s content and the panel’s fields share it', () => {
    const withContent = mergeFields(null, { content: '<p>Hi</p>' });
    const moved = mergeFields(withContent, { parent: 2, menu_order: undefined });
    expect(moved).toEqual({ content: '<p>Hi</p>', parent: 2 });
    expect(mergeFields(moved, { content: undefined })).toEqual({ parent: 2 });
    expect(mergeFields({ parent: 2 }, { parent: undefined })).toBeNull();
  });

  it('set the home page, or nothing when it already is', () => {
    expect(homePageEntries(4, { show_on_front: 'posts', page_on_front: 0 })).toEqual(
      new Map<string, unknown>([
        ['option:show_on_front', 'page'],
        ['option:page_on_front', 4],
      ]),
    );
    expect(homePageEntries(4, { show_on_front: 'page', page_on_front: 4 })).toEqual(
      new Map([
        ['option:show_on_front', null],
        ['option:page_on_front', null],
      ]),
    );
  });

  it('are listed under Publish by title, a new one as a new page', () => {
    const __ = (text: string) => text;
    const names = { page: () => undefined, part: () => undefined };
    expect(describeChange('page:prices', { value: { title: 'Prices' } }, names, __)).toEqual({
      title: 'Prices',
      detail: 'New page',
    });
    expect(describeChange('page:2', { value: {} }, { ...names, page: () => 'About' }, __)).toEqual({
      title: 'About',
      detail: 'Page',
    });
  });
});

describe('who opens which pages', () => {
  it('shows people without edit_others_pages only their own pages, and new ones', () => {
    const pages = [
      page(1, 'Mine', 0, 0, { author: 5 }),
      page(2, 'Theirs', 0, 0, { author: 1 }),
      page('new', 'New'),
    ];
    expect(editablePages(pages, { id: 5, editOthers: false }).map((p) => p.id)).toEqual([1, 'new']);
    expect(editablePages(pages, { id: 5, editOthers: true })).toHaveLength(3);
  });
});
