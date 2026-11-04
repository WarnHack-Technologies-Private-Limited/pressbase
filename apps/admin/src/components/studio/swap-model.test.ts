import { type ParsedBlock, parseBlocks } from '@pressbase/blocks';
import { describe, expect, it } from 'vitest';
import {
  type LayoutPattern,
  personalName,
  sectionLayouts,
  sectionName,
  sectionSlots,
  shapeOf,
  swapLayout,
  swapSource,
  unusedText,
  withPlaceholders,
} from './swap-model';

const heading = (text: string, level = 1) =>
  `<!-- wp:heading {"level":${level}} -->\n<h${level} class="wp-block-heading">${text}</h${level}>\n<!-- /wp:heading -->`;
const paragraph = (text: string) => `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;
const button = (text: string) =>
  `<!-- wp:button -->\n<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#">${text}</a></div>\n<!-- /wp:button -->`;
const buttons = (...items: string[]) =>
  `<!-- wp:buttons -->\n<div class="wp-block-buttons">${items.join('\n\n')}</div>\n<!-- /wp:buttons -->`;
const group = (inner: string[], attrs = '') =>
  `<!-- wp:group ${attrs ? `${attrs} ` : ''}-->\n<div class="wp-block-group">${inner.join('\n\n')}</div>\n<!-- /wp:group -->`;
const column = (inner: string[]) =>
  `<!-- wp:column -->\n<div class="wp-block-column">${inner.join('\n\n')}</div>\n<!-- /wp:column -->`;
const columns = (...items: string[]) =>
  `<!-- wp:columns -->\n<div class="wp-block-columns">${items.join('\n\n')}</div>\n<!-- /wp:columns -->`;

const pattern = (name: string, content: string, extra: Partial<LayoutPattern> = {}) => ({
  name,
  title: name,
  content,
  category: 'banner',
  categories: ['banner', 'featured'],
  ...extra,
});

const HERO = pattern(
  'pressbase/hero',
  group([
    heading('A headline that says what you do'),
    paragraph('One or two sentences.'),
    buttons(button('Get started'), button('Learn more')),
  ]),
);
const CENTRED = pattern(
  'pressbase/hero-centered',
  group([
    paragraph('Repairs and upkeep'),
    heading('Good work, done properly'),
    paragraph('Tell us what needs doing.'),
    buttons(button('Ask for a quote'), button('See our work')),
  ]),
  { slots: { actions: { maxItems: 2 } } },
);
const SIMPLE = pattern('pressbase/simple', group([heading('Just a headline')]));
const TWO_PARTS = pattern('pressbase/two', `${paragraph('One')}\n\n${paragraph('Two')}`);
const CARDS = (n: number) =>
  pattern(
    `pressbase/cards-${n}`,
    group([
      heading('What we do', 2),
      columns(
        ...Array.from({ length: n }, (_, i) =>
          column([heading(`Card ${i + 1}`, 3), paragraph(`About card ${i + 1}.`)]),
        ),
      ),
    ]),
    { category: 'services', categories: ['services'] },
  );
const ABOUT = pattern('pressbase/about', group([heading('About us', 2)]), {
  category: 'about',
  categories: ['about'],
});

const LIBRARY = [HERO, ABOUT, CENTRED, TWO_PARTS, SIMPLE];

describe('shapeOf', () => {
  it('counts runs of alike blocks once, and ignores text and attributes', () => {
    const three = sectionSlotsShape(CARDS(3).content);
    expect(three).toBe(sectionSlotsShape(CARDS(4).content));
    expect(three).toBe(
      'core/group(core/heading2,core/columns(core/column(core/heading3,core/paragraph)))',
    );
    expect(sectionSlotsShape(HERO.content)).not.toBe(sectionSlotsShape(CENTRED.content));
  });
});

function sectionSlotsShape(markup: string) {
  return shapeOf(parseBlocks(markup)[0] as ParsedBlock);
}

describe('sectionLayouts', () => {
  it('finds a section’s pattern by name, and the others of its category in library order', () => {
    const markup = group(
      [heading('Fresh bread')],
      '{"metadata":{"patternName":"pressbase/hero-centered"}}',
    );
    const found = sectionLayouts(markup, LIBRARY);
    expect(found?.current.name).toBe('pressbase/hero-centered');
    // Single-block patterns of the category only: not "two", not "about".
    expect(found?.layouts.map((p) => p.name)).toEqual([
      'pressbase/hero',
      'pressbase/hero-centered',
      'pressbase/simple',
    ]);
    expect(found?.index).toBe(1);
  });

  it('matches a section without a pattern name by its shape', () => {
    const edited = group([
      heading('Fresh bread, every morning'),
      paragraph('Baked in the night.'),
      buttons(button('See the menu')),
    ]);
    expect(sectionLayouts(edited, LIBRARY)?.current.name).toBe('pressbase/hero');
  });

  it('is null for a section that matches no pattern, or several blocks', () => {
    expect(sectionLayouts(paragraph('Hello'), LIBRARY)).toBeNull();
    expect(sectionLayouts(`${paragraph('A')}${paragraph('B')}`, LIBRARY)).toBeNull();
    expect(sectionLayouts('', LIBRARY)).toBeNull();
  });

  it('falls back to the shape when the named pattern is gone', () => {
    const markup = group([heading('Just this')], '{"metadata":{"patternName":"theme/removed"}}');
    expect(sectionLayouts(markup, LIBRARY)?.current.name).toBe('pressbase/simple');
  });
});

describe('swapLayout', () => {
  const section = group([
    heading('Fresh bread, every morning'),
    paragraph('Sourdough, rye and croissants, baked in the night.'),
    buttons(button('See the menu'), button('Find us')),
  ]);

  it('moves the text into the next layout and names the pattern', () => {
    const { markup, unused } = swapLayout(sectionSlots(section, HERO), CENTRED);
    expect(markup).toContain('Fresh bread, every morning');
    expect(markup).toContain('Sourdough, rye and croissants');
    expect(markup).toContain('See the menu');
    expect(markup).toContain('Find us');
    // The label the hero had no text for is a placeholder, not another business's sample text.
    expect(markup).not.toContain('Repairs and upkeep');
    expect(markup).toContain('[Add a short label]');
    expect(markup).toContain('"patternName":"pressbase/hero-centered"');
    expect(unused).toEqual([]);
  });

  it('there and back gives the same text', () => {
    const there = swapLayout(sectionSlots(section, HERO), CENTRED);
    const back = swapLayout(sectionSlots(there.markup, CENTRED), HERO);
    for (const text of [
      'Fresh bread, every morning',
      'baked in the night',
      'See the menu',
      'Find us',
    ]) {
      expect(back.markup).toContain(text);
    }
  });

  it('reports what a smaller layout has no room for', () => {
    const { markup, unused } = swapLayout(sectionSlots(section, HERO), SIMPLE);
    expect(markup).toContain('Fresh bread, every morning');
    expect(unused.map(unusedText)).toEqual([
      'Sourdough, rye and croissants, baked in the night.',
      'See the menu',
      'Find us',
    ]);
  });

  it('reports a fourth card going into three columns', () => {
    const four = CARDS(4);
    const { markup, unused } = swapLayout(sectionSlots(four.content, four), CARDS(3));
    expect(markup).toContain('Card 3');
    expect(markup).not.toContain('Card 4');
    expect(unused.map(unusedText)).toEqual(['Card 4', 'About card 4.']);
  });

  it('keeps the name the person gave the section, not as content', () => {
    const named = group(
      [heading('Fresh bread'), paragraph('Baked at night.'), buttons(button('Menu'))],
      '{"metadata":{"name":"Welcome"}}',
    );
    expect(sectionName(named)).toBe('Welcome');
    const slots = sectionSlots(named, HERO);
    expect(slots.map((s) => s.id)).toContain('title');
    const { markup } = swapLayout(slots, CENTRED, { name: 'Welcome' });
    expect(markup).toContain('"name":"Welcome"');
  });

  it('tells a name the person gave from one that came with the pattern', () => {
    const named = (name: string) =>
      group([heading('Fresh bread')], `{"metadata":{"name":"${name}"}}`);
    const withOwnName = pattern('own', group([heading('Hi')], '{"metadata":{"name":"Hero"}}'));
    expect(personalName(named('Welcome'), withOwnName)).toBe('Welcome');
    expect(personalName(named('Hero'), withOwnName)).toBe('');
    expect(personalName(named('own'), withOwnName)).toBe('');
  });
});

describe('swapSource', () => {
  const section = group([
    heading('Fresh bread'),
    paragraph('Baked at night.'),
    buttons(button('Menu'), button('Find us')),
  ]);

  it('starts again from the original while the section is as the last swap left it', () => {
    const origin = sectionSlots(section, HERO);
    const first = swapLayout(origin, SIMPLE);
    const memory = { origin, produced: first.markup, kept: first.unused };
    const { from, carried } = swapSource(memory, first.markup, SIMPLE);
    expect(from).toBe(origin);
    expect(carried).toEqual([]);
    // So swapping back to the hero has everything again.
    expect(swapLayout(from, HERO).markup).toContain('Find us');
  });

  it('starts from the section as it is after an edit, and still lists what was left out', () => {
    const origin = sectionSlots(section, HERO);
    const first = swapLayout(origin, SIMPLE);
    const memory = { origin, produced: first.markup, kept: first.unused };
    const edited = first.markup.replace('Fresh bread', 'Warm bread');
    const { from, carried } = swapSource(memory, edited, SIMPLE);
    expect(from.map((s) => (s as { value?: unknown }).value)).toEqual(['Warm bread']);
    expect(carried.map(unusedText)).toEqual(['Baked at night.', 'Menu', 'Find us']);
  });

  it('without a memory, reads the section', () => {
    expect(swapSource(undefined, section, HERO).from).toHaveLength(3);
  });
});

describe('withPlaceholders', () => {
  const slots = (markup: string) => sectionSlots(markup, {});

  it('puts placeholders in text and buttons the section had nothing for', () => {
    const target = slots(CENTRED.content);
    const values = withPlaceholders(target, { title: 'Fresh bread' });
    expect(values.title).toBe('Fresh bread');
    expect(values.eyebrow).toBe('[Add a short label]');
    expect(values.body).toBe('[Add text]');
    // The buttons group had no source: its fewest items, as placeholders.
    expect(values.actions).toEqual([{ text: '[Add a button label]', url: '#' }]);
  });

  it('fills the missing parts of each card, and uses the given words', () => {
    const target = slots(CARDS(3).content);
    const values = withPlaceholders(
      target,
      { items: [{ title: 'Bread' }, { title: 'Cakes', body: 'Every day.' }] },
      (slot) => `[${slot.role}]`,
    );
    expect(values.items).toEqual([
      { title: 'Bread', body: '[body]' },
      { title: 'Cakes', body: 'Every day.' },
    ]);
    expect(values.title).toBe('[title]');
  });
});
