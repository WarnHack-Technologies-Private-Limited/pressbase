/**
 * The History panel (#34): Studio's undo history as a list of steps, and
 * each step's name in plain words ("Changed heading text", "Moved section
 * up"), worked out by comparing the canvas before and after it. Pure
 * functions, tested in history-model.test.ts. See
 * docs/architecture/studio.md#history.
 */

import { type CanvasBlock, POST_CONTENT, TEMPLATE_PART } from './canvas-model';

/* ---------------------------------------------------------------- the stack */

/** One point in the history: the canvas then, and what got it there. */
export interface HistoryEntry<T> {
  value: T;
  /** A name given when the step was made ("Restored the version from…"); else worked out. */
  label?: string;
  /** When it was made (ms since the epoch). */
  at: number;
}

/**
 * The undo history as a list of points: `entries[0]` is the page as it
 * opened, each later one a step; `index` is where the canvas is now (later
 * entries are steps undone, which redo brings back).
 *
 * Same rules as @wordpress/compose's useStateWithHistory (undo-manager): a
 * *staged* change (typing on in the same block, or a block adjusting itself
 * as the page opens) joins the current step instead of making one, so
 * undo takes back a whole run of typing.
 */
export interface HistoryState<T> {
  entries: HistoryEntry<T>[];
  index: number;
}

export const historyInit = <T>(value: T, at = Date.now()): HistoryState<T> => ({
  entries: [{ value, at }],
  index: 0,
});

export function historyRecord<T>(
  state: HistoryState<T>,
  value: T,
  options: { staged?: boolean; label?: string; at?: number } = {},
): HistoryState<T> {
  const at = options.at ?? Date.now();
  if (options.staged) {
    const entries = [...state.entries];
    const current = entries[state.index] as HistoryEntry<T>;
    entries[state.index] = { ...current, value };
    return { entries, index: state.index };
  }
  const entries = [...state.entries.slice(0, state.index + 1), { value, label: options.label, at }];
  return { entries, index: entries.length - 1 };
}

/** Moves to a point in the history (undo is `index - 1`, redo `index + 1`). */
export function historyGo<T>(state: HistoryState<T>, index: number): HistoryState<T> {
  const next = Math.max(0, Math.min(state.entries.length - 1, index));
  return next === state.index ? state : { ...state, index: next };
}

/* ------------------------------------------------------------- the labels */

/** What a step did, before it's put into words (editLabel()). */
export type EditKind =
  | 'text'
  | 'style'
  | 'alignment'
  | 'layout'
  | 'link'
  | 'media'
  | 'description'
  | 'rename'
  | 'settings'
  | 'added'
  | 'removed'
  | 'duplicated'
  | 'moved-up'
  | 'moved-down'
  | 'moved'
  | 'transformed'
  | 'many'
  | 'none';

export interface EditDescription {
  kind: EditKind;
  /** The block's type ("core/heading"). */
  block?: string;
  /** The block is a section: a top-level block of the page. */
  section?: boolean;
  /** The section's name (`metadata.name`, as Layers shows it). */
  name?: string;
  /** What a block became (a paragraph turned into a heading). */
  to?: string;
  /** How many blocks, for `many`, `added` and `removed`. */
  count?: number;
  /** The template part it's in (its slug: "header"). */
  part?: string;
}

interface Placed {
  block: CanvasBlock;
  parent: string | null;
  /** Where it sits among its parent's blocks. */
  index: number;
  /** The part it's in, if any. */
  part?: string;
  /** It's a top-level block of the page's content. */
  section: boolean;
}

function flatten(blocks: readonly CanvasBlock[]): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const walk = (
    list: readonly CanvasBlock[],
    parent: CanvasBlock | null,
    part: string | undefined,
  ) => {
    list.forEach((block, index) => {
      out.set(block.clientId, {
        block,
        parent: parent?.clientId ?? null,
        index,
        part,
        section: parent?.name === POST_CONTENT,
      });
      const inner =
        block.name === TEMPLATE_PART ? String(block.attributes.slug ?? '') || part : part;
      walk(block.innerBlocks, block, inner);
    });
  };
  walk(blocks, null, undefined);
  return out;
}

/** Attributes by what they change, in the order a step is named by. */
const TEXT = new Set(['content', 'text', 'value', 'citation', 'caption', 'label', 'title', 'summary']);
const ALIGNMENT = new Set(['align', 'textAlign', 'verticalAlignment', 'justification']);
const STYLE = new Set([
  'style',
  'textColor',
  'backgroundColor',
  'gradient',
  'fontSize',
  'fontFamily',
  'borderColor',
  'className',
  'overlayColor',
  'dimRatio',
]);
const LINK = new Set(['href', 'linkTarget', 'rel', 'opensInNewTab', 'linkDestination']);
const MEDIA = new Set(['url', 'id', 'mediaUrl', 'mediaId', 'src', 'sizeSlug']);
/** Blocks whose `url` is where they lead, not an image. */
const LINK_BLOCKS = new Set([
  'core/button',
  'core/navigation-link',
  'core/navigation-submenu',
  'core/social-link',
  'core/file',
]);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function changedKeys(before: CanvasBlock, after: CanvasBlock): string[] {
  const keys = new Set([...Object.keys(before.attributes), ...Object.keys(after.attributes)]);
  return [...keys].filter((key) => !same(before.attributes[key], after.attributes[key]));
}

/** What an attribute change is, for one block. */
function attributeKind(name: string, keys: readonly string[]): EditKind {
  const kinds = new Set<EditKind>();
  for (const key of keys) {
    if (key === 'metadata') kinds.add('rename');
    else if (key === 'alt') kinds.add('description');
    else if (key === 'url' && LINK_BLOCKS.has(name)) kinds.add('link');
    else if (TEXT.has(key)) kinds.add('text');
    else if (ALIGNMENT.has(key)) kinds.add('alignment');
    else if (key === 'layout') kinds.add('layout');
    else if (STYLE.has(key)) kinds.add('style');
    else if (LINK.has(key)) kinds.add('link');
    else if (MEDIA.has(key)) kinds.add('media');
    else kinds.add('settings');
  }
  // An image chosen often brings its size and alt text along: name it by the image.
  if (kinds.has('media')) return 'media';
  return kinds.size === 1 ? ([...kinds][0] as EditKind) : 'settings';
}

/** The section's name in Layers, if it has one. */
const sectionName = (block: CanvasBlock) => {
  const name = (block.attributes.metadata as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && name ? name : undefined;
};

/** The blocks of `ids` whose parent isn't in `ids` too (the tops of added or removed subtrees). */
const tops = (ids: readonly string[], placed: Map<string, Placed>) => {
  const set = new Set(ids);
  return ids.filter((id) => {
    const parent = placed.get(id)?.parent;
    return !parent || !set.has(parent);
  });
};

/** A copy of the block before it (Duplicate), apart from client IDs. */
function isDuplicate(id: string, after: Map<string, Placed>, parents: Map<string | null, string[]>) {
  const placed = after.get(id);
  if (!placed) return false;
  const siblings = parents.get(placed.parent) ?? [];
  const previous = siblings[placed.index - 1];
  const other = previous ? after.get(previous)?.block : undefined;
  const strip = (block: CanvasBlock): unknown => ({
    name: block.name,
    attributes: block.attributes,
    inner: block.innerBlocks.map(strip),
  });
  return Boolean(other) && same(strip(other as CanvasBlock), strip(placed.block));
}

const childrenOf = (placed: Map<string, Placed>) => {
  const out = new Map<string | null, string[]>();
  for (const [id, p] of placed) {
    const list = out.get(p.parent) ?? [];
    list[p.index] = id;
    out.set(p.parent, list);
  }
  return out;
};

/**
 * What changed between two canvases, for the History panel. `selected` is
 * the block selected after the step (the one moved, when two swap places).
 */
export function describeEdit(
  before: readonly CanvasBlock[],
  after: readonly CanvasBlock[],
  selected?: string | null,
): EditDescription {
  const was = flatten(before);
  const now = flatten(after);
  const addedIds = tops(
    [...now.keys()].filter((id) => !was.has(id)),
    now,
  );
  const removedIds = tops(
    [...was.keys()].filter((id) => !now.has(id)),
    was,
  );
  const withPart = (description: EditDescription, placed?: Placed): EditDescription =>
    placed?.part ? { ...description, part: placed.part } : description;
  const about = (placed: Placed): EditDescription => ({
    kind: 'none',
    block: placed.block.name,
    ...(placed.section ? { section: true, name: sectionName(placed.block) } : {}),
  });

  if (addedIds.length || removedIds.length) {
    if (addedIds.length === 1 && removedIds.length === 1) {
      const added = now.get(addedIds[0] as string) as Placed;
      const removed = was.get(removedIds[0] as string) as Placed;
      if (added.parent === removed.parent && added.index === removed.index) {
        if (added.block.name === removed.block.name) {
          return withPart({ ...about(added), kind: 'settings' }, added);
        }
        return withPart({ ...about(removed), kind: 'transformed', to: added.block.name }, added);
      }
    }
    if (addedIds.length && removedIds.length) {
      return { kind: 'many', count: addedIds.length + removedIds.length };
    }
    const ids = addedIds.length ? addedIds : removedIds;
    const placed = (addedIds.length ? now : was).get(ids[0] as string) as Placed;
    if (ids.length > 1) {
      return withPart({ kind: addedIds.length ? 'added' : 'removed', count: ids.length }, placed);
    }
    if (addedIds.length && isDuplicate(ids[0] as string, now, childrenOf(now))) {
      return withPart({ ...about(placed), kind: 'duplicated' }, placed);
    }
    return withPart({ ...about(placed), kind: addedIds.length ? 'added' : 'removed' }, placed);
  }

  // Moves: a block in another parent, or in another order among the blocks that stayed.
  const moved: { id: string; delta: number }[] = [];
  const wasChildren = childrenOf(was);
  const nowChildren = childrenOf(now);
  for (const [parent, ids] of nowChildren) {
    const order = ids.filter((id) => was.get(id)?.parent === parent);
    const before = (wasChildren.get(parent) ?? []).filter((id) => now.get(id)?.parent === parent);
    order.forEach((id, index) => {
      const from = before.indexOf(id);
      if (from !== index) moved.push({ id, delta: index - from });
    });
    for (const id of ids) {
      if (was.has(id) && was.get(id)?.parent !== parent) moved.push({ id, delta: 0 });
    }
  }
  if (moved.length) {
    const nested = moved.find((m) => m.delta === 0);
    const mover =
      nested ??
      moved.find((m) => m.id === selected) ??
      [...moved].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.delta - b.delta)[0];
    const placed = now.get(mover?.id as string) as Placed;
    const kind: EditKind =
      !mover || mover.delta === 0 ? 'moved' : mover.delta < 0 ? 'moved-up' : 'moved-down';
    return withPart({ ...about(placed), kind }, placed);
  }

  // Changed settings or text.
  const changed: { placed: Placed; kind: EditKind }[] = [];
  for (const [id, placed] of now) {
    const old = was.get(id);
    if (!old) continue;
    const keys = changedKeys(old.block, placed.block);
    if (keys.length) changed.push({ placed, kind: attributeKind(placed.block.name, keys) });
  }
  if (changed.length === 1) {
    const [{ placed, kind }] = changed as [{ placed: Placed; kind: EditKind }];
    return withPart({ ...about(placed), kind }, placed);
  }
  if (changed.length > 1) {
    const parts = new Set(changed.map((c) => c.placed.part));
    const first = changed[0]?.placed;
    return withPart({ kind: 'many', count: changed.length }, parts.size === 1 ? first : undefined);
  }
  return { kind: 'none' };
}

/* ------------------------------------------------------------- the words */

type Translate = (text: string, domain: string) => string;
type Plural = (single: string, plural: string, count: number, domain: string) => string;
type Format = (format: string, ...args: (string | number)[]) => string;

export interface LabelNames {
  /** A block type's name as a noun in a sentence: "heading" (lower case in English). */
  block: (name: string) => string;
  /** A template part's name: "Header". */
  part: (slug: string) => string;
}

/** A step in plain words: "Changed heading text", "Moved section up", "Added paragraph in the Header". */
export function editLabel(
  edit: EditDescription,
  names: LabelNames,
  i18n: { __: Translate; _n: Plural; sprintf: Format },
): string {
  const { __, _n, sprintf } = i18n;
  const noun = edit.section
    ? __('section', 'pressbase-admin')
    : edit.block
      ? names.block(edit.block)
      : __('block', 'pressbase-admin');
  const count = edit.count ?? 1;
  let label: string;
  switch (edit.kind) {
    case 'text':
      label = sprintf(__('Changed %s text', 'pressbase-admin'), noun);
      break;
    case 'style':
      label = sprintf(__('Changed %s style', 'pressbase-admin'), noun);
      break;
    case 'alignment':
      label = sprintf(__('Changed %s alignment', 'pressbase-admin'), noun);
      break;
    case 'layout':
      label = sprintf(__('Changed %s layout', 'pressbase-admin'), noun);
      break;
    case 'link':
      label = sprintf(__('Changed %s link', 'pressbase-admin'), noun);
      break;
    case 'media':
      // An Image block is the image: "Changed image", not "Changed image image".
      label =
        edit.block === 'core/image'
          ? sprintf(__('Changed %s', 'pressbase-admin'), noun)
          : sprintf(__('Changed %s image', 'pressbase-admin'), noun);
      break;
    case 'description':
      label = sprintf(__('Changed %s description', 'pressbase-admin'), noun);
      break;
    case 'rename':
      label = sprintf(__('Renamed %s', 'pressbase-admin'), noun);
      break;
    case 'settings':
      label = sprintf(__('Changed %s settings', 'pressbase-admin'), noun);
      break;
    case 'added':
      label =
        count > 1
          ? sprintf(_n('Added %d block', 'Added %d blocks', count, 'pressbase-admin'), count)
          : edit.section && edit.name
            ? sprintf(__('Added section “%s”', 'pressbase-admin'), edit.name)
            : sprintf(__('Added %s', 'pressbase-admin'), noun);
      break;
    case 'removed':
      label =
        count > 1
          ? sprintf(_n('Removed %d block', 'Removed %d blocks', count, 'pressbase-admin'), count)
          : edit.section && edit.name
            ? sprintf(__('Removed section “%s”', 'pressbase-admin'), edit.name)
            : sprintf(__('Removed %s', 'pressbase-admin'), noun);
      break;
    case 'duplicated':
      label = sprintf(__('Duplicated %s', 'pressbase-admin'), noun);
      break;
    case 'moved-up':
      label = sprintf(__('Moved %s up', 'pressbase-admin'), noun);
      break;
    case 'moved-down':
      label = sprintf(__('Moved %s down', 'pressbase-admin'), noun);
      break;
    case 'moved':
      label = sprintf(__('Moved %s', 'pressbase-admin'), noun);
      break;
    case 'transformed':
      label = sprintf(
        __('Changed %1$s to %2$s', 'pressbase-admin'),
        noun,
        edit.to ? names.block(edit.to) : __('block', 'pressbase-admin'),
      );
      break;
    case 'many':
      label = sprintf(_n('Changed %d block', 'Changed %d blocks', count, 'pressbase-admin'), count);
      break;
    default:
      label = __('Edited the page', 'pressbase-admin');
  }
  return edit.part
    ? sprintf(__('%1$s in the %2$s', 'pressbase-admin'), label, names.part(edit.part))
    : label;
}

/**
 * A block type's title as a noun inside a sentence. In English, lower case
 * ("Changed heading text"); other languages keep the title as it is, since
 * some (German) capitalise nouns.
 */
export function blockNoun(title: string, locale: string): string {
  return /^en\b/i.test(locale.replace('_', '-')) ? title.toLowerCase() : title;
}
