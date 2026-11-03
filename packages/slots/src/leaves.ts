import type { ParsedBlock } from '@pressbase/blocks';
import {
  findElement,
  findLastElement,
  findTag,
  getAttr,
  plainToRichText,
  replaceRange,
  safeUrl,
  setAttr,
  setImageClass,
} from './html';
import type { ButtonValue, ImageValue } from './types';

/**
 * Where each core block keeps its editable content, and how to read and
 * write it in place. Only these blocks hold slots; the rest are structure
 * that slots are found inside (groups, columns, covers…) or content that
 * isn't a slot (navigation, query loops, code).
 */

export type LeafKind = 'heading' | 'text' | 'button' | 'image';

export interface Leaf {
  kind: LeafKind;
  /** The inferred role before a section's title and eyebrow are worked out. */
  role: string;
  read(block: ParsedBlock): string | ButtonValue | (ImageValue & { url: string; alt: string });
  write(block: ParsedBlock, value: unknown, format: 'html' | 'text'): void;
  level?: (block: ParsedBlock) => number;
}

/** Index of the first or last HTML chunk in innerContent. */
function chunkIndex(block: ParsedBlock, which: 'first' | 'last'): number {
  const { innerContent } = block;
  if (which === 'first') return innerContent.findIndex((c) => typeof c === 'string');
  for (let i = innerContent.length - 1; i >= 0; i--) {
    if (typeof innerContent[i] === 'string') return i;
  }
  return -1;
}

function setChunk(block: ParsedBlock, index: number, html: string): void {
  block.innerContent[index] = html;
  block.innerHTML = block.innerContent.filter((c): c is string => typeof c === 'string').join('');
}

function chunk(block: ParsedBlock, which: 'first' | 'last'): { index: number; html: string } | null {
  const index = chunkIndex(block, which);
  return index === -1 ? null : { index, html: block.innerContent[index] as string };
}

function toRichText(value: unknown, format: 'html' | 'text'): string | null {
  if (typeof value !== 'string') return null;
  return format === 'text' ? plainToRichText(value) : value;
}

interface TextSpec {
  tag: string;
  which?: 'first' | 'last';
  last?: boolean;
  openEnded?: boolean;
}

function locate(block: ParsedBlock, spec: TextSpec) {
  const c = chunk(block, spec.which ?? 'first');
  if (!c) return null;
  const match = spec.last
    ? findLastElement(c.html, spec.tag)
    : findElement(c.html, spec.tag, spec.openEnded);
  return match ? { ...c, match } : null;
}

function textLeaf(kind: 'heading' | 'text', role: string, spec: TextSpec): Leaf {
  return {
    kind,
    role,
    read: (block) => locate(block, spec)?.match.inner ?? '',
    write(block, value, format) {
      const html = toRichText(value, format);
      const found = locate(block, spec);
      if (html === null || !found || found.match.inner === html) return;
      setChunk(block, found.index, replaceRange(found.html, found.match, html));
    },
  };
}

function hasElement(block: ParsedBlock, spec: TextSpec): boolean {
  return locate(block, spec) !== null;
}

const headingLevel = (block: ParsedBlock) =>
  typeof block.attrs.level === 'number' ? block.attrs.level : 2;

const buttonLeaf: Leaf = {
  kind: 'button',
  role: 'action',
  read(block) {
    const found = locate(block, { tag: 'a|button' });
    const tag = found ? findTag(found.html, 'a|button') : null;
    return { text: found?.match.inner ?? '', url: tag ? (getAttr(tag.tag, 'href') ?? '') : '' };
  },
  write(block, value, format) {
    if (!value || typeof value !== 'object') return;
    const { text, url } = value as Partial<ButtonValue>;
    textLeaf('text', 'action', { tag: 'a|button' }).write(block, text, format);
    if (typeof url !== 'string') return;
    const c = chunk(block, 'first');
    const tag = c ? findTag(c.html, 'a') : null;
    if (!c || !tag || (getAttr(tag.tag, 'href') ?? '') === url) return;
    const safe = safeUrl(url);
    const next = setAttr(tag.tag, 'href', safe === '' ? null : safe);
    setChunk(block, c.index, c.html.slice(0, tag.start) + next + c.html.slice(tag.end));
  },
};

/** Media IDs live in different attributes per block. */
const MEDIA_ID_ATTR: Record<string, string> = {
  'core/image': 'id',
  'core/cover': 'id',
  'core/media-text': 'mediaId',
};

const imageLeaf: Leaf = {
  kind: 'image',
  role: 'media',
  read(block) {
    const c = chunk(block, 'first');
    const tag = c ? findTag(c.html, 'img') : null;
    const fromTag = (name: string) => (tag ? (getAttr(tag.tag, name) ?? '') : '');
    if (block.blockName === 'core/cover') {
      return {
        url: typeof block.attrs.url === 'string' ? block.attrs.url : fromTag('src'),
        alt: typeof block.attrs.alt === 'string' ? block.attrs.alt : fromTag('alt'),
      };
    }
    return { url: fromTag('src'), alt: fromTag('alt') };
  },
  write(block, value) {
    if (!value || typeof value !== 'object') return;
    const { url, alt, id } = value as ImageValue;
    const c = chunk(block, 'first');
    const found = c ? findTag(c.html, 'img') : null;
    if (!c || !found) return;
    const current = imageLeaf.read(block) as { url: string; alt: string };
    let tag = found.tag;
    const idAttr = MEDIA_ID_ATTR[block.blockName ?? ''] ?? 'id';
    if (typeof url === 'string' && url !== current.url) {
      const safe = safeUrl(url);
      tag = setAttr(tag, 'src', safe === '' ? null : safe);
      if (block.blockName === 'core/cover') block.attrs.url = safe;
      // A different image is no longer the old attachment.
      if (typeof id === 'number') block.attrs[idAttr] = id;
      else delete block.attrs[idAttr];
      tag = setImageClass(tag, typeof id === 'number' ? id : null);
    } else if (typeof id === 'number' && block.attrs[idAttr] !== id) {
      block.attrs[idAttr] = id;
      tag = setImageClass(tag, id);
    }
    if (typeof alt === 'string' && alt !== current.alt) {
      tag = setAttr(tag, 'alt', alt);
      if (block.blockName === 'core/cover') {
        if (alt) block.attrs.alt = alt;
        else delete block.attrs.alt;
      }
    }
    if (tag !== found.tag) {
      setChunk(block, c.index, c.html.slice(0, found.start) + tag + c.html.slice(found.end));
    }
  },
};

export interface BlockLeaves {
  /** Slots read before the block's inner blocks. */
  before: Leaf[];
  /** Slots read after them (a quote's citation). */
  after: Leaf[];
}

const NONE: BlockLeaves = { before: [], after: [] };

/**
 * Blocks whose content is never a slot, and whose inner blocks aren't
 * searched: template and query blocks show site data, code is code, and
 * custom HTML is left alone.
 */
export const OPAQUE_BLOCKS = new Set([
  'core/pattern',
  'core/block',
  'core/template-part',
  'core/navigation',
  'core/query',
  'core/comments',
  'core/html',
  'core/code',
  'core/shortcode',
  'core/freeform',
  'core/embed',
  'core/table',
  'core/social-links',
]);

/** The slots a block holds itself (not those of its inner blocks). */
export function leavesOf(block: ParsedBlock): BlockLeaves {
  switch (block.blockName) {
    case 'core/heading':
      return {
        before: [{ ...textLeaf('heading', 'heading', { tag: 'h[1-6]' }), level: headingLevel }],
        after: [],
      };
    case 'core/paragraph':
      return { before: [textLeaf('text', 'body', { tag: 'p' })], after: [] };
    case 'core/list-item':
      return { before: [textLeaf('text', 'item', { tag: 'li', openEnded: true })], after: [] };
    case 'core/preformatted':
    case 'core/verse':
      return { before: [textLeaf('text', 'body', { tag: 'pre' })], after: [] };
    case 'core/details':
      return { before: [textLeaf('text', 'summary', { tag: 'summary' })], after: [] };
    case 'core/button':
      return { before: [buttonLeaf], after: [] };
    case 'core/quote': {
      const cite: TextSpec = { tag: 'cite', which: 'last', last: true };
      return { before: [], after: hasElement(block, cite) ? [textLeaf('text', 'citation', cite)] : [] };
    }
    case 'core/pullquote': {
      const cite: TextSpec = { tag: 'cite', last: true };
      return {
        before: [
          textLeaf('text', 'body', { tag: 'p' }),
          ...(hasElement(block, cite) ? [textLeaf('text', 'citation', cite)] : []),
        ],
        after: [],
      };
    }
    case 'core/image':
      return { before: [imageLeaf], after: [] };
    case 'core/cover':
      return block.attrs.backgroundType !== 'video' &&
        (typeof block.attrs.url === 'string' || hasImg(block))
        ? { before: [imageLeaf], after: [] }
        : NONE;
    case 'core/media-text':
      return hasImg(block) ? { before: [imageLeaf], after: [] } : NONE;
    default:
      return NONE;
  }
}

function hasImg(block: ParsedBlock): boolean {
  const c = chunk(block, 'first');
  return !!c && findTag(c.html, 'img') !== null;
}
