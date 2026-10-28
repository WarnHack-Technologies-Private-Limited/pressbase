import { schema } from '@pressbase/db';
import { eq, lt } from 'drizzle-orm';
import type { Post } from '../content/posts';
import type { Kernel } from '../kernel';

/**
 * The cron events core schedules, with WordPress's hook names where they exist:
 *
 * - `publish_future_post` (single, per post): publishes a scheduled post at its
 *   date. Scheduled when a `future` post is saved, moved when its date
 *   changes, cleared when it leaves `future` or is deleted
 *   (_future_post_hook(), check_and_publish_future_post(), wp-includes/post.php).
 * - `pressbase_delete_expired_sessions` (daily): removes expired login sessions
 *   (previously done on every login).
 * - `pressbase_prune_jobs` (daily): deletes old finished jobs (kernel.jobs.retention).
 *
 * The daily events are added on `init` when missing, as wp-admin/admin.php
 * does for wp_scheduled_delete. Pressbase doesn't empty the Trash on a
 * schedule yet, so there is no wp_scheduled_delete event.
 */

export const PUBLISH_FUTURE_POST = 'publish_future_post';

export const DAILY_EVENTS = ['pressbase_delete_expired_sessions', 'pressbase_prune_jobs'] as const;

declare module '@pressbase/hooks' {
  interface ActionRegistry {
    publish_future_post: [postId: number];
    pressbase_delete_expired_sessions: [];
    pressbase_prune_jobs: [];
  }
}

export function registerCoreEvents(kernel: Kernel): void {
  const { hooks, cron } = kernel;

  hooks.addAction(PUBLISH_FUTURE_POST, (postId) =>
    checkAndPublishFuturePost(kernel, Number(postId)),
  );

  // _future_post_hook(): every save of a scheduled post (re)schedules its event,
  // so a new date moves it.
  hooks.addAction(
    'save_post',
    async (_postId, post) => {
      const p = post as Post;
      if (p.status === 'future') await scheduleFuturePost(kernel, p);
    },
    5,
  );
  // _transition_post_status(): leaving `future` (published, back to draft, trashed) clears it.
  hooks.addAction('transition_post_status', async (newStatus, oldStatus, post) => {
    if (oldStatus === 'future' && newStatus !== 'future') {
      await cron.clearScheduledHook(PUBLISH_FUTURE_POST, [(post as Post).id]);
    }
  });
  // wp_delete_post()
  hooks.addAction('deleted_post', async (postId, post) => {
    if ((post as Post | undefined)?.status === 'future') {
      await cron.clearScheduledHook(PUBLISH_FUTURE_POST, [Number(postId)]);
    }
  });

  hooks.addAction('pressbase_delete_expired_sessions', async () => {
    await kernel.db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
  });
  hooks.addAction('pressbase_prune_jobs', async () => {
    await kernel.jobs.prune();
  });

  hooks.addAction('init', () => scheduleCoreEvents(kernel));
}

/** Schedules (or moves) a future post's publish_future_post event. */
export async function scheduleFuturePost(kernel: Kernel, post: Pick<Post, 'id' | 'date'>) {
  await kernel.cron.clearScheduledHook(PUBLISH_FUTURE_POST, [post.id]);
  // Rounded up, so the event never runs before the post's date.
  await kernel.cron.scheduleSingleEvent(
    Math.ceil(post.date.getTime() / 1000),
    PUBLISH_FUTURE_POST,
    [post.id],
  );
}

/**
 * check_and_publish_future_post(): publishes the post if it is still
 * scheduled; if its date moved later, schedules it again instead.
 */
export async function checkAndPublishFuturePost(kernel: Kernel, postId: number): Promise<void> {
  const post = await kernel.posts.get(postId);
  if (post?.status !== 'future') return;
  // Someone jumped the gun.
  if (post.date.getTime() > Date.now()) {
    await scheduleFuturePost(kernel, post);
    return;
  }
  await kernel.posts.publish(post.id);
}

/** Adds the daily events if they are missing, and events for scheduled posts that lack one. */
export async function scheduleCoreEvents(kernel: Kernel): Promise<void> {
  // Midnight UTC today: due now on first boot, then daily at midnight UTC; and
  // processes booting the same day schedule the same (deduplicated) event.
  const start = Math.floor(Date.now() / 86_400_000) * 86_400;
  for (const hook of DAILY_EVENTS) {
    if ((await kernel.cron.nextScheduled(hook)) === false) {
      await kernel.cron.scheduleEvent(start, 'daily', hook);
    }
  }
  // Posts scheduled before the queue existed.
  const future = await kernel.db
    .select({ id: schema.posts.id, date: schema.posts.date })
    .from(schema.posts)
    .where(eq(schema.posts.status, 'future'));
  for (const post of future) {
    if ((await kernel.cron.nextScheduled(PUBLISH_FUTURE_POST, [post.id])) === false) {
      await scheduleFuturePost(kernel, post);
    }
  }
}
