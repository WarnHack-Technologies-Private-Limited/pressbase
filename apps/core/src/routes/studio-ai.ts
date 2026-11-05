import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { AbilityError } from '../abilities/registry';
import { AiError } from '../ai/types';
import { userCan } from '../auth/users';
import { type AppEnv, invalidParams, readJson, requireCapability, restError } from '../http';
import type { Kernel } from '../kernel';
import { pageView } from '../site-building/abilities';
import {
  newMessageId,
  type OpenPage,
  readThread,
  runAssistant,
  saveThread,
  type ThreadMessage,
} from '../site-building/assistant';
import { changesetFor, entriesOf } from '../site-building/changeset';
import { quickEditRoutes } from './studio-ai-quick';

/**
 * Studio's AI panel (v0.8, #62), `edit_pages`: `/pressbase/v1/studio/ai`.
 *
 *   GET    /                 whether AI is on, today's requests and the limit, and the
 *                            conversation of the changeset (`?changeset_uuid=`, else
 *                            the person's open one)
 *   POST   /messages         ask: the reply as Server-Sent Events (`start`, `text`,
 *                            `proposal`, `done` or `error`)
 *   POST   /messages/{id}    `{ outcome: "kept" | "undone" }`: what the person did
 *                            with a proposal, so later requests know
 *   DELETE /                 start the conversation again
 *
 * The model reads the site and proposes operations through abilities, as
 * the person; nothing is written or published here. Studio applies the
 * operations in the editor, with Keep and Undo. See docs/architecture/ai-edits.md.
 */

const AI_OFF = 'AI isn’t set up on this site. Turn it on in Settings → AI.';

const askSchema = z
  .object({
    message: z.string().trim().min(1).max(2000),
    changeset_uuid: z.string().uuid().optional(),
    /** The page open in Studio. */
    page: z
      .object({
        id: z.number().int().positive().optional(),
        slug: z
          .string()
          .regex(/^[a-z0-9_-]{1,200}$/)
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
    /** The template parts on the canvas (header, footer). */
    parts: z
      .array(z.string().regex(/^[a-z0-9_-]{1,190}$/))
      .max(10)
      .optional(),
  })
  .strict();

const outcomeSchema = z
  .object({
    outcome: z.enum(['kept', 'undone']),
    changeset_uuid: z.string().uuid().optional(),
  })
  .strict();

function abilityError(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof AbilityError) {
    return restError(c, (error.status ?? 400) as 400, error.code, error.message);
  }
  throw error;
}

async function usage(kernel: Kernel) {
  const { dailyLimit } = await kernel.ai.settings();
  const today = await kernel.ai.requestsToday();
  return { daily_limit: dailyLimit, requests_today: today, limit_reached: today >= dailyLimit };
}

/** The open page, as the changeset has it: the model's context (data). */
async function openPage(
  kernel: Kernel,
  data: ReturnType<typeof entriesOf>,
  ref: { id?: number; slug?: string } | null | undefined,
): Promise<OpenPage | null> {
  if (!ref || (ref.id === undefined && ref.slug === undefined)) return null;
  try {
    const view = await pageView(kernel, data, ref.id !== undefined ? { id: ref.id } : ref);
    return { id: view.id, slug: view.slug, title: view.title };
  } catch {
    return null;
  }
}

export function studioAiRoutes() {
  const app = new Hono<AppEnv>({ strict: false });
  app.use(requireCapability('edit_pages'));

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const uuid = c.req.query('changeset_uuid');
    let changeset: Awaited<ReturnType<typeof changesetFor>>;
    try {
      changeset = await changesetFor(kernel, user, uuid || undefined, false);
    } catch (error) {
      return abilityError(c, error);
    }
    return c.json({
      supports_ai: await kernel.ai.supportsAi(),
      can_manage_ai: userCan(user, 'manage_options'),
      ...(await usage(kernel)),
      changeset_uuid: changeset?.slug ?? null,
      messages: await readThread(kernel, changeset),
    });
  });

  app.delete('/', async (c) => {
    const kernel = c.get('kernel');
    const uuid = c.req.query('changeset_uuid');
    try {
      const changeset = await changesetFor(kernel, c.get('user'), uuid || undefined, false);
      if (changeset) await saveThread(kernel, changeset, []);
      return c.json({ changeset_uuid: changeset?.slug ?? null, messages: [] });
    } catch (error) {
      return abilityError(c, error);
    }
  });

  app.post('/messages/:id', async (c) => {
    const kernel = c.get('kernel');
    const parsed = outcomeSchema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    try {
      const changeset = await changesetFor(
        kernel,
        c.get('user'),
        parsed.data.changeset_uuid,
        false,
      );
      const thread = await readThread(kernel, changeset);
      const message = thread.find((m) => m.id === c.req.param('id') && m.operations);
      if (!changeset || !message) {
        return restError(
          c,
          404,
          'studio_ai_message_not_found',
          'There’s no proposal with that ID.',
        );
      }
      message.outcome = parsed.data.outcome;
      await saveThread(kernel, changeset, thread);
      return c.json(message);
    } catch (error) {
      return abilityError(c, error);
    }
  });

  // Ask AI (#63): rewrite a selection, a prompt to a section or a page.
  quickEditRoutes(app);

  app.post('/messages', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    if (!user) return restError(c, 401, 'rest_not_logged_in', 'You are not currently logged in.');
    const parsed = askSchema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    if (!(await kernel.ai.supportsAi())) return restError(c, 503, 'prompt_prevented', AI_OFF);
    const limits = await usage(kernel);
    if (limits.limit_reached) {
      return restError(
        c,
        429,
        'ai_daily_limit_reached',
        'This site has used all of its AI requests for today. The limit resets at midnight UTC.',
        limits,
      );
    }
    let changeset: NonNullable<Awaited<ReturnType<typeof changesetFor>>>;
    try {
      // The conversation lives with the changeset, so one is started if needed.
      const found = await changesetFor(kernel, user, parsed.data.changeset_uuid, true);
      if (!found) throw new Error('A changeset should have been started.');
      changeset = found;
    } catch (error) {
      return abilityError(c, error);
    }
    const page = await openPage(kernel, entriesOf(kernel, changeset), parsed.data.page);
    const thread = await readThread(kernel, changeset);
    const request: ThreadMessage = {
      id: newMessageId(),
      role: 'user',
      text: parsed.data.message,
      at: new Date().toISOString(),
      page,
    };
    const earlier = [...thread];
    await saveThread(kernel, changeset, [...thread, request]);

    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });
      await send('start', { changeset_uuid: changeset.slug, request });
      const reply: ThreadMessage = {
        id: newMessageId(),
        role: 'assistant',
        text: '',
        at: new Date().toISOString(),
      };
      try {
        const result = await runAssistant(
          kernel,
          user,
          {
            message: parsed.data.message,
            thread: earlier,
            page,
            parts: parsed.data.parts ?? [],
            changesetUuid: changeset.slug,
          },
          {
            text: (text) => {
              void send('text', { text });
            },
            proposal: (proposal) => {
              reply.operations = proposal.operations;
              reply.summary = proposal.summary;
              if (proposal.styles) reply.styles = proposal.styles;
              else delete reply.styles;
              reply.outcome = 'proposed';
              void send('proposal', { message_id: reply.id, summary: proposal.summary });
            },
          },
        );
        reply.text = result.text;
      } catch (error) {
        if (!(error instanceof AiError)) console.error('Studio AI request failed:', error);
        const code = error instanceof AiError ? error.code : 'studio_ai_failed';
        reply.error = {
          code,
          message:
            code === 'prompt_prevented'
              ? AI_OFF
              : error instanceof AiError
                ? error.message
                : 'Something went wrong while asking AI. Please try again.',
        };
      }
      const latest = await readThread(kernel, changeset);
      await saveThread(kernel, changeset, [...latest, reply]);
      if (reply.error) await send('error', { ...reply.error, message_id: reply.id });
      await send('done', { message: reply, ...(await usage(kernel)) });
    });
  });

  return app;
}
