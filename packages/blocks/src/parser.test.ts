import { describe, expect, it } from 'vitest';
import { hasBlocks, parseBlocks } from './parser';
import { serializeBlock, serializeBlockAttributes, serializeBlocks } from './serializer';

describe('parseBlocks', () => {
  it('returns nothing for empty content', () => {
    expect(parseBlocks('')).toEqual([]);
  });

  it('turns classic content into one freeform block', () => {
    expect(parseBlocks('<p>Classic <em>post</em></p>')).toEqual([
      {
        blockName: null,
        attrs: {},
        innerBlocks: [],
        innerHTML: '<p>Classic <em>post</em></p>',
        innerContent: ['<p>Classic <em>post</em></p>'],
      },
    ]);
  });

  it('parses a block with the core namespace added', () => {
    expect(parseBlocks('<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->')).toEqual([
      {
        blockName: 'core/paragraph',
        attrs: {},
        innerBlocks: [],
        innerHTML: '<p>Hi</p>',
        innerContent: ['<p>Hi</p>'],
      },
    ]);
  });

  it('parses void blocks with attributes', () => {
    expect(
      parseBlocks('<!-- wp:latest-posts {"postsToShow":3,"displayPostDate":true} /-->'),
    ).toEqual([
      {
        blockName: 'core/latest-posts',
        attrs: { postsToShow: 3, displayPostDate: true },
        innerBlocks: [],
        innerHTML: '',
        innerContent: [],
      },
    ]);
  });

  it('keeps namespaced block names', () => {
    const [block] = parseBlocks(
      '<!-- wp:my-plugin/notice {"tone":"warm"} --><div>!</div><!-- /wp:my-plugin/notice -->',
    );
    expect(block?.blockName).toBe('my-plugin/notice');
    expect(block?.attrs).toEqual({ tone: 'warm' });
  });

  it('nests inner blocks and marks their places in innerContent', () => {
    const content =
      '<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div class="wp-block-column"><!-- wp:paragraph --><p>A</p><!-- /wp:paragraph --></div><!-- /wp:column --><!-- wp:column --><div class="wp-block-column"><!-- wp:separator /--></div><!-- /wp:column --></div><!-- /wp:columns -->';
    const [columns] = parseBlocks(content);
    expect(columns?.blockName).toBe('core/columns');
    expect(columns?.innerHTML).toBe('<div class="wp-block-columns"></div>');
    expect(columns?.innerContent).toEqual(['<div class="wp-block-columns">', null, null, '</div>']);
    const [first, second] = columns?.innerBlocks ?? [];
    expect(first?.innerContent).toEqual(['<div class="wp-block-column">', null, '</div>']);
    expect(first?.innerBlocks[0]).toEqual({
      blockName: 'core/paragraph',
      attrs: {},
      innerBlocks: [],
      innerHTML: '<p>A</p>',
      innerContent: ['<p>A</p>'],
    });
    expect(second?.innerBlocks[0]?.blockName).toBe('core/separator');
    expect(second?.innerBlocks[0]?.innerContent).toEqual([]);
  });

  it('keeps HTML between top-level blocks as freeform blocks', () => {
    const blocks = parseBlocks(
      'intro<!-- wp:separator /-->\n\n<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->outro',
    );
    expect(blocks.map((b) => [b.blockName, b.innerHTML])).toEqual([
      [null, 'intro'],
      ['core/separator', ''],
      [null, '\n\n'],
      ['core/paragraph', '<p>x</p>'],
      [null, 'outro'],
    ]);
  });

  it('decodes attribute JSON with closing braces, escaped dashes and unicode', () => {
    const [block] = parseBlocks(
      '<!-- wp:paragraph {"text":"a } b }} c","close":"\\u002d\\u002d\\u003e","emoji":"नमस्ते 👋","nested":{"deep":{"x":[1,{"y":"}"}]}}} -->\n<p>x</p>\n<!-- /wp:paragraph -->',
    );
    expect(block?.attrs).toEqual({
      text: 'a } b }} c',
      close: '-->',
      emoji: 'नमस्ते 👋',
      nested: { deep: { x: [1, { y: '}' }] } },
    });
    expect(block?.innerHTML).toBe('\n<p>x</p>\n');
  });

  it('uses empty attributes when the JSON is invalid', () => {
    const [block] = parseBlocks('<!-- wp:paragraph {"a":} --><p>x</p><!-- /wp:paragraph -->');
    expect(block?.attrs).toEqual({});
    expect(block?.blockName).toBe('core/paragraph');
  });

  it('closes unclosed blocks at the end of the document', () => {
    const [block] = parseBlocks('<!-- wp:group --><div>open');
    expect(block).toMatchObject({ blockName: 'core/group', innerHTML: '<div>open' });
  });

  it('treats a stray closer and everything after it as freeform', () => {
    const blocks = parseBlocks('<!-- /wp:paragraph --><p>x</p>');
    expect(blocks).toEqual([
      {
        blockName: null,
        attrs: {},
        innerBlocks: [],
        innerHTML: '<!-- /wp:paragraph --><p>x</p>',
        innerContent: ['<!-- /wp:paragraph --><p>x</p>'],
      },
    ]);
  });

  it('ignores comments that are not block delimiters', () => {
    const blocks = parseBlocks('<!-- just a comment --><!-- wp:Bad --><p>x</p>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.blockName).toBeNull();
  });

  it('handles very long attribute values without backtracking blow-ups', () => {
    const long = 'x'.repeat(200_000);
    const [block] = parseBlocks(`<!-- wp:paragraph {"a":"${long}"} /-->`);
    expect((block!.attrs.a as string).length).toBe(200_000);
  });

  it('detects block content', () => {
    expect(hasBlocks('<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->')).toBe(true);
    expect(hasBlocks('<p>classic</p>')).toBe(false);
  });
});

describe('serializeBlocks', () => {
  const fixtures = [
    '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->',
    '<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">Title</h3>\n<!-- /wp:heading -->',
    'Before<!-- wp:separator /-->\n\n<!-- wp:latest-posts {"postsToShow":2} /-->After',
    '<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div class="wp-block-column"><!-- wp:quote --><blockquote class="wp-block-quote"><!-- wp:paragraph --><p>Q</p><!-- /wp:paragraph --><cite>Me</cite></blockquote><!-- /wp:quote --></div><!-- /wp:column --></div><!-- /wp:columns -->',
    '<!-- wp:my-plugin/card {"title":"\\u003cb\\u003eHi\\u003c/b\\u003e \\u0026 \\u002d\\u002d","ok":true} --><div>card</div><!-- /wp:my-plugin/card -->',
    '<!-- wp:block {"ref":12} /-->',
    '<p>Only classic HTML</p>',
  ];

  it.each(fixtures)('round-trips %#', (content) => {
    expect(serializeBlocks(parseBlocks(content))).toBe(content);
  });

  it('omits the core namespace and empty attributes', () => {
    expect(
      serializeBlock({
        blockName: 'core/paragraph',
        attrs: {},
        innerBlocks: [],
        innerHTML: '<p>x</p>',
        innerContent: ['<p>x</p>'],
      }),
    ).toBe('<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->');
  });

  it('writes blocks without content as void blocks', () => {
    expect(
      serializeBlock({
        blockName: 'core/archives',
        attrs: { showPostCounts: true },
        innerBlocks: [],
        innerHTML: '',
        innerContent: [],
      }),
    ).toBe('<!-- wp:archives {"showPostCounts":true} /-->');
  });

  it('escapes attribute JSON so the comment cannot be closed early', () => {
    const attrs = { text: '--><script>alert("x")</script>', path: 'a\\b', amp: '&' };
    const json = serializeBlockAttributes(attrs);
    expect(json).toBe(
      '{"text":"\\u002d\\u002d\\u003e\\u003cscript\\u003ealert(\\u0022x\\u0022)\\u003c/script\\u003e","path":"a\\u005cb","amp":"\\u0026"}',
    );
    expect(json).not.toMatch(/--|<|>/);
    const markup = serializeBlock({
      blockName: 'core/paragraph',
      attrs,
      innerBlocks: [],
      innerHTML: '<p>x</p>',
      innerContent: ['<p>x</p>'],
    });
    expect(parseBlocks(markup)[0]?.attrs).toEqual(attrs);
  });

  it('keeps unicode readable, as WordPress does', () => {
    expect(serializeBlockAttributes({ t: 'café ✓' })).toBe('{"t":"café ✓"}');
  });
});
