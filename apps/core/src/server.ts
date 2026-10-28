import { serve } from '@hono/node-server';
import { createApp } from './app';
import { PURGE_ACTION } from './cache/invalidation';
import { startRevalidationNotifier } from './cache/notifier';
import { CacheTag } from './cache/tags';
import { loadConfig } from './config';
import { Kernel } from './kernel';

// Named in the built-in database's lock file, so `pressbase` can say who holds it.
process.env.PRESSBASE_PROCESS ??= 'the Pressbase server';
const config = await loadConfig();
const kernel = new Kernel(config);
await kernel.boot();

// Public page caching: tell apps/web which cached pages a change made stale
// (docs/adr/0008-public-page-caching.md).
if (config.revalidate) {
  startRevalidationNotifier(kernel, config.revalidate);
  // A restart may bring new code, themes or plugins: pages cached by the
  // previous process are out of date.
  void kernel.hooks.doAction(PURGE_ACTION, [CacheTag.site], 'boot');
}

// The job queue worker runs cron events (publish_future_post, daily chores)
// and plugin jobs on time. PRESSBASE_WORKER=off leaves that to other
// processes (docs/architecture/jobs.md).
if (config.worker !== false) kernel.jobs.start();

const server = serve({ fetch: createApp(kernel).fetch, port: config.port }, (info) => {
  console.log(`Pressbase core listening on http://localhost:${info.port} (${kernel.state})`);
  if (kernel.state !== 'ready') {
    console.log('Open the admin app to finish installing Pressbase.');
  }
});

async function shutdown() {
  server.close();
  await kernel.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
