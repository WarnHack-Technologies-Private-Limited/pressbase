import { parseBlocks, serializeBlocks } from '@pressbase/blocks';
import {
  extractSlots,
  fillSlots,
  findPlaceholders,
  type GroupSlot,
  slotsJsonSchema,
  slotValues,
} from '@pressbase/slots';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkPattern,
  LIBRARY_CATEGORIES,
  type LibraryPattern,
  libraryPatterns,
  PORTABLE_PRESETS,
  PRESSBASE_PRESETS,
} from './index';

const patterns = libraryPatterns();

const SECTIONS = [
  'hero',
  'about',
  'features',
  'services',
  'pricing',
  'testimonials',
  'team',
  'faq',
  'gallery',
  'contact',
  'opening-hours',
  'call-to-action',
  'header',
  'footer',
];

const sample = (content: string, over: Partial<LibraryPattern> = {}): LibraryPattern => ({
  name: 'pressbase/test',
  title: 'Test',
  categories: ['about'],
  keywords: ['test'],
  viewportWidth: 1000,
  content,
  ...over,
});

const heading =
  '<!-- wp:heading -->\n<h2 class="wp-block-heading">About us</h2>\n<!-- /wp:heading -->';

describe('the pattern library', () => {
  it('has the section categories, with WordPress names where they exist', () => {
    expect(LIBRARY_CATEGORIES.map((c) => c.section)).toEqual(SECTIONS);
    expect(LIBRARY_CATEGORIES.find((c) => c.section === 'hero')?.name).toBe('banner');
    expect(LIBRARY_CATEGORIES.filter((c) => !c.wordpress).map((c) => c.name)).toEqual([
      'features',
      'pricing',
      'faq',
      'opening-hours',
    ]);
  });

  it('reads every pattern with its metadata', () => {
    expect(patterns.map((p) => p.name)).toEqual(
      expect.arrayContaining(['pressbase/hero-centered', 'pressbase/opening-hours']),
    );
    const hero = patterns.find((p) => p.name === 'pressbase/hero-centered');
    expect(hero).toMatchObject({ title: 'Hero, centred', categories: ['banner', 'featured'] });
    expect(hero?.content.startsWith('<!-- wp:group')).toBe(true);
    expect(hero?.content.endsWith('<!-- /wp:group -->')).toBe(true);
  });

  for (const pattern of patterns) {
    describe(pattern.name, () => {
      it('follows the rules', () => {
        expect(checkPattern(pattern)).toEqual([]);
      });

      it('has slots that fill back to the same markup', () => {
        const blocks = parseBlocks(pattern.content);
        const options = { declarations: pattern.slots };
        const slots = extractSlots(blocks, options);
        expect(serializeBlocks(fillSlots(blocks, slotValues(slots), options))).toBe(
          pattern.content,
        );
        expect(slotsJsonSchema(slots)).toMatchObject({ type: 'object' });
      });
    });
  }
});

describe('opening hours', () => {
  const pattern = patterns.find((p) => p.name === 'pressbase/opening-hours') as LibraryPattern;
  const blocks = parseBlocks(pattern.content);
  const options = { declarations: pattern.slots };

  it('declares its days as a repeated group of facts', () => {
    const slots = extractSlots(blocks, options);
    expect(slots.map((s) => s.id)).toEqual(['title', 'body', 'note', 'actions', 'hours']);
    const hours = slots.find((s) => s.id === 'hours') as GroupSlot;
    expect(hours).toMatchObject({ minItems: 1, maxItems: 7, facts: true, flat: false });
    expect(
      hours.items.map((item) => item.map((s) => (s.kind === 'group' ? null : s.value))),
    ).toEqual([
      ['Monday to Friday', '8:00 – 18:00'],
      ['Saturday', '9:00 – 14:00'],
      ['Sunday', 'Closed'],
    ]);
  });

  it('takes a week of hours, or placeholders when none are known', () => {
    const week = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const filled = fillSlots(
      blocks,
      { hours: week.map((day) => ({ day, time: day === 'Sunday' ? 'Closed' : '7:00 – 15:00' })) },
      options,
    );
    expect(serializeBlocks(filled).match(/"name":"Day and time"/g)).toHaveLength(7);
    const unknown = fillSlots(
      blocks,
      {
        hours: [{ day: '[Add days]', time: '[Add hours]' }],
        note: '[Add holiday closures, or remove this line]',
      },
      options,
    );
    const found = findPlaceholders(extractSlots(unknown, options)).map((f) => f.path);
    expect(found).toEqual(['note', 'actions.0', 'hours.0.day', 'hours.0.time']);
  });
});

describe('checkPattern', () => {
  it('passes a pattern that follows the rules', () => {
    expect(checkPattern(sample(heading))).toEqual([]);
  });

  it('fails raw colours and sizes', () => {
    const raw = (attrs: string, html: string) =>
      checkPattern(
        sample(
          `<!-- wp:group ${attrs} -->\n<div class="wp-block-group"${html}>${heading}</div>\n<!-- /wp:group -->`,
        ),
      );
    expect(
      raw('{"style":{"color":{"background":"#ff0000"}}}', ' style="background-color:#ff0000"'),
    ).toEqual([
      'core/group style.color.background: "#ff0000" is a raw value; use a preset',
      'core/group: inline style "background-color:#ff0000" has a raw value',
    ]);
    expect(
      raw('{"style":{"spacing":{"padding":{"top":"24px"}}}}', ' style="padding-top:24px"'),
    ).toHaveLength(2);
    expect(raw('{"style":{"typography":{"fontSize":"3rem"}}}', '')).toHaveLength(1);
    expect(raw('{"style":{"color":{"text":"red"}}}', '')).toEqual([
      'core/group style.color.text: "red" isn\'t a preset',
    ]);
    expect(raw('{"customBackgroundColor":"#fff"}', '')[0]).toContain('custom colour');
    expect(raw('{"layout":{"type":"constrained","contentSize":"640px"}}', '')).toEqual([
      'core/group: layout.contentSize is a raw size',
    ]);
    expect(raw('{"backgroundColor":"accent-3"}', '')[0]).toContain("isn't one every theme has");
    // The Pressbase theme's presets, which every generated design restyles.
    expect(
      raw(
        '{"backgroundColor":"accent-soft","fontSize":"display","style":{"border":{"radius":"var:preset|border-radius|xl"}}}',
        ' style="border-radius:var(--wp--preset--border-radius--xl)"',
      ),
    ).toEqual([]);
    expect(raw('{"style":{"border":{"radius":"var:preset|border-radius|huge"}}}', '')).toEqual([
      'core/group style.border.radius: the border-radius preset "huge" isn\'t one every theme has',
    ]);
    // A grid wraps at a minimum column width in rem.
    expect(raw('{"layout":{"type":"grid","minimumColumnWidth":"16rem"}}', '')).toEqual([]);
    expect(raw('{"layout":{"type":"grid","minimumColumnWidth":"240px"}}', '')).toEqual([
      'core/group: layout.minimumColumnWidth must be in rem',
    ]);
    expect(
      raw(
        '{"style":{"spacing":{"padding":{"top":"var:preset|spacing|50"}}}}',
        ' style="padding-top:var(--wp--preset--spacing--50)"',
      ),
    ).toEqual([]);
  });

  it('takes a column’s width as a share of the row', () => {
    const column = (width: string) =>
      checkPattern(
        sample(
          `${heading}\n\n<!-- wp:columns -->\n<div class="wp-block-columns"><!-- wp:column {"width":"${width}"} -->\n<div class="wp-block-column" style="flex-basis:${width}"><!-- wp:paragraph -->\n<p>Text</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:column --></div>\n<!-- /wp:columns -->`,
        ),
      );
    expect(column('40%')).toEqual([]);
    expect(column('320px')).toEqual([
      'core/column: "width" is a raw value ("320px")',
      'core/column: inline style "flex-basis:320px" has a raw value',
    ]);
  });

  it('allows the Pressbase theme’s presets, which its theme.json defines', () => {
    const theme = JSON.parse(
      readFileSync(new URL('../../../themes/pressbase/theme.json', import.meta.url), 'utf8'),
    );
    const slugs = (list: { slug: string }[]) => list.map((p) => p.slug);
    expect(slugs(theme.settings.color.palette)).toEqual(
      expect.arrayContaining([...PRESSBASE_PRESETS.color, ...PORTABLE_PRESETS.color]),
    );
    expect(slugs(theme.settings.typography.fontSizes)).toEqual(
      expect.arrayContaining([...PRESSBASE_PRESETS['font-size'], ...PORTABLE_PRESETS['font-size']]),
    );
    expect(slugs(theme.settings.border.radiusSizes)).toEqual(
      expect.arrayContaining([...PRESSBASE_PRESETS['border-radius']]),
    );
  });

  it('fails other blocks, scripts, theme classes and fonts', () => {
    const problems = checkPattern(
      sample(
        `${heading}\n\n<!-- wp:acme/slider /-->\n\n<!-- wp:html -->\n<script>alert(1)</script>\n<!-- /wp:html -->\n\n<!-- wp:paragraph {"className":"is-style-pill","fontFamily":"manrope"} -->\n<p class="is-style-pill has-manrope-font-family" onclick="x()">Hi</p>\n<!-- /wp:paragraph -->`,
      ),
    );
    expect(problems).toEqual([
      'acme/slider: only core blocks are allowed',
      'core/html: not allowed in a library pattern',
      "core/html: scripts, styles and frames aren't allowed",
      'core/paragraph: fonts come from the theme ("fontFamily" is set)',
      'core/paragraph: class "is-style-pill" depends on a theme; use core block styles only',
      "core/paragraph: event handler attributes aren't allowed",
    ]);
  });

  it('checks headings, alt text, categories and declared slots', () => {
    const h3 = heading.replace('wp:heading -->', 'wp:heading {"level":4} -->').replace(/h2/g, 'h4');
    expect(checkPattern(sample(`${heading}\n\n${h3}`))).toEqual([
      'heading levels skip from h2 to h4',
    ]);
    expect(checkPattern(sample(heading, { categories: ['banner'] }))).toEqual([
      'the section must open with one h1, not h2',
    ]);
    const image =
      '<!-- wp:image -->\n<figure class="wp-block-image"><img src="/a.jpg" alt=""/></figure>\n<!-- /wp:image -->';
    expect(checkPattern(sample(`${heading}\n\n${image}`))).toEqual([
      'image "media" needs alt text that says what it shows',
    ]);
    expect(checkPattern(sample(heading, { categories: ['misc'] }))[0]).toContain('must be one of');
    expect(checkPattern(sample(heading, { slots: { subtitle: {} } }))).toEqual([
      "declared slots that don't exist: subtitle",
    ]);
  });
});
