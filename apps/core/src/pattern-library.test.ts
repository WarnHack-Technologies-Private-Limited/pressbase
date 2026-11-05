import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBlocks, serializeBlocks } from '@pressbase/blocks';
import { checkPattern, LIBRARY_CATEGORIES, libraryPatterns } from '@pressbase/patterns';
import {
  extractSlots,
  fillSlots,
  findPlaceholders,
  type GroupSlot,
  isPlaceholder,
  type Slot,
  type SlotValue,
  type SlotValues,
  slotValues,
  transferSlots,
} from '@pressbase/slots';
import { applyStyleVariation, type StyleVariation } from '@pressbase/theme-json';
import { describe, expect, it } from 'vitest';
import { CORE_PATTERNS } from './blocks/patterns';
import { checkPage, pageStylesFromThemeJson } from './quality/check-page';
import { setup } from './test-utils';
import { loadPhpPattern } from './themes/php-patterns';

/**
 * Pattern slots (@pressbase/slots) over the bundled theme's patterns, the
 * `Slots:` header, and the Pressbase pattern library (@pressbase/patterns)
 * as core registers it. See docs/architecture/patterns.md.
 */

const THEME_PATTERNS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../themes/pressbase/patterns',
);
const CONTEXT = {
  templateUri: '/wp-content/themes/pressbase',
  stylesheetUri: '/wp-content/themes/pressbase',
};

async function themePatterns() {
  const out: { file: string; slug: string; content: string }[] = [];
  for (const file of (await readdir(THEME_PATTERNS)).filter((f) => f.endsWith('.php')).sort()) {
    const result = loadPhpPattern(await readFile(path.join(THEME_PATTERNS, file), 'utf8'), CONTEXT);
    if (!result.ok) throw new Error(`${file}: ${result.reason}`);
    out.push({ file, slug: result.pattern.slug, content: result.pattern.content });
  }
  return out;
}

const shape = (slots: Slot[]): string[] =>
  slots.map((s) => (s.kind === 'group' ? `${s.id}[${s.items.length}]` : s.id));

describe('slots of the Pressbase theme’s patterns', () => {
  it('extract, fill with the same values and serialise to the same markup', async () => {
    const patterns = await themePatterns();
    expect(patterns.length).toBeGreaterThanOrEqual(29);
    let withSlots = 0;
    for (const { file, content } of patterns) {
      const blocks = parseBlocks(content);
      const slots = extractSlots(blocks);
      if (slots.length > 0) withSlots++;
      expect(serializeBlocks(fillSlots(blocks, slotValues(slots))), file).toBe(content);
      // fillSlots() works on a copy: the parsed pattern is unchanged.
      expect(serializeBlocks(blocks), file).toBe(content);
    }
    expect(withSlots).toBeGreaterThanOrEqual(22);
  });

  it('find the sections’ repeated items', async () => {
    const byFile = new Map((await themePatterns()).map((p) => [p.file, p.content]));
    const slotsOf = (file: string) => extractSlots(parseBlocks(byFile.get(file) as string));
    expect(shape(slotsOf('faq.php'))).toEqual(['title', 'body', 'items[5]']);
    expect(shape(slotsOf('team.php'))).toEqual(['title', 'body', 'items[4]']);
    expect(shape(slotsOf('cta-band.php'))).toEqual(['title', 'body', 'actions[2]']);
    const team = slotsOf('team.php')[2] as GroupSlot;
    expect(shape(team.items[0] ?? [])).toEqual(['media', 'title', 'body']);
    expect(team.items[0]?.[0]).toMatchObject({
      kind: 'image',
      value: {
        url: '/wp-content/themes/pressbase/assets/images/portrait-1.svg',
        alt: 'Placeholder portrait',
      },
    });
    // The highlighted middle plan has an extra label, so plans aren't alike: each is its own slots.
    expect(shape(slotsOf('pricing.php'))).toContain('list-2[4]');
  });

  it('grow and shrink the repeated items of a theme pattern', async () => {
    const byFile = new Map((await themePatterns()).map((p) => [p.file, p.content]));
    const blocks = parseBlocks(byFile.get('faq.php') as string);
    const questions = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        summary: `Question ${i + 1}?`,
        body: `Answer ${i + 1}.`,
      }));
    for (const n of [1, 2, 7]) {
      const markup = serializeBlocks(fillSlots(blocks, { items: questions(n) }));
      expect(markup.match(/<!-- wp:details[ -]/g)).toHaveLength(n);
      expect(markup).toContain(`<summary>Question ${n}?</summary>`);
      expect(serializeBlocks(parseBlocks(markup))).toBe(markup);
      const items = extractSlots(parseBlocks(markup))[2] as GroupSlot;
      expect(items.items).toHaveLength(n);
    }
  });

  it('move a theme section into a library layout (Swap layout)', async () => {
    const byFile = new Map((await themePatterns()).map((p) => [p.file, p.content]));
    const from = extractSlots(parseBlocks(byFile.get('cta-band.php') as string));
    const hero = libraryPatterns().find((p) => p.name === 'pressbase/hero-centered');
    const blocks = parseBlocks(hero?.content as string);
    const { values, unused } = transferSlots(
      from,
      extractSlots(blocks, { declarations: hero?.slots }),
    );
    expect(unused).toEqual([]);
    const markup = serializeBlocks(fillSlots(blocks, values, { declarations: hero?.slots }));
    expect(markup).toContain(
      '<h1 class="wp-block-heading has-text-align-center has-xx-large-font-size">',
    );
    expect(markup).not.toContain('Good work, done properly');
  });
});

describe('the Slots header of a PHP pattern', () => {
  const pattern = (slots: string) => `<?php
/**
 * Title: Hours
 * Slug: acme/hours
 * Slots: ${slots}
 */
?>
<!-- wp:paragraph -->
<p><?php esc_html_e( 'Mon to Fri, 9 to 5', 'acme' ); ?></p>
<!-- /wp:paragraph -->`;

  it('declares slots', () => {
    const result = loadPhpPattern(
      pattern('{"body":{"facts":true,"placeholder":"[Add your hours]"}}'),
      CONTEXT,
    );
    expect(result).toMatchObject({
      ok: true,
      pattern: { slots: { body: { facts: true, placeholder: '[Add your hours]' } } },
    });
  });

  it('skips the pattern when it is not valid', () => {
    expect(loadPhpPattern(pattern('{"body":{"facts":"yes"}}'), CONTEXT)).toEqual({
      ok: false,
      reason: 'the "Slots" header is not valid: slots.body.facts must be true or false',
    });
  });
});

describe('the Pressbase pattern library', () => {
  it('follows the library rules: presets, core blocks, headings, alt text, no scripts', () => {
    for (const pattern of libraryPatterns())
      expect(checkPattern(pattern), pattern.name).toEqual([]);
  });

  it('shares no name with the theme’s patterns or core’s built-ins', async () => {
    const taken = new Set([
      ...(await themePatterns()).map((p) => p.slug),
      ...CORE_PATTERNS.map((p) => p.name),
    ]);
    for (const { name } of libraryPatterns()) {
      expect(name.startsWith('pressbase/'), name).toBe(true);
      expect(taken.has(name), name).toBe(false);
    }
  });

  it('is registered with its categories and served by /wp/v2/block-patterns', async () => {
    const ctx = await setup();
    await ctx.install();
    await ctx.kernel.themes.activate('pressbase');
    const res = await ctx.request('GET', '/wp/v2/block-patterns/patterns');
    expect(res.status).toBe(200);
    const byName = new Map(res.body.map((p: { name: string }) => [p.name, p]));
    for (const pattern of libraryPatterns()) {
      const served = byName.get(pattern.name) as Record<string, unknown>;
      expect(served, pattern.name).toMatchObject({
        title: pattern.title,
        content: pattern.content,
        categories: pattern.categories,
        keywords: pattern.keywords,
        viewport_width: pattern.viewportWidth,
        source: 'core',
      });
      if (pattern.slots) expect(served.slots).toEqual(pattern.slots);
    }
    expect(byName.get('pressbase/opening-hours')).toMatchObject({
      categories: ['opening-hours', 'contact'],
      slots: { hours: { minItems: 1, maxItems: 7, facts: true } },
    });

    const categories = (await ctx.request('GET', '/wp/v2/block-patterns/categories')).body as {
      name: string;
      label: string;
    }[];
    const names = categories.map((c) => c.name);
    for (const category of LIBRARY_CATEGORIES)
      expect(names, category.name).toContain(category.name);
    // WordPress's own categories keep WordPress's labels; each is registered once.
    expect(categories.find((c) => c.name === 'banner')?.label).toBe('Banners');
    expect(categories.find((c) => c.name === 'opening-hours')?.label).toBe('Opening hours');
    expect(new Set(names).size).toBe(names.length);
  });
});

/** Every image slot in a list of slots, through groups. */
const imagesIn = (slots: Slot[]): Extract<Slot, { kind: 'image' }>[] =>
  slots.flatMap((s) =>
    s.kind === 'image' ? [s] : s.kind === 'group' ? s.items.flatMap(imagesIn) : [],
  );

describe('the library’s sections (#40–#43)', () => {
  // Every section a page is built from; headers and footers are template parts (below).
  const sections = LIBRARY_CATEGORIES.map((c) => c.name).filter(
    (name) => name !== 'header' && name !== 'footer',
  );
  const byCategory = (category: string) =>
    libraryPatterns().filter((p) => p.categories[0] === category);

  it('offers two to four layouts per section, as many as the site builder offers', () => {
    for (const category of sections) {
      const count = byCategory(category).length;
      expect(count, category).toBeGreaterThanOrEqual(2);
      expect(count, category).toBeLessThanOrEqual(4);
    }
  });

  it('leaves images to be chosen: no file, alt text that says what to show, and a subject', () => {
    let images = 0;
    for (const pattern of libraryPatterns()) {
      const slots = extractSlots(parseBlocks(pattern.content), { declarations: pattern.slots });
      for (const image of imagesIn(slots)) {
        images++;
        expect(image.value.url, `${pattern.name} ${image.id}`).toBe('');
        expect(image.value.alt.length, `${pattern.name} ${image.id}`).toBeGreaterThan(10);
        expect(image.subject, `${pattern.name} ${image.id}`).toBeTruthy();
      }
      // An image not chosen is a placeholder on the "Before you publish" checklist.
      const unchosen = findPlaceholders(slots).filter((f) => f.reason === 'image');
      expect(unchosen).toHaveLength(imagesIn(slots).length);
    }
    expect(images).toBeGreaterThan(20);
  });

  it('swap layouts within a section and keep the heading', () => {
    for (const category of sections) {
      const patterns = byCategory(category);
      for (const from of patterns) {
        const fromSlots = extractSlots(parseBlocks(from.content), { declarations: from.slots });
        const title = fromSlots.find((s) => s.id === 'title');
        for (const to of patterns) {
          if (to === from) continue;
          const blocks = parseBlocks(to.content);
          const options = { declarations: to.slots };
          const { values, unused } = transferSlots(fromSlots, extractSlots(blocks, options));
          const where = `${from.name} → ${to.name}`;
          expect(values.title, where).toBe(title?.kind === 'heading' ? title.value : undefined);
          expect(
            unused.map((u) => u.path),
            where,
          ).not.toContain('title');
          const markup = serializeBlocks(fillSlots(blocks, values, options));
          expect(serializeBlocks(parseBlocks(markup)), where).toBe(markup);
          expect(checkPattern({ ...to, content: markup }), where).toEqual([]);
        }
      }
    }
  });

  it('pass the quality checks in the Pressbase theme and its dark Midnight style', async () => {
    const ctx = await setup();
    await ctx.install();
    await ctx.kernel.themes.activate('pressbase');
    const active = await ctx.kernel.themes.active();
    const midnight = active.variations.find((v) => v.title === 'Midnight');
    const dark = await ctx.kernel.themes.withUserStyles(
      applyStyleVariation({ version: 3 }, midnight as StyleVariation),
    );
    const problems: string[] = [];
    for (const [scheme, theme] of [
      ['default', active],
      ['Midnight', dark],
    ] as const) {
      const styles = pageStylesFromThemeJson(theme.themeJson.tree.getRawData());
      for (const pattern of libraryPatterns()) {
        const findings = checkPage(pattern.content, styles, {
          blockTypes: ctx.kernel.blocks.registry,
          titleIsH1: pattern.categories[0] !== 'banner',
        });
        for (const f of findings) {
          // Images left to choose and `#` links are placeholders a person fills in.
          if (f.rule === 'placeholder') continue;
          problems.push(
            `${scheme} ${pattern.name}: ${f.rule} ${f.message} ${JSON.stringify(f.block)}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('render without the images not chosen yet; galleries keep their columns', async () => {
    const ctx = await setup();
    await ctx.install();
    await ctx.kernel.themes.activate('pressbase');
    const content = ['hero-split-image', 'gallery-grid']
      .map((name) => libraryPatterns().find((p) => p.name === `pressbase/${name}`)?.content)
      .join('\n\n');
    const chosen =
      '<!-- wp:image -->\n<figure class="wp-block-image"><img src="/a.jpg" alt="A chosen image"/></figure>\n<!-- /wp:image -->';
    const created = await ctx.request('POST', '/wp/v2/pages', {
      title: 'Sections',
      slug: 'sections',
      status: 'publish',
      content: `${content}\n\n${chosen}`,
    });
    expect(created.status).toBe(201);
    const res = await ctx.app.request(
      `/wp-json/pressbase/v1/render?url=${encodeURIComponent('/sections/')}`,
    );
    const { html } = (await res.json()) as { html: string };
    expect(html).toContain('Thoughtful work for people who notice the details');
    // render_block_core_image(): no source, no image.
    expect(html).not.toContain('A bright, welcoming workspace');
    expect(html.match(/<img\b[^>]*\balt="A chosen image"/g)).toHaveLength(1);
    // block_core_gallery_render(): a unique class and the gap its image widths subtract.
    expect(html).toMatch(/<figure class="wp-block-gallery [^"]*\bwp-block-gallery-1\b/);
    expect(html).toContain(
      '.wp-block-gallery.wp-block-gallery-1{--wp--style--unstable-gallery-gap:var( --wp--style--gallery-gap-default, var( --gallery-block--gutter-size, var( --wp--style--block-gap, 0.5em ) ) );}',
    );
  });
});

/**
 * A pattern's slots with every placeholder filled in, as the site's owner
 * does before publishing: text in brackets, `#` links and images not chosen.
 */
function filledIn(slots: Slot[]): SlotValues {
  const fill = (slot: Slot): SlotValue => {
    switch (slot.kind) {
      case 'group':
        return slot.items.map((item) =>
          slot.flat && item[0] ? fill(item[0]) : (filledIn(item) as SlotValue),
        );
      case 'image':
        return { url: '/wp-content/uploads/photo.jpg', alt: slot.value.alt };
      case 'button':
        return {
          text: isPlaceholder(slot.value.text) ? 'Book a table' : slot.value.text,
          url: slot.value.url === '' || slot.value.url === '#' ? '/contact/' : slot.value.url,
        };
      default:
        return isPlaceholder(slot.value) ? 'Filled in by the owner' : slot.value;
    }
  };
  return Object.fromEntries(slots.map((slot) => [slot.id, fill(slot)]));
}

describe('the library with its placeholders filled in (#42, #43)', () => {
  it('passes every quality check, the "Before you publish" checklist’s included', async () => {
    const ctx = await setup();
    await ctx.install();
    await ctx.kernel.themes.activate('pressbase');
    const active = await ctx.kernel.themes.active();
    const midnight = active.variations.find((v) => v.title === 'Midnight');
    const dark = await ctx.kernel.themes.withUserStyles(
      applyStyleVariation({ version: 3 }, midnight as StyleVariation),
    );
    const problems: string[] = [];
    for (const [scheme, theme] of [
      ['default', active],
      ['Midnight', dark],
    ] as const) {
      const styles = pageStylesFromThemeJson(theme.themeJson.tree.getRawData());
      for (const pattern of libraryPatterns()) {
        const blocks = parseBlocks(pattern.content);
        const options = { declarations: pattern.slots };
        const markup = serializeBlocks(
          fillSlots(blocks, filledIn(extractSlots(blocks, options)), options),
        );
        for (const f of checkPage(markup, styles, {
          blockTypes: ctx.kernel.blocks.registry,
          titleIsH1: pattern.categories[0] !== 'banner',
        })) {
          problems.push(`${scheme} ${pattern.name}: ${f.rule} ${f.message}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('render on a page: questions open, hours and plans are lists, quotes are quotes', async () => {
    const ctx = await setup();
    await ctx.install();
    await ctx.kernel.themes.activate('pressbase');
    const batch = libraryPatterns().filter((p) =>
      [
        'pricing',
        'testimonials',
        'team',
        'faq',
        'contact',
        'opening-hours',
        'header',
        'footer',
      ].includes(p.categories[0] as string),
    );
    expect(batch.length).toBe(23);
    const created = await ctx.request('POST', '/wp/v2/pages', {
      title: 'Sections',
      slug: 'sections',
      status: 'publish',
      content: batch.map((p) => p.content).join('\n\n'),
    });
    expect(created.status).toBe(201);
    const res = await ctx.app.request(
      `/wp-json/pressbase/v1/render?url=${encodeURIComponent('/sections/')}`,
    );
    const { html } = (await res.json()) as { html: string };
    for (const pattern of batch) {
      const title = extractSlots(parseBlocks(pattern.content), {
        declarations: pattern.slots,
      }).find((s) => s.id === 'title');
      if (title?.kind === 'heading') expect(html, pattern.name).toContain(title.value);
    }
    expect(html.match(/<details class="wp-block-details/g)?.length).toBe(16);
    expect(html).toContain('<summary>How do I book?</summary>');
    expect(html).toMatch(/<blockquote class="wp-block-quote[^"]*">\s*<p>\[Add a customer’s words/);
    expect(html).toContain('<cite>[Customer name]</cite>');
    expect(html).toContain('<li>Monday to Friday: 8:00 – 18:00</li>');
    expect(html).toContain('href="/contact/"');
    expect(html).toContain('href="https://www.openstreetmap.org/"');
    // Portraits and the contact image aren't chosen yet: left out, as render_block_core_image() does.
    expect(html).not.toContain('Portrait of a member of the team');
    // The menus: six, the footer's named.
    expect(html.match(/<nav\b/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html).toContain('aria-label="Footer"');
  });

  it('rebuild the site’s header and footer (core/update-template-part)', async () => {
    const ctx = await setup();
    await ctx.install();
    await ctx.kernel.themes.activate('pressbase');
    for (const pattern of libraryPatterns()) {
      const area = pattern.categories[0];
      if (area !== 'header' && area !== 'footer') continue;
      expect(pattern.blockTypes).toEqual([`core/template-part/${area}`]);
      const res = await ctx.request(
        'POST',
        '/wp-abilities/v1/abilities/core/update-template-part/run',
        { input: { slug: area, pattern: pattern.name } },
      );
      expect(res.status, pattern.name).toBe(200);
      expect(res.body.area).toBe(area);
      // Contact details nobody gave yet are on the "Before you publish" list.
      if (pattern.name === 'pressbase/footer-hours') {
        expect(res.body.placeholders).toEqual(['0.address', '0.phone', '0.email']);
      }
      const changesets = await ctx.request('GET', '/pressbase/v1/changesets');
      const content = changesets.body[0]?.entries[`wp_template_part:${area}`]?.value.content;
      expect(content, pattern.name).toContain(`"patternName":"${pattern.name}"`);
    }
    // Served for the editor's "Replace" of a template part, as WordPress's Block Types header.
    const served = (await ctx.request('GET', '/wp/v2/block-patterns/patterns')).body as {
      name: string;
      block_types?: string[];
    }[];
    expect(served.find((p) => p.name === 'pressbase/header-centered')?.block_types).toEqual([
      'core/template-part/header',
    ]);
  });
});
