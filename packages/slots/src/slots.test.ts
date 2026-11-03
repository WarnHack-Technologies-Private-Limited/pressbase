import { parseBlocks, serializeBlocks } from '@pressbase/blocks';
import { describe, expect, it } from 'vitest';
import {
  extractSlots,
  fillSlots,
  findPlaceholders,
  type GroupSlot,
  isPlaceholder,
  parseSlotDeclarations,
  type Slot,
  SlotDeclarationError,
  type SlotValues,
  slotsJsonSchema,
  slotValues,
  transferSlots,
  unknownDeclarations,
} from './index';

const HERO = `<!-- wp:group {"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|70"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--70)"><!-- wp:paragraph {"fontSize":"small"} -->
<p class="has-small-font-size">Open every day</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":1,"fontSize":"xx-large"} -->
<h1 class="wp-block-heading has-xx-large-font-size">Bread baked <em>before</em> sunrise</h1>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>A neighbourhood bakery with sourdough, pastries &amp; good coffee.</p>
<!-- /wp:paragraph -->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#menu">See the menu</a></div>
<!-- /wp:button -->

<!-- wp:button {"className":"is-style-outline"} -->
<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="#">Find us</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group -->`;

const card = (
  title: string,
  text: string,
) => `<!-- wp:column {"style":{"spacing":{"padding":{"top":"var:preset|spacing|40"}}}} -->
<div class="wp-block-column" style="padding-top:var(--wp--preset--spacing--40)"><!-- wp:image {"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="/a.jpg" alt="Fresh loaves on a shelf"/></figure>
<!-- /wp:image -->

<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">${title}</h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>${text}</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column -->`;

const FEATURES = `<!-- wp:group {"layout":{"type":"constrained"}} -->
<div class="wp-block-group"><!-- wp:heading -->
<h2 class="wp-block-heading">What we bake</h2>
<!-- /wp:heading -->

<!-- wp:columns {"align":"wide"} -->
<div class="wp-block-columns alignwide">${card('Bread', 'Sourdough and rye.')}

${card('Pastries', 'Croissants on weekends.')}

${card('Cakes', 'To order, two days ahead.')}</div>
<!-- /wp:columns -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>Gluten-free loaves</li>
<!-- /wp:list-item -->

<!-- wp:list-item -->
<li>Vegan pastries</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list --></div>
<!-- /wp:group -->`;

const roundTrip = (markup: string, options = {}) => {
  const blocks = parseBlocks(markup);
  const slots = extractSlots(blocks, options);
  return serializeBlocks(fillSlots(blocks, slotValues(slots), options));
};

describe('extractSlots', () => {
  it('finds typed, ordered slots with roles and limits', () => {
    const slots = extractSlots(parseBlocks(HERO));
    expect(slots.map((s) => [s.id, s.kind, s.role])).toEqual([
      ['eyebrow', 'text', 'eyebrow'],
      ['title', 'heading', 'title'],
      ['body', 'text', 'body'],
      ['actions', 'group', 'actions'],
    ]);
    const title = slots[1];
    expect(title).toMatchObject({
      value: 'Bread baked <em>before</em> sunrise',
      level: 1,
      length: 26,
      maxLength: 40,
      path: [0, 1],
      block: 'core/heading',
    });
    const actions = slots[3] as GroupSlot;
    expect(actions).toMatchObject({
      flat: true,
      minItems: 1,
      maxItems: 2,
      itemBlock: 'core/button',
    });
    expect(actions.items[0]?.[0]).toMatchObject({
      kind: 'button',
      value: { text: 'See the menu', url: '#menu' },
    });
  });

  it('turns alike cards and list items into repeated groups', () => {
    const slots = extractSlots(parseBlocks(FEATURES));
    expect(slots.map((s) => s.id)).toEqual(['title', 'items', 'list']);
    const items = slots[1] as GroupSlot;
    expect(items.flat).toBe(false);
    expect(items.maxItems).toBe(3); // columns sit side by side
    expect(items.items[0]?.map((s) => [s.id, s.kind])).toEqual([
      ['media', 'image'],
      ['title', 'heading'],
      ['body', 'text'],
    ]);
    expect(items.items[0]?.[0]).toMatchObject({
      value: { url: '/a.jpg', alt: 'Fresh loaves on a shelf' },
      subject: 'Fresh loaves on a shelf',
    });
    expect(slotValues(slots).list).toEqual(['Gluten-free loaves', 'Vegan pastries']);
  });

  it('names slots after renamed blocks', () => {
    const markup = `<!-- wp:paragraph {"metadata":{"name":"Phone number"}} -->
<p>[Add a phone number]</p>
<!-- /wp:paragraph -->`;
    const [slot] = extractSlots(parseBlocks(markup));
    expect(slot).toMatchObject({ id: 'phone-number', label: 'Phone number' });
  });

  it('leaves query loops, navigation and synced patterns alone', () => {
    const markup =
      '<!-- wp:query {"queryId":1} --><div class="wp-block-query"><!-- wp:paragraph --><p>x</p><!-- /wp:paragraph --></div><!-- /wp:query --><!-- wp:pattern {"slug":"a/b"} /-->';
    expect(extractSlots(parseBlocks(markup))).toEqual([]);
  });
});

describe('fillSlots', () => {
  it('gives back the same markup when filled with the same values', () => {
    expect(roundTrip(HERO)).toBe(HERO);
    expect(roundTrip(FEATURES)).toBe(FEATURES);
  });

  it('writes text, links and images, keeping attributes and presets', () => {
    const blocks = parseBlocks(HERO);
    const out = serializeBlocks(
      fillSlots(blocks, {
        title: 'Fresh bread, every morning',
        actions: [{ text: 'Order online', url: 'https://example.com/order?x=1&y=2' }],
      }),
    );
    expect(out).toContain(
      '<h1 class="wp-block-heading has-xx-large-font-size">Fresh bread, every morning</h1>',
    );
    expect(out).toContain('<!-- wp:heading {"level":1,"fontSize":"xx-large"} -->');
    expect(out).toContain('href="https://example.com/order?x=1&amp;y=2">Order online</a>');
    expect(out).not.toContain('Find us');
    expect(out).toContain('<p class="has-small-font-size">Open every day</p>');
    // The input is not changed.
    expect(serializeBlocks(blocks)).toBe(HERO);
  });

  it('escapes plain text from a model and refuses unsafe links', () => {
    const out = serializeBlocks(
      fillSlots(
        parseBlocks(HERO),
        { body: 'Tea & cake <b>daily</b>', actions: [{ text: 'Go', url: 'javascript:alert(1)' }] },
        { format: 'text' },
      ),
    );
    expect(out).toContain('<p>Tea &amp; cake &lt;b&gt;daily&lt;/b&gt;</p>');
    expect(out).toContain('<a class="wp-block-button__link wp-element-button">Go</a>');
  });

  it('grows a repeated group by copying its last item', () => {
    const values: SlotValues = {
      list: ['One', 'Two', 'Three', 'Four'],
      items: [{ title: 'A' }, { title: 'B' }],
    };
    const out = fillSlots(parseBlocks(FEATURES), values);
    const markup = serializeBlocks(out);
    expect(markup.match(/<li>/g)).toHaveLength(4);
    expect(markup).toContain(
      '<li>Three</li>\n<!-- /wp:list-item -->\n\n<!-- wp:list-item -->\n<li>Four</li>',
    );
    // Shrunk to two columns; the third card is gone with its separator.
    expect(markup.match(/<!-- wp:column /g)).toHaveLength(2);
    expect(markup).not.toContain('Cakes');
    expect(markup).toContain('<h3 class="wp-block-heading">B</h3>');
    expect(markup).toContain('<p>Croissants on weekends.</p>');
    // Still valid: parsing and serialising again is stable.
    expect(serializeBlocks(parseBlocks(markup))).toBe(markup);
    const slots = extractSlots(out);
    expect(slotValues(slots).list).toEqual(['One', 'Two', 'Three', 'Four']);
  });

  it('shrinks a group to its minimum and caps it at its maximum', () => {
    const fewer = serializeBlocks(fillSlots(parseBlocks(FEATURES), { list: [] }));
    expect(fewer.match(/<li>/g)).toHaveLength(1);
    const more = fillSlots(parseBlocks(FEATURES), {
      items: [{}, {}, {}, { title: 'Fourth' }],
    });
    expect(serializeBlocks(more)).not.toContain('Fourth');
  });

  it('keeps one column a group, so it can grow again', () => {
    const one = fillSlots(parseBlocks(FEATURES), { items: [{ title: 'Only' }] });
    const slots = extractSlots(one);
    expect(slots.map((s) => s.id)).toEqual(['title', 'items', 'list']);
    // Columns hold as many items as they were designed with, unless declared.
    expect((slots[1] as GroupSlot).maxItems).toBe(1);
    const three = fillSlots(
      one,
      { items: [{}, { title: 'Two' }, { title: 'Three' }] },
      { declarations: { items: { maxItems: 3 } } },
    );
    expect(serializeBlocks(three).match(/<!-- wp:column /g)).toHaveLength(3);
    expect(serializeBlocks(three)).toContain('<h3 class="wp-block-heading">Three</h3>');
  });

  it('writes images, dropping the old attachment ID', () => {
    const markup = `<!-- wp:image {"id":12,"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="/old.jpg" alt="" class="wp-image-12"/></figure>
<!-- /wp:image -->`;
    const out = serializeBlocks(
      fillSlots(parseBlocks(markup), { media: { url: '/new.jpg', alt: 'A "warm" kitchen' } }),
    );
    expect(out).toBe(`<!-- wp:image {"sizeSlug":"large"} -->
<figure class="wp-block-image size-large"><img src="/new.jpg" alt="A &quot;warm&quot; kitchen"/></figure>
<!-- /wp:image -->`);
    const withId = serializeBlocks(
      fillSlots(parseBlocks(markup), { media: { url: '/b.jpg', alt: '', id: 40 } }),
    );
    expect(withId).toContain('{"id":40,"sizeSlug":"large"}');
    expect(withId).toContain('class="wp-image-40"');
  });

  it('fills quotes, details and covers', () => {
    const markup = `<!-- wp:cover {"url":"/c.jpg","alt":"Old","dimRatio":50} -->
<div class="wp-block-cover"><img class="wp-block-cover__image-background" alt="Old" src="/c.jpg" data-object-fit="cover"/><div class="wp-block-cover__inner-container"><!-- wp:quote -->
<blockquote class="wp-block-quote"><!-- wp:paragraph -->
<p>Lovely bread.</p>
<!-- /wp:paragraph --><cite>[Customer name]</cite></blockquote>
<!-- /wp:quote -->

<!-- wp:details -->
<details class="wp-block-details"><summary>Do you deliver?</summary><!-- wp:paragraph -->
<p>Within the city.</p>
<!-- /wp:paragraph --></details>
<!-- /wp:details --></div></div>
<!-- /wp:cover -->`;
    const blocks = parseBlocks(markup);
    const slots = extractSlots(blocks);
    expect(slots.map((s) => [s.id, s.role])).toEqual([
      ['media', 'media'],
      ['body', 'body'],
      ['citation', 'citation'],
      ['items', 'items'],
    ]);
    // A question is an item even alone, so more can be added.
    expect((slots[3] as GroupSlot).items[0]?.map((s) => s.id)).toEqual(['summary', 'body']);
    expect(roundTrip(markup)).toBe(markup);
    const out = serializeBlocks(
      fillSlots(blocks, {
        media: { url: '/d.jpg', alt: 'New' },
        citation: 'Asha, regular',
        items: [{ summary: 'Can I order a cake?' }, { summary: 'Do you deliver?' }],
      }),
    );
    expect(out).toContain('{"url":"/d.jpg","alt":"New","dimRatio":50}');
    expect(out).toContain('alt="New" src="/d.jpg"');
    expect(out).toContain('<cite>Asha, regular</cite>');
    expect(out).toContain('<summary>Can I order a cake?</summary>');
    expect(out.match(/<!-- wp:details -->/g)).toHaveLength(2);
  });
});

describe('declared slots', () => {
  const HOURS = `<!-- wp:group {"metadata":{"name":"Hours"},"layout":{"type":"default"}} -->
<div class="wp-block-group"><!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"metadata":{"name":"Day"}} -->
<p>Monday to Friday</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"metadata":{"name":"Time"}} -->
<p>8:00–18:00</p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->

<!-- wp:group {"layout":{"type":"flex","justifyContent":"space-between"}} -->
<div class="wp-block-group"><!-- wp:paragraph {"metadata":{"name":"Day"}} -->
<p>Saturday</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"metadata":{"name":"Time"}} -->
<p>9:00–14:00</p>
<!-- /wp:paragraph --></div>
<!-- /wp:group --></div>
<!-- /wp:group -->

<!-- wp:paragraph -->
<p>Closed on public holidays.</p>
<!-- /wp:paragraph -->`;

  const declarations = parseSlotDeclarations(
    '{"hours":{"minItems":1,"maxItems":7,"facts":true,"placeholder":"[Add your opening hours]"},"hours.time":{"maxLength":30},"body":{"ignore":true}}',
  );

  it('override the inferred slots', () => {
    const slots = extractSlots(parseBlocks(HOURS), { declarations });
    expect(slots.map((s) => s.id)).toEqual(['hours']);
    const hours = slots[0] as GroupSlot;
    expect(hours).toMatchObject({
      label: 'Hours',
      minItems: 1,
      maxItems: 7,
      facts: true,
      placeholder: '[Add your opening hours]',
    });
    expect(hours.items[0]?.map((s) => s.id)).toEqual(['day', 'time']);
    expect(hours.items[0]?.[1]).toMatchObject({ maxLength: 30 });
    expect(unknownDeclarations(extractSlots(parseBlocks(HOURS)), declarations)).toEqual([]);
    expect(unknownDeclarations([], { nope: {} })).toEqual(['nope']);
  });

  it('allow more items than inferred, and leave ignored slots as they are', () => {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Extra'];
    const out = serializeBlocks(
      fillSlots(
        parseBlocks(HOURS),
        { hours: days.map((day) => ({ day, time: '9–5' })), body: 'Changed' },
        { declarations },
      ),
    );
    expect(out.match(/"name":"Day"/g)).toHaveLength(7);
    expect(out).toContain('<p>Sun</p>');
    expect(out).not.toContain('Extra');
    expect(out).toContain('Closed on public holidays.');
    expect(roundTrip(HOURS, { declarations })).toBe(HOURS);
  });

  it('are checked', () => {
    expect(() => parseSlotDeclarations('{"a":{"maxItems":"3"}}')).toThrow(SlotDeclarationError);
    expect(() => parseSlotDeclarations('{"a":{"colour":"red"}}')).toThrow(/not known/);
    expect(() => parseSlotDeclarations('{"A B":{}}')).toThrow(/not a slot ID/);
    expect(() => parseSlotDeclarations('[1]')).toThrow(/JSON object/);
    expect(() => parseSlotDeclarations('{"a":{"minItems":3,"maxItems":2}}')).toThrow();
  });
});

describe('slotsJsonSchema', () => {
  it('describes the values a model must return', () => {
    const schema = slotsJsonSchema(extractSlots(parseBlocks(FEATURES))) as any;
    expect(schema).toMatchObject({
      type: 'object',
      required: ['title', 'items', 'list'],
      additionalProperties: false,
    });
    expect(schema.properties.title).toMatchObject({ type: 'string', maxLength: 30 });
    expect(schema.properties.title.description).toContain('heading level 2');
    expect(schema.properties.items).toMatchObject({ type: 'array', minItems: 1, maxItems: 3 });
    expect(schema.properties.items.items.properties.media).toMatchObject({
      type: 'object',
      required: ['alt', 'subject'],
    });
    expect(schema.properties.list.items).toMatchObject({ type: 'string' });
  });

  it('tells the model to use the placeholder for facts it was not given', () => {
    const markup =
      '<!-- wp:paragraph {"metadata":{"name":"Quote"}} -->\n<p>[Add a customer quote]</p>\n<!-- /wp:paragraph -->';
    const declarations = { quote: { facts: true, placeholder: '[Add a customer quote]' } };
    const schema = slotsJsonSchema(extractSlots(parseBlocks(markup), { declarations })) as any;
    expect(schema.properties.quote.description).toContain(
      'otherwise exactly "[Add a customer quote]"',
    );
  });
});

describe('placeholders', () => {
  it('are found for the checklist', () => {
    expect(isPlaceholder('[Add a customer quote]')).toBe(true);
    expect(isPlaceholder('<em>[Add a name]</em>')).toBe(true);
    expect(isPlaceholder('Open [daily]')).toBe(false);
    const blocks = fillSlots(parseBlocks(FEATURES), { list: ['[Add a speciality]', 'Rye'] });
    const found = findPlaceholders(extractSlots(blocks));
    expect(found.map((f) => [f.path, f.reason])).toEqual([['list.0', 'text']]);
    const hero = findPlaceholders(extractSlots(parseBlocks(HERO)));
    expect(hero.map((f) => [f.path, f.reason])).toEqual([['actions.1', 'link']]);
  });
});

describe('transferSlots', () => {
  it('moves content into another layout and reports what does not fit', () => {
    const from = extractSlots(parseBlocks(HERO));
    const to = extractSlots(parseBlocks(FEATURES));
    const { values, unused } = transferSlots(from, to);
    expect(values.title).toBe('Bread baked <em>before</em> sunrise');
    // The buttons have no button to go to in the cards, and nothing takes the eyebrow or text.
    expect(unused.map((u) => u.path)).toEqual(['eyebrow', 'body', 'actions.0', 'actions.1']);
    expect(values.items).toBeUndefined();
    const out = serializeBlocks(fillSlots(parseBlocks(FEATURES), values));
    expect(out).toContain('<h2 class="wp-block-heading">Bread baked <em>before</em> sunrise</h2>');
  });

  it('keeps a fourth card out of a three-column layout', () => {
    const four = fillSlots(parseBlocks(FEATURES), {
      items: [{}, {}, {}, { title: 'Fourth' }],
    });
    // Build a four-card source by hand: lists can grow past columns.
    const source = extractSlots(four);
    const sourceGroup = source[1] as GroupSlot;
    const extra = sourceGroup.items[2] ?? [];
    sourceGroup.items.push(
      extra.map((s) => (s.id === 'title' ? ({ ...s, value: 'Fourth' } as Slot) : s)),
    );
    const { values, unused } = transferSlots(source, extractSlots(parseBlocks(FEATURES)));
    expect((values.items as unknown[]).length).toBe(3);
    expect(unused.map((u) => u.path)).toEqual(['items.3.media', 'items.3.title', 'items.3.body']);
  });

  it('round-trips a section through another layout and back', () => {
    const hero = parseBlocks(HERO);
    const other = parseBlocks(HERO.replace('"level":1', '"level":2').replace(/h1/g, 'h2'));
    const there = fillSlots(other, transferSlots(extractSlots(hero), extractSlots(other)).values);
    const back = fillSlots(hero, transferSlots(extractSlots(there), extractSlots(hero)).values);
    expect(serializeBlocks(back)).toBe(HERO);
  });
});
