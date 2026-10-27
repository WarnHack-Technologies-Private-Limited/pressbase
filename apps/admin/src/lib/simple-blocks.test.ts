import { describe, expect, it } from 'vitest';
import { blocksToText, textToBlocks } from './simple-blocks';

const SAMPLE = `Opening paragraph with **bold**, *italic*, \`code\` and a [link](https://example.com).
A second line in the same paragraph.

## A heading

### A smaller heading

- First
- Second

1. One
2. Two

> Quoted words
> on two lines

---

Closing.`;

describe('simple blocks', () => {
  it('produces Gutenberg block markup', () => {
    const html = textToBlocks('Hello\n\n## Title\n\n- a\n- b');
    expect(html).toBe(
      [
        '<!-- wp:paragraph -->\n<p>Hello</p>\n<!-- /wp:paragraph -->',
        '<!-- wp:heading -->\n<h2 class="wp-block-heading">Title</h2>\n<!-- /wp:heading -->',
        '<!-- wp:list -->\n<ul class="wp-block-list"><!-- wp:list-item -->\n<li>a</li>\n<!-- /wp:list-item --><!-- wp:list-item -->\n<li>b</li>\n<!-- /wp:list-item --></ul>\n<!-- /wp:list -->',
      ].join('\n\n'),
    );
  });

  it('round-trips everything the writing editor supports', () => {
    expect(blocksToText(textToBlocks(SAMPLE))).toBe(SAMPLE);
  });

  it('reads the installer’s sample content', () => {
    expect(
      blocksToText(
        '<!-- wp:paragraph -->\n<p>Welcome to Pressbase. This is your first post.</p>\n<!-- /wp:paragraph -->',
      ),
    ).toBe('Welcome to Pressbase. This is your first post.');
  });

  it('refuses content it cannot show without loss', () => {
    expect(
      blocksToText(
        '<!-- wp:paragraph {"align":"center"} -->\n<p class="has-text-align-center">x</p>\n<!-- /wp:paragraph -->',
      ),
    ).toBeUndefined();
    expect(
      blocksToText(
        '<!-- wp:image {"id":3} -->\n<figure><img src="a.jpg"/></figure>\n<!-- /wp:image -->',
      ),
    ).toBeUndefined();
    expect(
      blocksToText('<!-- wp:paragraph -->\n<p>x</p>\n<!-- /wp:paragraph --><div>stray</div>'),
    ).toBeUndefined();
    expect(blocksToText('<!-- wp:paragraph -->\n<p>unclosed</p>')).toBeUndefined();
  });

  it('accepts classic content with paragraphs and inline tags', () => {
    expect(blocksToText('<p>One <strong>two</strong></p><p>Three</p>')).toBe(
      'One **two**\n\nThree',
    );
    expect(blocksToText('<table><tr><td>x</td></tr></table>')).toBeUndefined();
  });

  it('escapes stray angle brackets and ampersands but keeps entities', () => {
    const html = textToBlocks('1 < 2 & 3 &amp; 4');
    expect(html).toContain('<p>1 &lt; 2 &amp; 3 &amp; 4</p>');
    expect(blocksToText(html)).toBe('1 < 2 & 3 & 4');
  });
});
