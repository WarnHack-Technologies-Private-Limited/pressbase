/**
 * Studio's canvas as one block tree, and the way back to the entities it is
 * made of. Pure functions over plain block objects (the shape `parse()`
 * returns), so they're tested without the editor. See
 * docs/architecture/studio.md#the-canvas.
 *
 * The canvas is the page's template with two kinds of *regions* filled in:
 *
 * - `core/template-part` blocks get the part's blocks (the header, the
 *   footer) as inner blocks;
 * - `core/post-content` gets the page's own blocks.
 *
 * Both blocks save as self-closing comments (`save` returns null), so the
 * template serializes back unchanged; each region's inner blocks are the
 * entity's content. That is how #30 (header and footer) and #31 (changesets)
 * split the canvas into the edits to save.
 */

export interface CanvasBlock {
  name: string;
  clientId: string;
  attributes: Record<string, unknown>;
  innerBlocks: CanvasBlock[];
}

export const TEMPLATE_PART = 'core/template-part';
export const POST_CONTENT = 'core/post-content';

/** The deepest template part nesting followed; WordPress stops recursing the same way. */
const MAX_PART_DEPTH = 5;

export interface PartSource {
  /** The part's blocks, parsed from /wp/v2/template-parts `content.raw`; undefined when it doesn't exist. */
  blocks(slug: string): CanvasBlock[] | undefined;
}

/**
 * Fills the template's regions. `content` is the page's blocks, or null when
 * the canvas shows something without its own content (the blog's home page).
 * A part that includes itself (directly or through another part) is left
 * empty, as WordPress's template-part block refuses to render it.
 */
export function composeCanvas(
  template: CanvasBlock[],
  parts: PartSource,
  content: CanvasBlock[] | null,
): CanvasBlock[] {
  let contentUsed = false;
  const fill = (blocks: CanvasBlock[], seen: readonly string[]): CanvasBlock[] =>
    blocks.map((block) => {
      if (block.name === TEMPLATE_PART) {
        const slug = String(block.attributes.slug ?? '');
        const inner =
          slug && !seen.includes(slug) && seen.length < MAX_PART_DEPTH
            ? parts.blocks(slug)
            : undefined;
        return { ...block, innerBlocks: inner ? fill(inner, [...seen, slug]) : [] };
      }
      if (block.name === POST_CONTENT) {
        // Only the first post-content shows the page, as WordPress renders it once.
        const inner = content && !contentUsed ? content : [];
        if (content) contentUsed = true;
        return { ...block, innerBlocks: inner };
      }
      return block.innerBlocks.length
        ? { ...block, innerBlocks: fill(block.innerBlocks, seen) }
        : block;
    });
  return fill(template, []);
}

export interface Region {
  kind: 'part' | 'content';
  clientId: string;
  /** The template part's slug. */
  slug?: string;
}

/** The regions in the canvas, in document order. Parts inside parts are listed too. */
export function findRegions(blocks: CanvasBlock[]): Region[] {
  const out: Region[] = [];
  const walk = (list: CanvasBlock[]) => {
    for (const block of list) {
      if (block.name === TEMPLATE_PART) {
        out.push({
          kind: 'part',
          clientId: block.clientId,
          slug: String(block.attributes.slug ?? ''),
        });
      } else if (block.name === POST_CONTENT) {
        out.push({ kind: 'content', clientId: block.clientId });
        continue; // The page's own blocks aren't regions.
      }
      walk(block.innerBlocks);
    }
  };
  walk(blocks);
  return out;
}

/** The page's blocks: the first post-content region's inner blocks, or null without one. */
export function pageBlocks(blocks: CanvasBlock[]): CanvasBlock[] | null {
  for (const block of blocks) {
    if (block.name === POST_CONTENT) return block.innerBlocks;
    if (block.name === TEMPLATE_PART) continue;
    const found = pageBlocks(block.innerBlocks);
    if (found) return found;
  }
  return null;
}

export type EditingMode = 'default' | 'contentOnly' | 'disabled';

export interface EditingRules {
  /** Header, footer and other parts can be edited (#30); until then they're shown locked. */
  partsEditable: boolean;
}

/**
 * The block editing modes that make the canvas behave as Studio needs
 * (`setBlockEditingMode()`): the template itself is locked (the root is
 * `disabled`, so its blocks inherit it), the page's content is editable, and
 * a template part can be selected as a whole while its blocks stay locked
 * unless parts are editable. Blocks without an entry inherit their nearest
 * ancestor's mode.
 */
export function editingModes(
  blocks: CanvasBlock[],
  rules: EditingRules = { partsEditable: false },
): [clientId: string, mode: EditingMode][] {
  const modes: [string, EditingMode][] = [['', 'disabled']];
  const walk = (list: CanvasBlock[]) => {
    for (const block of list) {
      if (block.name === POST_CONTENT) {
        modes.push([block.clientId, 'default']);
        continue;
      }
      if (block.name === TEMPLATE_PART) {
        modes.push([block.clientId, 'default']);
        if (!rules.partsEditable) {
          for (const child of block.innerBlocks) modes.push([child.clientId, 'disabled']);
        }
        // Parts inside parts are their own regions, selectable too.
        walkParts(block.innerBlocks);
        continue;
      }
      walk(block.innerBlocks);
    }
  };
  const walkParts = (list: CanvasBlock[]) => {
    for (const block of list) {
      if (block.name === TEMPLATE_PART) walk([block]);
      else walkParts(block.innerBlocks);
    }
  };
  walk(blocks);
  return modes;
}

/* ------------------------------------------------------------- breadcrumb */

export interface ChainLink {
  clientId: string;
  name: string;
  /** What people call it: "Header", "Heading", "Hero"… */
  label: string;
}

export type CrumbLevel = 'site' | 'page' | 'section' | 'block';

export interface Crumb {
  level: CrumbLevel;
  label: string;
  /** The block to select; none for Site and Page, which clear the selection. */
  clientId?: string;
}

/**
 * Site › Page › Section › Block for the selection. `chain` runs from the
 * top of the canvas to the selected block, inclusive (getBlockParents() plus
 * the block). A *section* is a block directly in the page's content, or a
 * whole template part ("Header"); the *block* is the selection when it sits
 * deeper than its section. Blocks in between are left out, so the trail
 * stays four steps long at most.
 */
export function breadcrumbTrail({
  site,
  page,
  chain,
}: {
  site: string;
  page: string;
  chain: ChainLink[];
}): Crumb[] {
  const trail: Crumb[] = [
    { level: 'site', label: site },
    { level: 'page', label: page },
  ];
  const selected = chain[chain.length - 1];
  if (!selected) return trail;
  // The innermost region holding the selection.
  let regionIndex = -1;
  for (let i = chain.length - 1; i >= 0; i--) {
    const name = chain[i]?.name;
    if (name === POST_CONTENT || name === TEMPLATE_PART) {
      regionIndex = i;
      break;
    }
  }
  const region = chain[regionIndex];
  if (!region) {
    // A template block outside any region (locked; not normally selectable).
    trail.push({ level: 'block', label: selected.label, clientId: selected.clientId });
    return trail;
  }
  if (region.name === TEMPLATE_PART) {
    trail.push({ level: 'section', label: region.label, clientId: region.clientId });
    if (selected !== region) {
      trail.push({ level: 'block', label: selected.label, clientId: selected.clientId });
    }
    return trail;
  }
  // In the page's content.
  if (selected === region) return trail;
  const section = chain[regionIndex + 1] as ChainLink;
  trail.push({ level: 'section', label: section.label, clientId: section.clientId });
  if (selected !== section) {
    trail.push({ level: 'block', label: selected.label, clientId: selected.clientId });
  }
  return trail;
}
