/**
 * Navigation menus in the admin (Appearance → Menus): a `wp_navigation`
 * post's block markup as an editable tree of items, the tree operations the
 * editor offers (drag and drop, and their keyboard equivalents: move up,
 * down, in and out), and serialising the tree back to the markup the block
 * editor would save.
 *
 * Pure functions on immutable data, so they are easy to test
 * (menus.test.ts). No React, no fetch.
 */

/* ------------------------------------------------------------------ types */

export type MenuItemKind = 'post-type' | 'taxonomy' | 'custom' | 'home' | 'page-list' | 'block';

export interface MenuItem {
  /** Stable key for React and the tree operations; not saved. */
  key: string;
  kind: MenuItemKind;
  /** `page`, `post`, `category`, `tag`, `custom`… (the block's `type` attribute). */
  type?: string;
  /** The linked post or term. */
  id?: number;
  label: string;
  url: string;
  opensInNewTab: boolean;
  description: string;
  /**
   * Every attribute of the original block, so attributes the menu editor
   * doesn't show (rel, title, styles, metadata…) survive a save.
   */
  attrs: Record<string, unknown>;
  /** `kind: 'block'` only: the original markup, saved back unchanged. */
  raw?: string;
  children: MenuItem[];
}

/** Gutenberg's navigation block allows five levels (maxNestingLevel). */
export const MAX_DEPTH = 5;

/* ------------------------------------------------------------------ parse */

interface RawBlock {
  name: string;
  attrs: Record<string, unknown>;
  inner: RawBlock[];
  /** The block's source, delimiters included. */
  source: string;
}

/**
 * The block comment grammar of WordPress's default parser
 * (packages/block-serialization-default-parser): `<!-- wp:name {json} /-->`,
 * `<!-- wp:name {json} -->` … `<!-- /wp:name -->`. HTML between blocks is
 * dropped: a menu is only blocks.
 */
const TOKEN =
  /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)\s+({(?:(?=([^}]+|}+(?=})|(?!}\s+\/?-->)[\s\S])*)\5|[\s\S]*?)}\s+)?(\/)?-->/g;

export function parseBlockMarkup(markup: string): RawBlock[] {
  const root: RawBlock[] = [];
  const stack: { block: RawBlock; start: number }[] = [];
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(markup); match; match = TOKEN.exec(markup)) {
    const [whole, closer, namespace = 'core/', name, json, , voidMark] = match;
    const blockName = `${namespace}${name}`;
    const start = match.index;
    const end = start + whole.length;
    if (closer) {
      const open = stack.pop();
      if (!open) continue;
      open.block.source = markup.slice(open.start, end);
      (stack.at(-1)?.block.inner ?? root).push(open.block);
      continue;
    }
    let attrs: Record<string, unknown> = {};
    if (json) {
      try {
        const parsed = JSON.parse(json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) attrs = parsed;
      } catch {
        attrs = {};
      }
    }
    const block: RawBlock = { name: blockName, attrs, inner: [], source: whole };
    if (voidMark) (stack.at(-1)?.block.inner ?? root).push(block);
    else stack.push({ block, start });
  }
  // Unclosed blocks: keep what we have.
  while (stack.length) {
    const open = stack.pop() as { block: RawBlock; start: number };
    open.block.source = markup.slice(open.start);
    (stack.at(-1)?.block.inner ?? root).push(open.block);
  }
  return root;
}

let keyCounter = 0;
/** A unique key for a new item. */
export function newKey(): string {
  keyCounter += 1;
  return `item-${keyCounter}`;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

function toItem(block: RawBlock): MenuItem {
  const { attrs } = block;
  const base = {
    key: newKey(),
    label: str(attrs.label),
    url: str(attrs.url),
    opensInNewTab: attrs.opensInNewTab === true,
    description: str(attrs.description),
    attrs,
    children: [] as MenuItem[],
  };
  switch (block.name) {
    case 'core/navigation-link':
    case 'core/navigation-submenu': {
      const kind = attrs.kind === 'taxonomy' || attrs.kind === 'post-type' ? attrs.kind : 'custom';
      const id = Number(attrs.id);
      return {
        ...base,
        kind,
        type: str(attrs.type) || (kind === 'custom' ? 'custom' : undefined),
        id: Number.isInteger(id) && id > 0 ? id : undefined,
        children: block.inner.map(toItem),
      };
    }
    case 'core/home-link':
      return { ...base, kind: 'home', label: str(attrs.label) || 'Home' };
    case 'core/page-list':
      return { ...base, kind: 'page-list', label: 'Page list' };
    default:
      return { ...base, kind: 'block', label: blockTitle(block.name), raw: block.source };
  }
}

/** A readable name for a block the menu editor only keeps ("Search", "Social icons"). */
export function blockTitle(name: string): string {
  const known: Record<string, string> = {
    'core/search': 'Search',
    'core/social-links': 'Social icons',
    'core/site-title': 'Site title',
    'core/site-logo': 'Site logo',
    'core/spacer': 'Spacer',
    'core/buttons': 'Buttons',
    'core/loginout': 'Login/out',
  };
  if (known[name]) return known[name] as string;
  const short = name.replace(/^core\//, '').replace(/[-_]/g, ' ');
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** A `wp_navigation` post's content as menu items. */
export function parseMenu(markup: string): MenuItem[] {
  return parseBlockMarkup(markup).map(toItem);
}

/* -------------------------------------------------------------- serialise */

/**
 * serializeAttributes() from @wordpress/blocks: JSON with `--`, `<`, `>`,
 * `&` and escaped quotes as unicode escapes, so it can't end the comment.
 */
export function serializeAttributes(attrs: Record<string, unknown>): string {
  return JSON.stringify(attrs)
    .replace(/--/g, '\\u002d\\u002d')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\\"/g, '\\u0022');
}

function comment(name: string, attrs: Record<string, unknown>, inner?: string): string {
  const short = name.replace(/^core\//, '');
  const json = Object.keys(attrs).length ? `${serializeAttributes(attrs)} ` : '';
  if (inner === undefined) return `<!-- wp:${short} ${json}/-->`;
  return `<!-- wp:${short} ${json}-->\n${inner}\n<!-- /wp:${short} -->`;
}

/** Drops empty values, so the markup stays as small as the editor's. */
function compact(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attrs).filter(([, v]) => v !== undefined && v !== '' && v !== false),
  );
}

/** The attributes in block.json order, then anything else the block had. */
function linkAttributes(item: MenuItem, topLevelKey: string, topLevel: boolean) {
  const {
    label: _l,
    type: _t,
    description: _d,
    id: _i,
    opensInNewTab: _o,
    url: _u,
    kind: _k,
    isTopLevelLink: _a,
    isTopLevelItem: _b,
    ...rest
  } = item.attrs;
  return compact({
    label: item.label,
    type: item.kind === 'custom' ? undefined : item.type,
    description: item.description,
    rel: rest.rel,
    id: item.kind === 'custom' ? undefined : item.id,
    opensInNewTab: item.opensInNewTab,
    url: item.url,
    title: rest.title,
    kind: item.kind,
    ...rest,
    [topLevelKey]: topLevel || undefined,
  });
}

function serializeItem(item: MenuItem, depth: number): string {
  switch (item.kind) {
    case 'block':
      return item.raw ?? '';
    case 'page-list':
      return comment('core/page-list', item.attrs);
    case 'home': {
      const { label: _l, description: _d, opensInNewTab: _o, ...rest } = item.attrs;
      return comment(
        'core/home-link',
        compact({
          label: item.label,
          description: item.description,
          opensInNewTab: item.opensInNewTab,
          ...rest,
        }),
      );
    }
    default: {
      // An item with children is a submenu; without, a link (as the editor
      // converts them).
      if (item.children.length) {
        const inner = item.children.map((c) => serializeItem(c, depth + 1)).join('\n');
        return comment(
          'core/navigation-submenu',
          linkAttributes(item, 'isTopLevelItem', depth === 0),
          inner,
        );
      }
      return comment('core/navigation-link', linkAttributes(item, 'isTopLevelLink', depth === 0));
    }
  }
}

/** Menu items as `wp_navigation` post content. */
export function serializeMenu(items: readonly MenuItem[]): string {
  return items.map((item) => serializeItem(item, 0)).join('\n');
}

/* ----------------------------------------------------------- tree helpers */

/** Where an item is: its parent's key (null at the top) and its index. */
export interface Position {
  parent: string | null;
  index: number;
  depth: number;
  siblings: readonly MenuItem[];
}

export function findPosition(
  items: readonly MenuItem[],
  key: string,
  parent: string | null = null,
  depth = 0,
): Position | null {
  for (const [index, item] of items.entries()) {
    if (item.key === key) return { parent, index, depth, siblings: items };
    const found = findPosition(item.children, key, item.key, depth + 1);
    if (found) return found;
  }
  return null;
}

export function findItem(items: readonly MenuItem[], key: string): MenuItem | null {
  for (const item of items) {
    if (item.key === key) return item;
    const found = findItem(item.children, key);
    if (found) return found;
  }
  return null;
}

/** Items in reading order, with their depth (for the outline and announcements). */
export function flatten(
  items: readonly MenuItem[],
  depth = 0,
): { item: MenuItem; depth: number }[] {
  return items.flatMap((item) => [{ item, depth }, ...flatten(item.children, depth + 1)]);
}

/** How many levels an item's subtree spans (1 for a leaf). */
export function subtreeDepth(item: MenuItem): number {
  return 1 + Math.max(0, ...item.children.map(subtreeDepth));
}

/** Only links can hold a submenu: not the home link, the page list or other blocks. */
export function canHaveChildren(item: MenuItem): boolean {
  return item.kind === 'post-type' || item.kind === 'taxonomy' || item.kind === 'custom';
}

/** Replaces the list a parent holds (null: the top level). */
function withChildren(
  items: readonly MenuItem[],
  parent: string | null,
  update: (children: readonly MenuItem[]) => MenuItem[],
): MenuItem[] {
  if (parent === null) return update(items);
  return items.map((item) =>
    item.key === parent
      ? { ...item, children: update(item.children) }
      : { ...item, children: withChildren(item.children, parent, update) },
  );
}

/** Removes an item (and its submenu). */
export function removeItem(items: readonly MenuItem[], key: string): MenuItem[] {
  return items
    .filter((item) => item.key !== key)
    .map((item) => ({ ...item, children: removeItem(item.children, key) }));
}

/** Changes an item's fields. */
export function updateItem(
  items: readonly MenuItem[],
  key: string,
  changes: Partial<Omit<MenuItem, 'key' | 'children'>>,
): MenuItem[] {
  return items.map((item) =>
    item.key === key
      ? { ...item, ...changes }
      : { ...item, children: updateItem(item.children, key, changes) },
  );
}

/** Adds items at the end of the menu, or of a parent's submenu. */
export function appendItems(
  items: readonly MenuItem[],
  added: readonly MenuItem[],
  parent: string | null = null,
): MenuItem[] {
  return withChildren(items, parent, (children) => [...children, ...added]);
}

export type Move = 'up' | 'down' | 'in' | 'out';

/** Whether a keyboard move is possible (to disable its button). */
export function canMove(items: readonly MenuItem[], key: string, move: Move): boolean {
  const pos = findPosition(items, key);
  if (!pos) return false;
  const item = pos.siblings[pos.index] as MenuItem;
  switch (move) {
    case 'up':
      return pos.index > 0;
    case 'down':
      return pos.index < pos.siblings.length - 1;
    case 'in': {
      const previous = pos.siblings[pos.index - 1];
      return (
        Boolean(previous && canHaveChildren(previous)) &&
        pos.depth + 1 + subtreeDepth(item) <= MAX_DEPTH
      );
    }
    case 'out':
      return pos.parent !== null;
  }
}

/**
 * The keyboard alternatives to dragging, as WordPress's classic menu screen
 * offers them ("Move up one", "Under {previous}", "Out from under {parent}"):
 *
 * - up / down: swap with the previous / next sibling;
 * - in: become the last item of the previous sibling's submenu;
 * - out: leave the submenu, right after its parent. Later siblings stay where
 *   they are.
 *
 * Returns the same array when the move isn't possible.
 */
export function moveItem(items: MenuItem[], key: string, move: Move): MenuItem[] {
  if (!canMove(items, key, move)) return items;
  const pos = findPosition(items, key) as Position;
  const item = pos.siblings[pos.index] as MenuItem;
  switch (move) {
    case 'up':
    case 'down': {
      const target = move === 'up' ? pos.index - 1 : pos.index + 1;
      return withChildren(items, pos.parent, (children) => {
        const next = [...children];
        next[pos.index] = children[target] as MenuItem;
        next[target] = item;
        return next;
      });
    }
    case 'in': {
      const previous = pos.siblings[pos.index - 1] as MenuItem;
      const without = removeItem(items, key);
      return withChildren(without, previous.key, (children) => [...children, item]);
    }
    case 'out': {
      const parent = findPosition(items, pos.parent as string) as Position;
      const without = removeItem(items, key);
      return withChildren(without, parent.parent, (children) => {
        const next = [...children];
        next.splice(parent.index + 1, 0, item);
        return next;
      });
    }
  }
}

export type DropPosition = 'before' | 'after' | 'inside';

/** Whether `key` can be dropped there: not into itself, nor too deep, nor into a non-link. */
export function canDrop(
  items: readonly MenuItem[],
  key: string,
  target: string,
  position: DropPosition,
): boolean {
  if (key === target) return false;
  const item = findItem(items, key);
  const over = findPosition(items, target);
  if (!item || !over) return false;
  // Not inside its own submenu.
  if (findItem(item.children, target)) return false;
  const targetItem = over.siblings[over.index] as MenuItem;
  if (position === 'inside' && !canHaveChildren(targetItem)) return false;
  const depth = position === 'inside' ? over.depth + 1 : over.depth;
  return depth + subtreeDepth(item) <= MAX_DEPTH;
}

/** Drag and drop: moves `key` before, after or inside (at the end of) `target`. */
export function dropItem(
  items: MenuItem[],
  key: string,
  target: string,
  position: DropPosition,
): MenuItem[] {
  if (!canDrop(items, key, target, position)) return items;
  const item = findItem(items, key) as MenuItem;
  const without = removeItem(items, key);
  if (position === 'inside') {
    return withChildren(without, target, (children) => [...children, item]);
  }
  const over = findPosition(without, target) as Position;
  return withChildren(without, over.parent, (children) => {
    const next = [...children];
    next.splice(position === 'before' ? over.index : over.index + 1, 0, item);
    return next;
  });
}

/* --------------------------------------------------------------- creating */

/** A result of /wp/v2/search (WP_REST_Search_Controller). */
export interface SearchResult {
  id: number;
  title: string;
  url: string;
  type: 'post' | 'term' | 'post-format';
  subtype: string;
}

/** A menu item linking to a search result, as the link control creates them. */
export function itemFromSearchResult(result: SearchResult): MenuItem {
  const kind = result.type === 'term' ? 'taxonomy' : 'post-type';
  const type = result.subtype === 'post_tag' ? 'tag' : result.subtype;
  return {
    key: newKey(),
    kind,
    type,
    id: result.id,
    label: decodeEntities(result.title) || '(no title)',
    url: result.url,
    opensInNewTab: false,
    description: '',
    attrs: {},
    children: [],
  };
}

export function customLink(label: string, url: string): MenuItem {
  return {
    key: newKey(),
    kind: 'custom',
    type: 'custom',
    label,
    url,
    opensInNewTab: false,
    description: '',
    attrs: {},
    children: [],
  };
}

export function homeLink(): MenuItem {
  return {
    key: newKey(),
    kind: 'home',
    label: 'Home',
    url: '',
    opensInNewTab: false,
    description: '',
    attrs: {},
    children: [],
  };
}

/** A published page, enough to link to it. */
export interface PageLink {
  id: number;
  title: string;
  link: string;
  parent: number;
}

/**
 * Links to pages, nested as the pages are (what the editor's "Edit" on a Page
 * List block does: convert it to links). Children whose parent isn't in the
 * list go to the top level. Nesting stops at MAX_DEPTH.
 */
export function itemsFromPages(pages: readonly PageLink[]): MenuItem[] {
  const ids = new Set(pages.map((p) => p.id));
  const build = (parent: number, depth: number): MenuItem[] =>
    pages
      .filter((p) => (ids.has(p.parent) ? p.parent : 0) === parent)
      .map((p) => ({
        ...itemFromSearchResult({
          id: p.id,
          title: p.title,
          url: p.link,
          type: 'post',
          subtype: 'page',
        }),
        children: depth + 1 < MAX_DEPTH ? build(p.id, depth + 1) : [],
      }));
  return build(0, 0);
}

/**
 * The link control's URL check, made stricter: http(s), mailto, tel,
 * root-relative paths and anchors. Anything else (javascript:, data:…) is
 * refused here; core strips such URLs on output anyway.
 */
export function normalizeUrl(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (/^(\/(?!\/)|#|\?)/.test(value)) return value;
  if (/^(mailto|tel):/i.test(value)) return value;
  if (/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(value)) return value;
  // "example.com/about" → https://example.com/about
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(value)) return `https://${value}`;
  return null;
}

/** Titles from /wp/v2/search are rendered HTML; menu labels are plain text. */
export function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** "Page", "Category", "Custom link"… for an item's type line. */
export function itemTypeLabel(item: MenuItem): string {
  switch (item.kind) {
    case 'home':
      return 'Home link';
    case 'page-list':
      return 'All published pages';
    case 'block':
      return 'Block';
    case 'custom':
      return 'Custom link';
    default: {
      const labels: Record<string, string> = {
        page: 'Page',
        post: 'Post',
        category: 'Category',
        tag: 'Tag',
        post_tag: 'Tag',
      };
      return labels[item.type ?? ''] ?? (item.kind === 'taxonomy' ? 'Term' : 'Content');
    }
  }
}
