/**
 * The Sections panel (#44): which patterns are sections, how they're
 * grouped and ordered, and search. Pure functions over
 * `/wp/v2/block-patterns/patterns` and `/categories`, tested in
 * sections-model.test.ts. See docs/architecture/studio.md#the-sections-panel.
 */

import type { SlotDeclarations } from '@pressbase/slots';

/** A pattern as `/wp/v2/block-patterns/patterns` gives it (the fields Studio reads). */
export interface RestPattern {
  name: string;
  title: string;
  content: string;
  description?: string;
  categories?: string[];
  keywords?: string[];
  viewport_width?: number;
  inserter?: boolean;
  block_types?: string[];
  post_types?: string[];
  template_types?: string[];
  /** `core` (WordPress's and the Pressbase library), `theme`, or a plugin's. */
  source?: string;
  /** Pressbase: the pattern's declared slots (see @pressbase/slots), for Swap layout. */
  slots?: SlotDeclarations;
}

export interface RestPatternCategory {
  name: string;
  label: string;
  description?: string;
}

/** Where a pattern comes from, in the order the panel lists them; `saved`: the site's own (#36). */
export type SectionSource = 'library' | 'theme' | 'plugin' | 'saved';

export interface Section {
  name: string;
  title: string;
  description: string;
  content: string;
  /** The section's category: its first one ("banner" for heroes). */
  category: string;
  categories: string[];
  keywords: string[];
  viewportWidth: number;
  source: SectionSource;
  /** Declared slots, when the pattern has any (#45). */
  slots?: SlotDeclarations;
  /** A saved section that stays the same everywhere it's used (a synced pattern, #36). */
  synced?: boolean;
}

export interface SectionGroup {
  category: string;
  label: string;
  sections: Section[];
}

/** Categories for a site's header and footer, not for a page's sections. */
const PART_CATEGORIES = new Set(['header', 'footer']);

/**
 * Lists that cut across kinds of section ("Featured"), or a theme's own
 * collection (a category named like its patterns' namespace: `pressbase` for
 * `pressbase/pricing`): a section is filed under its first other category.
 */
const isCollection = (category: string, patternName: string) =>
  category === 'featured' || category === patternName.split('/')[0];

/**
 * The library (Pressbase's `pressbase/*` patterns registered by core) first,
 * then the theme's, then plugins'.
 */
export function sourceOf(pattern: Pick<RestPattern, 'name' | 'source'>): SectionSource {
  if (pattern.source === 'theme') return 'theme';
  if (pattern.source === 'core') return 'library';
  return 'plugin';
}

const SOURCE_RANK: Record<SectionSource, number> = { library: 0, theme: 1, plugin: 2, saved: 3 };

/**
 * The patterns that are page sections: shown in inserters, not for a
 * template part or another post type, and not a header or footer.
 */
export function sectionsOf(patterns: readonly RestPattern[]): Section[] {
  const out: Section[] = [];
  for (const pattern of patterns) {
    if (pattern.inserter === false) continue;
    // Parts of a header or footer, and whole-page starters (for core/post-content), aren't sections.
    if (
      pattern.block_types?.some(
        (type) => type.startsWith('core/template-part') || type === 'core/post-content',
      )
    ) {
      continue;
    }
    if (pattern.post_types?.length && !pattern.post_types.includes('page')) continue;
    if (pattern.template_types?.length) continue;
    const categories = (pattern.categories ?? []).filter((c) => !PART_CATEGORIES.has(c));
    if (pattern.categories?.length && !categories.length) continue;
    const own = categories.find((c) => !isCollection(c, pattern.name)) ?? categories[0];
    out.push({
      name: pattern.name,
      title: pattern.title,
      description: pattern.description ?? '',
      content: pattern.content,
      category: own ?? 'uncategorized',
      categories: categories.length ? categories : ['uncategorized'],
      keywords: pattern.keywords ?? [],
      viewportWidth: pattern.viewport_width || 1200,
      source: sourceOf(pattern),
      ...(pattern.slots ? { slots: pattern.slots } : {}),
    });
  }
  // Stable: the library first, then the theme, then plugins; registration order within each.
  return out
    .map((section, index) => ({ section, index }))
    .sort(
      (a, b) => SOURCE_RANK[a.section.source] - SOURCE_RANK[b.section.source] || a.index - b.index,
    )
    .map(({ section }) => section);
}

/** The category saved sections are listed under. */
export const SAVED_CATEGORY = 'pressbase-saved';

/** A pattern the site saved (`wp_block`, /wp/v2/blocks?context=edit): the fields Studio reads. */
export interface RestSavedPattern {
  id: number;
  title: { raw?: string; rendered?: string };
  content: { raw?: string };
  /** '' (synced, WordPress's default), 'partial' or 'unsynced'. */
  wp_pattern_sync_status?: string;
  status?: string;
}

/**
 * The site's saved sections (#36: *Save as section* on the canvas), as
 * WordPress's inserter lists "My patterns": named `core/block/{id}`; a
 * synced one goes in as a reference to it (`core/block` with `ref`), an
 * unsynced one as a copy of its blocks. Listed after the others.
 */
export function savedSectionsOf(posts: readonly RestSavedPattern[]): Section[] {
  return posts
    .filter((post) => !post.status || post.status === 'publish')
    .map((post) => {
      const synced = !post.wp_pattern_sync_status;
      return {
        name: `core/block/${post.id}`,
        title: post.title.raw || post.title.rendered || `#${post.id}`,
        description: '',
        content: synced ? `<!-- wp:block {"ref":${post.id}} /-->` : (post.content.raw ?? ''),
        category: SAVED_CATEGORY,
        categories: [SAVED_CATEGORY],
        keywords: [],
        viewportWidth: 1200,
        source: 'saved' as const,
        synced,
      };
    });
}

const normalize = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Whether a section matches every word of a search, in its title, category, keywords or description. */
export function matches(
  section: Section,
  search: string,
  labels: ReadonlyMap<string, string> = new Map(),
): boolean {
  const words = normalize(search).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = normalize(
    [
      section.title,
      section.description,
      ...section.keywords,
      ...section.categories.map((c) => labels.get(c) ?? c),
    ].join(' '),
  );
  return words.every((word) => haystack.includes(word));
}

/**
 * Sections by category: each section under its own (first) category,
 * categories in the order of their first section (so the library's lead),
 * "Uncategorized" last. `category` narrows to one: there, every section in
 * it, its own or not.
 */
export function groupSections(
  sections: readonly Section[],
  categories: readonly RestPatternCategory[],
  { search = '', category = '' }: { search?: string; category?: string } = {},
): SectionGroup[] {
  const labels = new Map(categories.map((c) => [c.name, c.label]));
  const found = sections.filter((s) => matches(s, search, labels));
  const label = (name: string) =>
    labels.get(name) ?? (name === 'uncategorized' ? 'Uncategorized' : name);
  if (category) {
    const inCategory = found.filter((s) => s.categories.includes(category));
    return inCategory.length ? [{ category, label: label(category), sections: inCategory }] : [];
  }
  const groups = new Map<string, SectionGroup>();
  for (const section of found) {
    const group = groups.get(section.category) ?? {
      category: section.category,
      label: label(section.category),
      sections: [],
    };
    group.sections.push(section);
    groups.set(section.category, group);
  }
  const out = [...groups.values()];
  return [
    ...out.filter((g) => g.category !== 'uncategorized'),
    ...out.filter((g) => g.category === 'uncategorized'),
  ];
}

/** The categories that hold sections, for the category picker, with how many each has. */
export function sectionCategories(
  sections: readonly Section[],
  categories: readonly RestPatternCategory[],
): { name: string; label: string; count: number }[] {
  return groupSections(sections, categories).map((group) => ({
    name: group.category,
    label: group.label,
    count: sections.filter((s) => s.categories.includes(group.category)).length,
  }));
}

/* ------------------------------------------------------- ＋ Add section */

/** The ＋ Add section pill's height, and the round ＋ used where there's less room. */
const PILL = 28;
const ROUND = 24;

/**
 * Where ＋ Add section goes on one side of a section, so it never covers
 * the page: in the gap beside the section (at most 20px from its edge) when
 * the pill fits there; a small round ＋ in a narrower gap; and where
 * sections touch, a round ＋ at the left end of the edge, outside the
 * section's outline (#44 put the pill across the edge, over the text).
 */
export function addButtonPlace(
  edge: number,
  space: number,
  side: 'above' | 'below',
  box: { left: number; width: number },
): { top: number; left: number; round: boolean } {
  const direction = side === 'above' ? -1 : 1;
  const middle = box.left + box.width / 2;
  if (space >= PILL + 4) {
    return { top: edge + direction * Math.min(space / 2, 20), left: middle, round: false };
  }
  if (space >= ROUND + 2) return { top: edge + (direction * space) / 2, left: middle, round: true };
  return { top: edge, left: box.left - ROUND / 2 - 2, round: true };
}
