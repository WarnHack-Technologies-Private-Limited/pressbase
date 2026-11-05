import { schema } from '@pressbase/db';
import { describe, expect, it } from 'vitest';
import { createRecordedProvider, RECORDED_PROVIDER_ID } from './ai/providers/recorded';
import type { AiProvider, AiTextRequest } from './ai/types';
import { namedCategory, rewriteSchema, rewriteTask } from './site-building/quick-edits';
import { setup } from './test-utils';

/**
 * Studio's Ask AI (#63) and the "Before you publish" checklist (#61):
 * `/pressbase/v1/studio/ai/{rewrite,section,page}` with the recorded
 * provider (or a fake that answers as told), and
 * `/pressbase/v1/studio/checklist`. No test reaches a real provider.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;
type Json = Record<string, unknown>;
const KEY = 'recorded-key-for-tests-0123';

/** The recorded provider, wrapped to keep each request. */
function recorded() {
  const inner = createRecordedProvider();
  const requests: AiTextRequest[] = [];
  const provider: AiProvider = {
    ...inner,
    async generateText(request, context) {
      requests.push(structuredClone(request));
      return inner.generateText(request, context);
    },
  };
  return { provider, requests };
}

/** A provider that answers every request with `answer` (JSON). */
function answering(answer: unknown): AiProvider {
  return {
    ...createRecordedProvider(),
    async generateText(request) {
      return {
        id: 'fake',
        message: { role: 'model', parts: [{ type: 'text', text: JSON.stringify(answer) }] },
        finishReason: 'stop',
        tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        providerId: RECORDED_PROVIDER_ID,
        model: request.model,
      };
    },
  };
}

async function site(provider?: AiProvider, fastModel = ''): Promise<Ctx> {
  const ctx = await setup();
  await ctx.install();
  await ctx.kernel.themes.activate('pressbase');
  if (provider) {
    ctx.kernel.ai.registerProvider(provider);
    await ctx.kernel.ai.saveSettings({
      enabled: true,
      provider: provider.id,
      dailyLimit: 50,
      ...(fastModel ? { fastModel } : {}),
    });
    await ctx.kernel.ai.setApiKey(provider.id, KEY);
  }
  return ctx;
}

async function page(ctx: Ctx, title: string, content: string) {
  const res = await ctx.request('POST', '/wp/v2/pages', { title, content, status: 'publish' });
  expect(res.status).toBe(201);
  return res.body as { id: number; slug: string };
}

const paragraph = (text: string) => `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;

/* ------------------------------------------------------------------ rewrite */

describe('POST /pressbase/v1/studio/ai/rewrite', () => {
  it('rewrites texts with the quick-edits model, each action as asked', async () => {
    const { provider, requests } = recorded();
    const ctx = await site(provider, 'recorded-fast');
    const rewrite = (body: Json) => ctx.request('POST', '/pressbase/v1/studio/ai/rewrite', body);

    const short = await rewrite({
      action: 'shorten',
      texts: [{ id: 'body', text: 'Bread baked fresh every morning. Come in and say hello.' }],
    });
    expect(short.status).toBe(200);
    expect(short.body).toEqual({
      texts: [{ id: 'body', text: 'Bread baked fresh every morning.' }],
      kept: [],
    });
    // The quick-edits model, attributed to Ask AI.
    expect(requests[0]?.model).toBe('recorded-fast');
    expect(requests[0]?.messages[0]?.parts[0]).toMatchObject({
      text: expect.stringMatching(/^Make each text shorter/),
    });

    const french = await rewrite({
      action: 'translate',
      language: 'French',
      texts: [{ id: 'title', text: 'Bread baked fresh every morning' }],
    });
    expect(french.body.texts).toEqual([{ id: 'title', text: 'Du pain frais, cuit chaque matin' }]);

    const spelled = await rewrite({
      action: 'fix_spelling',
      texts: [{ id: 'a', text: 'Fresh bread evry mornig' }],
    });
    expect(spelled.body.texts).toEqual([{ id: 'a', text: 'Fresh bread every morning' }]);

    const toned = await rewrite({
      action: 'tone',
      tone: 'friendly',
      texts: [{ id: 'a', text: 'Open daily' }],
    });
    expect(toned.body.texts[0].text).toBe('Open daily. We’d love to see you.');

    const rows = await ctx.kernel.db.select().from(schema.aiRequests);
    expect(rows.map((r) => r.ability)).toEqual(Array(4).fill('studio/quick-edit'));
  });

  it('keeps a text whose new version brings in facts nobody gave', async () => {
    const ctx = await site(answering({ rewritten: { t1: 'Over 1200 loaves sold daily.', t2: 'Warm bread.' } }));
    const res = await ctx.request('POST', '/pressbase/v1/studio/ai/rewrite', {
      action: 'expand',
      texts: [
        { id: 'one', text: 'Lots of loaves.' },
        { id: 'two', text: 'Bread.' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ texts: [{ id: 'two', text: 'Warm bread.' }], kept: ['one'] });
  });

  it('checks the request, and says when AI is off', async () => {
    const off = await site();
    const res = await off.request('POST', '/pressbase/v1/studio/ai/rewrite', {
      action: 'rewrite',
      texts: [{ id: 'a', text: 'Hello' }],
    });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('prompt_prevented');

    const ctx = await site(recorded().provider);
    const bad = await ctx.request('POST', '/pressbase/v1/studio/ai/rewrite', {
      action: 'translate',
      texts: [{ id: 'a', text: 'Hello' }],
    });
    expect(bad.status).toBe(400);
    const contributor = await ctx.loginAs('co', 'contributor');
    const refused = await contributor.request('POST', '/pressbase/v1/studio/ai/rewrite', {
      action: 'rewrite',
      texts: [{ id: 'a', text: 'Hello' }],
    });
    expect(refused.status).toBe(403);
  });

  it('asks for one string per text, shorter when shortening', () => {
    const schema = rewriteSchema({
      action: 'shorten',
      texts: [
        { id: 'a', text: 'Twelve chars' },
        { id: 'b', text: 'x' },
      ],
    }) as { properties: { rewritten: { properties: Record<string, { maxLength: number }> } } };
    expect(schema.properties.rewritten.properties).toEqual({
      t1: { type: 'string', minLength: 1, maxLength: 12 },
      t2: { type: 'string', minLength: 1, maxLength: 1 },
    });
    expect(rewriteTask('translate', { language: 'German' })).toMatch(/into German/);
  });
});

/* ---------------------------------------------------------------- sections */

describe('POST /pressbase/v1/studio/ai/section and /page', () => {
  it('turns a prompt into a section from the library, honest about prices', async () => {
    const { provider, requests } = recorded();
    const ctx = await site(provider);
    const home = await page(ctx, 'Home', paragraph('Welcome.'));
    const res = await ctx.request('POST', '/pressbase/v1/studio/ai/section', {
      prompt: 'Pricing with three tiers',
      page: { id: home.id },
      index: 1,
    });
    expect(res.status).toBe(200);
    // Found by the pattern's keywords ("pricing"): no call needed to choose it.
    expect(res.body.pattern).toEqual({ name: 'pressbase/pricing', title: 'Pricing, three tiers' });
    const [operation] = res.body.operations as Json[];
    expect(operation).toMatchObject({
      type: 'insertSection',
      page: home.id,
      index: 1,
      pattern: 'pressbase/pricing',
    });
    expect(requests).toHaveLength(1);
    // Prices are facts: nobody gave any, so they're placeholders.
    expect(JSON.stringify(operation?.slots)).toMatch(/\[Add/);
    expect(res.body.summary).toBe('Adds a section: Pricing, three tiers.');
    // Nothing was written.
    expect((await ctx.request('GET', '/pressbase/v1/changesets')).body).toEqual([]);
  });

  it('asks which kind of section when the words don’t say', async () => {
    const { provider, requests } = recorded();
    const ctx = await site(provider);
    const home = await page(ctx, 'Home', paragraph('Welcome.'));
    const res = await ctx.request('POST', '/pressbase/v1/studio/ai/section', {
      prompt: 'Something lovely',
      page: { id: home.id },
    });
    expect(res.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(res.body.operations[0]).toMatchObject({ type: 'insertSection', page: home.id });
    const missing = await ctx.request('POST', '/pressbase/v1/studio/ai/section', {
      prompt: 'Pricing',
      page: { id: 999 },
    });
    expect(missing.status).toBe(404);
  });

  it('turns a prompt into a new page made of sections', async () => {
    const ctx = await site(recorded().provider);
    const res = await ctx.request('POST', '/pressbase/v1/studio/ai/page', {
      prompt: 'Catering with services, pricing and a call to action',
    });
    expect(res.status).toBe(200);
    expect(res.body.page).toEqual({ title: 'Catering', slug: 'catering' });
    const [operation] = res.body.operations as {
      type: string;
      sections: { pattern: string }[];
    }[];
    expect(operation?.type).toBe('createPage');
    expect(operation?.sections.length).toBeGreaterThanOrEqual(2);
    expect(res.body.summary).toMatch(/^Adds a new page, “Catering”/);
    // Pages need publish_pages.
    const author = await ctx.loginAs('au', 'author');
    const refused = await author.request('POST', '/pressbase/v1/studio/ai/page', { prompt: 'Menu' });
    expect(refused.status).toBe(403);
  });

  it('finds the kind of section a person names', () => {
    const labels = new Map([
      ['pricing', 'Pricing'],
      ['call-to-action', 'Call to action'],
      ['testimonials', 'Testimonials'],
      ['opening-hours', 'Opening hours'],
    ]);
    expect(namedCategory('pricing with three tiers', labels)).toBe('pricing');
    expect(namedCategory('a testimonial from a customer', labels)).toBe('testimonials');
    expect(namedCategory('our opening hours', labels)).toBe('opening-hours');
    expect(namedCategory('pricing and opening hours', labels)).toBeNull();
    expect(namedCategory('something nice', labels)).toBeNull();
  });
});

/* ---------------------------------------------------------------- checklist */

describe('GET /pressbase/v1/studio/checklist', () => {
  it('lists placeholders, images to choose and failed checks across the draft', async () => {
    const ctx = await site();
    const home = await page(ctx, 'Home', paragraph('Welcome.'));
    const content = [
      paragraph('[Add a customer quote]'),
      '<!-- wp:image -->\n<figure class="wp-block-image"><img alt=""/></figure>\n<!-- /wp:image -->',
      '<!-- wp:image -->\n<figure class="wp-block-image"><img src="/a.jpg" alt=""/></figure>\n<!-- /wp:image -->',
    ].join('\n\n');
    const saved = await ctx.request('POST', '/pressbase/v1/changesets', {
      entries: {
        [`page:${home.id}`]: { content },
        'page:catering': { title: 'Catering', status: 'publish', content: paragraph('[Add your prices]') },
      },
    });
    expect(saved.status).toBe(201);
    const res = await ctx.request('GET', '/pressbase/v1/studio/checklist');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ placeholder: 2, image: 1, check: 1 });
    expect(res.body.items).toEqual([
      expect.objectContaining({
        key: `page:${home.id}`,
        kind: 'placeholder',
        page: home.id,
        title: 'Home',
        text: '[Add a customer quote]',
        block: { path: [0], name: 'core/paragraph' },
      }),
      expect.objectContaining({ kind: 'image', block: { path: [1], name: 'core/image' } }),
      expect.objectContaining({ kind: 'check', rule: 'image_alt', block: { path: [2], name: 'core/image' } }),
      expect.objectContaining({
        key: 'page:catering',
        kind: 'placeholder',
        page: 'catering',
        title: 'Catering',
        text: '[Add your prices]',
      }),
    ]);
    expect(res.body.checked.map((c: { key: string }) => c.key)).toEqual([
      `page:${home.id}`,
      'page:catering',
    ]);
  });

  it('checks the header and footer in the draft, and nothing without one', async () => {
    const ctx = await site();
    const empty = await ctx.request('GET', '/pressbase/v1/studio/checklist');
    expect(empty.body).toMatchObject({ changeset_uuid: null, items: [], checked: [] });
    await ctx.request('POST', '/pressbase/v1/changesets', {
      entries: {
        'wp_template_part:footer': {
          content: `<!-- wp:heading {"level":1} -->\n<h1 class="wp-block-heading">[Add your name]</h1>\n<!-- /wp:heading -->`,
        },
      },
    });
    const res = await ctx.request('GET', '/pressbase/v1/studio/checklist');
    // Heading checks are the page's business, not the footer's.
    expect(res.body.items).toEqual([
      expect.objectContaining({
        key: 'wp_template_part:footer',
        part: 'footer',
        page: null,
        kind: 'placeholder',
        text: '[Add your name]',
      }),
    ]);
    const contributor = await ctx.loginAs('co', 'contributor');
    expect((await contributor.request('GET', '/pressbase/v1/studio/checklist')).status).toBe(403);
  });
});
