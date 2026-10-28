import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { schema } from '@pressbase/db';
import { describe, expect, it } from 'vitest';
import { pluginAssetUrl } from './plugins/assets';
import { setup } from './test-utils';

/**
 * The plugin API's background work and public assets (v0.5):
 * api.cron and api.jobs (scoping, deactivation, uninstall cleanup) and
 * api.scripts / api.styles with the plugin's public/ files.
 * See docs/architecture/plugins.md and docs/architecture/jobs.md#plugins.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

async function writePlugin(ctx: Ctx, slug: string, files: Record<string, string>) {
  const dir = path.join(ctx.dataDir, 'plugins', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ name: slug, title: slug, version: '1.2.0', main: 'index.js' }),
  );
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

declare global {
  var __pluginLog: any[];
}

const WORKER = `
export default function register(api) {
  api.cron.addAction('tick', (n) => globalThis.__pluginLog.push(['tick', n]));
  api.cron.addAction('once', () => globalThis.__pluginLog.push(['once']));
  api.jobs.register('sync', (data) => {
    if (data.fail) throw new Error('Sync failed.');
    globalThis.__pluginLog.push(['sync', data.n]);
  }, { maxAttempts: 2, backoffSeconds: 1 });
}
export async function activate(api) {
  if (!(await api.cron.nextScheduled('tick', [1]))) {
    await api.cron.scheduleEvent(Math.floor(Date.now() / 1000), 'hourly', 'tick', [1]);
  }
  await api.jobs.enqueue('sync', { n: 1 });
}
export async function uninstall(api) {
  globalThis.__pluginLog.push(['uninstall', await api.cron.nextScheduled('tick', [1]) !== false]);
}
`;

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

async function jobRows(ctx: Ctx) {
  return (await ctx.kernel.db.select().from(schema.jobs)).filter(
    (job) => job.name.startsWith('worker/') || job.name === 'cron:worker',
  );
}

describe('api.cron and api.jobs', () => {
  it('prefix hooks, namespace jobs and run while the plugin is active', async () => {
    globalThis.__pluginLog = [];
    const ctx = await site();
    const { kernel } = ctx;
    await writePlugin(ctx, 'worker', { 'index.js': WORKER });
    await kernel.plugins.activate('worker');

    const api = kernel.plugins.runtime('worker')?.api;
    expect(api?.cron.hookName('tick')).toBe('worker_tick');
    expect(api?.cron.hookName('worker_tick')).toBe('worker_tick');
    expect(api?.jobs.name('sync')).toBe('worker/sync');
    expect(() => api?.cron.hookName('../x')).toThrow(/lowercase/);
    expect(() => api?.jobs.name('Sync Now')).toThrow(/lowercase/);

    // Core's cron (and the Scheduled tasks screen) sees the plugin's event.
    expect((await kernel.cron.events()).map((e) => e.hook)).toContain('worker_tick');
    expect(kernel.jobs.handlers()).toEqual(expect.arrayContaining(['worker/sync', 'cron:worker']));

    await kernel.jobs.runDue({ now: later(1) });
    expect(globalThis.__pluginLog).toEqual(
      expect.arrayContaining([
        ['tick', 1],
        ['sync', 1],
      ]),
    );
    // The recurring event was rescheduled under the plugin's own job name.
    expect(await api?.cron.nextScheduled('tick', [1])).toBeGreaterThan(Date.now() / 1000);

    // A failing handler is retried, and recorded against the plugin.
    await api?.jobs.enqueue('sync', { fail: true });
    expect(await kernel.jobs.runDue({ now: later(2) })).toMatchObject({ retried: 1 });
    const status = await kernel.plugins.status((await kernel.plugins.get('worker'))!);
    expect(status.runtimeErrors[0]?.during).toBe('job worker/sync');
    expect((await api?.jobs.list({ status: 'pending' }))?.map((j) => j.name)).toEqual([
      'worker/sync',
    ]);
  });

  it('keep a deactivated plugin’s work pending, run it on reactivation, and clear it on delete', async () => {
    globalThis.__pluginLog = [];
    const ctx = await site();
    const { kernel } = ctx;
    await writePlugin(ctx, 'worker', { 'index.js': WORKER });
    await kernel.plugins.activate('worker');
    await kernel.plugins.runtime('worker')?.api.cron.scheduleSingleEvent(later(30), 'once');
    await kernel.plugins.deactivate('worker');

    expect(kernel.jobs.handlers()).not.toContain('worker/sync');
    expect(kernel.jobs.handlers()).not.toContain('cron:worker');
    expect(kernel.hooks.hasAction('worker_tick')).toBe(false);

    // Due work waits: nothing runs, nothing fails.
    // (Core's own daily events may be due too; they complete.)
    expect(await kernel.jobs.runDue({ now: later(50) })).toMatchObject({ retried: 0, failed: 0 });
    expect(globalThis.__pluginLog).toEqual([]);
    const pending = await jobRows(ctx);
    expect(pending.map((j) => [j.name, j.status]).sort()).toEqual([
      ['cron:worker', 'pending'],
      ['cron:worker', 'pending'],
      ['worker/sync', 'pending'],
    ]);
    expect((await kernel.cron.events()).map((e) => e.hook)).toEqual(
      expect.arrayContaining(['worker_tick', 'worker_once']),
    );

    // Back on: overdue events run once, jobs run, the recurring event keeps going.
    await kernel.plugins.activate('worker');
    await kernel.jobs.runDue({ now: later(50) });
    expect(globalThis.__pluginLog).toEqual(
      expect.arrayContaining([['tick', 1], ['once'], ['sync', 1]]),
    );
    expect(globalThis.__pluginLog.filter((e) => e[0] === 'tick')).toHaveLength(1);

    // Deleting removes every job and event it left.
    await kernel.plugins.deactivate('worker');
    await kernel.jobs.enqueue('worker/sync', { n: 2 });
    expect((await jobRows(ctx)).length).toBeGreaterThan(0);
    await kernel.plugins.delete('worker');
    expect(globalThis.__pluginLog).toContainEqual(['uninstall', true]);
    expect(await jobRows(ctx)).toEqual([]);
  });

  it('scope a plugin’s cron to its own events', async () => {
    globalThis.__pluginLog = [];
    const ctx = await site();
    const { kernel } = ctx;
    await writePlugin(ctx, 'worker', { 'index.js': WORKER });
    await kernel.plugins.activate('worker');
    await kernel.cron.scheduleSingleEvent(later(5), 'worker_core_owned');
    const api = kernel.plugins.runtime('worker')?.api;
    // The same hook name scheduled by core is not the plugin's to see or clear.
    expect(await api?.cron.nextScheduled('core_owned')).toBe(false);
    expect(await api?.cron.unscheduleHook('core_owned')).toBe(0);
    expect(await kernel.cron.nextScheduled('worker_core_owned')).not.toBe(false);
  });
});

const ASSETS = `
export default function register(api) {
  api.styles.enqueue('worker-style', 'style.css');
  api.scripts.enqueue('worker-js', 'app.js', [], undefined, { inFooter: true, strategy: 'defer' });
  api.scripts.register('worker-cdn', 'https://cdn.example.com/lib.js', [], null);
  api.hooks.addAction('wp_enqueue_scripts', () => {
    // During a render: this page only, nothing to clean up.
    api.styles.enqueue('worker-page', './page.css');
  });
}
`;

async function render(ctx: Ctx, url: string) {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { html: string }).html;
}

describe('api.scripts, api.styles and public files', () => {
  it('serves an active plugin’s public/ files and prints its assets on public pages', async () => {
    const ctx = await site();
    const { kernel, app } = ctx;
    const dir = await writePlugin(ctx, 'worker', {
      'index.js': ASSETS,
      'public/app.js': 'console.log("hi");',
      'public/style.css': 'body{color:red}',
      'public/page.css': 'p{margin:0}',
      'public/img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'public/.env.js': 'secret',
      'public/notes.txt': 'not an allowed type',
      'secret.js': 'outside public',
    });
    await symlink(path.join(dir, 'secret.js'), path.join(dir, 'public', 'linked.js'));

    const get = (url: string) => app.request(url);
    expect((await get('/wp-content/plugins/worker/app.js')).status).toBe(404);

    await kernel.plugins.activate('worker');
    const js = await get('/wp-content/plugins/worker/app.js?ver=1.2.0');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000');
    expect(await js.text()).toBe('console.log("hi");');
    expect((await get('/wp-content/plugins/worker/app.js')).headers.get('cache-control')).toBe(
      'public, max-age=3600',
    );
    expect((await get('/wp-content/plugins/worker/style.css')).headers.get('content-type')).toBe(
      'text/css; charset=utf-8',
    );
    const svg = await get('/wp-content/plugins/worker/img/logo.svg');
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');

    for (const url of [
      '/wp-content/plugins/worker/../plugin.json',
      '/wp-content/plugins/worker/%2e%2e/secret.js',
      '/wp-content/plugins/worker/..%2Fsecret.js',
      '/wp-content/plugins/worker/img%2F..%2F..%2Fsecret.js',
      '/wp-content/plugins/worker/..%5Csecret.js',
      '/wp-content/plugins/worker/.env.js',
      '/wp-content/plugins/worker/notes.txt',
      '/wp-content/plugins/worker/linked.js',
      '/wp-content/plugins/worker/index.js',
      '/wp-content/plugins/worker/public/app.js',
      '/wp-content/plugins/daily-tips/index.js',
      '/wp-content/plugins/missing/app.js',
    ]) {
      expect((await get(url)).status, url).toBe(404);
    }

    const html = await render(ctx, '/');
    expect(html).toContain(
      "<link rel='stylesheet' id='worker-style-css' href='/wp-content/plugins/worker/style.css?ver=1.2.0' media='all' />",
    );
    expect(html).toContain(
      '<script src="/wp-content/plugins/worker/app.js?ver=1.2.0" id="worker-js-js" defer data-wp-strategy="defer"></script>',
    );
    expect(html).toContain('/wp-content/plugins/worker/page.css?ver=1.2.0');
    expect(kernel.scripts.is('worker-cdn', 'registered')).toBe(true);

    const purged: string[][] = [];
    kernel.hooks.addAction('pressbase_cache_purge', (tags) => {
      purged.push(tags);
    });
    await kernel.plugins.deactivate('worker');
    // Cached public pages carried its tags: they're purged.
    expect(purged).toContainEqual(['site']);
    expect(kernel.styles.is('worker-style', 'registered')).toBe(false);
    expect(kernel.scripts.is('worker-js', 'registered')).toBe(false);
    expect(kernel.scripts.is('worker-js', 'enqueued')).toBe(false);
    expect(kernel.scripts.is('worker-cdn', 'registered')).toBe(false);
    const after = await render(ctx, '/');
    expect(after).not.toContain('/wp-content/plugins/worker/');
    expect((await get('/wp-content/plugins/worker/app.js?ver=1.2.0')).status).toBe(404);
  });

  it('builds plugins_url() and refuses paths outside public/', () => {
    expect(pluginAssetUrl('worker', 'img/a b.png')).toBe(
      '/wp-content/plugins/worker/img/a%20b.png',
    );
    expect(pluginAssetUrl('worker', './public/app.js')).toBe('/wp-content/plugins/worker/app.js');
    for (const bad of ['../x.js', 'a/../../x.js', '.env', 'a\\b.js', '', 'a//b.js']) {
      expect(() => pluginAssetUrl('worker', bad), bad).toThrow();
    }
  });
});
