import { type ParsedBlock, parseBlocks, serializeBlocks } from '@pressbase/blocks';
import { describe, expect, it } from 'vitest';
import {
  applyPageOperations,
  applyPartOperation,
  type BlockCodec,
  type EditBlock,
  type EditContext,
  type EditPattern,
  menuMarkup,
  mergeAttributes,
  planEdits,
  renderPattern,
} from './ai-edits-model';

/**
 * Blocks as Studio's canvas has them, made from markup with
 * @pressbase/blocks: each gets a client ID, as @wordpress/blocks' parse() gives.
 */
interface TestBlock extends EditBlock {
  parsed: ParsedBlock;
  innerBlocks: TestBlock[];
}
let ids = 0;
function toBlock(parsed: ParsedBlock): TestBlock {
  return {
    clientId: `b${++ids}`,
    name: parsed.blockName ?? '',
    attributes: parsed.attrs,
    innerBlocks: parsed.innerBlocks.filter((b) => b.blockName !== null).map(toBlock),
    parsed,
  };
}
function toParsed(block: TestBlock): ParsedBlock {
  return {
    ...block.parsed,
    attrs: block.attributes,
    innerBlocks: block.innerBlocks.map(toParsed),
  };
}
const codec: BlockCodec<TestBlock> = {
  fromMarkup: (markup) =>
    parseBlocks(markup)
      .filter((b) => b.blockName !== null)
      .map(toBlock),
  toMarkup: (blocks) => serializeBlocks(blocks.map(toParsed)),
};

const group = (pattern: string, inner: string) =>
  `<!-- wp:group {"metadata":{"patternName":"${pattern}"}} --><div class="wp-block-group">${inner}</div><!-- /wp:group -->`;
const heading = (text: string, level = 2) =>
  `<!-- wp:heading {"level":${level}} --><h${level} class="wp-block-heading">${text}</h${level}><!-- /wp:heading -->`;
const paragraph = (text: string) => `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;

const PATTERNS: EditPattern[] = [
  { name: 'test/hero', content: group('test/hero', heading('Big words', 1) + paragraph('Sample')) },
  { name: 'test/faq', content: group('test/faq', heading('Questions') + paragraph('An answer')) },
  { name: 'test/cta', content: group('test/cta', heading('Visit us')) },
  {
    name: 'test/header',
    content: group('test/header', paragraph('Site name')),
  },
];
const patterns = new Map(PATTERNS.map((p) => [p.name, p]));

const page = () =>
  codec.fromMarkup(
    [
      group('test/hero', heading('Fresh bread', 1) + paragraph('Every morning.')),
      group('test/cta', heading('Come in')),
    ].join('\n\n'),
  );

const text = (blocks: TestBlock[]) => codec.toMarkup(blocks).replace(/<[^>]*>/g, ' ');
const words = (blocks: TestBlock[]) => text(blocks).split(/\s+/).filter(Boolean).join(' ');

describe('applyPageOperations()', () => {
  it('insertSection: renders the pattern with its slots filled, at the end by default', () => {
    const start = page();
    const { sections, changed } = applyPageOperations(
      start,
      [{ type: 'insertSection', pattern: 'test/faq', slots: { title: 'Questions people ask' } }],
      patterns,
      codec,
    );
    expect(sections).toHaveLength(3);
    expect(sections.slice(0, 2)).toEqual(start); // untouched sections keep their blocks
    expect(words([sections[2] as TestBlock])).toBe('Questions people ask An answer');
    expect(sections[2]?.attributes.metadata).toEqual({ patternName: 'test/faq' });
    expect([...changed]).toEqual([sections[2]?.clientId]);
  });

  it('insertSection: at a place, and refuses one past the end', () => {
    const { sections } = applyPageOperations(
      page(),
      [{ type: 'insertSection', pattern: 'test/faq', index: 0 }],
      patterns,
      codec,
    );
    expect(sections[0]?.attributes.metadata).toEqual({ patternName: 'test/faq' });
    expect(() =>
      applyPageOperations(
        page(),
        [{ type: 'insertSection', pattern: 'test/faq', index: 3 }],
        patterns,
        codec,
      ),
    ).toThrow('no_section');
  });

  it('replaceSection: moves the content into the new pattern, unless asked not to', () => {
    const kept = applyPageOperations(
      page(),
      [{ type: 'replaceSection', index: 0, pattern: 'test/faq' }],
      patterns,
      codec,
    );
    expect(words([kept.sections[0] as TestBlock])).toBe('Fresh bread Every morning.');
    expect(kept.sections[0]?.attributes.metadata).toEqual({ patternName: 'test/faq' });
    const fresh = applyPageOperations(
      page(),
      [{ type: 'replaceSection', index: 0, pattern: 'test/faq', keep_content: false }],
      patterns,
      codec,
    );
    expect(words([fresh.sections[0] as TestBlock])).toBe('Questions An answer');
  });

  it('replaceSection: lists what the new layout has no place for', () => {
    const { unused } = applyPageOperations(
      page(),
      [{ type: 'replaceSection', index: 0, pattern: 'test/cta' }],
      patterns,
      codec,
    );
    expect(unused).toEqual(['Every morning.']);
  });

  it('moveSection: moves a section, keeping its blocks, and highlights it', () => {
    const start = page();
    const { sections, changed } = applyPageOperations(
      start,
      [{ type: 'moveSection', index: 0, to: 1 }],
      patterns,
      codec,
    );
    expect(sections).toEqual([start[1], start[0]]);
    expect([...changed]).toEqual([start[0]?.clientId]);
    expect(() =>
      applyPageOperations(start, [{ type: 'moveSection', index: 0, to: 2 }], patterns, codec),
    ).toThrow('no_section');
  });

  it('removeSection: takes a section out', () => {
    const start = page();
    const { sections, changed } = applyPageOperations(
      start,
      [{ type: 'removeSection', index: 0 }],
      patterns,
      codec,
    );
    expect(sections).toEqual([start[1]]);
    expect(changed.size).toBe(0);
  });

  it('updateSlots: writes plain text into the section’s slots, and refuses unknown slots', () => {
    const { sections } = applyPageOperations(
      page(),
      [{ type: 'updateSlots', index: 0, slots: { title: 'Bread & <b>cake</b>' } }],
      patterns,
      codec,
    );
    const markup = codec.toMarkup([sections[0] as TestBlock]);
    expect(markup).toContain('Bread &amp; &lt;b&gt;cake&lt;/b&gt;');
    expect(markup).toContain('Every morning.');
    expect(() =>
      applyPageOperations(
        page(),
        [{ type: 'updateSlots', index: 0, slots: { price: '£3' } }],
        patterns,
        codec,
      ),
    ).toThrow('no_slot');
  });

  it('updateBlockAttributes: sets presets on the section or a block inside it', () => {
    const start = page();
    const { sections, changed } = applyPageOperations(
      start,
      [
        { type: 'updateBlockAttributes', index: 0, attributes: { backgroundColor: 'accent' } },
        {
          type: 'updateBlockAttributes',
          index: 0,
          block: [0],
          attributes: { textAlign: 'center' },
        },
      ],
      patterns,
      codec,
    );
    const section = sections[0] as TestBlock;
    expect(section.clientId).toBe(start[0]?.clientId);
    expect(section.attributes.backgroundColor).toBe('accent');
    expect(section.innerBlocks[0]?.attributes.textAlign).toBe('center');
    expect(start[0]?.attributes.backgroundColor).toBeUndefined(); // the start is unchanged
    expect([...changed]).toEqual([section.clientId, section.innerBlocks[0]?.clientId]);
    expect(() =>
      applyPageOperations(
        start,
        [{ type: 'updateBlockAttributes', index: 0, block: [5], attributes: { align: 'wide' } }],
        patterns,
        codec,
      ),
    ).toThrow('no_block');
  });

  it('reads each index after the operations before it', () => {
    const start = page();
    const { sections } = applyPageOperations(
      start,
      [
        { type: 'insertSection', pattern: 'test/faq', index: 0 },
        { type: 'removeSection', index: 1 },
      ],
      patterns,
      codec,
    );
    expect(
      sections.map((s) => (s.attributes.metadata as { patternName: string }).patternName),
    ).toEqual(['test/faq', 'test/cta']);
  });

  it('refuses a pattern that isn’t there', () => {
    expect(() =>
      applyPageOperations(
        page(),
        [{ type: 'insertSection', pattern: 'test/nope' }],
        patterns,
        codec,
      ),
    ).toThrow('no_pattern');
  });
});

describe('mergeAttributes()', () => {
  it('sets presets, removes with null, and merges style', () => {
    expect(
      mergeAttributes(
        { textColor: 'contrast', style: { border: { radius: '4px', width: '1px' } } },
        {
          textColor: null,
          backgroundColor: 'accent',
          style: { border: { radius: 'var:preset|border-radius|full', width: null } },
        },
      ),
    ).toEqual({
      backgroundColor: 'accent',
      style: { border: { radius: 'var:preset|border-radius|full' } },
    });
    expect(
      mergeAttributes(
        { style: { border: { width: '1px' } } },
        { style: { border: { width: null } } },
      ),
    ).toEqual({});
  });
});

describe('applyPartOperation()', () => {
  const header = () => codec.fromMarkup(group('test/header', paragraph('Bakery')));
  it('updateTemplatePart: fills the part’s slots', () => {
    const blocks = applyPartOperation(
      header(),
      { type: 'updateTemplatePart', slug: 'header', slots: { body: 'The Corner Bakery' } },
      patterns,
      codec,
    );
    expect(words(blocks)).toBe('The Corner Bakery');
  });
  it('updateTemplatePart: rebuilds the part from a pattern', () => {
    const blocks = applyPartOperation(
      header(),
      { type: 'updateTemplatePart', slug: 'header', pattern: 'test/cta' },
      patterns,
      codec,
    );
    expect(words(blocks)).toBe('Visit us');
  });
});

describe('menuMarkup()', () => {
  it('writes a Navigation Link per item, escaping labels', () => {
    const markup = menuMarkup(
      [
        { label: 'Home', page: 'home' },
        { label: 'Tea & <cake>', url: '/menu/' },
      ],
      (slug) => (slug === 'home' ? '/' : null),
    );
    const links = parseBlocks(markup).filter((b) => b.blockName);
    expect(links.map((l) => l.attrs)).toEqual([
      { label: 'Home', url: '/', kind: 'custom', isTopLevelLink: true },
      { label: 'Tea & <cake>', url: '/menu/', kind: 'custom', isTopLevelLink: true },
    ]);
    expect(markup).not.toContain('<cake>');
    expect(() => menuMarkup([{ label: 'Gone', page: 'gone' }], () => null)).toThrow('no_page');
  });
});

describe('renderPattern()', () => {
  it('names the pattern on its root block', () => {
    const markup = renderPattern(patterns.get('test/cta') as EditPattern, { title: 'Hello' });
    expect(markup).toContain('"patternName":"test/cta"');
    expect(markup).toContain('Hello');
  });
});

describe('planEdits()', () => {
  const context = (over: Partial<EditContext<TestBlock>> = {}): EditContext<TestBlock> => {
    const sections = page();
    return {
      codec,
      patterns,
      open: { id: 12, slug: 'home', key: 'page:12', sections },
      parts: new Map([
        [
          'header',
          {
            key: 'wp_template_part:header',
            blocks: codec.fromMarkup(group('test/header', paragraph('Bakery'))),
          },
        ],
      ]),
      pages: new Map([[20, { key: 'page:20', content: group('test/cta', heading('About')) }]]),
      pageUrl: (slug) => (slug === 'home' ? '/' : slug === 'about' ? '/about/' : null),
      newPage: (title, slug) => ({
        key: `page:${slug ?? 'new'}`,
        slug: slug ?? 'new',
        fields: { title, status: 'publish', parent: 0, menu_order: 3 },
      }),
      can: { styles: true, parts: true, pages: true },
      ...over,
    };
  };

  it('splits a set between the canvas, other pages, new pages, the menu and styles', () => {
    const result = planEdits(
      [
        { type: 'insertSection', page: 12, pattern: 'test/faq' },
        { type: 'removeSection', page: 20, index: 0 },
        { type: 'insertSection', page: 20, pattern: 'test/cta' },
        { type: 'updateTemplatePart', slug: 'header', slots: { body: 'Corner Bakery' } },
        {
          type: 'createPage',
          title: 'Questions',
          slug: 'questions',
          sections: [{ pattern: 'test/faq' }],
        },
        { type: 'insertSection', page: 'questions', pattern: 'test/cta' },
        {
          type: 'updateMenu',
          items: [
            { label: 'Home', page: 'home' },
            { label: 'Questions', page: 'questions' },
          ],
        },
        { type: 'setGlobalStyles', styles: { color: { background: 'var:preset|color|base' } } },
      ],
      context(),
    );
    if ('problem' in result) throw new Error(JSON.stringify(result.problem));
    const { plan } = result;
    expect([...plan.regions.keys()]).toEqual(['page:12', 'wp_template_part:header']);
    expect(plan.regions.get('page:12')).toHaveLength(3);
    expect(plan.highlight).toHaveLength(2);
    expect(words(plan.regions.get('wp_template_part:header') ?? [])).toBe('Corner Bakery');
    expect(plan.fields.get('page:20')?.content).toContain('Visit us');
    expect(plan.fields.get('page:20')?.content).not.toContain('About');
    expect(plan.fields.get('page:questions')).toMatchObject({
      title: 'Questions',
      status: 'publish',
    });
    expect(String(plan.fields.get('page:questions')?.content)).toMatch(/Questions[\s\S]*Visit us/);
    expect(plan.menu).toContain('"url":"/questions/"');
    expect(plan.styles).toBe(true);
  });

  it('means the open page when an operation names none', () => {
    const result = planEdits([{ type: 'removeSection', index: 1 }], context());
    expect('plan' in result && result.plan.regions.get('page:12')).toHaveLength(1);
  });

  it('refuses the whole set with the first problem', () => {
    expect(planEdits([], context())).toEqual({
      problem: { code: 'invalid', message: 'There are no changes to make.' },
    });
    expect(
      planEdits([{ type: 'setGlobalStyles', styles: { color: { text: '#ff0000' } } }], context()),
    ).toMatchObject({ problem: { code: 'invalid' } });
    expect(planEdits([{ type: 'removeSection', index: 9 }], context())).toEqual({
      problem: { code: 'no_section', index: 9, count: 2 },
    });
    expect(planEdits([{ type: 'removeSection', page: 99, index: 0 }], context())).toEqual({
      problem: { code: 'no_page', page: '99' },
    });
    expect(
      planEdits([{ type: 'updateTemplatePart', slug: 'sidebar', slots: {} }], context()),
    ).toEqual({ problem: { code: 'no_part', slug: 'sidebar' } });
  });

  it('refuses changes the person can’t make', () => {
    const locked = context({ can: { styles: false, parts: false, pages: false } });
    expect(
      planEdits(
        [{ type: 'setGlobalStyles', styles: { color: { text: 'var:preset|color|base' } } }],
        locked,
      ),
    ).toEqual({ problem: { code: 'not_allowed', what: 'styles' } });
    expect(
      planEdits([{ type: 'updateMenu', items: [{ label: 'Home', url: '/' }] }], locked),
    ).toEqual({ problem: { code: 'not_allowed', what: 'parts' } });
    expect(
      planEdits(
        [{ type: 'createPage', title: 'New', sections: [{ pattern: 'test/faq' }] }],
        locked,
      ),
    ).toEqual({ problem: { code: 'not_allowed', what: 'pages' } });
  });
});
