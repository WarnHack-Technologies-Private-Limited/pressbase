import { createDesign, toGlobalStyles } from '@pressbase/design';
import { describe, expect, it } from 'vitest';
import { checkPage, pageStylesFromThemeJson } from './quality/check-page';
import { setup } from './test-utils';

/**
 * The quality checks over the API (#55): the `core/check-page` ability and
 * `POST /pressbase/v1/check-page`. Each rule's unit tests are in
 * quality/check-page.test.ts. See docs/architecture/quality-checks.md.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site(): Promise<Ctx> {
  const ctx = await setup();
  await ctx.install();
  await ctx.kernel.themes.activate('pressbase');
  return ctx;
}

const GOOD = `<!-- wp:heading {"level":1} --><h1 class="wp-block-heading">Fresh bread daily</h1><!-- /wp:heading --><!-- wp:paragraph --><p>Baked every morning in Leeds. <a href="/menu">See the menu</a>.</p><!-- /wp:paragraph -->`;

const BAD = `<!-- wp:heading {"level":1} --><h1 class="wp-block-heading">One</h1><!-- /wp:heading --><!-- wp:heading {"level":3} --><h3 class="wp-block-heading">Three</h3><!-- /wp:heading --><!-- wp:paragraph --><p>[Add your opening hours]</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>Our <a href="/x">click here</a></p><!-- /wp:paragraph --><!-- wp:acme/carousel /-->`;

describe('core/check-page', () => {
  it('is registered as a read-only ability in REST', async () => {
    const ctx = await site();
    const res = await ctx.request('GET', '/wp-abilities/v1/abilities/core/check-page');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'core/check-page',
      category: 'site',
      meta: { annotations: { readonly: true }, show_in_rest: true },
    });
    const run = await ctx.request(
      'GET',
      `/wp-abilities/v1/abilities/core/check-page/run?input=${encodeURIComponent(JSON.stringify({ content: GOOD }))}`,
    );
    expect(run.status).toBe(200);
    expect(run.body).toEqual({ findings: [], errors: 0, warnings: 0, passed: true });
  });

  it('checks markup over POST /pressbase/v1/check-page with block references', async () => {
    const ctx = await site();
    const res = await ctx.request('POST', '/pressbase/v1/check-page', { content: BAD });
    expect(res.status).toBe(200);
    const rules = (res.body.findings as { rule: string; block: unknown }[]).map((f) => [
      f.rule,
      f.block,
    ]);
    expect(rules).toEqual([
      ['block_unknown', { path: [4], name: 'acme/carousel' }],
      ['heading_skipped', { path: [1], name: 'core/heading' }],
      ['placeholder', { path: [2], name: 'core/paragraph' }],
      ['link_text', { path: [3], name: 'core/paragraph' }],
    ]);
    expect(res.body).toMatchObject({ errors: 2, warnings: 2, passed: false });

    const some = await ctx.request('POST', '/pressbase/v1/check-page', {
      content: BAD,
      rules: ['placeholder'],
    });
    expect(some.body.findings).toHaveLength(1);
  });

  it('checks a saved page by ID, for people who may edit it', async () => {
    const ctx = await site();
    const page = await ctx.request('POST', '/wp/v2/pages', {
      title: 'Home',
      content: BAD,
      status: 'draft',
    });
    expect(page.status).toBe(201);
    const res = await ctx.request('POST', '/pressbase/v1/check-page', {
      id: page.body.id,
      title_is_h1: true,
    });
    expect(res.status).toBe(200);
    expect((res.body.findings as { rule: string }[]).map((f) => f.rule)).toContain(
      'heading_multiple_h1',
    );

    const author = await ctx.loginAs('writer', 'author');
    const denied = await author.request('POST', '/pressbase/v1/check-page', { id: page.body.id });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ability_invalid_permissions');
    const own = await author.request('POST', '/pressbase/v1/check-page', { content: GOOD });
    expect(own.status).toBe(200);

    const missing = await ctx.request('POST', '/pressbase/v1/check-page', { id: 99999 });
    expect(missing.status).toBe(404);
  });

  it('validates the body and needs a logged-in writer', async () => {
    const ctx = await site();
    expect((await ctx.request('POST', '/pressbase/v1/check-page', {})).status).toBe(400);
    expect(
      (await ctx.request('POST', '/pressbase/v1/check-page', { content: GOOD, extra: 1 })).status,
    ).toBe(400);
    expect(
      (await ctx.request('POST', '/pressbase/v1/check-page', { content: GOOD, rules: ['nope'] }))
        .status,
    ).toBe(400);
    const subscriber = await ctx.loginAs('reader', 'subscriber');
    expect(
      (await subscriber.request('POST', '/pressbase/v1/check-page', { content: GOOD })).status,
    ).toBe(403);
    ctx.clearCookie();
    expect((await ctx.request('POST', '/pressbase/v1/check-page', { content: GOOD })).status).toBe(
      401,
    );
  });

  it('checks contrast against unsaved global styles', async () => {
    const ctx = await site();
    const ink = `<!-- wp:group {"className":"is-style-section-ink"} --><div class="wp-block-group is-style-section-ink"><!-- wp:paragraph --><p>On ink</p><!-- /wp:paragraph --></div><!-- /wp:group --><!-- wp:paragraph {"textColor":"muted"} --><p class="has-muted-color has-text-color">Muted</p><!-- /wp:paragraph -->`;
    const saved = await ctx.request('POST', '/pressbase/v1/check-page', { content: ink });
    expect(saved.body.findings).toEqual([]);

    // A generated design passes too…
    const design = toGlobalStyles(
      createDesign({
        mood: 'vibrant',
        hue: 90,
        contrast: 'standard',
        scheme: 'dark',
        fontPair: 'rounded',
        radius: 'soft',
        density: 'spacious',
      }),
    );
    const generated = await ctx.request('POST', '/pressbase/v1/check-page', {
      content: ink,
      global_styles: design,
    });
    expect(generated.body.findings).toEqual([]);

    // …and a hand-made muted colour that's too pale doesn't.
    const palette = (
      design.settings.color as { palette: { theme: { slug: string; color: string }[] } }
    ).palette.theme;
    const pale = palette.map((c) => (c.slug === 'muted' ? { ...c, color: '#3a3a3a' } : c));
    const edited = await ctx.request('POST', '/pressbase/v1/check-page', {
      content: ink,
      global_styles: {
        ...design,
        settings: { ...design.settings, color: { palette: { theme: pale } } },
      },
      rules: ['contrast'],
    });
    expect(edited.body.findings).toEqual([
      expect.objectContaining({
        rule: 'contrast',
        block: { path: [1], name: 'core/paragraph' },
        data: expect.objectContaining({ text: '#3a3a3a' }),
      }),
    ]);
  });

  // Image alt text and vague links are left out: the theme's illustrations
  // have empty alt text without being marked decorative, and its hero says
  // "Learn more". Both are content a person fills in.
  it('finds no block, contrast or colour problems in the Pressbase theme’s patterns', async () => {
    const ctx = await site();
    const active = await ctx.kernel.themes.active();
    const styles = pageStylesFromThemeJson(active.themeJson.tree.getRawData());
    expect(styles.variations).toHaveProperty('section-ink');
    const problems: string[] = [];
    for (const pattern of ctx.kernel.blocks.patterns()) {
      if (!pattern.name.startsWith('pressbase/')) continue;
      const findings = checkPage(pattern.content, styles, {
        blockTypes: ctx.kernel.blocks.registry,
        rules: ['block_unknown', 'block_invalid', 'contrast', 'color_raw'],
      });
      for (const f of findings)
        problems.push(`${pattern.name}: ${f.rule} ${f.message} ${JSON.stringify(f.block)}`);
    }
    expect(problems).toEqual([]);
  });
});
