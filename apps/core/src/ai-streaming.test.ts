import type Anthropic from '@anthropic-ai/sdk';
import { schema } from '@pressbase/db';
import { describe, expect, it } from 'vitest';
import { type AnthropicClientLike, createAnthropicProvider } from './ai/providers/anthropic';
import { createHtmlStripper, stripHtml } from './ai/security';
import {
  AiError,
  type AiProvider,
  type AiProviderContext,
  type AiResult,
  type AiStreamEvent,
  type AiTextRequest,
} from './ai/types';
import { setup } from './test-utils';

/**
 * The AI client's additions for Studio (#53): streamText(), per-call
 * timeouts, the model for quick edits and image input. Providers are fakes;
 * nothing here reaches a real API. See docs/architecture/ai.md.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

const KEY = 'sk-ant-test-0123456789abcdefWXYZ';

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

const result = (model: string, text: string, extra: Partial<AiResult> = {}): AiResult => ({
  id: 'msg_1',
  message: { role: 'model', parts: [{ type: 'text', text }] },
  finishReason: 'stop',
  tokenUsage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
  providerId: 'fake',
  model,
  ...extra,
});

interface Recorded {
  request: AiTextRequest;
  context: AiProviderContext;
}

/**
 * A provider that streams `chunks` (or, without them, has no streamText) and
 * records each request and its context.
 */
function fakeProvider(
  script: {
    chunks?: (request: AiTextRequest, n: number) => AsyncIterable<AiStreamEvent>;
    answer?: (request: AiTextRequest, n: number) => Promise<AiResult> | AiResult;
  } = {},
) {
  const calls: Recorded[] = [];
  const provider: AiProvider = {
    id: 'fake',
    name: 'Fake',
    envVar: 'PRESSBASE_FAKE_API_KEY',
    defaultModel: 'fake-large',
    models: [
      { id: 'fake-large', name: 'Fake Large' },
      { id: 'fake-small', name: 'Fake Small' },
    ],
    async generateText(request, context) {
      calls.push({ request: structuredClone(request), context });
      return script.answer
        ? script.answer(request, calls.length)
        : result(request.model, 'Whole answer');
    },
    ...(script.chunks
      ? {
          streamText(request: AiTextRequest, context: AiProviderContext) {
            calls.push({ request: structuredClone(request), context });
            return script.chunks?.(request, calls.length) as AsyncIterable<AiStreamEvent>;
          },
        }
      : {}),
  };
  return { provider, calls };
}

async function* events(model: string, ...pieces: string[]): AsyncIterable<AiStreamEvent> {
  for (const text of pieces) yield { type: 'text', text };
  yield { type: 'done', result: result(model, pieces.join('')) };
}

async function enable(ctx: Ctx, provider: AiProvider, limit = 100) {
  ctx.kernel.ai.registerProvider(provider);
  await ctx.kernel.ai.saveSettings({ enabled: true, provider: provider.id, dailyLimit: limit });
  await ctx.kernel.ai.setApiKey(provider.id, KEY);
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const piece of stream) out.push(piece);
  return out;
}

const logRows = (ctx: Ctx) => ctx.kernel.db.select().from(schema.aiRequests);

describe('streamText()', () => {
  it('yields text as it arrives, with HTML stripped, and logs one attributed request', async () => {
    const ctx = await site();
    const fake = fakeProvider({
      chunks: (request) =>
        events(request.model, 'Fresh ', 'bread <str', 'ong>daily</strong> &am', 'p; more'),
    });
    await enable(ctx, fake.provider);
    const stream = ctx.kernel.ai
      .prompt('Describe the bakery')
      .forAbility('site-builder/brief')
      .streamText();
    const pieces = await collect(stream);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe('Fresh bread daily & more');
    const final = await stream.result;
    expect(final.tokenUsage).toEqual({ promptTokens: 20, completionTokens: 5, totalTokens: 25 });

    const rows = await logRows(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ability: 'site-builder/brief',
      provider: 'fake',
      model: 'fake-large',
      inputTokens: 20,
      outputTokens: 5,
      status: 'ok',
    });
    expect(JSON.stringify(rows)).not.toContain('bread');
  });

  it('answers in one piece when the provider cannot stream', async () => {
    const ctx = await site();
    const fake = fakeProvider();
    await enable(ctx, fake.provider);
    const stream = ctx.kernel.ai.prompt('Hi').streamText();
    expect(await collect(stream)).toEqual(['Whole answer']);
    expect((await stream.result).model).toBe('fake-large');
  });

  it('applies the daily cap and the prevent filter before sending', async () => {
    const ctx = await site();
    const fake = fakeProvider({ chunks: (r) => events(r.model, 'OK') });
    await enable(ctx, fake.provider, 1);
    await collect(ctx.kernel.ai.prompt('1').streamText());
    const capped = ctx.kernel.ai.prompt('2').streamText();
    await expect(collect(capped)).rejects.toMatchObject({ code: 'ai_daily_limit_reached' });
    await expect(capped.result).rejects.toMatchObject({ code: 'ai_daily_limit_reached' });
    expect(fake.calls).toHaveLength(1);

    ctx.kernel.hooks.addFilter('wp_ai_client_prevent_prompt', () => true);
    await expect(collect(ctx.kernel.ai.prompt('3').streamText())).rejects.toMatchObject({
      code: 'prompt_prevented',
    });
  });

  it('times out a reply that stalls, aborts the provider and logs it', async () => {
    const ctx = await site();
    const fake = fakeProvider({
      chunks: async function* () {
        yield { type: 'text', text: 'Start' };
        await new Promise(() => {});
      },
    });
    await enable(ctx, fake.provider);
    const seen: string[] = [];
    const stream = ctx.kernel.ai.prompt('Hi').usingTimeout(50).streamText();
    await expect(
      (async () => {
        for await (const piece of stream) seen.push(piece);
      })(),
    ).rejects.toMatchObject({ code: 'prompt_timeout', status: 504 });
    expect(seen).toEqual(['Start']);
    expect(fake.calls[0]?.context.timeoutMs).toBe(50);
    expect(fake.calls[0]?.context.signal.aborted).toBe(true);
    const [row] = await logRows(ctx);
    expect(row).toMatchObject({ status: 'error', errorCode: 'prompt_timeout' });
  });

  it('logs a reply the caller stopped reading as cancelled, and aborts it', async () => {
    const ctx = await site();
    const fake = fakeProvider({ chunks: (r) => events(r.model, 'One. ', 'Two. ', 'Three.') });
    await enable(ctx, fake.provider);
    const stream = ctx.kernel.ai.prompt('Count').streamText();
    for await (const piece of stream) {
      expect(piece).toBe('One. ');
      break;
    }
    await expect(stream.result).rejects.toMatchObject({ code: 'prompt_cancelled' });
    expect(fake.calls[0]?.context.signal.aborted).toBe(true);
    const [row] = await logRows(ctx);
    expect(row).toMatchObject({ status: 'error', errorCode: 'prompt_cancelled' });
  });

  it('redacts keys from errors thrown while streaming', async () => {
    const ctx = await site();
    const fake = fakeProvider({
      chunks: async function* () {
        yield { type: 'text', text: 'Partial' };
        throw new AiError('prompt_client_error', `Refused ${KEY}`, 401);
      },
    });
    await enable(ctx, fake.provider);
    const error = await collect(ctx.kernel.ai.prompt('Hi').streamText()).catch((e) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).message).toBe('Refused [redacted]');
    const [row] = await logRows(ctx);
    expect(row).toMatchObject({ status: 'error', errorCode: 'prompt_client_error' });
  });

  it('answers ability calls between streamed rounds', async () => {
    const ctx = await site();
    const fake = fakeProvider({
      chunks: (request, n) =>
        n === 1
          ? (async function* (): AsyncIterable<AiStreamEvent> {
              yield { type: 'text', text: 'Checking. ' };
              yield {
                type: 'done',
                result: result(request.model, 'Checking. ', {
                  finishReason: 'tool_calls',
                  message: {
                    role: 'model',
                    parts: [
                      { type: 'text', text: 'Checking. ' },
                      {
                        type: 'function_call',
                        id: 'call_1',
                        name: 'wpab__core__get-site-info',
                        args: { fields: ['name'] },
                      },
                    ],
                  },
                }),
              };
            })()
          : events(request.model, 'It is called ', 'Test Site.'),
    });
    await enable(ctx, fake.provider);
    const { loadUser } = await import('./auth/users');
    const admin = await loadUser(ctx.kernel, 1);
    const stream = ctx.kernel.ai
      .prompt('What is the site called?')
      .usingAbilities('core/get-site-info')
      .forUser(admin)
      .streamText();
    expect((await collect(stream)).join('')).toBe('Checking. It is called Test Site.');
    expect(fake.calls[1]?.request.messages[2]?.parts[0]).toMatchObject({
      type: 'function_response',
      response: { name: 'Test Site' },
    });
    expect((await stream.result).tokenUsage.totalTokens).toBe(50);
    expect(await logRows(ctx)).toHaveLength(2);
  });
});

describe('createHtmlStripper()', () => {
  it('matches stripHtml() of the whole text however it is split', () => {
    const texts = [
      'Plain text only',
      '<p>Para</p> and <em>emphasis</em> &amp; &lt;3 &#39;quoted&#39;',
      'a < b and c > d',
      '<script>alert(1)</script>Safe <img src=x onerror=alert(1)> end',
    ];
    for (const whole of texts) {
      for (let size = 1; size <= 6; size++) {
        const stripper = createHtmlStripper();
        let out = '';
        for (let i = 0; i < whole.length; i += size) out += stripper.push(whole.slice(i, i + size));
        out += stripper.end();
        expect(out, `${whole} in pieces of ${size}`).toBe(stripHtml(whole));
      }
    }
  });
});

describe('usingTimeout()', () => {
  it('sets the timeout per call in milliseconds; the default stays 30 s', async () => {
    const ctx = await site();
    const fake = fakeProvider();
    await enable(ctx, fake.provider);
    await ctx.kernel.ai.prompt('Default').generateText();
    await ctx.kernel.ai.prompt('Page').usingTimeout(120_000).generateText();
    await ctx.kernel.ai.prompt('Seconds').usingRequestTimeout(60).generateText();
    expect(fake.calls.map((c) => c.context.timeoutMs)).toEqual([30_000, 120_000, 60_000]);

    expect(() => ctx.kernel.ai.prompt('x').usingTimeout(0)).toThrow(AiError);
    expect(() => ctx.kernel.ai.prompt('x').usingTimeout(Number.POSITIVE_INFINITY)).toThrow(AiError);
  });

  it('fails a slow call with prompt_timeout', async () => {
    const ctx = await site();
    const fake = fakeProvider({ answer: () => new Promise<AiResult>(() => {}) });
    await enable(ctx, fake.provider);
    await expect(ctx.kernel.ai.prompt('Hi').usingTimeout(30).generateText()).rejects.toMatchObject({
      code: 'prompt_timeout',
    });
  });
});

describe('usingModelTier()', () => {
  it('uses the model for quick edits for the fast tier, or the main model without one', async () => {
    const ctx = await site();
    const fake = fakeProvider();
    await enable(ctx, fake.provider);

    await ctx.kernel.ai.prompt('a').usingModelTier('fast').generateText();
    await ctx.kernel.ai.saveSettings({ model: 'fake-large', fastModel: 'fake-small' });
    await ctx.kernel.ai.prompt('b').usingModelTier('fast').generateText();
    await ctx.kernel.ai.prompt('c').generateText();
    await collect(ctx.kernel.ai.prompt('d').usingModelTier('fast').streamText());
    expect(fake.calls.map((c) => c.request.model)).toEqual([
      'fake-large',
      'fake-small',
      'fake-large',
      'fake-small',
    ]);
    expect(ctx.kernel.ai.prompt('e').usingModelTier('fast').describe().tier).toBe('fast');
    expect(() => ctx.kernel.ai.prompt('x').usingModelTier('huge' as 'fast')).toThrow(AiError);

    const rows = await logRows(ctx);
    expect(rows.map((r) => r.model)).toEqual([
      'fake-large',
      'fake-small',
      'fake-large',
      'fake-small',
    ]);
  });

  it('saves the model for quick edits over REST', async () => {
    const ctx = await site();
    const saved = await ctx.request('POST', '/pressbase/v1/ai/settings', {
      fast_model: 'claude-haiku-5-5',
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ fast_model: 'claude-haiku-5-5', model: '' });
    expect(await ctx.kernel.options.get('pressbase_ai_fast_model')).toBe('claude-haiku-5-5');
    const bad = await ctx.request('POST', '/pressbase/v1/ai/settings', { fast_model: 'no spaces' });
    expect(bad.status).toBe(400);
    const cleared = await ctx.request('POST', '/pressbase/v1/ai/settings', { fast_model: '' });
    expect(cleared.body.fast_model).toBe('');
  });
});

describe('withImage()', () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('adds an image part to the user message, and never logs it', async () => {
    const ctx = await site();
    const fake = fakeProvider();
    await enable(ctx, fake.provider);
    await ctx.kernel.ai.prompt('Rebuild this section').withImage(PNG, 'image/png').generateText();
    expect(fake.calls[0]?.request.messages).toEqual([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'Rebuild this section' },
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        ],
      },
    ]);
    expect(JSON.stringify(await logRows(ctx))).not.toContain('iVBORw0KGgo');
  });

  it('refuses other types, bad base64 and images over 5 MB', async () => {
    const { kernel } = await site();
    expect(() => kernel.ai.prompt('x').withImage(PNG, 'image/svg+xml' as 'image/png')).toThrow(
      'Images must be JPEG, PNG, GIF or WebP.',
    );
    expect(() => kernel.ai.prompt('x').withImage('not base64!', 'image/png')).toThrow(
      'The image is not valid base64.',
    );
    expect(() =>
      kernel.ai.prompt('x').withImage(new Uint8Array(5 * 1024 * 1024 + 3), 'image/jpeg'),
    ).toThrow('Images can be up to 5 MB.');
    // A data URL's prefix is dropped.
    expect(() =>
      kernel.ai.prompt('x').withImage('data:image/png;base64,iVBORw0KGgo=', 'image/png'),
    ).not.toThrow();
  });
});

describe('the Anthropic provider, streaming and images', () => {
  const context = { apiKey: KEY, signal: new AbortController().signal, timeoutMs: 90_000 };

  function message(params: { model: string }): Anthropic.Beta.BetaMessage {
    return {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: params.model,
      content: [{ type: 'text', text: 'Hello there', citations: null }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 4 },
    } as Anthropic.Beta.BetaMessage;
  }

  it('streams text deltas through messages.stream() and ends with the final message', async () => {
    const calls: { params: unknown; timeout?: number }[] = [];
    const client: AnthropicClientLike = {
      beta: {
        messages: {
          async create() {
            throw new Error('create() should not be called');
          },
          stream(params, options) {
            calls.push({ params: structuredClone(params), timeout: options?.timeout });
            const deltas = ['Hello', ' there'];
            return {
              async *[Symbol.asyncIterator]() {
                for (const text of deltas) {
                  yield {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text },
                  } as Anthropic.Beta.BetaRawMessageStreamEvent;
                }
              },
              finalMessage: async () => message(params),
            };
          },
        },
      },
    };
    const provider = createAnthropicProvider(() => client);
    const seen: AiStreamEvent[] = [];
    for await (const event of provider.streamText?.(
      {
        model: 'claude-sonnet-5-5',
        maxTokens: 100,
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'Hi' },
              { type: 'image', mimeType: 'image/webp', data: 'AAAA' },
            ],
          },
        ],
      },
      context,
    ) ?? []) {
      seen.push(event);
    }
    expect(seen.slice(0, 2)).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' there' },
    ]);
    expect(seen[2]).toMatchObject({
      type: 'done',
      result: { tokenUsage: { totalTokens: 14 }, model: 'claude-sonnet-5-5' },
    });
    expect(calls[0]?.timeout).toBe(90_000);
    expect((calls[0]?.params as { messages: unknown[] } | undefined)?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hi' },
          { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'AAAA' } },
        ],
      },
    ]);
  });

  it('falls back to create() when the client has no stream()', async () => {
    const client: AnthropicClientLike = {
      beta: { messages: { create: async (params) => message(params) } },
    };
    const provider = createAnthropicProvider(() => client);
    const seen: AiStreamEvent[] = [];
    for await (const event of provider.streamText?.(
      { model: 'claude-opus-5-5', maxTokens: 100, messages: [] },
      context,
    ) ?? []) {
      seen.push(event);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'done', result: { providerId: 'anthropic' } });
  });
});
