import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { Kernel } from './kernel';

const config = await loadConfig();
const kernel = new Kernel(config);
await kernel.boot();

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
