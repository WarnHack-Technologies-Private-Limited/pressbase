import { describe, expect, it } from 'vitest';
import {
  addButtonPlace,
  groupSections,
  matches,
  type RestPattern,
  SAVED_CATEGORY,
  savedSectionsOf,
  sectionCategories,
  sectionsOf,
  sourceOf,
} from './sections-model';

const pattern = (name: string, extra: Partial<RestPattern> = {}): RestPattern => ({
  name,
  title: name.split('/')[1] ?? name,
  content: '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->',
  source: 'core',
  categories: ['text'],
  ...extra,
});

/** What /wp/v2/block-patterns/patterns lists on a fresh site, in registration order, abridged. */
const PATTERNS: RestPattern[] = [
  pattern('pressbase/hero', { title: 'Hero', categories: ['banner', 'featured'] }),
  pattern('pressbase/opening-hours', {
    title: 'Opening hours',
    categories: ['opening-hours', 'contact'],
    keywords: ['times', 'open'],
  }),
  pattern('pressbase/pricing', {
    title: 'Pricing, three tiers',
    source: 'theme',
    categories: ['pressbase', 'call-to-action', 'services'],
  }),
  pattern('pressbase/hero-gradient', {
    title: 'Hero with animated gradient',
    source: 'theme',
    categories: ['pressbase', 'banner', 'featured'],
  }),
  pattern('pressbase/footer', {
    source: 'theme',
    categories: ['footer'],
    block_types: ['core/template-part/footer'],
  }),
  pattern('pressbase/hidden-404', { source: 'theme', categories: undefined, inserter: false }),
  pattern('pressbase/page-landing', {
    source: 'theme',
    categories: ['pressbase_page', 'pressbase'],
    block_types: ['core/post-content'],
    post_types: ['page'],
  }),
  pattern('daily-tips/tip', { title: 'Tip of the day', source: 'plugin', categories: ['text'] }),
  pattern('pressbase/plain', { title: 'Plain', categories: [] }),
];

const CATEGORIES = [
  { name: 'banner', label: 'Banners' },
  { name: 'text', label: 'Text' },
  { name: 'call-to-action', label: 'Call to action' },
  { name: 'contact', label: 'Contact' },
  { name: 'opening-hours', label: 'Opening hours' },
  { name: 'pressbase', label: 'Pressbase' },
];

describe('sections', () => {
  it('are the patterns for a page: no headers, footers, hidden or whole-page patterns', () => {
    expect(sectionsOf(PATTERNS).map((s) => s.name)).toEqual([
      'pressbase/hero',
      'pressbase/opening-hours',
      'pressbase/plain',
      'pressbase/pricing',
      'pressbase/hero-gradient',
      'daily-tips/tip',
    ]);
  });

  it('come from the library first, then the theme, then plugins', () => {
    expect(sourceOf({ name: 'pressbase/hero', source: 'core' })).toBe('library');
    expect(sourceOf({ name: 'pressbase/pricing', source: 'theme' })).toBe('theme');
    expect(sourceOf({ name: 'daily-tips/tip', source: 'plugin' })).toBe('plugin');
  });

  it('are filed under their own kind, not a theme’s collection or Featured', () => {
    const byName = new Map(sectionsOf(PATTERNS).map((s) => [s.name, s]));
    expect(byName.get('pressbase/pricing')?.category).toBe('call-to-action');
    expect(byName.get('pressbase/hero-gradient')?.category).toBe('banner');
    expect(byName.get('pressbase/plain')?.category).toBe('uncategorized');
  });

  it('group by category, the library’s first, uncategorized last', () => {
    const groups = groupSections(sectionsOf(PATTERNS), CATEGORIES);
    expect(groups.map((g) => [g.label, g.sections.map((s) => s.title)])).toEqual([
      ['Banners', ['Hero', 'Hero with animated gradient']],
      ['Opening hours', ['Opening hours']],
      ['Call to action', ['Pricing, three tiers']],
      ['Text', ['Tip of the day']],
      ['Uncategorized', ['Plain']],
    ]);
  });

  it('narrow to one category, with every section in it', () => {
    const groups = groupSections(sectionsOf(PATTERNS), CATEGORIES, { category: 'contact' });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sections.map((s) => s.title)).toEqual(['Opening hours']);
    expect(
      sectionCategories(sectionsOf(PATTERNS), CATEGORIES).find((c) => c.name === 'banner'),
    ).toEqual({ name: 'banner', label: 'Banners', count: 2 });
  });

  it('are found by every word of a search, in title, keywords and category names', () => {
    const sections = sectionsOf(PATTERNS);
    const labels = new Map(CATEGORIES.map((c) => [c.name, c.label]));
    const hours = sections.find((s) => s.name === 'pressbase/opening-hours');
    if (!hours) throw new Error('No section.');
    expect(matches(hours, 'OPEN times', labels)).toBe(true);
    expect(matches(hours, 'contact', labels)).toBe(true);
    expect(matches(hours, 'pricing', labels)).toBe(false);
    expect(
      groupSections(sections, CATEGORIES, { search: 'hero' }).flatMap((g) =>
        g.sections.map((s) => s.title),
      ),
    ).toEqual(['Hero', 'Hero with animated gradient']);
    expect(groupSections(sections, CATEGORIES, { search: 'nothing like this' })).toEqual([]);
  });
});

describe('addButtonPlace', () => {
  const box = { left: 100, width: 600 };

  it('puts the pill in the gap beside the section, never across its edge', () => {
    // A 40px gap above: the pill (28px) sits 20px above the edge, clear of both sections.
    expect(addButtonPlace(500, 40, 'above', box)).toEqual({ top: 480, left: 400, round: false });
    expect(addButtonPlace(800, 40, 'below', box)).toEqual({ top: 820, left: 400, round: false });
    // A large gap: still close to the edge it belongs to.
    expect(addButtonPlace(800, 300, 'below', box).top).toBe(820);
  });

  it('uses a round ＋ in a narrower gap', () => {
    expect(addButtonPlace(500, 26, 'above', box)).toEqual({ top: 487, left: 400, round: true });
  });

  it('where sections touch, puts a round ＋ outside the outline, at the left', () => {
    const place = addButtonPlace(500, 0, 'below', box);
    expect(place.round).toBe(true);
    expect(place.top).toBe(500);
    // Its right side (12px from its centre) stays left of the section.
    expect(place.left + 12).toBeLessThan(box.left);
  });
});

describe('saved sections', () => {
  it('lists the site’s saved sections: synced ones by reference, unsynced ones as a copy', () => {
    const saved = savedSectionsOf([
      { id: 7, title: { raw: 'Our hours' }, content: { raw: '<!-- wp:group /-->' } },
      {
        id: 8,
        title: { raw: '', rendered: 'Price list' },
        content: { raw: '<!-- wp:paragraph --><p>€5</p><!-- /wp:paragraph -->' },
        wp_pattern_sync_status: 'unsynced',
      },
      { id: 9, title: { raw: 'Draft' }, content: { raw: '' }, status: 'draft' },
    ]);
    expect(saved.map((s) => [s.name, s.title, s.synced, s.source])).toEqual([
      ['core/block/7', 'Our hours', true, 'saved'],
      ['core/block/8', 'Price list', false, 'saved'],
    ]);
    expect(saved[0]?.content).toBe('<!-- wp:block {"ref":7} /-->');
    expect(saved[1]?.content).toContain('€5');
    // After the library's, in their own group.
    const groups = groupSections(
      [
        ...sectionsOf([pattern('pressbase/hero', { categories: ['banner'], source: 'core' })]),
        ...saved,
      ],
      [{ name: SAVED_CATEGORY, label: 'Saved sections' }],
    );
    expect(groups.map((g) => g.label)).toEqual(['banner', 'Saved sections']);
  });
});
