import { describe, expect, it } from 'vitest';
import {
  appendItems,
  canDrop,
  canMove,
  customLink,
  decodeEntities,
  dropItem,
  findPosition,
  flatten,
  itemFromSearchResult,
  itemsFromPages,
  MAX_DEPTH,
  type MenuItem,
  moveItem,
  normalizeUrl,
  parseBlockMarkup,
  parseMenu,
  removeItem,
  serializeAttributes,
  serializeMenu,
  updateItem,
} from './menus';

/** The shape of a tree, by label: "A[B,C]". */
const shape = (items: readonly MenuItem[]): string =>
  items.map((i) => (i.children.length ? `${i.label}[${shape(i.children)}]` : i.label)).join(',');

const keyOf = (items: readonly MenuItem[], label: string): string => {
  const found = flatten(items).find((f) => f.item.label === label);
  if (!found) throw new Error(`No item "${label}"`);
  return found.item.key;
};

const menu = (...labels: (string | [string, MenuItem[]])[]): MenuItem[] =>
  labels.map((l) => {
    const [label, children] = typeof l === 'string' ? [l, []] : l;
    return { ...customLink(label, `/${label.toLowerCase()}/`), children };
  });

const SAVED = `<!-- wp:navigation-link {"label":"Home page","type":"page","id":2,"url":"http://localhost/","kind":"post-type","isTopLevelLink":true} /-->
<!-- wp:navigation-submenu {"label":"About","type":"page","id":3,"url":"http://localhost/about/","kind":"post-type","isTopLevelItem":true} -->
<!-- wp:navigation-link {"label":"Team","type":"page","rel":"author","id":4,"url":"http://localhost/about/team/","kind":"post-type"} /-->
<!-- wp:navigation-link {"label":"News","type":"category","id":5,"url":"http://localhost/category/news/","kind":"taxonomy"} /-->
<!-- /wp:navigation-submenu -->
<!-- wp:home-link {"label":"Start"} /-->
<!-- wp:page-list /-->
<!-- wp:search {"label":"Search","buttonText":"Go"} /-->
<!-- wp:navigation-link {"label":"Docs \\u0026 more","description":"Read \\u003cem\\u003ethis\\u003c/em\\u003e","opensInNewTab":true,"url":"https://example.com/docs","kind":"custom","isTopLevelLink":true} /-->`;

describe('parseMenu', () => {
  it('reads links, submenus, the home link, the page list and other blocks', () => {
    const items = parseMenu(SAVED);
    expect(shape(items)).toBe('Home page,About[Team,News],Start,Page list,Search,Docs & more');
    const [home, about, start, pageList, search, docs] = items as MenuItem[];
    expect(home).toMatchObject({ kind: 'post-type', type: 'page', id: 2 });
    expect(about?.children[1]).toMatchObject({ kind: 'taxonomy', type: 'category', id: 5 });
    expect(start).toMatchObject({ kind: 'home', label: 'Start' });
    expect(pageList?.kind).toBe('page-list');
    expect(search).toMatchObject({ kind: 'block', label: 'Search' });
    expect(docs).toMatchObject({
      kind: 'custom',
      opensInNewTab: true,
      description: 'Read <em>this</em>',
    });
  });

  it('survives broken markup', () => {
    expect(parseMenu('')).toEqual([]);
    expect(shape(parseMenu('<!-- wp:navigation-link {"label":"A" /-->'))).toBe('');
    expect(shape(parseMenu('<!-- wp:navigation-submenu {"label":"A"} -->'))).toBe('A');
    expect(parseBlockMarkup('<!-- wp:my-plugin/thing {"a":1} /-->')[0]).toMatchObject({
      name: 'my-plugin/thing',
      attrs: { a: 1 },
    });
  });
});

describe('serializeMenu', () => {
  it('round-trips saved menus, keeping attributes it doesn’t edit', () => {
    const once = serializeMenu(parseMenu(SAVED));
    expect(once).toBe(SAVED);
    expect(serializeMenu(parseMenu(once))).toBe(once);
    // The search block is kept exactly as it was.
    expect(once).toContain('<!-- wp:search {"label":"Search","buttonText":"Go"} /-->');
    // rel survives.
    expect(once).toContain('"rel":"author"');
  });

  it('turns links with children into submenus and back', () => {
    let items = menu('A', 'B');
    items = moveItem(items, keyOf(items, 'B'), 'in');
    const markup = serializeMenu(items);
    expect(markup).toMatch(
      /^<!-- wp:navigation-submenu \{"label":"A".*"isTopLevelItem":true\} -->\n<!-- wp:navigation-link \{"label":"B","url":"\/b\/","kind":"custom"\} \/-->\n<!-- \/wp:navigation-submenu -->$/,
    );
    items = moveItem(items, keyOf(items, 'B'), 'out');
    expect(serializeMenu(items)).not.toContain('navigation-submenu');
  });

  it('escapes attribute JSON so labels can’t close the comment', () => {
    const hostile = customLink('--> <script>alert(1)</script> & "x"', 'javascript:alert(1)');
    const markup = serializeMenu([hostile]);
    expect(markup).not.toMatch(/-->.*-->/s);
    expect(markup).not.toContain('<script>');
    expect(parseMenu(markup)[0]?.label).toBe(hostile.label);
    expect(serializeAttributes({ a: 'x--y' })).toBe('{"a":"x\\u002d\\u002dy"}');
  });

  it('drops type and id from custom links', () => {
    const item = { ...customLink('X', '/x/'), type: 'page', id: 9 };
    expect(serializeMenu([item])).toBe(
      '<!-- wp:navigation-link {"label":"X","url":"/x/","kind":"custom","isTopLevelLink":true} /-->',
    );
  });
});

describe('moveItem (keyboard)', () => {
  it('moves up and down among siblings', () => {
    let items = menu('A', 'B', 'C');
    items = moveItem(items, keyOf(items, 'C'), 'up');
    expect(shape(items)).toBe('A,C,B');
    items = moveItem(items, keyOf(items, 'A'), 'down');
    expect(shape(items)).toBe('C,A,B');
    expect(canMove(items, keyOf(items, 'C'), 'up')).toBe(false);
    expect(moveItem(items, keyOf(items, 'C'), 'up')).toBe(items);
    expect(canMove(items, keyOf(items, 'B'), 'down')).toBe(false);
  });

  it('indents under the previous item and outdents after the parent', () => {
    let items = menu('A', 'B', 'C', 'D');
    items = moveItem(items, keyOf(items, 'B'), 'in');
    items = moveItem(items, keyOf(items, 'C'), 'in');
    expect(shape(items)).toBe('A[B,C],D');
    // C goes under B (the previous sibling inside A).
    items = moveItem(items, keyOf(items, 'C'), 'in');
    expect(shape(items)).toBe('A[B[C]],D');
    items = moveItem(items, keyOf(items, 'C'), 'out');
    expect(shape(items)).toBe('A[B,C],D');
    // Outdenting B puts it right after A; C stays in A.
    items = moveItem(items, keyOf(items, 'B'), 'out');
    expect(shape(items)).toBe('A[C],B,D');
    expect(canMove(items, keyOf(items, 'A'), 'out')).toBe(false);
    expect(canMove(items, keyOf(items, 'A'), 'in')).toBe(false);
  });

  it('only nests under links, and no deeper than five levels', () => {
    let items = [...parseMenu('<!-- wp:page-list /-->'), ...menu('A')];
    expect(canMove(items, keyOf(items, 'A'), 'in')).toBe(false);
    items = menu('L1', 'L2', 'L3', 'L4', 'L5', 'L6');
    for (const label of ['L2', 'L3', 'L4', 'L5']) {
      // Each one goes under the previous, as deep as it can.
      while (canMove(items, keyOf(items, label), 'in')) {
        items = moveItem(items, keyOf(items, label), 'in');
      }
    }
    expect(shape(items)).toBe('L1[L2[L3[L4[L5]]]],L6');
    expect(findPosition(items, keyOf(items, 'L5'))?.depth).toBe(MAX_DEPTH - 1);
    // L6 can go as deep as L5, beside it, but not under it.
    while (canMove(items, keyOf(items, 'L6'), 'in')) {
      items = moveItem(items, keyOf(items, 'L6'), 'in');
    }
    expect(shape(items)).toBe('L1[L2[L3[L4[L5,L6]]]]');
    expect(canMove(items, keyOf(items, 'L6'), 'in')).toBe(false);
  });
});

describe('dropItem (drag and drop)', () => {
  it('drops before, after and inside', () => {
    let items = menu('A', 'B', ['C', menu('D')]);
    items = dropItem(items, keyOf(items, 'A'), keyOf(items, 'D'), 'after');
    expect(shape(items)).toBe('B,C[D,A]');
    items = dropItem(items, keyOf(items, 'D'), keyOf(items, 'B'), 'before');
    expect(shape(items)).toBe('D,B,C[A]');
    items = dropItem(items, keyOf(items, 'C'), keyOf(items, 'B'), 'inside');
    expect(shape(items)).toBe('D,B[C[A]]');
  });

  it('refuses drops into the item itself or its submenu', () => {
    const items = menu(['A', menu('B')]);
    expect(canDrop(items, keyOf(items, 'A'), keyOf(items, 'B'), 'inside')).toBe(false);
    expect(canDrop(items, keyOf(items, 'A'), keyOf(items, 'A'), 'after')).toBe(false);
    expect(dropItem(items, keyOf(items, 'A'), keyOf(items, 'B'), 'after')).toBe(items);
  });
});

describe('editing', () => {
  it('adds, updates and removes items', () => {
    let items = menu('A');
    items = appendItems(items, menu('B'));
    items = appendItems(items, menu('C'), keyOf(items, 'A'));
    expect(shape(items)).toBe('A[C],B');
    items = updateItem(items, keyOf(items, 'C'), { label: 'See', opensInNewTab: true });
    expect(flatten(items)[1]?.item).toMatchObject({ label: 'See', opensInNewTab: true });
    items = removeItem(items, keyOf(items, 'A'));
    expect(shape(items)).toBe('B');
  });

  it('makes items from search results', () => {
    expect(
      itemFromSearchResult({
        id: 7,
        title: 'Tom &amp; Jerry&#8217;s',
        url: 'http://x/t/',
        type: 'term',
        subtype: 'post_tag',
      }),
    ).toMatchObject({ kind: 'taxonomy', type: 'tag', id: 7, label: 'Tom & Jerry’s' });
    expect(decodeEntities('<b>Hi</b> &lt;3')).toBe('Hi <3');
  });

  it('turns pages into nested links', () => {
    const items = itemsFromPages([
      { id: 1, title: 'About', link: '/about/', parent: 0 },
      { id: 2, title: 'Team', link: '/about/team/', parent: 1 },
      { id: 3, title: 'Orphan', link: '/orphan/', parent: 99 },
    ]);
    expect(shape(items)).toBe('About[Team],Orphan');
    expect(items[0]).toMatchObject({ kind: 'post-type', type: 'page', id: 1, url: '/about/' });
  });

  it('accepts web, mail and relative URLs only', () => {
    expect(normalizeUrl('example.com/about')).toBe('https://example.com/about');
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeUrl('/shop/')).toBe('/shop/');
    expect(normalizeUrl('#top')).toBe('#top');
    expect(normalizeUrl('mailto:hi@example.com')).toBe('mailto:hi@example.com');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl(' JaVaScRiPt:alert(1)')).toBeNull();
    expect(normalizeUrl('data:text/html,x')).toBeNull();
    expect(normalizeUrl('//evil.example')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });
});
