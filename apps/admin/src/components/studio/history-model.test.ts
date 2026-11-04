import { describe, expect, it } from 'vitest';
import type { CanvasBlock } from './canvas-model';
import {
  blockNoun,
  describeEdit,
  editLabel,
  historyGo,
  historyInit,
  historyRecord,
} from './history-model';

/* -------------------------------------------------------------- the stack */

describe('the history stack', () => {
  it('records steps, undoes, redoes and jumps back to any point', () => {
    let h = historyInit('a', 0);
    h = historyRecord(h, 'b', { at: 1 });
    h = historyRecord(h, 'c', { at: 2, label: 'Restored the version from May 2' });
    expect(h.entries.map((e) => e.value)).toEqual(['a', 'b', 'c']);
    expect(h.index).toBe(2);
    expect(h.entries[2]?.label).toBe('Restored the version from May 2');
    h = historyGo(h, 0);
    expect(h.entries[h.index]?.value).toBe('a');
    h = historyGo(h, h.index + 1);
    expect(h.entries[h.index]?.value).toBe('b');
    // Out of range stays at the ends.
    expect(historyGo(h, 99).index).toBe(2);
    expect(historyGo(h, -1).index).toBe(0);
  });

  it('drops the steps undone when a new one is made', () => {
    let h = historyInit('a', 0);
    h = historyRecord(h, 'b');
    h = historyRecord(h, 'c');
    h = historyGo(h, 1);
    h = historyRecord(h, 'd');
    expect(h.entries.map((e) => e.value)).toEqual(['a', 'b', 'd']);
    expect(h.index).toBe(2);
  });

  it('adds staged changes (typing on) to the current step, as WordPress’s undo manager does', () => {
    let h = historyInit('', 0);
    h = historyRecord(h, 'H', { at: 1 });
    h = historyRecord(h, 'He', { staged: true, at: 2 });
    h = historyRecord(h, 'Hey', { staged: true, at: 3 });
    expect(h.entries.map((e) => e.value)).toEqual(['', 'Hey']);
    // The step keeps the time it started.
    expect(h.entries[1]?.at).toBe(1);
    // Before any step, a staged change (a block settling as the page opens) becomes the start.
    let opening = historyInit('x', 0);
    opening = historyRecord(opening, 'x+menu', { staged: true });
    expect(opening.entries).toHaveLength(1);
    expect(opening.entries[0]?.value).toBe('x+menu');
  });
});

/* ------------------------------------------------------------- the labels */

let ids = 0;
const b = (
  name: string,
  attributes: Record<string, unknown> = {},
  innerBlocks: CanvasBlock[] = [],
  clientId = `id${++ids}`,
): CanvasBlock => ({ name, clientId, attributes, innerBlocks });

/** A canvas: header part, the page's content with its sections, footer part. */
const canvas = (sections: CanvasBlock[], header: CanvasBlock[] = []) => [
  b('core/template-part', { slug: 'header' }, header, 'part-header'),
  b('core/group', {}, [b('core/post-content', {}, sections, 'content')], 'layout'),
];

const titles: Record<string, string> = {
  'core/heading': 'Heading',
  'core/paragraph': 'Paragraph',
  'core/group': 'Group',
  'core/image': 'Image',
  'core/button': 'Button',
  'core/navigation': 'Navigation',
  'core/site-title': 'Site Title',
};
const names = {
  block: (name: string) => blockNoun(titles[name] ?? name, 'en_US'),
  part: (slug: string) => (slug === 'header' ? 'Header' : slug),
};
const i18n = {
  __: (text: string) => text,
  _n: (single: string, plural: string, count: number) => (count === 1 ? single : plural),
  sprintf: (format: string, ...args: (string | number)[]) => {
    let i = 0;
    return format
      .replace(/%(\d)\$[sd]/g, (_, n) => String(args[Number(n) - 1]))
      .replace(/%[sd]/g, () => String(args[i++]));
  },
};
const label = (before: CanvasBlock[], after: CanvasBlock[], selected?: string) =>
  editLabel(describeEdit(before, after, selected), names, i18n);

describe('naming a step', () => {
  const heading = b('core/heading', { content: 'Fresh bread', level: 2 }, [], 'h');
  const text = b('core/paragraph', { content: 'Every morning.' }, [], 'p');
  const hero = b('core/group', { metadata: { name: 'Hero' } }, [heading, text], 'hero');
  const pricing = b('core/group', { metadata: { name: 'Pricing' } }, [], 'pricing');
  const faq = b('core/group', {}, [], 'faq');
  const start = canvas([hero, pricing, faq]);

  const withHeading = (attributes: Record<string, unknown>) =>
    canvas([
      { ...hero, innerBlocks: [{ ...heading, attributes: { ...heading.attributes, ...attributes } }, text] },
      pricing,
      faq,
    ]);

  it('names text, style, alignment and settings changes by the block', () => {
    expect(label(start, withHeading({ content: 'Fresh bread daily' }))).toBe('Changed heading text');
    expect(label(start, withHeading({ textColor: 'accent' }))).toBe('Changed heading style');
    expect(label(start, withHeading({ style: { typography: { fontSize: '3rem' } } }))).toBe(
      'Changed heading style',
    );
    expect(label(start, withHeading({ textAlign: 'center' }))).toBe('Changed heading alignment');
    expect(label(start, withHeading({ level: 3 }))).toBe('Changed heading settings');
    // Two kinds at once: just "settings".
    expect(label(start, withHeading({ level: 3, content: 'x' }))).toBe('Changed heading settings');
  });

  it('names images, links and descriptions', () => {
    const image = b('core/image', { url: 'a.jpg', id: 1, alt: '' }, [], 'img');
    const button = b('core/button', { text: 'Menu', url: '/menu' }, [], 'btn');
    const page = canvas([b('core/group', {}, [image, button], 'g')]);
    const change = (block: CanvasBlock, attributes: Record<string, unknown>) =>
      canvas([
        b(
          'core/group',
          {},
          [image, button].map((x) =>
            x === block ? { ...x, attributes: { ...x.attributes, ...attributes } } : x,
          ),
          'g',
        ),
      ]);
    expect(label(page, change(image, { url: 'b.jpg', id: 2, alt: 'Loaves' }))).toBe(
      'Changed image',
    );
    expect(label(page, change(image, { alt: 'Loaves on a shelf' }))).toBe(
      'Changed image description',
    );
    expect(label(page, change(button, { url: '/menu/today' }))).toBe('Changed button link');
    expect(label(page, change(button, { text: 'See the menu' }))).toBe('Changed button text');
  });

  it('moves sections up and down', () => {
    expect(label(start, canvas([pricing, hero, faq]), 'pricing')).toBe('Moved section up');
    expect(label(start, canvas([pricing, hero, faq]), 'hero')).toBe('Moved section down');
    // Without a selection, a swap reads as the one going up.
    expect(label(start, canvas([pricing, hero, faq]))).toBe('Moved section up');
    // Across several places: the one that travelled.
    expect(label(start, canvas([faq, hero, pricing]))).toBe('Moved section up');
    expect(label(start, canvas([pricing, faq, hero]))).toBe('Moved section down');
  });

  it('moves a block into another', () => {
    const moved = canvas([
      { ...hero, innerBlocks: [heading] },
      { ...pricing, innerBlocks: [text] },
      faq,
    ]);
    expect(label(start, moved)).toBe('Moved paragraph');
  });

  it('adds, duplicates and removes sections and blocks', () => {
    const added = b('core/group', { metadata: { name: 'Opening hours' } }, [], 'new');
    expect(label(start, canvas([hero, added, pricing, faq]))).toBe(
      'Added section “Opening hours”',
    );
    expect(
      label(start, canvas([hero, pricing, faq, b('core/group', { tagName: 'section' })])),
    ).toBe('Added section');
    const copy = { ...pricing, clientId: 'copy' };
    expect(label(start, canvas([hero, pricing, copy, faq]))).toBe('Duplicated section');
    expect(label(start, canvas([hero, faq]))).toBe('Removed section “Pricing”');
    expect(label(start, canvas([hero, pricing]))).toBe('Removed section');
    expect(
      label(start, canvas([{ ...hero, innerBlocks: [heading, text, b('core/paragraph')] }, pricing, faq])),
    ).toBe('Added paragraph');
    expect(label(start, canvas([{ ...hero, innerBlocks: [heading] }, pricing, faq]))).toBe(
      'Removed paragraph',
    );
    expect(label(start, canvas([hero]))).toBe('Removed 2 blocks');
  });

  it('names a block turned into another', () => {
    const asHeading = b('core/heading', { content: 'Every morning.' }, [], 'h2');
    expect(label(start, canvas([{ ...hero, innerBlocks: [heading, asHeading] }, pricing, faq]))).toBe(
      'Changed paragraph to heading',
    );
  });

  it('says when a change is in the header', () => {
    const title = b('core/site-title', { content: 'Corner Bakery' }, [], 'title');
    const before = canvas([hero], [title]);
    const after = canvas([hero], [{ ...title, attributes: { content: 'The Corner Bakery' } }]);
    expect(label(before, after)).toBe('Changed site title text in the Header');
  });

  it('counts several blocks changed at once, and names nothing when nothing changed', () => {
    const many = canvas([
      {
        ...hero,
        innerBlocks: [
          { ...heading, attributes: { content: 'A' } },
          { ...text, attributes: { content: 'B' } },
        ],
      },
      pricing,
      faq,
    ]);
    expect(label(start, many)).toBe('Changed 2 blocks');
    expect(label(start, start)).toBe('Edited the page');
  });

  it('writes block names in lower case in English only', () => {
    expect(blockNoun('Site Title', 'en_US')).toBe('site title');
    expect(blockNoun('Überschrift', 'de_DE')).toBe('Überschrift');
  });
});
