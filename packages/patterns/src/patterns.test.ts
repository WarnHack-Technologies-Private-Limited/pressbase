import { readFileSync } from 'node:fs';
import { parseBlocks, serializeBlocks } from '@pressbase/blocks';
import {
  extractSlots,
  fillSlots,
  findPlaceholders,
  type GroupSlot,
  isPlaceholder,
  type Slot,
  slotsJsonSchema,
  slotValues,
} from '@pressbase/slots';
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

/** The sections of #42 and #43, by issue. */
const BATCH = {
  42: [
    'pricing-three-plans',
    'pricing-plan-rows',
    'pricing-price-list',
    'testimonials-cards',
    'testimonials-large-quote',
    'testimonials-split',
    'team-grid',
    'team-list',
    'faq-centered',
    'faq-split',
    'faq-two-columns',
  ],
  43: [
    'contact-cards',
    'contact-split-image',
    'contact-band',
    'opening-hours-card',
    'opening-hours-band',
    'header-simple',
    'header-with-button',
    'header-centered',
    'footer-centered',
    'footer-columns',
    'footer-hours',
  ],
};

const named = (name: string) => {
  const pattern = patterns.find((p) => p.name === `pressbase/${name}`);
  if (!pattern) throw new Error(`no pattern ${name}`);
  return pattern;
};
const slotsOf = (pattern: LibraryPattern) =>
  extractSlots(parseBlocks(pattern.content), { declarations: pattern.slots });
const groupOf = (pattern: LibraryPattern, id: string) =>
  slotsOf(pattern).find((s) => s.id === id) as GroupSlot;
/** Every leaf slot's value with its path, through groups. */
const leaves = (slots: Slot[], prefix = ''): [string, Slot][] =>
  slots.flatMap((slot): [string, Slot][] =>
    slot.kind === 'group'
      ? slot.items.flatMap((item, i) => leaves(item, `${prefix}${slot.id}.${i}.`))
      : [[`${prefix}${slot.id}`, slot]],
  );
const text = (slot: Slot): string => {
  if (slot.kind === 'group') return '';
  if (slot.kind === 'button') return slot.value.text;
  if (slot.kind === 'image') return slot.value.alt;
  return slot.value;
};

describe('pricing, testimonials, team and questions (#42); contact, hours, headers and footers (#43)', () => {
  const batch = [...BATCH[42], ...BATCH[43]].map(named);

  it('gives every section of the library two to four layouts', () => {
    for (const category of LIBRARY_CATEGORIES) {
      const count = patterns.filter((p) => p.categories[0] === category.name).length;
      expect(count, category.name).toBeGreaterThanOrEqual(2);
      expect(count, category.name).toBeLessThanOrEqual(4);
    }
    expect(batch).toHaveLength(22);
  });

  it('links to real addresses, never # or nowhere', () => {
    for (const pattern of batch) {
      for (const [, href] of pattern.content.matchAll(/\shref="([^"]*)"/g)) {
        expect(href, pattern.name).toMatch(/^(\/[a-z-]+\/|https:\/\/[a-z.]+\/)$/);
      }
      for (const [path, slot] of leaves(slotsOf(pattern))) {
        if (slot.kind === 'button') expect(slot.value.url, `${pattern.name} ${path}`).not.toBe('#');
      }
    }
  });

  it('never invents prices, quotes, people or contact details: they are placeholders', () => {
    const facts: Record<string, RegExp> = {
      'pricing-three-plans': /^plans\.\d\.price$/,
      'pricing-plan-rows': /^plans\.\d\.price$/,
      'pricing-price-list': /^prices\.\d\.price$/,
      'testimonials-cards': /^testimonials\.\d\.(body|citation)$/,
      'testimonials-large-quote': /^testimonials\.\d\.(body|citation)$/,
      'testimonials-split': /^testimonials\.\d\.(body|citation)$/,
      'team-grid': /^people\.\d\.(title|role|body)$/,
      'team-list': /^people\.\d\.(title|role|body)$/,
      'contact-cards': /^details\.\d\.body$/,
      'contact-split-image': /^details\.\d\.body$/,
      'contact-band': /^details\.\d\.body$/,
      'footer-columns': /^(address|phone|email)$/,
      'footer-hours': /^(address|phone|email)$/,
    };
    for (const [name, paths] of Object.entries(facts)) {
      const pattern = named(name);
      const found = leaves(slotsOf(pattern)).filter(([path]) => paths.test(path));
      expect(found.length, name).toBeGreaterThan(0);
      for (const [path, slot] of found) {
        expect(isPlaceholder(text(slot)), `${name} ${path}`).toBe(true);
        // A fact the AI wasn't given becomes the declared placeholder.
        expect(slot.facts, `${name} ${path}`).toBe(true);
        expect(slot.placeholder && isPlaceholder(slot.placeholder), `${name} ${path}`).toBe(true);
      }
    }
    // A name stays a name: testimonials and team members are `[Customer name]`-style.
    const cited = new Map(leaves(slotsOf(named('testimonials-cards'))));
    expect(text(cited.get('testimonials.0.citation') as Slot)).toBe('[Customer name]');
    const team = new Map(leaves(slotsOf(named('team-grid'))));
    expect(text(team.get('people.0.title') as Slot)).toBe('[Team member name]');
  });

  it('shares slot shapes within a section, so Swap layout carries the content', () => {
    const shapes = (name: string) =>
      slotsOf(named(name)).map((s) =>
        s.kind === 'group' && !s.flat
          ? `${s.id}(${(s.items[0] ?? []).map((c) => c.role).join(',')})`
          : `${s.id}`,
      );
    expect(shapes('pricing-three-plans')).toContain('plans(title,body,price,list,actions)');
    expect(shapes('pricing-plan-rows')).toContain('plans(title,body,price,actions)');
    expect(shapes('pricing-price-list')).toContain('prices(title,price,body)');
    for (const name of ['testimonials-cards', 'testimonials-large-quote', 'testimonials-split']) {
      expect(shapes(name), name).toContain('testimonials(body,citation)');
    }
    expect(shapes('team-grid')).toContain('people(media,title,job-title,body)');
    expect(shapes('team-list')).toContain('people(title,job-title,body)');
    for (const name of BATCH[42].filter((n) => n.startsWith('faq-'))) {
      expect(shapes(name), name).toContain('questions(summary,body)');
    }
    for (const name of ['contact-cards', 'contact-split-image', 'contact-band']) {
      expect(shapes(name), name).toContain('details(title,body)');
    }
  });

  it('asks questions with core/details, one per question', () => {
    for (const name of BATCH[42].filter((n) => n.startsWith('faq-'))) {
      const pattern = named(name);
      const questions = groupOf(pattern, 'questions');
      expect(questions.items.length, name).toBeGreaterThanOrEqual(5);
      expect(pattern.content.match(/<!-- wp:details -->/g), name).toHaveLength(
        questions.items.length,
      );
      // One more question copies the last; none is left out.
      const blocks = parseBlocks(pattern.content);
      const more = fillSlots(
        blocks,
        {
          questions: [...questions.items, []].map((_, i) => ({
            summary: `Question ${i + 1}?`,
            body: `Answer ${i + 1}.`,
          })),
        },
        { declarations: pattern.slots },
      );
      expect(serializeBlocks(more).match(/<summary>/g), name).toHaveLength(
        questions.items.length + 1,
      );
    }
  });

  it('lists opening hours as a real list, a line per day', () => {
    for (const name of ['opening-hours-card', 'opening-hours-band', 'footer-hours']) {
      const pattern = named(name);
      const hours = groupOf(pattern, 'hours');
      expect(hours, name).toMatchObject({ flat: true, facts: true, minItems: 1, maxItems: 7 });
      expect(pattern.content, name).toContain('<ul class="wp-block-list');
      const week = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      const blocks = parseBlocks(pattern.content);
      const filled = serializeBlocks(
        fillSlots(
          blocks,
          { hours: week.map((day) => `${day}: 7:00 – 15:00`) },
          {
            declarations: pattern.slots,
          },
        ),
      );
      expect(filled.match(/<li>/g), name).toHaveLength(7);
    }
    // The hours layouts are swappable with each other: the same slots in the same order.
    expect(
      slotsOf(named('opening-hours-card'))
        .map((s) => s.id)
        .sort(),
    ).toEqual(
      slotsOf(named('opening-hours-band'))
        .map((s) => s.id)
        .sort(),
    );
  });

  it('builds headers and footers for their template part from site blocks and the menu', () => {
    for (const area of ['header', 'footer'] as const) {
      const parts = patterns.filter((p) => p.categories[0] === area);
      expect(parts.map((p) => p.name).sort(), area).toEqual(
        BATCH[43]
          .filter((n) => n.startsWith(`${area}-`))
          .map((n) => `pressbase/${n}`)
          .sort(),
      );
      for (const pattern of parts) {
        expect(pattern.blockTypes, pattern.name).toEqual([`core/template-part/${area}`]);
        // The site's own title and menu: nothing to retype, nothing tied to one site.
        expect(pattern.content, pattern.name).toContain('<!-- wp:site-title');
        expect(pattern.content, pattern.name).toMatch(/<!-- wp:navigation \{(?![^}]*"ref")/);
        expect(pattern.content, pattern.name).not.toContain('wp:heading {"level":1');
      }
    }
    // A second menu on the page says which one it is.
    for (const name of BATCH[43].filter((n) => n.startsWith('footer-'))) {
      expect(named(name).content, name).toContain('"ariaLabel":"Footer"');
    }
    // Sections are never for a template part.
    for (const pattern of patterns.filter(
      (p) => !['header', 'footer'].includes(p.categories[0] ?? ''),
    )) {
      expect(pattern.blockTypes, pattern.name).toBeUndefined();
    }
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

  it('puts headers and footers in their template part, with the site’s menu', () => {
    const nav = '<!-- wp:navigation /-->';
    const part = (over: Partial<LibraryPattern>, content = nav) =>
      checkPattern(sample(content, { categories: ['header'], ...over }));
    expect(part({ blockTypes: ['core/template-part/header'] })).toEqual([]);
    expect(part({})).toEqual([
      'a header is for its template part: add "blockTypes": ["core/template-part/header"]',
    ]);
    expect(part({ categories: ['footer'], blockTypes: ['core/template-part/header'] })).toEqual([
      'a footer is for its template part: add "blockTypes": ["core/template-part/footer"]',
    ]);
    expect(checkPattern(sample(heading, { blockTypes: ['core/template-part/header'] }))).toEqual([
      'only headers and footers are for a template part',
    ]);
    expect(
      part({ blockTypes: ['core/template-part/header'] }, '<!-- wp:navigation {"ref":12} /-->'),
    ).toEqual(['core/navigation: "ref" names one site\'s menu; leave it out']);
  });

  it('keeps a declared group of one a group', () => {
    const quote =
      '<!-- wp:group {"metadata":{"name":"Quotes"},"layout":{"type":"constrained"}} -->\n<div class="wp-block-group"><!-- wp:quote -->\n<blockquote class="wp-block-quote"><!-- wp:paragraph -->\n<p>Good.</p>\n<!-- /wp:paragraph --><cite>[Customer name]</cite></blockquote>\n<!-- /wp:quote --></div>\n<!-- /wp:group -->';
    const content = `${heading}\n\n${quote}`;
    expect(checkPattern(sample(content, { slots: { quotes: { maxItems: 1 } } }))).toEqual([]);
    expect(checkPattern(sample(content, { slots: { quotes: { ignore: true } } }))).toEqual([
      "declared slots that don't exist: quotes",
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
