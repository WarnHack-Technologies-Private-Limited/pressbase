import { schema } from '@pressbase/db';
import { desc } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createRecordedProvider, RECORDED_PROVIDER_ID } from './ai/providers/recorded';
import type { AiMessage, AiMessagePart, AiProvider, AiTextRequest } from './ai/types';
import { historyMessages, SYSTEM, type ThreadMessage } from './site-building/assistant';
import { setup, type TestResponse } from './test-utils';

/**
 * Studio's AI panel (#62) and the edits it proposes (#57): the
 * `core/propose-site-edits` ability, which checks a set of operations
 * against the site and changes nothing, and `/pressbase/v1/studio/ai`,
 * which runs a request through the tool loop and streams the reply. AI
 * answers come from a scripted fake provider or the recorded one; no test
 * reaches a real provider. See docs/architecture/ai-edits.md.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;
type Client = Pick<Ctx, 'request'>;
type Json = Record<string, unknown>;

const KEY = 'fake-key-for-tests-0123';
const HERO = 'pressbase/hero-centered';
const FAQ = 'pressbase/faq';

/** A step of a scripted conversation: an ability call, or the reply's text. */
type Step = { call: string; args: Json } | { text: string };

/** A fake provider that plays `steps` in order, recording each request. */
function scripted(steps: Step[]) {
  const requests: AiTextRequest[] = [];
  let n = 0;
  const provider: AiProvider = {
    id: 'scripted',
    name: 'Scripted',
    envVar: 'PRESSBASE_SCRIPTED_API_KEY',
    defaultModel: 'scripted-1',
    models: [{ id: 'scripted-1', name: 'Scripted' }],
    async generateText(request) {
      requests.push(structuredClone(request));
      const step = steps[n++] ?? { text: 'Done.' };
      const parts: AiMessagePart[] =
        'call' in step
          ? [{ type: 'function_call', id: `call_${n}`, name: step.call, args: step.args }]
          : [{ type: 'text', text: step.text }];
      return {
        id: `r${n}`,
        message: { role: 'model', parts },
        finishReason: 'call' in step ? 'tool_calls' : 'stop',
        tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        providerId: 'scripted',
        model: request.model,
      };
    },
  };
  return { provider, requests };
}

async function site(provider?: AiProvider, on = true): Promise<Ctx> {
  const ctx = await setup();
  await ctx.install();
  await ctx.kernel.themes.activate('pressbase');
  if (provider) {
    ctx.kernel.ai.registerProvider(provider);
    await ctx.kernel.ai.saveSettings({ enabled: on, provider: provider.id, dailyLimit: 50 });
    await ctx.kernel.ai.setApiKey(provider.id, KEY);
  }
  return ctx;
}

function propose(client: Client, input: Json): Promise<TestResponse> {
  const url = '/wp-abilities/v1/abilities/core/propose-site-edits/run';
  return client.request('GET', `${url}?input=${encodeURIComponent(JSON.stringify(input))}`);
}

async function pageFromPatterns(ctx: Ctx, title: string, ...names: string[]) {
  const patterns = ctx.kernel.blocks.patterns();
  const content = names
    .map((name) => patterns.find((p) => p.name === name)?.content ?? '')
    .join('\n\n');
  const res = await ctx.request('POST', '/wp/v2/pages', { title, content, status: 'publish' });
  expect(res.status).toBe(201);
  return res.body as { id: number; slug: string };
}

/** Sends a request to the panel and reads its Server-Sent Events. */
async function ask(ctx: Ctx, body: Json) {
  const login = await ctx.app.request('/wp-json/pressbase/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pressbase-request': '1' },
    body: JSON.stringify({ login: 'admin', password: 'correct horse battery staple' }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const res = await ctx.app.request('/wp-json/pressbase/v1/studio/ai/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pressbase-request': '1', cookie },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return { status: res.status, body: JSON.parse(text) as Json, events: [] };
  }
  const events = text
    .split('\n\n')
    .filter((chunk) => chunk.includes('data:'))
    .map((chunk) => {
      const field = (name: string) =>
        chunk
          .split('\n')
          .find((line) => line.startsWith(`${name}:`))
          ?.slice(name.length + 1)
          .trim();
      return { event: field('event'), data: JSON.parse(field('data') ?? 'null') as Json };
    });
  return { status: res.status, body: {}, events };
}

async function changesetEntries(ctx: Ctx) {
  const res = await ctx.request('GET', '/pressbase/v1/changesets');
  return (res.body[0]?.entries ?? {}) as Record<string, unknown>;
}

/* ------------------------------------------------------------- the ability */

describe('core/propose-site-edits', () => {
  it('checks a set against the site, names each page, and changes nothing', async () => {
    const ctx = await site();
    const page = await pageFromPatterns(ctx, 'Home', HERO);
    const res = await propose(ctx, {
      summary: 'Adds questions and a page for them.',
      page: page.id,
      operations: [
        { type: 'insertSection', pattern: FAQ },
        { type: 'moveSection', index: 1, to: 0 },
        { type: 'updateBlockAttributes', index: 1, attributes: { backgroundColor: 'accent' } },
        {
          type: 'setGlobalStyles',
          styles: { elements: { button: { border: { radius: 'var:preset|border-radius|full' } } } },
        },
        { type: 'createPage', title: 'Questions', sections: [{ pattern: FAQ }] },
        { type: 'updateMenu', items: [{ label: 'Questions', page: 'questions' }] },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as { operations: Json[]; summary: string; unused: string[] };
    expect(body.summary).toBe('Adds questions and a page for them.');
    expect(body.operations.slice(0, 3).map((o) => o.page)).toEqual([page.id, page.id, page.id]);
    expect(body.operations[4]).toMatchObject({ type: 'createPage', slug: 'questions' });
    // Nothing was written: no changeset, no new page.
    expect(await changesetEntries(ctx)).toEqual({});
    expect((await ctx.request('GET', '/wp/v2/pages?slug=questions')).body).toEqual([]);
  });

  it('says what’s wrong, with the operation’s path', async () => {
    const ctx = await site();
    const page = await pageFromPatterns(ctx, 'Home', HERO);
    const problem = async (operations: Json[]) => {
      const res = await propose(ctx, { summary: 'x', page: page.id, operations });
      expect(res.status).toBe(400);
      return (res.body as { message: string }).message;
    };
    expect(await problem([{ type: 'insertSection', pattern: 'nope/nope' }])).toMatch(
      /input\[operations\]\[0\]\[pattern\]: there’s no pattern “nope\/nope”/,
    );
    expect(
      await problem([
        { type: 'removeSection', index: 0 },
        { type: 'removeSection', index: 0 },
      ]),
    ).toMatch(/input\[operations\]\[1\]\[index\]: there’s no section 0; the page has 0/);
    expect(
      await problem([{ type: 'setGlobalStyles', styles: { color: { background: '#ff0000' } } }]),
    ).toMatch(/isn’t a preset/);
    expect(
      await problem([
        { type: 'updateBlockAttributes', index: 0, attributes: { textColor: 'chartreuse' } },
      ]),
    ).toMatch(/no preset “chartreuse”/);
    expect(await problem([{ type: 'updateSlots', index: 0, slots: { not_a_slot: 'x' } }])).toMatch(
      /input\[operations\]\[0\]: not_a_slot is not a valid property/,
    );
    expect(
      await problem([{ type: 'updateMenu', items: [{ label: 'X', page: 'missing' }] }]),
    ).toMatch(/no page “missing”/);
    expect(await problem([{ type: 'insertSection', pattern: FAQ, page: 'nowhere' }])).toMatch(
      /no page “nowhere”/,
    );
    const noPage = await propose(ctx, {
      summary: 'x',
      operations: [{ type: 'removeSection', index: 0 }],
    });
    expect((noPage.body as { message: string }).message).toMatch(/name the page/);
  });

  it('checks the person may make every change', async () => {
    const ctx = await site();
    const editor = await ctx.loginAs('ed', 'editor');
    const styles = await propose(editor, {
      summary: 'x',
      operations: [{ type: 'setGlobalStyles', styles: { typography: { fontSize: '1rem' } } }],
    });
    expect(styles.status).toBe(403);
    const author = await ctx.loginAs('au', 'author');
    const page = await pageFromPatterns(ctx, 'Home', HERO);
    const pages = await propose(author, {
      summary: 'x',
      page: page.id,
      operations: [{ type: 'removeSection', index: 0 }],
    });
    expect(pages.status).toBe(403);
  });
});

/* ---------------------------------------------------------------- the panel */

describe('/pressbase/v1/studio/ai', () => {
  it('says when AI is off, and how many requests are left', async () => {
    const { provider } = scripted([]);
    const ctx = await site(provider, false);
    const status = await ctx.request('GET', '/pressbase/v1/studio/ai');
    expect(status.body).toMatchObject({
      supports_ai: false,
      can_manage_ai: true,
      daily_limit: 50,
      requests_today: 0,
      limit_reached: false,
      changeset_uuid: null,
      messages: [],
    });
    const res = await ask(ctx, { message: 'Make it green' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('prompt_prevented');
  });

  it('runs a request through the tool loop and streams the reply with the proposal', async () => {
    const steps: Step[] = [];
    const { provider, requests } = scripted(steps);
    const ctx = await site(provider);
    const page = await pageFromPatterns(ctx, 'Home', HERO);
    steps.push(
      { call: 'wpab__core__get-page-structure', args: { id: page.id } },
      {
        call: 'wpab__core__propose-site-edits',
        args: {
          summary: 'Adds a questions section.',
          page: page.id,
          operations: [{ type: 'insertSection', pattern: 'nope' }],
        },
      },
      {
        call: 'wpab__core__propose-site-edits',
        args: {
          summary: 'Adds a questions section.',
          page: page.id,
          operations: [{ type: 'insertSection', pattern: FAQ }],
        },
      },
      { text: 'I added a questions section at the end of the page.' },
    );
    const res = await ask(ctx, {
      message: 'Add an FAQ',
      page: { id: page.id },
      parts: ['header', 'footer'],
    });
    expect(res.status).toBe(200);
    const types = res.events.map((e) => e.event);
    expect(types[0]).toBe('start');
    expect(types).toContain('text');
    expect(types.at(-1)).toBe('done');
    const done = res.events.at(-1)?.data as {
      message: ThreadMessage;
      requests_today: number;
      daily_limit: number;
    };
    expect(done.message).toMatchObject({
      role: 'assistant',
      text: 'I added a questions section at the end of the page.',
      summary: 'Adds a questions section.',
      outcome: 'proposed',
      operations: [{ type: 'insertSection', pattern: FAQ, page: page.id }],
    });
    // Four provider requests: read, a refused proposal, the corrected one, the reply.
    expect(requests).toHaveLength(4);
    expect(done.requests_today).toBe(4);
    const rows = await ctx.kernel.db
      .select()
      .from(schema.aiRequests)
      .orderBy(desc(schema.aiRequests.id));
    expect(rows.every((r) => r.ability === 'studio/assistant')).toBe(true);

    // The refused proposal's error went back to the model, with its path.
    const refused = requests[2]?.messages.at(-1)?.parts[0] as { response: Json };
    expect(String(refused.response.error)).toMatch(/there’s no pattern “nope”/);

    // The model gets reads and the proposal, never a write; site content is data.
    const first = requests[0] as AiTextRequest;
    expect(first.functionDeclarations?.map((f) => f.name)).toEqual([
      'wpab__core__get-site-brief',
      'wpab__core__get-design-system',
      'wpab__core__list-patterns',
      'wpab__core__get-page-structure',
      'wpab__core__propose-site-edits',
    ]);
    expect(first.systemInstruction).toContain(SYSTEM);
    const prompt = (first.messages.at(-1)?.parts[0] as { text: string }).text;
    expect(prompt).toContain('<studio_context>');
    expect(prompt).toContain(`"slug": "${page.slug}"`);
    expect(prompt.endsWith('The site owner asks:\nAdd an FAQ')).toBe(true);

    // Nothing was written to the site: the changeset holds only the conversation.
    expect(await changesetEntries(ctx)).toEqual({});
    const thread = await ctx.request('GET', '/pressbase/v1/studio/ai');
    const messages = (thread.body as { messages: ThreadMessage[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]?.page).toMatchObject({ id: page.id, title: 'Home' });

    // Keep: recorded, so the next request knows.
    const kept = await ctx.request('POST', `/pressbase/v1/studio/ai/messages/${messages[1]?.id}`, {
      outcome: 'kept',
    });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ outcome: 'kept' });
    expect(
      (await ctx.request('POST', '/pressbase/v1/studio/ai/messages/nope', { outcome: 'kept' }))
        .status,
    ).toBe(404);

    // The next request carries the conversation.
    steps.push({ text: 'Sure.' });
    await ask(ctx, { message: 'Thanks' });
    const history = requests.at(-1)?.messages as AiMessage[];
    expect(history.map((m) => m.role)).toEqual(['user', 'model', 'user']);
    expect((history[1]?.parts[0] as { text: string }).text).toContain('kept these changes');

    // Starting again clears it.
    await ctx.request('DELETE', '/pressbase/v1/studio/ai');
    expect(
      ((await ctx.request('GET', '/pressbase/v1/studio/ai')).body as { messages: unknown[] })
        .messages,
    ).toEqual([]);
  });

  it('says plainly when a request can’t be done, and proposes nothing', async () => {
    const { provider } = scripted([
      { text: 'I can’t publish for you. Use Publish when you’re happy.' },
    ]);
    const ctx = await site(provider);
    const res = await ask(ctx, { message: 'Publish the site now' });
    const done = res.events.at(-1)?.data as { message: ThreadMessage };
    expect(done.message.text).toMatch(/can’t publish/);
    expect(done.message.operations).toBeUndefined();
    expect((await ctx.request('GET', '/pressbase/v1/changesets')).body[0]?.count).toBe(0);
  });

  it('stops at the daily cap, before and during a request', async () => {
    const steps: Step[] = [
      { call: 'wpab__core__get-site-brief', args: {} },
      { call: 'wpab__core__get-site-brief', args: {} },
      { text: 'Done.' },
    ];
    const { provider } = scripted(steps);
    const ctx = await site(provider);
    await ctx.kernel.ai.saveSettings({ dailyLimit: 2 });
    const res = await ask(ctx, { message: 'What is my site about?' });
    const error = res.events.find((e) => e.event === 'error');
    expect(error?.data).toMatchObject({ code: 'ai_daily_limit_reached' });
    expect(res.events.at(-1)?.data).toMatchObject({ limit_reached: true, requests_today: 2 });
    const again = await ask(ctx, { message: 'And now?' });
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({
      code: 'ai_daily_limit_reached',
      data: { limit_reached: true, daily_limit: 2 },
    });
    const status = await ctx.request('GET', '/pressbase/v1/studio/ai');
    expect(status.body).toMatchObject({ limit_reached: true });
  });

  it('is for people who edit pages', async () => {
    const { provider } = scripted([]);
    const ctx = await site(provider);
    const contributor = await ctx.loginAs('co', 'contributor');
    expect((await contributor.request('GET', '/pressbase/v1/studio/ai')).status).toBe(403);
  });

  it('plays the recorded conversations: rounder buttons, and an FAQ', async () => {
    const ctx = await site(createRecordedProvider());
    await ctx.kernel.ai.saveSettings({ provider: RECORDED_PROVIDER_ID });
    await ctx.kernel.ai.setApiKey(RECORDED_PROVIDER_ID, KEY);
    const page = await pageFromPatterns(ctx, 'Home', HERO);

    const buttons = await ask(ctx, { message: 'Make the buttons rounder', page: { id: page.id } });
    const styled = buttons.events.at(-1)?.data as { message: ThreadMessage };
    expect(styled.message.operations).toEqual([
      {
        type: 'setGlobalStyles',
        styles: { elements: { button: { border: { radius: 'var:preset|border-radius|full' } } } },
      },
    ]);
    expect(styled.message.text).toMatch(/fully rounded/);

    const faq = await ask(ctx, { message: 'Add an FAQ', page: { id: page.id } });
    const added = faq.events.at(-1)?.data as { message: ThreadMessage };
    expect(added.message.operations).toEqual([
      expect.objectContaining({ type: 'insertSection', page: page.id }),
    ]);

    const cannot = await ask(ctx, { message: 'Publish everything' });
    const said = cannot.events.at(-1)?.data as { message: ThreadMessage };
    expect(said.message.operations).toBeUndefined();
    expect(said.message.text).toMatch(/can’t do that/);
  });
});

describe('historyMessages()', () => {
  const message = (role: 'user' | 'assistant', text: string, extra = {}): ThreadMessage => ({
    id: text,
    role,
    text,
    at: '',
    ...extra,
  });

  it('alternates, starts with the person and ends with the model', () => {
    const history = historyMessages([
      message('assistant', 'orphan'),
      message('user', 'a'),
      message('user', 'b'),
      message('assistant', 'ok', { summary: 'Did it.', outcome: 'undone' }),
      message('user', 'unanswered'),
    ]);
    expect(history.map((m) => m.role)).toEqual(['user', 'model']);
    expect(history[0]?.parts).toHaveLength(2);
    expect((history[1]?.parts[0] as { text: string }).text).toBe(
      'ok\n(Proposed: Did it.)\n(The person undid these changes.)',
    );
  });
});
