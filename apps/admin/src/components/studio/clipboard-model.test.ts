import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  looksLikeBlocks,
  PASTE_STYLE_ATTRIBUTES,
  pastePlace,
  pasteStyles,
  type StyleBlock,
  type Supports,
  styleAttributes,
  supportedStyle,
} from './clipboard-model';

/** The real supports, from WordPress's block.json files. */
const SUPPORTS = new Map<string, Supports>();
function supportsOf(name: string): Supports {
  if (!SUPPORTS.has(name)) {
    const file = new URL(
      `../../../node_modules/@wordpress/block-library/src/${name.replace('core/', '')}/block.json`,
      import.meta.url,
    );
    SUPPORTS.set(name, JSON.parse(readFileSync(file, 'utf8')).supports);
  }
  return SUPPORTS.get(name);
}

const block = (
  name: string,
  attributes: Record<string, unknown> = {},
  innerBlocks: StyleBlock[] = [],
): StyleBlock => ({ name: `core/${name}`, attributes, innerBlocks });

const styled = {
  fontSize: 'large',
  textColor: 'contrast',
  backgroundColor: 'accent',
  className: 'is-style-outline',
  style: {
    typography: { fontWeight: '700', lineHeight: '1.2' },
    spacing: { padding: { top: 'var:preset|spacing|40' }, margin: { top: '0' } },
    border: { radius: '8px' },
    color: { text: '#111' },
    '@mobile': { typography: { fontSize: '1rem' }, spacing: { padding: { top: '8px' } } },
  },
};

describe('paste style: which attributes', () => {
  it('lists WordPress’s style attributes', () => {
    expect(PASTE_STYLE_ATTRIBUTES).toEqual([
      'align',
      'borderColor',
      'backgroundColor',
      'textAlign',
      'textColor',
      'gradient',
      'className',
      'fontFamily',
      'fontSize',
      'layout',
      'style',
    ]);
  });

  it('copies a heading’s presets, typography, spacing, colours and border onto a paragraph', () => {
    const attributes = styleAttributes(
      block('heading', styled),
      block('paragraph', { content: 'Hi', fontSize: 'small' }),
      supportsOf,
    );
    expect(attributes).toMatchObject({
      fontSize: 'large',
      textColor: 'contrast',
      backgroundColor: 'accent',
      style: styled.style,
    });
    // Its classes (a style variation, Additional CSS classes) too, as in WordPress.
    expect(attributes.className).toBe('is-style-outline');
    // Content is never touched.
    expect(attributes).not.toHaveProperty('content');
  });

  it('clears what the source doesn’t have, so the target looks like the source', () => {
    const attributes = styleAttributes(
      block('paragraph', { fontSize: 'small' }),
      block('heading', {
        fontSize: 'x-large',
        textColor: 'accent',
        style: { color: { text: '#f00' } },
      }),
      supportsOf,
    );
    expect(attributes.fontSize).toBe('small');
    expect('textColor' in attributes && attributes.textColor).toBeUndefined();
    expect('style' in attributes && attributes.style).toBeUndefined();
  });

  it('keeps only the styles the target supports: no typography or padding on an image', () => {
    const attributes = styleAttributes(block('heading', styled), block('image'), supportsOf);
    // The image has no text or background colour, no font sizes.
    expect(attributes).not.toHaveProperty('fontSize');
    expect(attributes).not.toHaveProperty('textColor');
    expect(attributes).not.toHaveProperty('backgroundColor');
    expect(attributes.style).toEqual({
      spacing: { margin: { top: '0' } },
      border: { radius: '8px' },
    });
  });

  it('filters each device’s styles too', () => {
    expect(
      supportedStyle(
        {
          '@tablet': {
            typography: { fontSize: '2rem' },
            spacing: { padding: { top: '4px' }, margin: { top: '4px' } },
          },
          '@mobile': { typography: { fontSize: '1rem' } },
        },
        supportsOf('core/image'),
      ),
    ).toEqual({ '@tablet': { spacing: { margin: { top: '4px' } } } });
  });

  it('copies a group’s padding and gap onto a column, but not its top margin', () => {
    const attributes = styleAttributes(
      block('group', {
        style: {
          spacing: { padding: { top: '2rem' }, margin: { top: '1rem' }, blockGap: '1rem' },
        },
        layout: { type: 'constrained' },
      }),
      block('column'),
      supportsOf,
    );
    expect(attributes.style).toEqual({ spacing: { padding: { top: '2rem' }, blockGap: '1rem' } });
  });

  it('copies layout only between blocks of the same type', () => {
    const row = block('group', { layout: { type: 'flex', flexWrap: 'nowrap' } });
    expect(styleAttributes(row, block('group'), supportsOf).layout).toEqual({
      type: 'flex',
      flexWrap: 'nowrap',
    });
    expect(styleAttributes(row, block('columns'), supportsOf)).not.toHaveProperty('layout');
  });

  it('copies an alignment only where the target offers it', () => {
    const left = block('image', { align: 'left' });
    expect(styleAttributes(left, block('group'), supportsOf)).not.toHaveProperty('align');
    expect(
      styleAttributes(block('image', { align: 'wide' }), block('group'), supportsOf).align,
    ).toBe('wide');
    // No alignment on the source: the target's goes, as in WordPress.
    expect(styleAttributes(block('group'), block('image', { align: 'left' }), supportsOf)).toEqual(
      expect.objectContaining({ align: undefined }),
    );
  });

  it('leaves a child’s size in a row behind (it belongs to where the block sits)', () => {
    expect(
      supportedStyle(
        { layout: { selfStretch: 'fixed', flexSize: '200px' } },
        supportsOf('core/group'),
      ),
    ).toBeUndefined();
  });
});

describe('paste style: blocks', () => {
  const target = (
    clientId: string,
    name: string,
    attributes = {},
    innerBlocks: StyleBlock[] = [],
  ) => ({
    clientId,
    ...block(name, attributes, innerBlocks),
  });

  it('styles every target from one copied block, and skips targets already alike', () => {
    const copied = [block('paragraph', { fontSize: 'large' })];
    const updates = pasteStyles(
      copied,
      [
        target('a', 'paragraph'),
        target('b', 'heading', { textColor: 'accent' }),
        target('c', 'paragraph', { fontSize: 'large' }),
      ],
      supportsOf,
    );
    expect([...updates.keys()]).toEqual(['a', 'b']);
    expect(updates.get('b')).toMatchObject({ fontSize: 'large', textColor: undefined });
  });

  it('styles inner blocks from the source’s inner blocks at the same place', () => {
    const copied = [
      block('group', { backgroundColor: 'accent' }, [
        block('heading', { textColor: 'base' }),
        block('paragraph', { fontSize: 'small' }),
      ]),
    ];
    const heading = { clientId: 'h', ...block('heading') };
    const paragraph = { clientId: 'p', ...block('paragraph') };
    const updates = pasteStyles(
      copied,
      [target('g', 'group', {}, [heading, paragraph] as StyleBlock[])],
      supportsOf,
    );
    expect(updates.get('g')).toMatchObject({ backgroundColor: 'accent' });
    expect(updates.get('h')).toMatchObject({ textColor: 'base' });
    expect(updates.get('p')).toMatchObject({ fontSize: 'small' });
  });

  it('matches several copied blocks one to one', () => {
    const updates = pasteStyles(
      [block('paragraph', { fontSize: 'small' }), block('paragraph', { fontSize: 'large' })],
      [target('a', 'paragraph'), target('b', 'paragraph'), target('c', 'paragraph')],
      supportsOf,
    );
    expect(updates.get('a')?.fontSize).toBe('small');
    expect(updates.get('b')?.fontSize).toBe('large');
    expect(updates.has('c')).toBe(false);
  });

  it('does nothing without a copied block', () => {
    expect(pasteStyles([], [target('a', 'paragraph')], supportsOf).size).toBe(0);
  });
});

describe('paste: where the blocks go', () => {
  // template › content › section A [heading, columns › column › paragraph], section B
  const tree: Record<string, string[]> = {
    template: ['header', 'content'],
    header: ['title'],
    content: ['A', 'B'],
    A: ['heading', 'cols'],
    cols: ['col'],
    col: ['para'],
  };
  const indexOf = (id: string, root: string) => (tree[root] ?? []).indexOf(id);
  const options = (canInsert: (name: string, root: string) => boolean, section = false) => ({
    contentRoot: 'content',
    section,
    indexOf,
    canInsert,
  });
  const anywhere = (_: string, root: string) => root !== 'template';

  it('goes just after the block, in its parent', () => {
    expect(
      pastePlace(
        ['template', 'content', 'A', 'cols', 'col', 'para'],
        ['core/paragraph'],
        options(anywhere),
      ),
    ).toEqual({ root: 'col', index: 1 });
  });

  it('climbs out of a parent that doesn’t take the block (a Column into Columns only)', () => {
    const canInsert = (name: string, root: string) =>
      name === 'core/column' ? root === 'cols' : anywhere(name, root);
    expect(
      pastePlace(
        ['template', 'content', 'A', 'cols', 'col', 'para'],
        ['core/column'],
        options(canInsert),
      ),
    ).toEqual({ root: 'cols', index: 1 });
    // A heading can't go in Columns: after the Columns instead.
    const noColumns = (name: string, root: string) => root !== 'cols' && anywhere(name, root);
    expect(
      pastePlace(['template', 'content', 'A', 'cols'], ['core/heading'], options(noColumns)),
    ).toEqual({ root: 'A', index: 2 });
  });

  it('puts a copied section after the section, never inside it', () => {
    expect(
      pastePlace(
        ['template', 'content', 'A', 'cols', 'col', 'para'],
        ['core/group'],
        options(anywhere, true),
      ),
    ).toEqual({ root: 'content', index: 1 });
    expect(
      pastePlace(['template', 'content', 'B'], ['core/group'], options(anywhere, true)),
    ).toEqual({ root: 'content', index: 2 });
  });

  it('never leaves the page for the template, and stays in a part when pasting there', () => {
    const nowhere = () => false;
    expect(pastePlace(['template', 'content', 'A'], ['core/group'], options(nowhere))).toBeNull();
    expect(
      pastePlace(['template', 'header', 'title'], ['core/paragraph'], options(anywhere, true)),
    ).toEqual({ root: 'header', index: 1 });
  });
});

describe('clipboard text', () => {
  it('tells blocks from words', () => {
    expect(looksLikeBlocks('<!-- wp:paragraph -->\n<p>Hi</p>\n<!-- /wp:paragraph -->')).toBe(true);
    expect(looksLikeBlocks('Just some words')).toBe(false);
    expect(looksLikeBlocks('<p>HTML</p>')).toBe(false);
  });
});
