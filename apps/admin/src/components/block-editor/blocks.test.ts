import { describe, expect, it } from 'vitest';
import { allowedBlockTypes, countWords, readingMinutes, unavailableReason } from './blocks';
import { NO_FEATURES, namespaceListed, toEditorPattern } from './features';

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
      // Server-rendered like Latest Posts, now that core has comments.
      'core/comments',
    ]);
  });

  it('offers only the dynamic blocks the server can render, once it reports them', () => {
    const features = {
      blockRenderer: true,
      oembed: false,
      syncedPatterns: [],
      blockTypes: [{ name: 'core/latest-posts', is_dynamic: true }],
    };
    expect(unavailableReason('core/latest-posts', features)).toBeNull();
    expect(unavailableReason('core/query', features)).toBe('not rendered by the server yet');
    // Static blocks don't depend on the server.
    for (const name of [
      'core/image',
      'core/gallery',
      'core/media-text',
      'core/cover',
      'core/file',
      'core/audio',
      'core/video',
    ]) {
      expect(unavailableReason(name, features), name).toBeNull();
      expect(unavailableReason(name, NO_FEATURES), name).toBeNull();
    }
  });

  it('offers the navigation blocks once core serves /wp/v2/navigation', () => {
    const base = { blockRenderer: true, oembed: false, syncedPatterns: [] };
    expect(unavailableReason('core/navigation', base)).toBe('needs navigation menus');
    const features = { ...base, navigation: true };
    for (const name of [
      'core/navigation',
      'core/navigation-link',
      'core/navigation-submenu',
      'core/home-link',
      'core/page-list',
    ]) {
      expect(unavailableReason(name, features), name).toBeNull();
    }
    // Still needs the server to render them, once it reports block types.
    expect(unavailableReason('core/navigation', { ...features, blockTypes: [] })).toBe(
      'not rendered by the server yet',
    );
    expect(unavailableReason('core/navigation-overlay-close', features)).toMatch(/not supported/);
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

describe('namespaceListed', () => {
  it('skips routes whose namespace the REST index doesn’t list', () => {
    const index = { namespaces: ['pressbase/v1', 'wp/v2'] };
    expect(namespaceListed(index, '/oembed/1.0/proxy')).toBe(false);
    expect(namespaceListed(index, '/wp/v2/media?per_page=1')).toBe(true);
    expect(namespaceListed({ namespaces: ['oembed/1.0'] }, 'oembed/1.0/proxy')).toBe(true);
    // No index: probe the route itself.
    expect(namespaceListed(undefined, '/oembed/1.0/proxy')).toBe(true);
  });
});
