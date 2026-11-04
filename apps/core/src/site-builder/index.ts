import type { Job } from '../jobs/queue';
import type { Kernel } from '../kernel';
import { SITE_BRIEF_OPTION } from '../site-building/brief';
import { runPipeline, SITE_BUILDER_JOB } from './pipeline';
import { FINISHED_STATUSES, getRun, registerSiteRunPostType, saveRun } from './runs';

/**
 * The site builder (v0.8, #59): the `pressbase_site_run` post type, the
 * `pressbase/site-builder` job that runs the pipeline, and the brief as an
 * option a changeset may hold. Routes: routes/site-builder.ts.
 * See docs/architecture/site-builder.md.
 */

/** A run is one job; it isn't retried, which would spend the day's AI requests twice. */
const JOB_TIMEOUT_SECONDS = 30 * 60;

export function registerSiteBuilder(kernel: Kernel): void {
  registerSiteRunPostType(kernel);
  // The run saves the brief into its changeset, with the site's other changes.
  kernel.changesets.allowOption(SITE_BRIEF_OPTION);
  kernel.jobs.register<{ runId: number }>(
    SITE_BUILDER_JOB,
    async (data, { signal }) => {
      await runPipeline(kernel, data.runId, signal);
    },
    { maxAttempts: 1, timeoutSeconds: JOB_TIMEOUT_SECONDS },
  );
  // A run whose process died, or whose job failed outside the pipeline, says so.
  kernel.hooks.addAction('pressbase_job_failed', async (job: Job, error: unknown) => {
    if (job.name !== SITE_BUILDER_JOB) return;
    const id = (job.data as { runId?: number } | null)?.runId;
    const run = id ? await getRun(kernel, id) : undefined;
    if (!run || FINISHED_STATUSES.includes(run.status)) return;
    run.status = 'failed';
    run.stage = null;
    run.error = {
      code: 'site_builder_job_failed',
      message: error instanceof Error ? error.message : String(error),
    };
    run.events.push({
      id: (run.events[run.events.length - 1]?.id ?? 0) + 1,
      type: 'done',
      data: { status: run.status, tokens: run.tokens, requests: run.requests, error: run.error },
      at: new Date().toISOString(),
    });
    await saveRun(kernel, run);
  });
}

export { runPipeline, SITE_BUILDER_JOB } from './pipeline';
