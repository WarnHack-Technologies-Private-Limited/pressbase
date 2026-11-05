import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AbilityError } from '../abilities/registry';
import { AiError } from '../ai/types';
import { type AppEnv, invalidParams, readJson, restError } from '../http';
import { pageView } from '../site-building/abilities';
import { changesetFor, entriesOf } from '../site-building/changeset';
import {
  MAX_TEXT_LENGTH,
  MAX_TEXTS,
  proposePage,
  proposeSection,
  REWRITE_ACTIONS,
  rewriteTexts,
  TONES,
} from '../site-building/quick-edits';

/**
 * *Ask AI* in Studio (#63), under `/pressbase/v1/studio/ai` (`edit_pages`):
 *
 *   POST /rewrite   `{ action, tone?, language?, texts: [{ id, text }] }` →
 *                   `{ texts: [{ id, text }], kept }`, with the quick-edits model
 *   POST /section   `{ prompt, page: { id } | { slug }, index?, changeset_uuid? }` →
 *                   `{ operations: [insertSection], summary, unused, category }`
 *   POST /page      `{ prompt, changeset_uuid? }` →
 *                   `{ operations: [createPage], summary, unused, page: { title, slug } }`
 *
 * Answers are operations checked by `core/propose-site-edits` (or texts
 * Studio makes into `updateSlots`), which Studio applies with Keep and
 * Undo. Nothing is written here. See docs/architecture/ai-edits.md#ask-ai.
 */

const AI_OFF = 'AI isn’t set up on this site. Turn it on in Settings → AI.';

const rewriteSchema = z
  .object({
    action: z.enum(REWRITE_ACTIONS),
    tone: z.enum(TONES).optional(),
    language: z.string().trim().min(1).max(60).optional(),
    texts: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            text: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TEXTS),
  })
  .strict()
  .refine((v) => v.action !== 'translate' || v.language, {
    message: 'Say which language to translate into.',
    path: ['language'],
  });

const pageRef = z
  .object({
    id: z.number().int().positive().optional(),
    slug: z
      .string()
      .regex(/^[a-z0-9_-]{1,200}$/)
      .optional(),
  })
  .strict()
  .refine((v) => v.id !== undefined || v.slug !== undefined, { message: 'Name the page.' });

const sectionSchema = z
  .object({
    prompt: z.string().trim().min(1).max(500),
    page: pageRef,
    index: z.number().int().min(0).max(200).optional(),
    changeset_uuid: z.string().uuid().optional(),
  })
  .strict();

const pageSchema = z
  .object({
    prompt: z.string().trim().min(1).max(500),
    changeset_uuid: z.string().uuid().optional(),
  })
  .strict();

function failure(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof AiError) {
    const message = error.code === 'prompt_prevented' ? AI_OFF : error.message;
    return restError(c, error.status as 400, error.code, message);
  }
  if (error instanceof AbilityError) {
    return restError(c, (error.status ?? 400) as 400, error.code, error.message);
  }
  throw error;
}

/** Adds the Ask AI routes to Studio's AI routes. */
export function quickEditRoutes(app: Hono<AppEnv>): void {
  /** Parses the body and checks AI is on: the parsed body, or the response to send. */
  const start = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>) => {
    const user = c.get('user');
    if (!user) {
      return {
        response: restError(c, 401, 'rest_not_logged_in', 'You are not currently logged in.'),
      };
    }
    const parsed = schema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return { response: invalidParams(c, parsed.error) };
    if (!(await c.get('kernel').ai.supportsAi())) {
      return { response: restError(c, 503, 'prompt_prevented', AI_OFF) };
    }
    return { user, data: parsed.data };
  };

  app.post('/rewrite', async (c) => {
    const started = await start(c, rewriteSchema);
    if ('response' in started) return started.response;
    try {
      return c.json(await rewriteTexts(c.get('kernel'), started.user, started.data));
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post('/section', async (c) => {
    const started = await start(c, sectionSchema);
    if ('response' in started) return started.response;
    const kernel = c.get('kernel');
    const { prompt, page, index, changeset_uuid } = started.data;
    try {
      const changeset = await changesetFor(kernel, started.user, changeset_uuid, false);
      const view = await pageView(kernel, entriesOf(kernel, changeset), page);
      return c.json(
        await proposeSection(kernel, started.user, {
          prompt,
          page: view.id ?? view.slug,
          pageTitle: view.title,
          index,
          changeset_uuid: changeset?.slug,
        }),
      );
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post('/page', async (c) => {
    const started = await start(c, pageSchema);
    if ('response' in started) return started.response;
    const kernel = c.get('kernel');
    try {
      const changeset = await changesetFor(
        kernel,
        started.user,
        started.data.changeset_uuid,
        false,
      );
      return c.json(
        await proposePage(kernel, started.user, {
          prompt: started.data.prompt,
          changeset_uuid: changeset?.slug,
        }),
      );
    } catch (error) {
      return failure(c, error);
    }
  });
}
