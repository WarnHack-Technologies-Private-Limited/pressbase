import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { schema } from '@pressbase/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateJsonSchema } from './abilities/json-schema';
import { AbilityError } from './abilities/registry';
import { apiKeyOption } from './ai/client';
import { abilityNameToFunctionName, functionNameToAbilityName } from './ai/function-resolver';
import { type AnthropicClientLike, createAnthropicProvider } from './ai/providers/anthropic';
import { redactSecrets, stripHtml } from './ai/security';
import { AiError, type AiProvider, type AiResult, type AiTextRequest } from './ai/types';
import { setup } from './test-utils';

/**
 * The AI client and the Abilities API (v0.7, gap 10): ports of WordPress 7's
 * wp_ai_client_prompt() and wp_register_ability(). The provider is always a
 * mock: these tests never reach a real API. See docs/architecture/ai.md.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

const KEY = 'sk-ant-test-0123456789abcdefWXYZ';

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

/** A provider that answers from a script and records each request. */
function mockProvider(
  answer: (request: AiTextRequest, n: number) => Partial<AiResult> | Promise<Partial<AiResult>>,
  id = 'mock',
) {
  const requests: AiTextRequest[] = [];
  const keys: string[] = [];
  const provider: AiProvider = {
    id,
    name: 'Mock',
    envVar: 'PRESSBASE_MOCK_API_KEY',
    defaultModel: 'mock-large',
    models: [{ id: 'mock-large', name: 'Mock Large' }],
    async generateText(request, context) {
      requests.push(structuredClone(request));
      keys.push(context.apiKey);
      const partial = await answer(request, requests.length);
      return {
        id: `msg_${requests.length}`,
        message: { role: 'model', parts: [{ type: 'text', text: 'OK' }] },
        finishReason: 'stop',
        tokenUsage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
        providerId: id,
        model: request.model,
        ...partial,
      };
    },
  };
  return { provider, requests, keys };
}

const text = (t: string): Partial<AiResult> => ({
  message: { role: 'model', parts: [{ type: 'text', text: t }] },
});

/** Turns AI on with the mock provider and a saved key. */
async function enableAi(ctx: Ctx, mock: ReturnType<typeof mockProvider>, limit = 100) {
  ctx.kernel.ai.registerProvider(mock.provider);
  await ctx.kernel.ai.saveSettings({
    enabled: true,
    provider: mock.provider.id,
    dailyLimit: limit,
  });
  await ctx.kernel.ai.setApiKey(mock.provider.id, KEY);
}

const adminUser = async (ctx: Ctx) => {
  const { loadUser } = await import('./auth/users');
  return loadUser(ctx.kernel, 1);
};

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------ JSON Schema */

describe('validateJsonSchema (rest_validate_value_from_schema)', () => {
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 2, maxLength: 5 },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 2, uniqueItems: true },
      count: { type: 'integer', minimum: 1 },
    },
    required: ['title'],
    additionalProperties: false,
  };

  it('accepts valid values and names the first problem with WordPress messages', () => {
    expect(validateJsonSchema({ title: 'Hi' }, schema, 'input')).toBeNull();
    expect(validateJsonSchema({}, schema, 'input')).toBe('title is a required property of input.');
    expect(validateJsonSchema({ title: 'H' }, schema, 'input')).toBe(
      'input[title] must be at least 2 characters long.',
    );
    expect(validateJsonSchema({ title: 'Hi', tags: ['a', 'a'] }, schema, 'input')).toBe(
      'input[tags] has duplicate items.',
    );
    expect(validateJsonSchema({ title: 'Hi', count: 0 }, schema, 'input')).toBe(
      'input[count] must be greater than or equal to 1',
    );
    expect(validateJsonSchema({ title: 'Hi', extra: 1 }, schema, 'input')).toBe(
      'extra is not a valid property of Object.',
    );
    expect(validateJsonSchema('x', schema, 'input')).toBe('input is not of type object.');
  });

  it('reads `required: true` on properties, as WordPress does', () => {
    const v3 = { type: 'object', properties: { a: { type: 'string', required: true } } };
    expect(validateJsonSchema({}, v3, 'input')).toBe('a is a required property of input.');
  });
});

/* ------------------------------------------------------------- Abilities */

describe('kernel.abilities', () => {
  it('registers core/get-site-info in the site category, as WordPress does', async () => {
    const ctx = await site();
    const ability = ctx.kernel.abilities.get('core/get-site-info');
    expect(ability?.category).toBe('site');
    expect(ability?.meta.showInRest).toBe(true);
    expect(ctx.kernel.abilities.categories().map((c) => c.slug)).toEqual(['site', 'user']);

    const admin = await adminUser(ctx);
    const result = await ability?.execute(
      { fields: ['name', 'charset'] },
      ctx.kernel.abilities.context(admin, 'server'),
    );
    expect(result).toEqual({ name: 'Test Site', charset: 'UTF-8' });
  });

  it('requires a permission callback, a valid name and a registered category', async () => {
    const ctx = await site();
    const { abilities } = ctx.kernel;
    const base = {
      label: 'Echo',
      description: 'Echoes.',
      category: 'site',
      executeCallback: () => 'x',
      permissionCallback: () => true,
    };
    const { permissionCallback: _, ...noPermission } = base;
    expect(() => abilities.register('test/echo', noPermission as never)).toThrow(
      /permissionCallback/,
    );
    expect(() => abilities.register('Echo', base)).toThrow(/namespace prefix/);
    expect(() => abilities.register('test/echo', { ...base, category: 'nope' })).toThrow(
      /category "nope" is not registered/,
    );
    const off = abilities.register('test/echo', base);
    expect(() => abilities.register('test/echo', base)).toThrow(/already registered/);
    off();
    expect(abilities.has('test/echo')).toBe(false);
  });

  it('validates input and output, checks permissions and runs the hooks', async () => {
    const ctx = await site();
    const { abilities, hooks } = ctx.kernel;
    let output: unknown = { greeting: 'Hello, Ada' };
    abilities.register('test/greet', {
      label: 'Greet',
      description: 'Greets someone.',
      category: 'user',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1 } },
        required: ['name'],
        default: { name: 'Ada' },
      },
      outputSchema: {
        type: 'object',
        properties: { greeting: { type: 'string' } },
        required: ['greeting'],
      },
      permissionCallback: (_input, context) => context.can('edit_posts'),
      executeCallback: () => output,
    });
    const ability = abilities.get('test/greet');
    if (!ability) throw new Error('not registered');
    const admin = await adminUser(ctx);
    const asAdmin = abilities.context(admin, 'server');

    // The schema's default fills a missing input (normalize_input()).
    expect(await ability.execute(null, asAdmin)).toEqual({ greeting: 'Hello, Ada' });
    await expect(ability.execute({ name: '' }, asAdmin)).rejects.toMatchObject({
      code: 'ability_invalid_input',
    });
    await expect(
      ability.execute({ name: 'Ada' }, abilities.context(null, 'rest')),
    ).rejects.toMatchObject({ code: 'ability_invalid_permissions', status: 401 });
    // The CLI without --user is trusted.
    expect(
      await ability.execute({ name: 'Ada' }, abilities.context(null, 'cli', { trusted: true })),
    ).toEqual({ greeting: 'Hello, Ada' });

    output = { nope: true };
    await expect(ability.execute({ name: 'Ada' }, asAdmin)).rejects.toMatchObject({
      code: 'ability_invalid_output',
    });

    const seen: string[] = [];
    hooks.addAction('wp_before_execute_ability', (name) => {
      seen.push(`before ${name}`);
    });
    hooks.addFilter('wp_pre_execute_ability', (pre, name) =>
      name === 'test/greet' ? { cached: true } : pre,
    );
    expect(await ability.execute({ name: 'Ada' }, asAdmin)).toEqual({ cached: true });
    expect(seen).toEqual([]);
  });

  it('turns exceptions into ability_callback_exception and keeps AbilityErrors', async () => {
    const ctx = await site();
    const { abilities } = ctx.kernel;
    abilities.register('test/fail', {
      label: 'Fail',
      description: 'Fails.',
      category: 'site',
      permissionCallback: () => true,
      executeCallback: () => {
        throw new Error('boom');
      },
    });
    abilities.register('test/coded', {
      label: 'Coded',
      description: 'Fails with a code.',
      category: 'site',
      permissionCallback: () => true,
      executeCallback: () => {
        throw new AbilityError('test_nope', 'Nope.', 409);
      },
    });
    const context = abilities.context(null, 'server');
    await expect(abilities.get('test/fail')?.execute(null, context)).rejects.toMatchObject({
      code: 'ability_callback_exception',
    });
    await expect(abilities.get('test/coded')?.execute(null, context)).rejects.toMatchObject({
      code: 'test_nope',
      status: 409,
    });
  });
});

/* ------------------------------------------------------- /wp-abilities/v1 */

describe('/wp-abilities/v1', () => {
  async function withAbilities() {
    const ctx = await site();
    const { abilities } = ctx.kernel;
    abilities.register('test/hidden', {
      label: 'Hidden',
      description: 'Not in REST.',
      category: 'site',
      permissionCallback: () => true,
      executeCallback: () => 'secret',
    });
    abilities.register('test/rename', {
      label: 'Rename',
      description: 'Renames the site.',
      category: 'site',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1 } },
        required: ['title'],
      },
      permissionCallback: (_input, context) => context.can('manage_options'),
      executeCallback: async ({ title }: { title: string }) => {
        await ctx.kernel.options.set('blogname', title);
        return { title };
      },
      meta: { showInRest: true },
    });
    return ctx;
  }

  it('lists REST-visible abilities to logged-in users, with WordPress shapes', async () => {
    const ctx = await withAbilities();
    const res = await ctx.request('GET', '/wp-abilities/v1/abilities');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-wp-total')).toBe('2');
    const names = res.body.map((a: { name: string }) => a.name);
    expect(names).toEqual(['core/get-site-info', 'test/rename']);
    const info = res.body[0];
    expect(Object.keys(info)).toEqual([
      'name',
      'label',
      'description',
      'category',
      'input_schema',
      'output_schema',
      'meta',
      '_links',
    ]);
    expect(info.meta).toMatchObject({
      annotations: { readonly: true, destructive: false, idempotent: true },
      show_in_rest: true,
    });
    expect(info._links['wp:action-run'][0].href).toBe(
      '/wp-json/wp-abilities/v1/abilities/core/get-site-info/run',
    );

    expect((await ctx.request('GET', '/wp-abilities/v1/abilities/test/hidden')).status).toBe(404);
    const one = await ctx.request('GET', '/wp-abilities/v1/abilities/test/rename');
    expect(one.body.input_schema.required).toEqual(['title']);
    const filtered = await ctx.request('GET', '/wp-abilities/v1/abilities?category=user');
    expect(filtered.body).toEqual([]);
    const categories = await ctx.request('GET', '/wp-abilities/v1/categories');
    expect(categories.body.map((c: { slug: string }) => c.slug)).toEqual(['site', 'user']);
    expect((await ctx.request('GET', '/wp-abilities/v1/categories/nope')).body.code).toBe(
      'rest_ability_category_not_found',
    );

    ctx.clearCookie();
    expect((await ctx.request('GET', '/wp-abilities/v1/abilities')).status).toBe(401);
  });

  it('runs abilities with the method their annotations ask for', async () => {
    const ctx = await withAbilities();
    const info = await ctx.request(
      'GET',
      `/wp-abilities/v1/abilities/core/get-site-info/run?input[fields][]=name`,
    );
    expect(info.status).toBe(200);
    expect(info.body).toEqual({ name: 'Test Site' });

    const wrong = await ctx.request(
      'POST',
      '/wp-abilities/v1/abilities/core/get-site-info/run',
      {},
    );
    expect(wrong.status).toBe(405);
    expect(wrong.body.code).toBe('rest_ability_invalid_method');

    const renamed = await ctx.request('POST', '/wp-abilities/v1/abilities/test/rename/run', {
      input: { title: 'New name' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ title: 'New name' });
    expect(await ctx.kernel.options.get('blogname')).toBe('New name');
  });

  it('answers schema errors with 400 and refusals with 401/403', async () => {
    const ctx = await withAbilities();
    const invalid = await ctx.request('POST', '/wp-abilities/v1/abilities/test/rename/run', {
      input: { title: '' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('ability_invalid_input');
    expect(invalid.body.message).toContain('input[title] must be at least 1 character long.');

    const editor = await ctx.loginAs('ed', 'editor');
    const denied = await editor.request('POST', '/wp-abilities/v1/abilities/test/rename/run', {
      input: { title: 'Mine' },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('rest_ability_cannot_execute');

    ctx.clearCookie();
    const anonymous = await ctx.request('POST', '/wp-abilities/v1/abilities/test/rename/run', {
      input: { title: 'Mine' },
    });
    expect(anonymous.status).toBe(401);
    expect(await ctx.kernel.options.get('blogname')).toBe('Test Site');
    expect(
      (await ctx.request('POST', '/wp-abilities/v1/abilities/test/hidden/run', {})).status,
    ).toBe(404);
  });
});

/* -------------------------------------------------------------- AI client */

describe('kernel.ai', () => {
  it('supports AI only when enabled, with a provider key, and when wp_supports_ai agrees', async () => {
    const ctx = await site();
    const mock = mockProvider(() => text('OK'));
    ctx.kernel.ai.registerProvider(mock.provider);
    expect(await ctx.kernel.ai.supportsAi()).toBe(false);
    await ctx.kernel.ai.saveSettings({ enabled: true, provider: 'mock' });
    expect(await ctx.kernel.ai.supportsAi()).toBe(false); // no key yet
    await ctx.kernel.ai.setApiKey('mock', KEY);
    expect(await ctx.kernel.ai.supportsAi()).toBe(true);

    const off = ctx.kernel.hooks.addFilter('wp_supports_ai', () => false);
    expect(await ctx.kernel.ai.supportsAi()).toBe(false);
    await expect(ctx.kernel.ai.prompt('Hi').generateText()).rejects.toMatchObject({
      code: 'prompt_prevented',
      status: 503,
    });
    off();
    vi.stubEnv('PRESSBASE_AI_SUPPORT', '0');
    expect(await ctx.kernel.ai.supportsAi()).toBe(false);
    expect(mock.requests).toHaveLength(0);
  });

  it('prefers the key from the environment over the saved one', async () => {
    const ctx = await site();
    const mock = mockProvider(() => text('OK'));
    await enableAi(ctx, mock);
    vi.stubEnv('PRESSBASE_MOCK_API_KEY', 'env-key-1234567890');
    expect(await ctx.kernel.ai.keyStatus('mock')).toEqual({ source: 'env', last4: '7890' });
    await ctx.kernel.ai.prompt('Hi').generateText();
    expect(mock.keys).toEqual(['env-key-1234567890']);
  });

  it('builds the request: system instruction, messages, tokens, temperature and the site model', async () => {
    const ctx = await site();
    const mock = mockProvider(() =>
      text('<p>A <b>bold</b> title &amp; more</p><script>x()</script>'),
    );
    await enableAi(ctx, mock);
    await ctx.kernel.ai.saveSettings({ model: 'mock-small' });
    const out = await ctx.kernel.ai
      .prompt('Suggest a title.')
      .withText('About owls.')
      .usingSystemInstruction('You write titles.')
      .usingMaxTokens(300)
      .usingTemperature(0.2)
      .generateText();
    expect(out).toBe('A bold title & more');
    expect(mock.requests[0]).toEqual({
      model: 'mock-small',
      systemInstruction: 'You write titles.',
      maxTokens: 300,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'Suggest a title.' },
            { type: 'text', text: 'About owls.' },
          ],
        },
      ],
    });
  });

  it('parses structured output against the schema and strips HTML from it', async () => {
    const ctx = await site();
    const replies = ['{"titles":["<em>One</em>","Two"]}', 'not json', '{"titles":[1]}'];
    const mock = mockProvider((_r, n) => text(replies[n - 1] ?? ''));
    await enableAi(ctx, mock);
    const outputSchema = {
      type: 'object',
      properties: { titles: { type: 'array', items: { type: 'string' } } },
      required: ['titles'],
    };
    const ask = () => ctx.kernel.ai.prompt('Titles?').asJsonResponse(outputSchema).generateJson();
    expect(await ask()).toEqual({ titles: ['One', 'Two'] });
    expect(mock.requests[0]?.outputSchema).toEqual(outputSchema);
    await expect(ask()).rejects.toMatchObject({ code: 'prompt_invalid_output' });
    await expect(ask()).rejects.toMatchObject({ code: 'prompt_invalid_output' });
  });

  it('returns usage with generateTextResult and logs every request without content', async () => {
    const ctx = await site();
    const mock = mockProvider(() => text('Secret answer'));
    await enableAi(ctx, mock);
    const admin = await adminUser(ctx);
    const result = await ctx.kernel.ai
      .prompt('Private prompt text')
      .forUser(admin)
      .forAbility('test/thing')
      .generateTextResult();
    expect(result.tokenUsage).toEqual({ promptTokens: 12, completionTokens: 3, totalTokens: 15 });

    const rows = await ctx.kernel.db.select().from(schema.aiRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: 1,
      plugin: null,
      ability: 'test/thing',
      provider: 'mock',
      model: 'mock-large',
      inputTokens: 12,
      outputTokens: 3,
      status: 'ok',
      errorCode: null,
    });
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain('Private prompt');
    expect(stored).not.toContain('Secret answer');
    expect(stored).not.toContain(KEY);
  });

  it('enforces the daily request cap', async () => {
    const ctx = await site();
    const mock = mockProvider(() => text('OK'));
    await enableAi(ctx, mock, 2);
    await ctx.kernel.ai.prompt('1').generateText();
    await ctx.kernel.ai.prompt('2').generateText();
    await expect(ctx.kernel.ai.prompt('3').generateText()).rejects.toMatchObject({
      code: 'ai_daily_limit_reached',
      status: 429,
    });
    expect(mock.requests).toHaveLength(2);
    expect(await ctx.kernel.ai.requestsToday()).toBe(2);
  });

  it('times out slow providers and logs the timeout', async () => {
    const ctx = await site();
    const mock = mockProvider(() => new Promise(() => {}));
    await enableAi(ctx, mock);
    await expect(
      ctx.kernel.ai.prompt('Hi').usingRequestTimeout(0.05).generateText(),
    ).rejects.toMatchObject({ code: 'prompt_timeout', status: 504 });
    const [row] = await ctx.kernel.db.select().from(schema.aiRequests);
    expect(row).toMatchObject({ status: 'error', errorCode: 'prompt_timeout' });

    // The default comes from wp_ai_client_default_request_timeout (seconds).
    ctx.kernel.hooks.addFilter('wp_ai_client_default_request_timeout', () => 0.05);
    await expect(ctx.kernel.ai.prompt('Hi').generateText()).rejects.toMatchObject({
      code: 'prompt_timeout',
    });
  });

  it('redacts keys from provider errors', async () => {
    const ctx = await site();
    const mock = mockProvider(() => {
      throw new AiError('prompt_client_error', `Bad key ${KEY} and sk-ant-other-ABCDEFGHIJK`, 401);
    });
    await enableAi(ctx, mock);
    const error = await ctx.kernel.ai
      .prompt('Hi')
      .generateText()
      .catch((e: AiError) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).message).toBe('Bad key [redacted] and [redacted]');
    expect(redactSecrets(`x ${KEY} y`)).toBe('x [redacted] y');
  });

  it('wp_ai_client_prevent_prompt can stop a prompt', async () => {
    const ctx = await site();
    const mock = mockProvider(() => text('OK'));
    await enableAi(ctx, mock);
    ctx.kernel.hooks.addFilter('wp_ai_client_prevent_prompt', (prevent, builder) =>
      builder.describe().plugin === null ? true : prevent,
    );
    const builder = ctx.kernel.ai.prompt('Hi');
    expect(await builder.isSupportedForTextGeneration()).toBe(false);
    await expect(builder.generateText()).rejects.toMatchObject({
      message: 'Prompt execution was prevented by a filter.',
    });
  });

  it('strips markup from text', () => {
    expect(stripHtml('<h1>Owls</h1> &lt;3 <img src=x onerror=alert(1)>')).toBe('Owls <3 ');
  });
});

/* --------------------------------------------------- abilities as tools */

describe('usingAbilities (the ability function resolver)', () => {
  it('maps ability names to function names and back', () => {
    expect(abilityNameToFunctionName('tec/create-event')).toBe('wpab__tec__create-event');
    expect(functionNameToAbilityName('wpab__tec__create-event')).toBe('tec/create-event');
  });

  it('exposes abilities as functions and runs the calls as the prompt user', async () => {
    const ctx = await site();
    const mock = mockProvider((request, n) =>
      n === 1
        ? {
            finishReason: 'tool_calls',
            message: {
              role: 'model',
              parts: [
                {
                  type: 'function_call',
                  id: 'call_1',
                  name: 'wpab__core__get-site-info',
                  args: { fields: ['name'] },
                },
                { type: 'function_call', id: 'call_2', name: 'wpab__test__other', args: {} },
              ],
            },
          }
        : text(`Done after ${request.messages.length} messages`),
    );
    await enableAi(ctx, mock);
    const admin = await adminUser(ctx);
    const result = await ctx.kernel.ai
      .prompt('What is the site called?')
      .usingAbilities('core/get-site-info', 'missing/ability')
      .forUser(admin)
      .generateTextResult();

    expect(mock.requests[0]?.functionDeclarations).toEqual([
      {
        name: 'wpab__core__get-site-info',
        description: expect.stringContaining('Returns site information'),
        parameters: expect.objectContaining({ type: 'object', additionalProperties: false }),
      },
    ]);
    const second = mock.requests[1];
    expect(second?.messages).toHaveLength(3);
    expect(second?.messages[2]).toEqual({
      role: 'user',
      parts: [
        {
          type: 'function_response',
          id: 'call_1',
          name: 'wpab__core__get-site-info',
          response: { name: 'Test Site' },
        },
        {
          type: 'function_response',
          id: 'call_2',
          name: 'wpab__test__other',
          response: {
            error: 'Ability "test/other" was not specified in the allowed abilities list.',
            code: 'ability_not_allowed',
          },
        },
      ],
    });
    expect(result.tokenUsage.totalTokens).toBe(30);
    expect(await ctx.kernel.ai.requestsToday()).toBe(2);
  });

  it('refuses ability calls the prompt user may not make', async () => {
    const ctx = await site();
    const mock = mockProvider((_r, n) =>
      n === 1
        ? {
            message: {
              role: 'model',
              parts: [
                { type: 'function_call', id: 'c', name: 'wpab__core__get-site-info', args: {} },
              ],
            },
          }
        : text('ok'),
    );
    await enableAi(ctx, mock);
    await ctx.kernel.ai.prompt('Hi').usingAbilities('core/get-site-info').generateText();
    const response = mock.requests[1]?.messages[2]?.parts[0];
    expect(response).toMatchObject({ response: { code: 'ability_invalid_permissions' } });
  });
});

/* ---------------------------------------------------- Anthropic provider */

describe('the Anthropic provider', () => {
  function fakeClient(reply: Partial<Anthropic.Beta.BetaMessage> | Error) {
    const calls: { params: Anthropic.Beta.MessageCreateParamsNonStreaming; timeout?: number }[] =
      [];
    const factoryOptions: { apiKey: string; timeout: number }[] = [];
    const client: AnthropicClientLike = {
      beta: {
        messages: {
          async create(params, options) {
            calls.push({ params: structuredClone(params), timeout: options?.timeout });
            if (reply instanceof Error) throw reply;
            return {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: params.model,
              content: [{ type: 'text', text: 'Hello', citations: null }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 4 },
              ...reply,
            } as Anthropic.Beta.BetaMessage;
          },
        },
      },
    };
    const provider = createAnthropicProvider((options) => {
      factoryOptions.push(options);
      return client;
    });
    return { provider, calls, factoryOptions };
  }

  const context = { apiKey: KEY, signal: new AbortController().signal, timeoutMs: 30_000 };

  it('sends Messages API requests with structured output, tools and server-side fallbacks', async () => {
    const { provider, calls, factoryOptions } = fakeClient({});
    expect(provider.defaultModel).toBe('claude-opus-5-5');
    const result = await provider.generateText(
      {
        model: 'claude-opus-5-5',
        systemInstruction: 'Be brief.',
        maxTokens: 500,
        temperature: 0.7,
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
        outputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        functionDeclarations: [{ name: 'wpab__core__get-site-info', description: 'Site info.' }],
      },
      context,
    );
    expect(factoryOptions).toEqual([{ apiKey: KEY, timeout: 30_000 }]);
    const params = calls[0]?.params as unknown as Record<string, unknown>;
    expect(params).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 500,
      system: 'Be brief.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      tools: [
        {
          name: 'wpab__core__get-site-info',
          description: 'Site info.',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      tool_choice: { type: 'auto' },
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['a'],
            additionalProperties: false,
          },
        },
      },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(params).not.toHaveProperty('temperature');
    expect(result).toMatchObject({
      message: { role: 'model', parts: [{ type: 'text', text: 'Hello' }] },
      finishReason: 'stop',
      tokenUsage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      providerId: 'anthropic',
    });
  });

  it('maps tool calls and sends Claude’s own content back in the next turn', async () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'wpab__a__b', input: { x: 1 }, caller: null },
    ];
    const { provider, calls } = fakeClient({
      content: content as never,
      stop_reason: 'tool_use',
      model: 'claude-haiku-5-5',
    });
    const first = await provider.generateText(
      {
        model: 'claude-haiku-5-5',
        maxTokens: 100,
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Go' }] }],
      },
      context,
    );
    expect(calls[0]?.params).not.toHaveProperty('fallbacks');
    expect(first.finishReason).toBe('tool_calls');
    expect(first.message.parts).toEqual([
      { type: 'function_call', id: 'toolu_1', name: 'wpab__a__b', args: { x: 1 } },
    ]);
    await provider.generateText(
      {
        model: 'claude-haiku-5-5',
        maxTokens: 100,
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Go' }] },
          first.message,
          {
            role: 'user',
            parts: [
              { type: 'function_response', id: 'toolu_1', name: 'wpab__a__b', response: { ok: 1 } },
            ],
          },
        ],
      },
      context,
    );
    expect(calls[1]?.params.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Go' }] },
      { role: 'assistant', content },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"ok":1}' }],
      },
    ]);
  });

  it('maps SDK errors to the AI client’s codes', async () => {
    const auth = new Anthropic.AuthenticationError(
      401,
      undefined,
      'invalid x-api-key',
      new Headers(),
    );
    await expect(
      fakeClient(auth).provider.generateText(
        { model: 'claude-opus-5-5', maxTokens: 10, messages: [] },
        context,
      ),
    ).rejects.toMatchObject({ code: 'prompt_client_error', status: 401 });
    const timeout = new Anthropic.APIConnectionTimeoutError();
    await expect(
      fakeClient(timeout).provider.generateText(
        { model: 'claude-opus-5-5', maxTokens: 10, messages: [] },
        context,
      ),
    ).rejects.toMatchObject({ code: 'prompt_timeout' });
    const refusal = fakeClient({ stop_reason: 'refusal', content: [] });
    await expect(
      refusal.provider.generateText(
        { model: 'claude-opus-5-5', maxTokens: 10, messages: [] },
        context,
      ),
    ).rejects.toMatchObject({ code: 'prompt_refused' });
  });
});

/* ------------------------------------------------------------ Settings → AI */

describe('/pressbase/v1/ai', () => {
  it('saves settings and a key, and never returns the key', async () => {
    const ctx = await site();
    const before = await ctx.request('GET', '/pressbase/v1/ai/settings');
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      enabled: false,
      provider: 'anthropic',
      model: '',
      daily_limit: 100,
      supports_ai: false,
      requests_today: 0,
    });
    expect(before.body.providers[0]).toMatchObject({
      id: 'anthropic',
      default_model: 'claude-opus-5-5',
      env_var: 'PRESSBASE_ANTHROPIC_API_KEY',
      key: { source: 'none', last4: null },
    });

    const saved = await ctx.request('POST', '/pressbase/v1/ai/settings', {
      enabled: true,
      model: 'claude-sonnet-5-5',
      daily_limit: 20,
      api_key: KEY,
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
    expect(saved.body).toMatchObject({
      enabled: true,
      model: 'claude-sonnet-5-5',
      supports_ai: true,
    });
    expect(saved.body.providers[0].key).toEqual({ source: 'database', last4: 'WXYZ' });
    expect(await ctx.kernel.options.get(apiKeyOption('anthropic'))).toBe(KEY);

    // The key isn't in /wp/v2/settings either.
    const wp = await ctx.request('GET', '/wp/v2/settings');
    expect(JSON.stringify(wp.body)).not.toContain(KEY);

    vi.stubEnv('PRESSBASE_ANTHROPIC_API_KEY', 'sk-ant-from-env-00001111');
    const env = await ctx.request('GET', '/pressbase/v1/ai/settings');
    expect(env.body.providers[0].key).toEqual({ source: 'env', last4: '1111' });
    vi.unstubAllEnvs();

    const cleared = await ctx.request('POST', '/pressbase/v1/ai/settings', { api_key: '' });
    expect(cleared.body.providers[0].key).toEqual({ source: 'none', last4: null });
    expect(cleared.body.supports_ai).toBe(false);

    const bad = await ctx.request('POST', '/pressbase/v1/ai/settings', { provider: 'nope' });
    expect(bad.status).toBe(400);
    const unknown = await ctx.request('POST', '/pressbase/v1/ai/settings', { secret: 1 });
    expect(unknown.status).toBe(400);
  });

  it('is for administrators only', async () => {
    const ctx = await site();
    const editor = await ctx.loginAs('ed', 'editor');
    expect((await editor.request('GET', '/pressbase/v1/ai/settings')).status).toBe(403);
    expect((await editor.request('POST', '/pressbase/v1/ai/test')).status).toBe(403);
    ctx.clearCookie();
    expect((await ctx.request('GET', '/pressbase/v1/ai/settings')).status).toBe(401);
  });

  it('tests the connection through the configured provider', async () => {
    const ctx = await site();
    const failing = await ctx.request('POST', '/pressbase/v1/ai/test');
    expect(failing.status).toBe(503);
    expect(failing.body.code).toBe('prompt_prevented');

    const mock = mockProvider(() => text('OK'));
    await enableAi(ctx, mock);
    const ok = await ctx.request('POST', '/pressbase/v1/ai/test');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, provider: 'mock', model: 'mock-large' });

    const broken = mockProvider(() => {
      throw new AiError('prompt_client_error', `Invalid key ${KEY}`, 401);
    }, 'broken');
    await enableAi(ctx, broken);
    const res = await ctx.request('POST', '/pressbase/v1/ai/test');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid key [redacted]');
  });
});

/* ----------------------------------------------------------------- Plugins */

describe('api.ai and api.abilities', () => {
  async function writePlugin(ctx: Ctx, slug: string, source: string) {
    const dir = path.join(ctx.dataDir, 'plugins', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'plugin.json'),
      JSON.stringify({ name: slug, title: slug, version: '1.0.0', main: 'index.js' }),
    );
    await writeFile(path.join(dir, 'index.js'), source);
  }

  const PLUGIN = `
export default function register(api) {
  api.abilities.registerCategory('helper', { label: 'Helper', description: 'Helper abilities.' });
  api.abilities.register('shout', {
    label: 'Shout',
    description: 'Upper-cases text.',
    category: 'helper',
    inputSchema: { type: 'string', minLength: 1 },
    outputSchema: { type: 'string' },
    permissionCallback: (input, context) => context.can('edit_posts'),
    executeCallback: (input) => input.toUpperCase(),
    meta: { showInRest: true },
  });
  api.rest.registerRoute('helper/v1', '/suggest', {
    methods: ['POST'],
    permission: (c) => api.rest.userCan(c, 'edit_posts'),
    handler: async (c) => ({
      text: await api.ai.prompt('Suggest').forUser(api.rest.currentUser(c)).generateText(),
    }),
  });
}
`;

  it('namespaces abilities by the plugin, serves them over REST and removes them on deactivation', async () => {
    const ctx = await site();
    await writePlugin(ctx, 'helper', PLUGIN);
    await ctx.kernel.plugins.activate('helper');
    const ability = ctx.kernel.abilities.get('helper/shout');
    expect(ability?.plugin).toBe('helper');

    const run = await ctx.request('POST', '/wp-abilities/v1/abilities/helper/shout/run', {
      input: 'hello',
    });
    expect(run.status).toBe(200);
    expect(run.body).toBe('HELLO');

    const api = ctx.kernel.plugins.runtime('helper')?.api;
    expect(() =>
      api?.abilities.register('other/thing', {
        label: 'x',
        description: 'x',
        category: 'helper',
        permissionCallback: () => true,
        executeCallback: () => 1,
      }),
    ).toThrow(/start with "helper\/"/);
    expect(() =>
      api?.abilities.registerCategory('misc', { label: 'x', description: 'x' }),
    ).toThrow();

    await ctx.kernel.plugins.deactivate('helper');
    expect(ctx.kernel.abilities.has('helper/shout')).toBe(false);
    expect(ctx.kernel.abilities.category('helper')).toBeUndefined();
    expect(
      (await ctx.request('POST', '/wp-abilities/v1/abilities/helper/shout/run', { input: 'x' }))
        .status,
    ).toBe(404);
  });

  it('attributes api.ai requests to the plugin and applies its own daily limit', async () => {
    const ctx = await site();
    const mock = mockProvider(() => text('<b>Owls</b> at night'));
    await enableAi(ctx, mock);
    await writePlugin(ctx, 'helper', PLUGIN);
    await ctx.kernel.plugins.activate('helper');
    ctx.kernel.hooks.addFilter('pressbase_ai_plugin_daily_request_limit', (limit, plugin) =>
      plugin === 'helper' ? 1 : limit,
    );

    const first = await ctx.request('POST', '/helper/v1/suggest');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ text: 'Owls at night' });
    const [row] = await ctx.kernel.db.select().from(schema.aiRequests);
    expect(row).toMatchObject({ plugin: 'helper', userId: 1, status: 'ok' });

    const api = ctx.kernel.plugins.runtime('helper')?.api;
    await expect(api?.ai.prompt('Again').generateText()).rejects.toMatchObject({
      code: 'ai_daily_limit_reached',
    });
    // Core still has the site's allowance.
    expect(await ctx.kernel.ai.prompt('Core').generateText()).toBe('Owls at night');

    await ctx.kernel.plugins.deactivate('helper');
    expect(() => api?.ai.prompt('Late')).toThrow(/no longer active/);
  });
});
