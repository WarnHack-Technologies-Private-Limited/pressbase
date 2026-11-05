import { parseBlocks, serializeBlocks } from '@pressbase/blocks';
import { fillSlots } from '@pressbase/slots';
import { describe, expect, it } from 'vitest';
import { sectionTexts, selectionText, slotsUpdate, spliceSelection } from './ask-ai-model';

/** A hero: a label, a heading, a paragraph with emphasis, two buttons and a list. */
const SECTION = `<!-- wp:group {"metadata":{"patternName":"pressbase/hero"}} -->
<div class="wp-block-group"><!-- wp:paragraph -->
<p>Since the old days</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":1} -->
<h1 class="wp-block-heading">Bread baked fresh every morning</h1>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Sourdough, <em>pastries</em> and good coffee.</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>Sourdough</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>[Add an item]</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Coffee</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="/visit/">Come and visit</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group -->`;

describe('sectionTexts()', () => {
  it('lists every text a rewrite can change, placeholders left for the person', () => {
    const texts = sectionTexts(SECTION);
    expect(texts.map((t) => [t.id, t.kind, t.text])).toEqual([
      ['eyebrow', 'text', 'Since the old days'],
      ['title', 'heading', 'Bread baked fresh every morning'],
      ['body', 'text', 'Sourdough, pastries and good coffee.'],
      ['list.0', 'text', 'Sourdough'],
      ['list.2', 'text', 'Coffee'],
      ['actions.0', 'button', 'Come and visit'],
    ]);
    expect(texts[1]?.path).toEqual([0, 1]);
  });
});

describe('slotsUpdate()', () => {
  it('changes only the texts given, and keeps the rest (formatting and other items) as it was', () => {
    const texts = sectionTexts(SECTION);
    const byId = new Map(texts.map((t) => [t.id, t]));
    const slots = slotsUpdate(SECTION, undefined, [
      { address: byId.get('title')?.address ?? [], text: 'Fresh bread' },
      { address: byId.get('list.2')?.address ?? [], text: 'Good coffee' },
      { address: byId.get('actions.0')?.address ?? [], text: 'Visit us' },
    ]);
    expect(slots).toEqual({
      title: 'Fresh bread',
      list: [null, null, 'Good coffee'],
      actions: [{ text: 'Visit us' }],
    });
    // Applied as the applier does (fillSlots, plain text): only those change.
    const filled = serializeBlocks(
      fillSlots(
        parseBlocks(SECTION).filter((b) => b.blockName),
        slots as never,
        { format: 'text' },
      ),
    );
    expect(filled).toContain('<h1 class="wp-block-heading">Fresh bread</h1>');
    expect(filled).toContain('<li>Good coffee</li>');
    expect(filled).toContain('<li>[Add an item]</li>');
    expect(filled).toContain('<p>Sourdough, <em>pastries</em> and good coffee.</p>');
    expect(filled).toContain('href="/visit/">Visit us</a>');
  });
});

describe('a selection', () => {
  it('finds the block’s slot and the selected words, and puts the new words in their place', () => {
    const full = 'Sourdough, pastries and good coffee.';
    const found = selectionText(SECTION, undefined, [0, 2], full, { start: 11, end: 19 });
    expect(found).toMatchObject({ id: 'body', text: 'pastries', start: 11, end: 19 });
    expect(spliceSelection(found as never, 'cakes')).toBe('Sourdough, cakes and good coffee.');
    // Nothing selected: the whole block.
    expect(selectionText(SECTION, undefined, [0, 2], full, null)?.text).toBe(full);
    // A list item, by its path.
    expect(selectionText(SECTION, undefined, [0, 3, 2], 'Coffee', null)?.address).toEqual([
      'list',
      2,
    ]);
    // A block that isn't one of the section's texts.
    expect(selectionText(SECTION, undefined, [0, 9], 'x', null)).toBeNull();
  });

  it('keeps the spaces around the selection', () => {
    expect(spliceSelection({ full: 'one two three', start: 3, end: 8 }, 'TWO')).toBe(
      'one TWO three',
    );
  });
});
