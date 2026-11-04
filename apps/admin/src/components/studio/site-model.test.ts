import { describe, expect, it } from 'vitest';
import {
  initialTarget,
  isHome,
  pageTitle,
  pageTree,
  pickTemplate,
  type StudioPage,
  templateCandidates,
} from './site-model';

const page = (id: number, extra: Partial<StudioPage> = {}): StudioPage => ({
  id,
  title: { raw: `Page ${id}` },
  slug: `page-${id}`,
  status: 'publish',
  link: `/page-${id}/`,
  parent: 0,
  menu_order: 0,
  template: '',
  ...extra,
});

const posts = { show_on_front: 'posts', page_on_front: 0 };
const staticFront = { show_on_front: 'page', page_on_front: 7 };

describe('initialTarget', () => {
  const pages = [page(7), page(9)];

  it('opens the page asked for', () => {
    expect(initialTarget(9, staticFront, pages)).toEqual({ kind: 'page', id: 9 });
  });

  it('opens the home page otherwise: the static front page or the latest posts', () => {
    expect(initialTarget(undefined, staticFront, pages)).toEqual({ kind: 'page', id: 7 });
    expect(initialTarget(undefined, posts, pages)).toEqual({ kind: 'posts' });
    // An unknown page, or a front page that's gone, falls back.
    expect(initialTarget(404, posts, pages)).toEqual({ kind: 'posts' });
    expect(initialTarget(undefined, { show_on_front: 'page', page_on_front: 3 }, pages)).toEqual({
      kind: 'posts',
    });
  });

  it('knows which target is the home page', () => {
    expect(isHome({ kind: 'page', id: 7 }, staticFront)).toBe(true);
    expect(isHome({ kind: 'page', id: 9 }, staticFront)).toBe(false);
    expect(isHome({ kind: 'posts' }, posts)).toBe(true);
    expect(isHome({ kind: 'posts' }, staticFront)).toBe(false);
  });
});

describe('templateCandidates', () => {
  it('follows the hierarchy for a page', () => {
    expect(templateCandidates({ kind: 'page', id: 9 }, staticFront, page(9))).toEqual([
      'page-page-9',
      'page-9',
      'page',
      'singular',
      'index',
    ]);
  });

  it('puts the chosen template first, and front-page before it for the home page', () => {
    const home = page(7, { slug: 'home', template: 'page-no-title' });
    expect(templateCandidates({ kind: 'page', id: 7 }, staticFront, home)).toEqual([
      'front-page',
      'page-no-title',
      'page-home',
      'page-7',
      'page',
      'singular',
      'index',
    ]);
    // `default` means no custom template.
    expect(
      templateCandidates({ kind: 'page', id: 9 }, staticFront, page(9, { template: 'default' }))[0],
    ).toBe('page-page-9');
  });

  it('tries non-ASCII slugs encoded first, as WordPress does', () => {
    const cafe = page(9, { slug: 'café' });
    expect(templateCandidates({ kind: 'page', id: 9 }, posts, cafe).slice(0, 2)).toEqual([
      'page-caf%c3%a9',
      'page-café',
    ]);
  });

  it('uses front-page, home and index for the latest posts', () => {
    expect(templateCandidates({ kind: 'posts' }, posts)).toEqual(['front-page', 'home', 'index']);
  });

  it('picks the first template the theme has', () => {
    const templates = [{ slug: 'index' }, { slug: 'page' }, { slug: 'home' }];
    expect(pickTemplate(['page-about', 'page-9', 'page', 'index'], templates)?.slug).toBe('page');
    expect(pickTemplate(['front-page', 'home', 'index'], templates)?.slug).toBe('home');
    expect(pickTemplate(['nothing'], templates)).toBeUndefined();
  });
});

describe('pages', () => {
  it('orders the tree parents first, by menu order then title', () => {
    const tree = pageTree([
      page(1, { title: { raw: 'Menu' }, menu_order: 2 }),
      page(2, { title: { raw: 'Breakfast' }, parent: 1 }),
      page(3, { title: { raw: 'About' }, menu_order: 2 }),
      page(4, { title: { raw: 'Home' }, menu_order: 0 }),
      page(5, { title: { raw: 'Orphan' }, parent: 99 }),
    ]);
    expect(tree.map(({ page: p, depth }) => `${depth}:${pageTitle(p)}`)).toEqual([
      '0:Home',
      '0:Orphan',
      '0:About',
      '0:Menu',
      '1:Breakfast',
    ]);
  });

  it('survives a loop in the parents', () => {
    const tree = pageTree([page(1, { parent: 2 }), page(2, { parent: 1 })]);
    expect(tree.map(({ page: p, depth }) => [p.id, depth])).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it('names untitled pages', () => {
    expect(pageTitle(page(1, { title: { raw: '  ' } }))).toBe('(no title)');
  });
});
