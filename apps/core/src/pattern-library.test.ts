import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBlocks, serializeBlocks } from '@pressbase/blocks';
import { checkPattern, LIBRARY_CATEGORIES, libraryPatterns } from '@pressbase/patterns';
import {
  extractSlots,
  fillSlots,
  type GroupSlot,
  type Slot,
  slotValues,
  transferSlots,
} from '@pressbase/slots';
import { describe, expect, it } from 'vitest';
import { CORE_PATTERNS } from './blocks/patterns';
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
