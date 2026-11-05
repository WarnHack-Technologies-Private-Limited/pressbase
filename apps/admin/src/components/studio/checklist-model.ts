import { isPlaceholder } from '@pressbase/slots';
import { pageKey, partKey } from './changes-model';
import type { PageRef } from './site-model';

/**
 * The "Before you publish" checklist (#61), the pure part: the answer of
 * `GET /pressbase/v1/studio/checklist`, grouped for the panel, named for the
 * publish confirmation, and turned into a block on the canvas. See
 * docs/architecture/quality-checks.md#before-you-publish.
 */

export type ChecklistKind = 'placeholder' | 'image' | 'check';

export interface ChecklistItem {
  key: string;
  kind: ChecklistKind;
  page: PageRef | null;
  part: string | null;
  title: string;
  rule: string;
  severity: 'error' | 'warning';
  message: string;
  text: string;
  block: { path: number[]; name: string | null } | null;
}

export interface Checklist {
  changeset_uuid: string | null;
  items: ChecklistItem[];
  counts: Record<ChecklistKind, number>;
  checked: { key: string; title: string; kind: 'page' | 'part' }[];
}

export const KINDS: readonly ChecklistKind[] = ['placeholder', 'image', 'check'];

/** The items of each kind, in the panel's order. */
export function groupItems(items: readonly ChecklistItem[]): Map<ChecklistKind, ChecklistItem[]> {
  const groups = new Map<ChecklistKind, ChecklistItem[]>();
  for (const kind of KINDS) {
    const list = items.filter((item) => item.kind === kind);
    if (list.length) groups.set(kind, list);
  }
  return groups;
}

/** The canvas region an item is in (`page:12`, `wp_template_part:header`). */
export function itemRegion(item: Pick<ChecklistItem, 'page' | 'part' | 'key'>): string {
  if (item.part) return partKey(item.part);
  if (item.page !== null) return pageKey(item.page);
  return item.key;
}

/** A stable key for an item (for React and for which one was chosen). */
export const itemKey = (item: ChecklistItem, index: number) =>
  `${item.key}:${item.rule}:${item.block?.path.join('.') ?? '-'}:${index}`;

interface TreeBlock {
  clientId: string;
  innerBlocks: readonly TreeBlock[];
}

/** The block at `path` (indexes from the region's blocks through inner blocks), or null. */
export function blockAtPath<B extends TreeBlock>(blocks: readonly B[], path: readonly number[]) {
  let level: readonly TreeBlock[] = blocks;
  let found: TreeBlock | null = null;
  for (const index of path) {
    found = level[index] ?? null;
    if (!found) return null;
    level = found.innerBlocks;
  }
  return found as B | null;
}

type Translate = (text: string, domain: string) => string;
type Format = (format: string, ...args: (string | number)[]) => string;

/** What an item is, in a few words: the placeholder itself, or what's wrong. */
export function itemText(item: ChecklistItem, __: Translate, sprintf: Format): string {
  if (item.kind === 'placeholder') {
    if (item.text && isPlaceholder(item.text)) return item.text;
    if (item.text) {
      return sprintf(__('The “%s” button doesn’t link anywhere yet', 'pressbase-admin'), item.text);
    }
    return item.message;
  }
  if (item.kind === 'image') {
    return item.text
      ? sprintf(__('Choose an image: %s', 'pressbase-admin'), item.text)
      : __('Choose an image', 'pressbase-admin');
  }
  return item.message;
}

/** Where an item is, for people: the page's title, or "Footer · on every page". */
export function itemPlace(item: ChecklistItem, __: Translate, sprintf: Format): string {
  if (item.part) return sprintf(__('%s · on every page', 'pressbase-admin'), item.title);
  return item.title || __('Untitled page', 'pressbase-admin');
}

/** At most `max` items named for the publish confirmation, and how many more there are. */
export function namedItems(
  items: readonly ChecklistItem[],
  max = 6,
): { shown: ChecklistItem[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/** How many things are left, all kinds together. */
export const totalLeft = (checklist: Pick<Checklist, 'counts'> | null) =>
  checklist ? KINDS.reduce((sum, kind) => sum + (checklist.counts[kind] ?? 0), 0) : 0;

/** Placeholder text in a block's attributes, for the canvas: `[Add a customer quote]`. */
export function holdsPlaceholder(name: string, attributes: Record<string, unknown>): boolean {
  // Rich text is a string, or WordPress's RichTextData (its own toString()).
  const text = (value: unknown) =>
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && value.toString !== Object.prototype.toString
        ? String(value)
        : '';
  switch (name) {
    case 'core/button':
      return isPlaceholder(text(attributes.text));
    case 'core/quote':
    case 'core/pullquote':
      return isPlaceholder(text(attributes.citation));
    case 'core/details':
      return isPlaceholder(text(attributes.summary));
    default:
      return typeof attributes.content !== 'undefined' && isPlaceholder(text(attributes.content));
  }
}
