import { DESIGN_CHOICE_SCHEMA, type DesignChoice } from '@pressbase/design';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { validateJsonSchema } from '../abilities/json-schema';
import { AbilityError } from '../abilities/registry';
import { AiError } from '../ai/types';
import { type CurrentUser, userCan } from '../auth/users';
import { type AppEnv, invalidParams, readJson, requireCapability, restError } from '../http';
import type { Kernel } from '../kernel';
import { MAX_PAGES, MAX_SECTIONS, SITE_BUILDER_JOB } from '../site-builder/pipeline';
import {
  createRun,
  FINISHED_STATUSES,
  getRun,
  listRuns,
  presentRun,
  requestCancel,
  type SiteRun,
  saveRun,
  waitForChange,
} from '../site-builder/runs';
import {
  clarify,
  designOptions,
  draftBrief,
  draftSitemap,
  MAX_QUESTIONS,
} from '../site-builder/steps';
import { siteBriefSchema } from '../site-building/brief';
import { changesetFor } from '../site-building/changeset';

/**
 * The site builder (v0.8, #59), `edit_theme_options`:
 *
 *   POST   /pressbase/v1/site-builder/runs        start a run (the Describe step's form) → 202
 *   GET    /pressbase/v1/site-builder/runs        your runs, newest first
 *   GET    /pressbase/v1/site-builder/runs/{id}   a run; with `Accept: text/event-stream`, its
 *                                                 progress as Server-Sent Events (replayed
 *                                                 from `Last-Event-ID` or `?after=`)
 *   DELETE /pressbase/v1/site-builder/runs/{id}   stop it
 *
 * The guided flow's steps before a run (#60), one structured request each:
 *
 *   GET    /pressbase/v1/site-builder/status      AI on? a run to resume?
 *   POST   /pressbase/v1/site-builder/clarify     at most three questions
 *   POST   /pressbase/v1/site-builder/brief       the brief, from the form and the answers
 *   POST   /pressbase/v1/site-builder/designs     three design directions
 *   POST   /pressbase/v1/site-builder/sitemap     pages and their sections
 *
 * See docs/architecture/site-builder.md.
 */

const text = (max: number) => z.string().trim().max(max);

/** The Describe step's form. */
const formFields = {
  description: text(4000).min(1),
  name: text(200).optional(),
  location: text(200).optional(),
  phone: text(50).optional(),
  email: text(200).optional(),
  address: text(400).optional(),
  facts: z.array(text(500)).max(50).optional(),
  pages: z.array(text(100).min(1)).max(MAX_PAGES).optional(),
  language: z
    .string()
    .regex(/^([a-z]{2,3}([-_][A-Za-z0-9]{2,8})*)?$/)
    .optional(),
};

const clarifySchema = z.object(formFields).strict();

const briefSchema = z
  .object({
    ...formFields,
    /** The Clarify step's questions and the person's answers (empty answers are skipped). */
    answers: z
      .array(z.object({ question: text(300).min(1), answer: text(1000) }).strict())
      .max(MAX_QUESTIONS)
      .optional(),
  })
  .strict();

const designsSchema = z
  .object({
    brief: siteBriefSchema,
    /** Directions already shown ("Show three more"): the new ones differ. */
    shown: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
  })
  .strict();

const sitemapSchema = z.object({ brief: siteBriefSchema }).strict();

const startSchema = z
  .object({
    ...formFields,
    /** Steps the person already went through: the brief they edited… */
    brief: siteBriefSchema.optional(),
    /** …the design direction they picked… */
    design: z.record(z.string(), z.unknown()).optional(),
    /** …and the sitemap they arranged. */
    sitemap: z
      .object({
        pages: z
          .array(
            z
              .object({
                title: text(100).min(1),
                slug: z.string().max(60).default(''),
                sections: z
                  .array(
                    z
                      .object({
                        category: z.string().min(1).max(100),
                        intent: text(300).default(''),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(MAX_SECTIONS),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_PAGES),
      })
      .strict()
      .optional(),
    changeset_uuid: z.string().uuid().optional(),
  })
  .strict();

/** How often a progress stream looks at the run when nothing in this process wakes it. */
const POLL_MS = 1000;
const KEEP_ALIVE_MS = 15_000;

function canSee(c: Context<AppEnv>, run: SiteRun): boolean {
  const user = c.get('user');
  return Boolean(user && (run.author === user.id || userCan(user, 'manage_options')));
}

async function loadRun(c: Context<AppEnv>): Promise<SiteRun | Response> {
  const id = Number(c.req.param('id'));
  const run = Number.isInteger(id) && id > 0 ? await getRun(c.get('kernel'), id) : undefined;
  if (!run || !canSee(c, run)) {
    return restError(c, 404, 'site_builder_run_not_found', 'There’s no run with that ID.');
  }
  return run;
}

const AI_OFF = 'AI isn’t set up on this site. Turn it on in Settings → AI.';

/** A guided step's failure as a REST error: the AI client's code and status, or the ability's. */
function stepError(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof AiError) {
    const message = error.code === 'prompt_prevented' ? AI_OFF : error.message;
    return restError(c, (error.status ?? 500) as 500, error.code, message);
  }
  if (error instanceof AbilityError) {
    return restError(c, (error.status ?? 400) as 400, error.code, error.message);
  }
  throw error;
}

/**
 * A guided step (#60): parse the body, check AI is on, run the step as
 * the person. Each is one structured request (two when the first answer
 * doesn't fit), counted against the daily cap and logged as its ability.
 */
function step<S extends z.ZodTypeAny>(
  schema: S,
  run: (kernel: Kernel, user: CurrentUser, body: z.infer<S>) => Promise<object>,
) {
  return async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    if (!user) return restError(c, 401, 'rest_not_logged_in', 'You are not currently logged in.');
    const parsed = schema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    if (!(await kernel.ai.supportsAi())) return restError(c, 503, 'prompt_prevented', AI_OFF);
    try {
      return c.json(await run(kernel, user, parsed.data));
    } catch (error) {
      return stepError(c, error);
    }
  };
}

export function siteBuilderRoutes() {
  const app = new Hono<AppEnv>({ strict: false });
  app.use(requireCapability('edit_theme_options'));

  /** Whether to offer the flow: AI on, who can turn it on, and a run in progress to resume. */
  app.get('/status', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const runs = user ? await listRuns(kernel, user.id, 5) : [];
    const active = runs.find((run) => run.status === 'queued' || run.status === 'running');
    return c.json({
      supports_ai: await kernel.ai.supportsAi(),
      can_manage_ai: Boolean(user && userCan(user, 'manage_options')),
      max_pages: MAX_PAGES,
      max_questions: MAX_QUESTIONS,
      active_run: active?.id ?? null,
    });
  });

  app.post(
    '/clarify',
    step(clarifySchema, async (kernel, user, input) => clarify(kernel, user, input)),
  );

  app.post(
    '/brief',
    step(briefSchema, async (kernel, user, { answers, ...input }) =>
      draftBrief(kernel, user, input, answers ?? []),
    ),
  );

  app.post(
    '/designs',
    step(designsSchema, async (kernel, user, { brief, shown }) => {
      const valid: DesignChoice[] = [];
      for (const choice of shown ?? []) {
        if (!validateJsonSchema(choice, DESIGN_CHOICE_SCHEMA, 'shown')) {
          valid.push(choice as unknown as DesignChoice);
        }
      }
      return designOptions(kernel, user, siteBriefSchema.parse(brief), valid);
    }),
  );

  app.post(
    '/sitemap',
    step(sitemapSchema, async (kernel, user, { brief }) =>
      draftSitemap(kernel, user, siteBriefSchema.parse(brief)),
    ),
  );

  app.post('/runs', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    if (!user) return restError(c, 401, 'rest_not_logged_in', 'You are not currently logged in.');
    const parsed = startSchema.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    const { brief, design, sitemap, changeset_uuid, ...input } = parsed.data;
    if (design) {
      const problem = validateJsonSchema(design, DESIGN_CHOICE_SCHEMA, 'design');
      if (problem)
        return restError(c, 400, 'rest_invalid_param', problem, { params: { design: problem } });
    }
    if (!(await kernel.ai.supportsAi())) {
      return restError(
        c,
        503,
        'prompt_prevented',
        'AI isn’t set up on this site. Turn it on in Settings → AI.',
      );
    }
    if (changeset_uuid) {
      try {
        await changesetFor(kernel, user, changeset_uuid, false);
      } catch (error) {
        if (!(error instanceof AbilityError)) throw error;
        return restError(c, (error.status ?? 400) as 400, error.code, error.message);
      }
    }
    const active = (await listRuns(kernel, user.id, 5)).find(
      (run) => run.status === 'queued' || run.status === 'running',
    );
    if (active) {
      return restError(c, 409, 'site_builder_run_active', 'A site is already being built.', {
        data: { status: 409, run: active.id },
      });
    }
    const run = await createRun(kernel, user.id, input, {
      brief: brief ?? null,
      design: (design as DesignChoice | undefined) ?? null,
      sitemap: sitemap ?? null,
      changeset_uuid: changeset_uuid ?? null,
    });
    const job = await kernel.jobs.enqueue(SITE_BUILDER_JOB, { runId: run.id });
    run.job_id = job?.id ?? null;
    await saveRun(kernel, run);
    return c.json(presentRun(run), 202);
  });

  app.get('/runs', async (c) => {
    const user = c.get('user');
    const runs = user ? await listRuns(c.get('kernel'), user.id) : [];
    return c.json(runs.map(presentRun));
  });

  app.get('/runs/:id', async (c) => {
    const found = await loadRun(c);
    if (found instanceof Response) return found;
    if (!(c.req.header('accept') ?? '').includes('text/event-stream')) {
      return c.json(presentRun(found));
    }
    const kernel = c.get('kernel');
    const id = found.id;
    let after = Number(c.req.header('last-event-id') ?? c.req.query('after') ?? 0) || 0;
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const closed = new AbortController();
      stream.onAbort(() => closed.abort());
      let lastWrite = Date.now();
      // First, where the run is now (no ID, so it doesn't move Last-Event-ID).
      await stream.writeSSE({
        event: 'snapshot',
        data: JSON.stringify(presentRun(found)),
        retry: 2000,
      });
      let run: SiteRun | undefined = found;
      while (run && !closed.signal.aborted) {
        for (const event of run.events) {
          if (event.id <= after) continue;
          await stream.writeSSE({
            id: String(event.id),
            event: event.type,
            data: JSON.stringify(event.data),
          });
          after = event.id;
          lastWrite = Date.now();
        }
        if (FINISHED_STATUSES.includes(run.status)) break;
        await waitForChange(id, POLL_MS, closed.signal);
        if (Date.now() - lastWrite > KEEP_ALIVE_MS) {
          await stream.write(': keep-alive\n\n');
          lastWrite = Date.now();
        }
        run = await getRun(kernel, id);
      }
    });
  });

  app.delete('/runs/:id', async (c) => {
    const kernel = c.get('kernel');
    const found = await loadRun(c);
    if (found instanceof Response) return found;
    if (FINISHED_STATUSES.includes(found.status)) return c.json(presentRun(found));
    // Not started yet: drop the job and close the run here. Running: the pipeline stops at its next step.
    if (found.status === 'queued' && found.job_id && (await kernel.jobs.cancel(found.job_id))) {
      found.status = 'cancelled';
      found.events.push({
        id: (found.events[found.events.length - 1]?.id ?? 0) + 1,
        type: 'done',
        data: { status: 'cancelled', tokens: found.tokens, requests: found.requests, error: null },
        at: new Date().toISOString(),
      });
      await saveRun(kernel, found);
      return c.json(presentRun(found));
    }
    await requestCancel(kernel, found.id);
    return c.json(presentRun(found), 202);
  });

  return app;
}
