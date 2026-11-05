import { describe, expect, it } from 'vitest';
import { setup, type TestResponse } from './test-utils';

/**
 * The site-building abilities (#56): reads, and writes that land in the
 * user's changeset while the live site stays as it was. See
 * docs/architecture/site-abilities.md.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;
type Client = Pick<Ctx, 'request'>;

async function site(): Promise<Ctx> {
  const ctx = await setup();
  await ctx.install();
  await ctx.kernel.themes.activate('pressbase');
  return ctx;
}

const READS = new Set([
  'core/get-site-brief',
  'core/get-design-system',
  'core/list-patterns',
  'core/get-page-structure',
]);

/** Runs an ability over REST with the method its annotations ask for. */
function run(client: Client, name: string, input?: unknown): Promise<TestResponse> {
  const url = `/wp-abilities/v1/abilities/${name}/run`;
  if (READS.has(name)) {
    const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    return client.request('GET', `${url}${query}`);
  }
  return client.request('POST', url, input === undefined ? {} : { input });
}

/** The user's open changeset's entries. */
async function entries(ctx: Ctx, client: Client = ctx) {
  const res = await client.request('GET', '/pressbase/v1/changesets');
  return (res.body[0]?.entries ?? {}) as Record<string, { value: Record<string, unknown> }>;
}

const HERO = 'pressbase/hero-centered';
const HOURS = 'pressbase/opening-hours';

async function pageFromPattern(ctx: Ctx, title: string, ...names: string[]) {
  const patterns = ctx.kernel.blocks.patterns();
  const content = names
    .map((name) => patterns.find((p) => p.name === name)?.content ?? '')
    .join('\n\n');
  const res = await ctx.request('POST', '/wp/v2/pages', { title, content, status: 'publish' });
  expect(res.status).toBe(201);
  return res.body as { id: number; slug: string };
}

describe('site-building abilities', () => {
  it('are registered in REST with schemas', async () => {
    const ctx = await site();
    const res = await ctx.request('GET', '/wp-abilities/v1/abilities?per_page=100');
    const names = (res.body as { name: string }[]).map((a) => a.name);
    for (const name of [
      'core/get-site-brief',
      'core/get-design-system',
      'core/list-patterns',
      'core/get-page-structure',
      'core/create-page',
      'core/update-page-sections',
      'core/update-global-styles',
      'core/update-template-part',
      'core/propose-site-edits',
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe('core/get-site-brief', () => {
  it('reads the brief, saved through /wp/v2/settings', async () => {
    const ctx = await site();
    const empty = await run(ctx, 'core/get-site-brief');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({
      name: 'Test Site',
      kind: '',
      audience: '',
      tone: '',
      facts: [],
      pages: [],
      language: 'en-US',
    });

    const saved = await ctx.request('POST', '/wp/v2/settings', {
      pressbase_site_brief: {
        name: 'Corner Bakery',
        kind: 'bakery',
        facts: ['Open 7am to 3pm, Tuesday to Sunday', '12 Mill Street, Leeds'],
        pages: ['Home', 'Menu'],
        language: 'en_GB',
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.pressbase_site_brief.language).toBe('en-GB');
    const brief = await run(ctx, 'core/get-site-brief');
    expect(brief.body).toMatchObject({
      name: 'Corner Bakery',
      kind: 'bakery',
      audience: '',
      facts: ['Open 7am to 3pm, Tuesday to Sunday', '12 Mill Street, Leeds'],
      pages: ['Home', 'Menu'],
      language: 'en-GB',
    });

    const invalid = await ctx.request('POST', '/wp/v2/settings', {
      pressbase_site_brief: { facts: 'not a list' },
    });
    expect(invalid.status).toBe(400);
    const extra = await ctx.request('POST', '/wp/v2/settings', {
      pressbase_site_brief: { secret: 'x' },
    });
    expect(extra.status).toBe(400);
  });

  it('checks permissions and input', async () => {
    const ctx = await site();
    const author = await ctx.loginAs('writer', 'author');
    expect((await run(author, 'core/get-site-brief')).status).toBe(200);
    const subscriber = await ctx.loginAs('reader', 'subscriber');
    expect((await run(subscriber, 'core/get-site-brief')).status).toBe(403);
    const invalid = await run(ctx, 'core/get-site-brief', { nope: 1 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('ability_invalid_input');
  });
});

describe('core/get-design-system', () => {
  it('gives the presets, styles and design options', async () => {
    const ctx = await site();
    const res = await run(ctx, 'core/get-design-system');
    expect(res.status).toBe(200);
    expect(res.body.theme).toBe('pressbase');
    expect(res.body.from_changeset).toBe(false);
    const slugs = res.body.palette.map((p: { slug: string }) => p.slug);
    expect(slugs).toEqual(expect.arrayContaining(['base', 'contrast', 'accent']));
    expect(res.body.palette[0].color).toMatch(/^#/);
    expect(res.body.font_sizes.length).toBeGreaterThan(0);
    expect(res.body.spacing_sizes.length).toBeGreaterThan(0);
    expect(res.body.design_options.font_pairs.map((p: { id: string }) => p.id)).toContain(
      'platypi-manrope',
    );
    expect(res.body.styles.blocks).toBeUndefined();
    // Compact enough for a prompt.
    expect(JSON.stringify(res.body).length).toBeLessThan(20_000);

    const subscriber = await ctx.loginAs('reader', 'subscriber');
    expect((await run(subscriber, 'core/get-design-system')).status).toBe(403);
  });
});

describe('core/list-patterns', () => {
  it('lists patterns with their category and slots', async () => {
    const ctx = await site();
    const res = await run(ctx, 'core/list-patterns');
    expect(res.status).toBe(200);
    const hero = res.body.patterns.find((p: { name: string }) => p.name === HERO);
    expect(hero).toMatchObject({ category: 'banner', source: 'library' });
    expect(hero.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'title', kind: 'heading', level: 1 }),
        expect.objectContaining({ id: 'actions', kind: 'group', flat: true }),
      ]),
    );
    expect(hero.slots_schema).toBeUndefined();
    // The theme's too, and not hidden ones.
    const names = res.body.patterns.map((p: { name: string }) => p.name);
    expect(names).toContain('pressbase/footer-minimal');
    expect(names.some((n: string) => n.startsWith('pressbase/hidden-'))).toBe(false);
    expect(res.body.categories).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'banner', label: 'Banners' })]),
    );

    const hours = await run(ctx, 'core/list-patterns', {
      category: 'opening-hours',
      slots_schema: true,
    });
    expect(hours.body.patterns.map((p: { name: string }) => p.name)).toEqual([
      HOURS,
      'pressbase/opening-hours-band',
      'pressbase/opening-hours-card',
    ]);
    const [pattern] = hours.body.patterns;
    expect(pattern.slots.find((s: { id: string }) => s.id === 'hours')).toMatchObject({
      facts: true,
      min_items: 1,
      max_items: 7,
    });
    expect(pattern.slots_schema.properties.hours.type).toBe('array');

    const author = await ctx.loginAs('writer', 'author');
    expect((await run(author, 'core/list-patterns')).status).toBe(200);
    const subscriber = await ctx.loginAs('reader', 'subscriber');
    expect((await run(subscriber, 'core/list-patterns')).status).toBe(403);
  });
});

describe('core/create-page', () => {
  it('adds a page built from patterns to the changeset, not the live site', async () => {
    const ctx = await site();
    await pageFromPattern(ctx, 'About', HERO);
    const res = await run(ctx, 'core/create-page', {
      title: 'About',
      sections: [
        {
          pattern: HERO,
          slots: {
            title: 'Fresh bread <every> morning',
            actions: [{ text: 'See the menu', url: '/menu' }],
          },
        },
        { pattern: HOURS, slots: { hours: [{ day: '[Add days]', time: '[Add hours]' }] } },
      ],
    });
    expect(res.status).toBe(200);
    // "about" is taken by a live page, so the new one gets its own slug.
    expect(res.body).toMatchObject({ slug: 'about-2', title: 'About', entry: 'page:about-2' });
    expect(res.body.sections).toEqual([
      { index: 0, pattern: HERO },
      { index: 1, pattern: HOURS },
    ]);
    expect(res.body.placeholders).toEqual(expect.arrayContaining(['1.hours.0.day']));
    expect(res.body.preview_link).toContain(`changeset_uuid=${res.body.changeset_uuid}`);

    const pending = await entries(ctx);
    const content = pending['page:about-2']?.value.content as string;
    expect(content).toContain('Fresh bread &lt;every&gt; morning');
    expect(content).toContain('"patternName":"pressbase/hero-centered"');
    expect(content).toContain('href="/menu"');
    expect(content).not.toContain('Good work, done properly');
    // Nothing is live.
    const live = await ctx.request('GET', '/wp/v2/pages?slug=about-2&status=any');
    expect(live.body).toEqual([]);

    // Read back through the changeset.
    const structure = await run(ctx, 'core/get-page-structure', { slug: 'about-2' });
    expect(structure.status).toBe(200);
    expect(structure.body).toMatchObject({ id: null, from_changeset: true, title: 'About' });
    expect(structure.body.sections[0]).toMatchObject({ pattern: HERO, block: 'core/group' });
    expect(structure.body.sections[0].values.title).toBe('Fresh bread <every> morning');
  });

  it('validates patterns and slots, and checks permissions', async () => {
    const ctx = await site();
    const bad = async (input: unknown, code = 'ability_invalid_input') => {
      const res = await run(ctx, 'core/create-page', input);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
      return res.body.message as string;
    };
    expect(await bad({ title: 'X', sections: [{ pattern: 'acme/nope' }] })).toContain(
      'there’s no pattern “acme/nope”',
    );
    expect(
      await bad({ title: 'X', sections: [{ pattern: HERO, slots: { title: 'x'.repeat(500) } }] }),
    ).toContain('title');
    await bad({ title: 'X', sections: [{ pattern: HERO, slots: { nope: 'x' } }] });
    await bad({
      title: 'X',
      sections: [
        { pattern: HERO, slots: { actions: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] } },
      ],
    });
    // Images take alt text and a subject, never a URL from the model.
    await bad({ title: 'X', sections: [{ pattern: HERO, markup: '<p>hi</p>' }] });
    await bad({ title: '' });
    expect(await entries(ctx)).toEqual({});

    const author = await ctx.loginAs('writer', 'author');
    const denied = await run(author, 'core/create-page', { title: 'Mine' });
    expect(denied.status).toBe(403);
    const editor = await ctx.loginAs('ed', 'editor');
    const ok = await run(editor, 'core/create-page', { title: 'Team', status: 'draft' });
    expect(ok.status).toBe(200);
    expect((await entries(ctx, editor))['page:team']?.value).toMatchObject({
      title: 'Team',
      status: 'draft',
      content: '',
    });
  });
});

describe('core/update-page-sections', () => {
  it('inserts, updates, moves, replaces and removes sections in the changeset', async () => {
    const ctx = await site();
    const page = await pageFromPattern(ctx, 'Home', HERO);
    const before = (await ctx.kernel.posts.get(page.id))?.content;

    const structure = await run(ctx, 'core/get-page-structure', { id: page.id });
    expect(structure.body).toMatchObject({
      id: page.id,
      from_changeset: false,
      changeset_uuid: null,
    });
    expect(structure.body.sections).toHaveLength(1);
    expect(structure.body.sections[0]).toMatchObject({ index: 0, pattern: null });
    expect(structure.body.sections[0].values.title).toBe('Good work, done properly and on time');
    expect(structure.body.sections[0].placeholders).toEqual(expect.arrayContaining(['actions.0']));

    const res = await run(ctx, 'core/update-page-sections', {
      id: page.id,
      operations: [
        { type: 'updateSlots', index: 0, slots: { title: 'Fresh bread every morning' } },
        {
          type: 'insertSection',
          pattern: HOURS,
          slots: { hours: [{ day: 'Tue–Sun', time: '7am–3pm' }] },
        },
        { type: 'insertSection', index: 0, pattern: HERO, slots: { title: 'Second hero' } },
        { type: 'moveSection', index: 0, to: 2 },
        { type: 'removeSection', index: 1 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: page.id, entry: `page:${page.id}` });
    expect(res.body.sections).toEqual([
      { index: 0, pattern: null },
      { index: 1, pattern: HERO },
    ]);

    // Swap layout: the opening hours become a hero, keeping what fits.
    const swapped = await run(ctx, 'core/update-page-sections', {
      id: page.id,
      operations: [{ type: 'replaceSection', index: 0, pattern: HOURS }],
    });
    expect(swapped.status).toBe(200);
    expect(swapped.body.sections[0].pattern).toBe(HOURS);

    const after = await run(ctx, 'core/get-page-structure', { id: page.id });
    expect(after.body.from_changeset).toBe(true);
    expect(after.body.sections.map((s: { pattern: string }) => s.pattern)).toEqual([HOURS, HERO]);
    expect(after.body.sections[0].values.title).toBe('Fresh bread every morning');
    expect(after.body.sections[1].values.title).toBe('Second hero');

    // Live page unchanged.
    expect((await ctx.kernel.posts.get(page.id))?.content).toBe(before);

    // A second write keeps the entry's other fields.
    const pending = await entries(ctx);
    expect(Object.keys(pending)).toEqual([`page:${page.id}`]);
  });

  it('rejects bad indexes and slots, and checks edit_post', async () => {
    const ctx = await site();
    const page = await pageFromPattern(ctx, 'Home', HERO);
    const outOfRange = await run(ctx, 'core/update-page-sections', {
      id: page.id,
      operations: [{ type: 'removeSection', index: 3 }],
    });
    expect(outOfRange.status).toBe(400);
    expect(outOfRange.body.message).toContain('there’s no section 3');
    const unknownOp = await run(ctx, 'core/update-page-sections', {
      id: page.id,
      operations: [{ type: 'rewrite', index: 0, markup: '<p>x</p>' }],
    });
    expect(unknownOp.status).toBe(400);
    const tooLong = await run(ctx, 'core/update-page-sections', {
      id: page.id,
      operations: [{ type: 'updateSlots', index: 0, slots: { title: 'x'.repeat(400) } }],
    });
    expect(tooLong.status).toBe(400);
    const missing = await run(ctx, 'core/update-page-sections', {
      id: 99999,
      operations: [{ type: 'removeSection', index: 0 }],
    });
    expect(missing.status).toBe(404);
    expect(await entries(ctx)).toEqual({});

    const contributor = await ctx.loginAs('con', 'contributor');
    const denied = await run(contributor, 'core/update-page-sections', {
      id: page.id,
      operations: [{ type: 'removeSection', index: 0 }],
    });
    expect(denied.status).toBe(403);
    const editor = await ctx.loginAs('ed', 'editor');
    const allowed = await run(editor, 'core/update-page-sections', {
      id: page.id,
      operations: [{ type: 'removeSection', index: 0 }],
    });
    expect(allowed.status).toBe(200);
    expect((await entries(ctx, editor))[`page:${page.id}`]?.value.content).toBe('');
  });
});

describe('core/update-global-styles', () => {
  it('applies a design direction and preset styles in the changeset', async () => {
    const ctx = await site();
    const livePalette = JSON.stringify((await ctx.kernel.themes.active()).globalStyles.config);
    const design = {
      mood: 'warm',
      hue: 140,
      contrast: 'standard',
      scheme: 'light',
      fontPair: 'slab-humanist',
      radius: 'rounded',
      density: 'comfortable',
    };
    const res = await run(ctx, 'core/update-global-styles', { design });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ theme: 'pressbase', entry: 'wp_global_styles:pressbase' });
    expect(res.body.palette.map((p: { slug: string }) => p.slug)).toContain('accent');

    const styled = await run(ctx, 'core/update-global-styles', {
      styles: { elements: { button: { color: { background: 'var:preset|color|accent' } } } },
    });
    expect(styled.status).toBe(200);
    const value = (await entries(ctx))['wp_global_styles:pressbase']?.value as {
      settings: { color: { palette: { theme: unknown[] } } };
      styles: { elements: { button: { color: { background: string } } } };
    };
    // Both changes are kept.
    expect(value.settings.color.palette.theme.length).toBeGreaterThan(0);
    expect(value.styles.elements.button.color.background).toBe('var:preset|color|accent');

    const system = await run(ctx, 'core/get-design-system');
    expect(system.body.from_changeset).toBe(true);
    expect(system.body.palette).toEqual(expect.arrayContaining(res.body.palette));

    // The live site is unchanged.
    expect(JSON.stringify((await ctx.kernel.themes.active()).globalStyles.config)).toBe(
      livePalette,
    );
  });

  it('refuses raw colours, CSS and missing permissions', async () => {
    const ctx = await site();
    for (const styles of [
      { color: { background: '#ff0000' } },
      { color: { text: 'rgb(0, 0, 0)' } },
      { css: 'body { color: red }' },
      { blocks: { 'core/group': { css: '& { color: red }' } } },
      { background: { backgroundImage: { url: 'url(https://example.com/x.png)' } } },
    ]) {
      const res = await run(ctx, 'core/update-global-styles', { styles });
      expect(res.status, JSON.stringify(styles)).toBe(400);
    }
    expect((await run(ctx, 'core/update-global-styles', {})).status).toBe(400);
    const badDesign = await run(ctx, 'core/update-global-styles', {
      design: { mood: 'warm', hue: 400 },
    });
    expect(badDesign.status).toBe(400);
    expect(await entries(ctx)).toEqual({});

    const editor = await ctx.loginAs('ed', 'editor');
    const denied = await run(editor, 'core/update-global-styles', {
      styles: { color: { background: 'var:preset|color|base' } },
    });
    expect(denied.status).toBe(403);
  });
});

describe('core/update-template-part', () => {
  it('fills a part’s slots, or rebuilds it from a pattern, in the changeset', async () => {
    const ctx = await site();
    const live = await run(ctx, 'core/get-page-structure', { template_part: 'footer' });
    expect(live.status).toBe(200);
    expect(live.body.sections[0].pattern).toBe('pressbase/footer');
    const textSlot = live.body.sections[0].slots.find(
      (s: { kind: string }) => s.kind === 'text' || s.kind === 'heading',
    );
    expect(textSlot).toBeDefined();

    const res = await run(ctx, 'core/update-template-part', {
      slug: 'footer',
      slots: { [textSlot.id]: 'Corner Bakery, Leeds' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      slug: 'footer',
      area: 'footer',
      entry: 'wp_template_part:footer',
    });
    const content = (await entries(ctx))['wp_template_part:footer']?.value.content as string;
    expect(content).toContain('Corner Bakery, Leeds');

    const after = await run(ctx, 'core/get-page-structure', { template_part: 'footer' });
    expect(after.body.from_changeset).toBe(true);

    const rebuilt = await run(ctx, 'core/update-template-part', {
      slug: 'footer',
      pattern: 'pressbase/footer-minimal',
    });
    expect(rebuilt.status).toBe(200);
    expect((await entries(ctx))['wp_template_part:footer']?.value.content).toContain(
      '"patternName":"pressbase/footer-minimal"',
    );

    // The live part is the theme's file still.
    const stored = await ctx.request('GET', '/wp/v2/template-parts/pressbase//footer');
    expect(stored.body.source).toBe('theme');
  });

  it('checks the part, the input and edit_theme_options', async () => {
    const ctx = await site();
    expect(
      (await run(ctx, 'core/update-template-part', { slug: 'nope', pattern: HERO })).status,
    ).toBe(404);
    expect((await run(ctx, 'core/update-template-part', { slug: 'footer' })).status).toBe(400);
    expect(
      (await run(ctx, 'core/update-template-part', { slug: 'footer', slots: { nope: 'x' } }))
        .status,
    ).toBe(400);
    const editor = await ctx.loginAs('ed', 'editor');
    const denied = await run(editor, 'core/update-template-part', {
      slug: 'footer',
      pattern: HERO,
    });
    expect(denied.status).toBe(403);
    expect((await run(editor, 'core/get-page-structure', { template_part: 'footer' })).status).toBe(
      403,
    );
  });
});

describe('changesets', () => {
  it('writes into a named changeset and refuses one the user can’t manage', async () => {
    const ctx = await site();
    const created = await ctx.request('POST', '/pressbase/v1/changesets', { title: 'Redesign' });
    const uuid = created.body.uuid as string;
    const res = await run(ctx, 'core/create-page', { title: 'Menu', changeset_uuid: uuid });
    expect(res.body.changeset_uuid).toBe(uuid);

    const editor = await ctx.loginAs('ed', 'editor');
    const denied = await run(editor, 'core/create-page', { title: 'Menu', changeset_uuid: uuid });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('rest_cannot_edit');
    const unknown = await run(ctx, 'core/create-page', {
      title: 'Menu',
      changeset_uuid: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.status).toBe(404);
  });
});
