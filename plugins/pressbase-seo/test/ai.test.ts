import { describe, expect, it } from 'vitest';
import { cleanOptions } from '../src/ai';
import { publish, site } from './helpers';

/**
 * The AI abilities, against a mocked provider: the real API is never called.
 */

type Ctx = Awaited<ReturnType<typeof site>>;

function mockProvider(reply: (prompt: string) => string) {
  const prompts: string[] = [];
  return {
    prompts,
    provider: {
      id: 'mock',
      name: 'Mock',
      envVar: 'PRESSBASE_MOCK_API_KEY',
      defaultModel: 'mock-large',
      models: [{ id: 'mock-large', name: 'Mock Large' }],
      async generateText(request: {
        model: string;
        messages: { parts: { type: string; text?: string }[] }[];
      }) {
        const prompt = request.messages.flatMap((m) => m.parts.map((p) => p.text ?? '')).join('\n');
        prompts.push(prompt);
        return {
          id: `msg_${prompts.length}`,
          message: { role: 'model', parts: [{ type: 'text', text: reply(prompt) }] },
          finishReason: 'stop',
          tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          providerId: 'mock',
          model: request.model,
        };
      },
    },
  };
}

async function enableAi(ctx: Ctx, reply: (prompt: string) => string) {
  const mock = mockProvider(reply);
  ctx.kernel.ai.registerProvider(mock.provider as never);
  await ctx.kernel.ai.saveSettings({ enabled: true, provider: 'mock', dailyLimit: 100 });
  await ctx.kernel.ai.setApiKey('mock', 'mock-key-0123456789abcdef');
  return mock;
}

const run = (ctx: Ctx, name: string, input: unknown) =>
  name === 'audit-post'
    ? ctx.request(
        'GET',
        `/wp-abilities/v1/abilities/pressbase-seo/${name}/run?input=${encodeURIComponent(JSON.stringify(input))}`,
      )
    : ctx.request('POST', `/wp-abilities/v1/abilities/pressbase-seo/${name}/run`, { input });

describe('AI suggestions', () => {
  it('says whether AI is available, and refuses while it is off', async () => {
    const ctx = await site();
    expect((await ctx.request('GET', '/pressbase-seo/v1/ai')).body).toEqual({ available: false });
    const post = await publish(ctx, { title: 'Tea' });
    const off = await run(ctx, 'suggest-meta', { field: 'title', postId: post.id });
    expect(off.status).toBe(503);
    await enableAi(ctx, () => '{"options":["A"]}');
    expect((await ctx.request('GET', '/pressbase-seo/v1/ai')).body).toEqual({ available: true });
  });

  it('suggests meta options from the title, excerpt and start of the content, cleaned', async () => {
    const ctx = await site();
    const mock = await enableAi(
      ctx,
      () =>
        '{"options":["\\"Brewing green tea at home\\"","<b>Green tea</b>, step by step","Brewing green tea at home"]}',
    );
    const post = await publish(ctx, {
      title: 'Green tea at home',
      excerpt: 'A short guide.',
      content: '<!-- wp:paragraph --><p>Heat the water to 80°C.</p><!-- /wp:paragraph -->',
    });
    const res = await run(ctx, 'suggest-meta', {
      field: 'title',
      postId: post.id,
      keyphrase: 'green tea',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      options: ['Brewing green tea at home', 'Green tea, step by step'],
      provider: 'mock',
      model: 'mock-large',
    });
    expect(mock.prompts[0]).toContain('Post title: Green tea at home');
    expect(mock.prompts[0]).toContain('Excerpt: A short guide.');
    expect(mock.prompts[0]).toContain('Heat the water to 80°C.');
    expect(mock.prompts[0]).toContain('Focus keyphrase (use it naturally): green tea');
  });

  it('never sends a protected post’s content, and checks permissions', async () => {
    const ctx = await site();
    const mock = await enableAi(ctx, () => '{"options":["One","Two"]}');
    const post = await publish(ctx, {
      title: 'Members only',
      password: 'secret',
      content: '<p>Private words.</p>',
    });
    const res = await run(ctx, 'suggest-meta', { field: 'description', postId: post.id });
    expect(res.status).toBe(200);
    expect(mock.prompts[0]).not.toContain('Private words');
    const anon = await ctx
      .client()
      .request('POST', '/wp-abilities/v1/abilities/pressbase-seo/suggest-meta/run', {
        input: { field: 'title', postId: post.id },
      });
    expect([401, 403]).toContain(anon.status);
  });

  it('suggests alt text and explains an audit', async () => {
    const ctx = await site();
    await enableAi(ctx, (prompt) =>
      prompt.includes('Suggestions from the checks')
        ? 'Add a meta description that says what the reader gets.'
        : '{"options":["A teapot on a wooden table","Green tea in a glass teapot"]}',
    );
    const alt = await run(ctx, 'suggest-alt-text', {
      filename: '2026/10/glass-teapot.jpg',
      postTitle: 'Green tea',
    });
    expect(alt.body.options).toHaveLength(2);
    const post = await publish(ctx, { title: 'Audit with AI' });
    const audit = await run(ctx, 'audit-post', { postId: post.id, explain: true });
    expect(audit.status).toBe(200);
    expect(audit.body.checks.length).toBeGreaterThan(5);
    expect(audit.body.advice).toBe('Add a meta description that says what the reader gets.');
    expect(audit.body.provider).toBe('mock');
    const plain = await run(ctx, 'audit-post', { postId: post.id });
    expect(plain.body.advice).toBeUndefined();
  });

  it('cleans options: plain text, unquoted, unique, at most three, length-checked', () => {
    expect(cleanOptions(['"One"', 'one', '<i>Two</i>', '', 3, 'Three', 'Four'], 70)).toEqual([
      'One',
      'Two',
      'Three',
    ]);
    expect(cleanOptions(['word '.repeat(40)], 30)[0]!.length).toBeLessThanOrEqual(31);
  });
});
