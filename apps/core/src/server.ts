import { serve } from '@hono/node-server';
import { createApp } from './app';
import { PURGE_ACTION } from './cache/invalidation';
import { startRevalidationNotifier } from './cache/notifier';
import { CacheTag } from './cache/tags';
import { loadConfig } from './config';
import { Kernel } from './kernel';

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

// Scheduled posts go live on time even when every page is served from cache:
// what wp-cron's publish_future_post does, once a minute.
setInterval(() => {
  if (kernel.state === 'ready') kernel.posts.publishDue().catch((e) => console.error(e));
}, 60_000).unref();

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
