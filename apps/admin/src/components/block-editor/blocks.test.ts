import { describe, expect, it } from 'vitest';
import { allowedBlockTypes, countWords, readingMinutes, unavailableReason } from './blocks';
import { NO_FEATURES, toEditorPattern } from './features';

const REGISTERED = [
  'core/paragraph',
  'core/heading',
  'core/image',
  'core/embed',
  'core/block',
  'core/latest-posts',
  'core/freeform',
  'core/navigation',
  'core/comments',
];

describe('allowedBlockTypes', () => {
  it('keeps out blocks whose server features are missing', () => {
    expect(allowedBlockTypes(REGISTERED, NO_FEATURES)).toEqual([
      'core/paragraph',
      'core/heading',
      'core/image',
    ]);
  });

  it('offers them once the features exist', () => {
    const features = { blockRenderer: true, oembed: true, syncedPatterns: [] };
    expect(allowedBlockTypes(REGISTERED, features)).toEqual([
      'core/paragraph',
      'core/heading',
      'core/image',
      'core/embed',
      'core/block',
      'core/latest-posts',
    ]);
  });

  it('explains why a block is unavailable', () => {
    expect(unavailableReason('core/latest-posts', NO_FEATURES)).toBe('needs the block engine');
    expect(unavailableReason('core/freeform', NO_FEATURES)).toMatch(/not supported/);
    expect(unavailableReason('core/paragraph', NO_FEATURES)).toBeNull();
  });
});

describe('countWords', () => {
  it('counts words in block markup, ignoring delimiters and tags', () => {
    const markup =
      '<!-- wp:heading -->\n<h2 class="wp-block-heading">Hello world</h2>\n<!-- /wp:heading -->\n\n' +
      '<!-- wp:paragraph -->\n<p>It&rsquo;s <strong>three</strong> words&nbsp;here — really.</p>\n<!-- /wp:paragraph -->';
    expect(countWords(markup)).toBe(7);
    expect(countWords('')).toBe(0);
  });

  it('rounds reading time, with a one-minute floor', () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(460)).toBe(2);
  });
});

describe('toEditorPattern', () => {
  it('maps the REST shape to the editor’s camelCase one', () => {
    expect(
      toEditorPattern({
        name: 'core/hero',
        title: 'Hero',
        content: '<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->',
        categories: ['featured'],
        block_types: ['core/post-content'],
        viewport_width: 1200,
      }),
    ).toMatchObject({
      name: 'core/hero',
      categories: ['featured'],
      blockTypes: ['core/post-content'],
      viewportWidth: 1200,
      inserter: true,
    });
  });
});
