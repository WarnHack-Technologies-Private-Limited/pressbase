/**
 * AI edits in Studio (#57): turning a set of edit operations
 * (@pressbase/site-edits) into what Studio changes — the canvas's regions
 * (the open page, the header and footer), other pages' and new pages' draft
 * entries, the header menu's links and the site styles. Pure functions over
 * blocks, tested in ai-edits-model.test.ts; `use-ai-edits.ts` applies the
 * plan as one undo step with Keep and Undo. See docs/architecture/ai-edits.md.
 *
 *   const result = planEdits(proposal.operations, context);
 *   if ('problem' in result) say(problemText(result.problem));
 *   else apply(result.plan);
 *
 * Core has already checked an AI proposal against the site
 * (`core/propose-site-edits`); this checks again with the shared checks and
 * against the canvas as it is now, and refuses the whole set if one
 * operation can't be applied.
 */

import { type ParsedBlock, parseBlocks, serializeBlocks } from '@pressbase/blocks';
import {
  checkOperations,
  type EditOperation,
  type PageRef,
  type PresetAttributes,
  type SlotValuesInput,
} from '@pressbase/site-edits';
import {
  extractSlots,
  fillSlots,
  type SlotDeclarations,
  type SlotValues,
  transferSlots,
} from '@pressbase/slots';

/** The block fields the applier reads: WordPress's BlockInstance has them. */
export interface EditBlock {
  clientId: string;
  name: string;
  attributes: Record<string, unknown>;
  innerBlocks: EditBlock[];
}

/** Between blocks and markup: @wordpress/blocks' serialize() and parse() in Studio. */
export interface BlockCodec<B extends EditBlock> {
  toMarkup(blocks: B[]): string;
  fromMarkup(markup: string): B[];
}

/** A pattern as `/wp/v2/block-patterns/patterns` serves it (the fields read here). */
export interface EditPattern {
  name: string;
  content: string;
  slots?: SlotDeclarations;
}

/** Why a set can't be applied; the panel says it in the person's language (problemText()). */
export type ApplyProblem =
  | { code: 'invalid'; message: string }
  | { code: 'no_section'; index: number; count: number }
  | { code: 'no_block'; index: number }
  | { code: 'no_pattern'; pattern: string }
  | { code: 'no_slot'; slot: string }
  | { code: 'no_page'; page: string }
  | { code: 'no_part'; slug: string }
  | { code: 'no_menu' }
  | { code: 'not_allowed'; what: 'styles' | 'parts' | 'pages' };

export class EditApplyError extends Error {
  constructor(readonly problem: ApplyProblem) {
    super(problem.code);
  }
}

const fail = (problem: ApplyProblem): never => {
  throw new EditApplyError(problem);
};

/* ------------------------------------------------------------ sections */

const patternName = (block: EditBlock | ParsedBlock | undefined): string => {
  const attrs = (block && ('attributes' in block ? block.attributes : block.attrs)) ?? {};
  const name = (attrs.metadata as { patternName?: unknown } | undefined)?.patternName;
  return typeof name === 'string' ? name : '';
};

const rootsOf = (markup: string) => parseBlocks(markup).filter((b) => b.blockName !== null);

/** The slots' IDs a set of values names, that the slots don't have. */
function unknownSlot(slots: { id: string }[], values: SlotValuesInput): string | undefined {
  return Object.keys(values).find((id) => !slots.some((s) => s.id === id));
}

/** Records the pattern a section came from (`metadata.patternName`), as the block editor does. */
function markPattern(blocks: ParsedBlock[], name: string): ParsedBlock[] {
  if (blocks.length !== 1) return blocks;
  const [block] = blocks as [ParsedBlock];
  const metadata = (block.attrs.metadata as Record<string, unknown> | undefined) ?? {};
  return [{ ...block, attrs: { ...block.attrs, metadata: { ...metadata, patternName: name } } }];
}

/**
 * A pattern's markup with `values` (plain text) filled in, and `carried`
 * (rich text moved from the section it replaces) first. As core's
 * renderPattern() (apps/core/src/site-building/sections.ts).
 */
export function renderPattern(
  pattern: EditPattern,
  values?: SlotValuesInput,
  carried?: SlotValues,
): string {
  const declarations = pattern.slots;
  let blocks = rootsOf(pattern.content);
  if (carried) blocks = fillSlots(blocks, carried, { declarations, format: 'html' });
  if (values) {
    const slot = unknownSlot(extractSlots(blocks, { declarations }), values);
    if (slot) fail({ code: 'no_slot', slot });
    blocks = fillSlots(blocks, values as SlotValues, { declarations, format: 'text' });
  }
  return serializeBlocks(markPattern(blocks, pattern.name));
}

/** Merges preset attributes: `null` removes one; `style` merges, its `null`s removing too. */
export function mergeAttributes(
  attributes: Record<string, unknown>,
  change: PresetAttributes,
): Record<string, unknown> {
  const out = { ...attributes };
  for (const [key, value] of Object.entries(change)) {
    if (value === null) delete out[key];
    else if (key === 'style' && isObject(value)) {
      const merged = mergeStyle(out.style, value);
      if (Object.keys(merged).length) out.style = merged;
      else delete out.style;
    } else if (value !== undefined) out[key] = value;
  }
  return out;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function mergeStyle(base: unknown, patch: Json): Json {
  const out: Json = isObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (isObject(value)) {
      const merged = mergeStyle(out[key], value);
      if (Object.keys(merged).length) out[key] = merged;
      else delete out[key];
    } else out[key] = value;
  }
  return out;
}

/** The sections after one page operation, and what it changed. */
interface SectionsResult<B extends EditBlock> {
  sections: B[];
  /** Blocks to highlight: new sections, moved ones, blocks with new attributes. */
  changed: Set<string>;
  /** Content a replaced section's new layout had no place for, as plain text. */
  unused: string[];
}

export type PageOperationInput = Extract<
  EditOperation,
  {
    type:
      | 'insertSection'
      | 'replaceSection'
      | 'moveSection'
      | 'removeSection'
      | 'updateSlots'
      | 'updateBlockAttributes';
  }
>;

/**
 * Applies page operations to a page's sections, in order: each index is
 * read after the operations before it, as `core/update-page-sections` does.
 * Sections no operation touches keep their blocks (and client IDs).
 */
export function applyPageOperations<B extends EditBlock>(
  start: readonly B[],
  operations: readonly PageOperationInput[],
  patterns: ReadonlyMap<string, EditPattern>,
  codec: BlockCodec<B>,
): SectionsResult<B> {
  const sections = [...start];
  const changed = new Set<string>();
  const unused: string[] = [];
  const at = (index: number, insert = false) => {
    const max = insert ? sections.length : sections.length - 1;
    if (!Number.isInteger(index) || index < 0 || index > max) {
      fail({ code: 'no_section', index, count: sections.length });
    }
    return index;
  };
  const pattern = (name: string) =>
    patterns.get(name) ?? fail({ code: 'no_pattern', pattern: name });
  const mark = (blocks: B[]) => {
    for (const block of blocks) changed.add(block.clientId);
    return blocks;
  };

  for (const operation of operations) {
    switch (operation.type) {
      case 'insertSection': {
        const index = at(operation.index ?? sections.length, true);
        const markup = renderPattern(pattern(operation.pattern), operation.slots);
        sections.splice(index, 0, ...mark(codec.fromMarkup(markup)));
        break;
      }
      case 'replaceSection': {
        const index = at(operation.index);
        const to = pattern(operation.pattern);
        let carried: SlotValues | undefined;
        if (operation.keep_content !== false) {
          const current = rootsOf(codec.toMarkup([sections[index] as B]));
          const from = patterns.get(patternName(current[0]));
          const transfer = transferSlots(
            extractSlots(current, { declarations: from?.slots }),
            extractSlots(rootsOf(to.content), { declarations: to.slots }),
          );
          carried = transfer.values;
          unused.push(...transfer.unused.map(unusedPlain).filter(Boolean));
        }
        const markup = renderPattern(to, operation.slots, carried);
        sections.splice(index, 1, ...mark(codec.fromMarkup(markup)));
        break;
      }
      case 'moveSection': {
        const index = at(operation.index);
        const to = at(operation.to);
        const [moved] = sections.splice(index, 1) as [B];
        sections.splice(to, 0, moved);
        if (index !== to) changed.add(moved.clientId);
        break;
      }
      case 'removeSection': {
        const [removed] = sections.splice(at(operation.index), 1) as [B];
        changed.delete(removed.clientId);
        break;
      }
      case 'updateSlots': {
        const index = at(operation.index);
        const current = rootsOf(codec.toMarkup([sections[index] as B]));
        const declarations = patterns.get(patternName(current[0]))?.slots;
        const slot = unknownSlot(extractSlots(current, { declarations }), operation.slots);
        if (slot) fail({ code: 'no_slot', slot });
        const filled = fillSlots(current, operation.slots as SlotValues, {
          declarations,
          format: 'text',
        });
        sections.splice(index, 1, ...mark(codec.fromMarkup(serializeBlocks(filled))));
        break;
      }
      case 'updateBlockAttributes': {
        const index = at(operation.index);
        const path = operation.block ?? [];
        const section = sections[index] as B;
        const updated = updateAt(section, path, (block) => ({
          ...block,
          attributes: mergeAttributes(block.attributes, operation.attributes),
        }));
        if (!updated) fail({ code: 'no_block', index });
        sections[index] = (updated as { block: B }).block;
        changed.add((updated as { target: string }).target);
        break;
      }
    }
  }
  return { sections, changed, unused };
}

/** A copy of `block` with the block at `path` (inner-block positions) changed; null if there's none. */
function updateAt<B extends EditBlock>(
  block: B,
  path: readonly number[],
  change: (block: B) => B,
): { block: B; target: string } | null {
  if (!path.length) {
    const next = change(block);
    return { block: next, target: next.clientId };
  }
  const [first, ...rest] = path as [number, ...number[]];
  const child = block.innerBlocks[first] as B | undefined;
  if (!child) return null;
  const inner = updateAt(child, rest, change);
  if (!inner) return null;
  const innerBlocks = [...block.innerBlocks];
  innerBlocks[first] = inner.block;
  return { block: { ...block, innerBlocks }, target: inner.target };
}

function unusedPlain(value: { value: unknown }): string {
  const v = value.value as unknown;
  if (typeof v === 'string') return stripTags(v);
  if (isObject(v)) return stripTags(String(v.text ?? v.alt ?? v.url ?? ''));
  return '';
}

const stripTags = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/* --------------------------------------------------------- template parts */

/**
 * A template part's blocks after `updateTemplatePart`: rebuilt from a
 * pattern, and/or its slots filled (of the part as it is, when there's no
 * pattern; a part of one block from a pattern uses that pattern's slots).
 */
export function applyPartOperation<B extends EditBlock>(
  blocks: readonly B[],
  operation: Extract<EditOperation, { type: 'updateTemplatePart' }>,
  patterns: ReadonlyMap<string, EditPattern>,
  codec: BlockCodec<B>,
): B[] {
  if (operation.pattern !== undefined) {
    const pattern =
      patterns.get(operation.pattern) ?? fail({ code: 'no_pattern', pattern: operation.pattern });
    return codec.fromMarkup(renderPattern(pattern, operation.slots));
  }
  if (!operation.slots) return [...blocks];
  const current = rootsOf(codec.toMarkup([...blocks]));
  const declarations =
    current.length === 1 ? patterns.get(patternName(current[0]))?.slots : undefined;
  const slot = unknownSlot(extractSlots(current, { declarations }), operation.slots);
  if (slot) fail({ code: 'no_slot', slot });
  const filled = fillSlots(current, operation.slots as SlotValues, {
    declarations,
    format: 'text',
  });
  return codec.fromMarkup(serializeBlocks(filled));
}

/* ------------------------------------------------------------------ menu */

/** The header menu's markup: a Navigation Link per item, as the site builder writes it. */
export function menuMarkup(
  items: readonly { label: string; page?: string; url?: string }[],
  pageUrl: (slug: string) => string | null,
): string {
  const links: ParsedBlock[] = items.map((item) => {
    const url =
      item.url ??
      (item.page !== undefined
        ? (pageUrl(item.page) ?? fail({ code: 'no_page', page: item.page }))
        : '#');
    return {
      blockName: 'core/navigation-link',
      attrs: { label: item.label, url, kind: 'custom', isTopLevelLink: true },
      innerBlocks: [],
      innerHTML: '',
      innerContent: [],
    };
  });
  return serializeBlocks(links);
}

/* ------------------------------------------------------------------ plan */

/** What Studio has open, and what it knows, for planning a set. */
export interface EditContext<B extends EditBlock> {
  codec: BlockCodec<B>;
  patterns: ReadonlyMap<string, EditPattern>;
  /** The page on the canvas: its ID (a slug for a page the draft adds) and slug, its draft key and sections. */
  open: { id: PageRef; slug: string; key: string; sections: readonly B[] } | null;
  /** Template parts on the canvas: their draft key and blocks, by slug. */
  parts: ReadonlyMap<string, { key: string; blocks: readonly B[] }>;
  /** Other pages the set changes, as the draft leaves them: by ID or slug. */
  pages: ReadonlyMap<PageRef, { key: string; content: string }>;
  /** A page's address on the site, by slug (pages this set creates included); null if there's none. */
  pageUrl: (slug: string) => string | null;
  /** A new page's draft key, slug and fields (title, status, place), as the Pages panel adds one. */
  newPage: (title: string, slug?: string) => { key: string; slug: string; fields: Json };
  can: { styles: boolean; parts: boolean; pages: boolean };
}

export interface EditPlan<B extends EditBlock> {
  /** Canvas regions to replace, by draft key (`page:12`, `wp_template_part:header`). */
  regions: Map<string, B[]>;
  /** Blocks to highlight on the canvas. */
  highlight: string[];
  /** Page fields for the draft: other pages' content, and new pages. */
  fields: Map<string, Json>;
  /** The header menu's new links (markup), when the set changes it. */
  menu: string | null;
  /** The set changes the site styles (the entry comes from core with the proposal). */
  styles: boolean;
  /** Content replaced sections had no place for. */
  unused: string[];
}

const sameRef = (a: PageRef, b: PageRef) => String(a) === String(b);

/**
 * Plans a set: checks it (the shared checks, then against the canvas and
 * the draft) and works out every change, or says what's wrong with the
 * first operation that can't be applied. Changes nothing.
 */
export function planEdits<B extends EditBlock>(
  operations: unknown,
  context: EditContext<B>,
): { plan: EditPlan<B> } | { problem: ApplyProblem } {
  const checked = checkOperations(operations);
  const first = checked.problems[0];
  if (first) return { problem: { code: 'invalid', message: first.message } };
  try {
    return { plan: plan(checked.operations, context) };
  } catch (error) {
    if (error instanceof EditApplyError) return { problem: error.problem };
    throw error;
  }
}

function plan<B extends EditBlock>(
  operations: readonly EditOperation[],
  context: EditContext<B>,
): EditPlan<B> {
  const { codec, patterns } = context;
  const regions = new Map<string, B[]>();
  const highlight = new Set<string>();
  const fields = new Map<string, Json>();
  const unused: string[] = [];
  let menu: string | null = null;
  let styles = false;
  /** Pages off the canvas (and new ones), as sections, by draft key. */
  const offCanvas = new Map<string, B[]>();
  const created = new Map<string, string>(); // slug → key

  const sectionsOf = (
    ref: PageRef | undefined,
  ): { key: string; blocks: B[]; onCanvas: boolean } => {
    const open = context.open;
    if (ref === undefined || (open && (sameRef(ref, open.id) || sameRef(ref, open.slug)))) {
      if (!open) return fail({ code: 'no_page', page: String(ref ?? '') });
      return {
        key: open.key,
        blocks: regions.get(open.key) ?? [...open.sections],
        onCanvas: true,
      };
    }
    const newKey = typeof ref === 'string' ? created.get(ref) : undefined;
    const found = newKey ? undefined : [...context.pages].find(([r]) => sameRef(r, ref))?.[1];
    const key = newKey ?? found?.key ?? fail({ code: 'no_page', page: String(ref) });
    const blocks = offCanvas.get(key) ?? codec.fromMarkup(found?.content ?? '');
    return { key, blocks, onCanvas: false };
  };

  for (const operation of operations) {
    switch (operation.type) {
      case 'insertSection':
      case 'replaceSection':
      case 'moveSection':
      case 'removeSection':
      case 'updateSlots':
      case 'updateBlockAttributes': {
        const page = sectionsOf(operation.page);
        const result = applyPageOperations(page.blocks, [operation], patterns, codec);
        unused.push(...result.unused);
        if (page.onCanvas) {
          regions.set(page.key, result.sections);
          for (const id of result.changed) highlight.add(id);
        } else offCanvas.set(page.key, result.sections);
        break;
      }
      case 'updateTemplatePart': {
        if (!context.can.parts) fail({ code: 'not_allowed', what: 'parts' });
        const part = context.parts.get(operation.slug);
        if (!part) fail({ code: 'no_part', slug: operation.slug });
        const { key, blocks } = part as { key: string; blocks: readonly B[] };
        const next = applyPartOperation(regions.get(key) ?? blocks, operation, patterns, codec);
        regions.set(key, next);
        for (const block of next) highlight.add(block.clientId);
        break;
      }
      case 'createPage': {
        if (!context.can.pages) fail({ code: 'not_allowed', what: 'pages' });
        const page = context.newPage(operation.title, operation.slug);
        const blocks = operation.sections.flatMap((section) =>
          codec.fromMarkup(
            renderPattern(
              patterns.get(section.pattern) ??
                fail({ code: 'no_pattern', pattern: section.pattern }),
              section.slots,
            ),
          ),
        );
        created.set(operation.slug ?? page.slug, page.key);
        if (operation.slug && operation.slug !== page.slug) created.set(page.slug, page.key);
        offCanvas.set(page.key, blocks);
        fields.set(page.key, {
          ...page.fields,
          ...(operation.status ? { status: operation.status } : {}),
        });
        break;
      }
      case 'updateMenu': {
        if (!context.can.parts) fail({ code: 'not_allowed', what: 'parts' });
        const createdUrl = (slug: string) => (created.has(slug) ? `/${slug}/` : null);
        menu = menuMarkup(operation.items, (slug) => context.pageUrl(slug) ?? createdUrl(slug));
        break;
      }
      case 'setGlobalStyles':
        if (!context.can.styles) fail({ code: 'not_allowed', what: 'styles' });
        styles = true;
        break;
    }
  }
  for (const [key, blocks] of offCanvas) {
    fields.set(key, { ...fields.get(key), content: codec.toMarkup(blocks) });
  }
  return { regions, highlight: [...highlight], fields, menu, styles, unused };
}

/* ---------------------------------------------------------------- canvas */

/** A copy of a block tree with some blocks' inner blocks replaced, by client ID. */
export function withInnerBlocks<B extends EditBlock>(
  tree: readonly B[],
  replace: ReadonlyMap<string, readonly EditBlock[]>,
): B[] {
  return tree.map((block) => {
    const inner = replace.get(block.clientId);
    if (inner) return { ...block, innerBlocks: [...inner] };
    if (!block.innerBlocks.length) return block;
    const innerBlocks = withInnerBlocks(block.innerBlocks as B[], replace);
    return innerBlocks.every((b, i) => b === block.innerBlocks[i])
      ? block
      : { ...block, innerBlocks };
  });
}

/** The menu a header shows: its first Navigation block's `ref`, if it names one. */
export function navigationRef(blocks: readonly EditBlock[]): number | null {
  for (const block of blocks) {
    if (block.name === 'core/navigation') {
      const ref = Number(block.attributes.ref);
      if (ref > 0) return ref;
    }
    const inner = navigationRef(block.innerBlocks);
    if (inner) return inner;
  }
  return null;
}
