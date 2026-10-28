// Compiled by `pnpm typecheck` (never run): how a plugin uses the SDK. A type
// error here means the generated types are broken or the API changed shape.
import {
  allowAnyone,
  defineLifecycle,
  defineManifest,
  definePlugin,
  defineRoute,
  type FilterValue,
  type PluginApi,
  requireCapability,
  restError,
} from '../src/index';

declare module '../src/index' {
  interface FilterRegistry {
    usage_test_greeting: [greeting: string, name: string];
  }
}

export const manifest = defineManifest({
  name: 'usage-test',
  title: 'Usage test',
  version: '1.0.0',
  permissions: ['database'],
  migrations: 'migrations',
});

export default definePlugin((api) => {
  // Hooks core declares are typed: `robots` is a record of directives.
  api.hooks.addFilter('wp_robots', (robots) => ({ ...robots, 'max-snippet': '-1' }));
  // @ts-expect-error: a filter returns the type it was given.
  api.hooks.addFilter('wp_robots', () => 42);
  // @ts-expect-error: the plugin's own hook is typed too.
  api.hooks.addFilter('usage_test_greeting', (greeting: number) => greeting);
  // Hooks core doesn't declare yet take unknown arguments.
  api.hooks.addFilter('the_title', (title) => String(title).trim());
  api.hooks.addAction('wp_head', (out, page) => {
    out.print(`<meta name="usage" content="${page.main.is404 ? '404' : 'ok'}" />`);
  });
  api.hooks.addAction('pressbase_job_failed', (job, _error, retrying) => {
    api.logger.warn(job.name, retrying);
  });
  // The plugin's own hook, typed through declaration merging.
  api.hooks.addFilter('usage_test_greeting', (greeting, name) => `${greeting}, ${name}`);
  const greeting: FilterValue<'usage_test_greeting'> = 'hello';

  api.rest.registerRoute(
    'usage-test/v1',
    '/hello',
    defineRoute({
      permission: allowAnyone,
      handler: async (c) => {
        const name = c.req.query('name');
        if (!name) return restError(400, 'usage_test_missing_name', 'Say who to greet.');
        return { greeting: await api.hooks.applyFilters('usage_test_greeting', greeting, name) };
      },
    }),
  );
  api.rest.registerRoute('usage-test/v1', '/admin', {
    methods: ['POST'],
    permission: requireCapability(api, 'manage_options'),
    handler: (c) => ({ user: api.rest.currentUser(c)?.login ?? null }),
  });

  api.cron.addAction('cleanup', (days: number) => api.logger.info(days));
  api.jobs.register<{ url: string }>('fetch', async (data, { signal, attempt }) => {
    api.logger.debug(data.url.length, signal.aborted, attempt);
  });
  api.scripts.enqueue('usage-test', 'app.js', [], undefined, { inFooter: true, strategy: 'defer' });
  api.styles.enqueue('usage-test', 'style.css');
  api.assets.url('logo.svg');
});

export const activate = defineLifecycle(async (api: PluginApi) => {
  await api.cron.scheduleEvent(Date.now() / 1000, 'daily', 'cleanup', [30]);
  const job = await api.jobs.enqueue('fetch', { url: 'https://example.com' }, { maxAttempts: 5 });
  api.logger.info(job?.id);
  const posts = await api.content.query({ post_type: 'post', posts_per_page: 5 });
  api.logger.info(posts.posts.map((p) => p.title));
  await api.db?.exec('select 1');
});

export const uninstall = defineLifecycle(async (api) => {
  await api.cron.unscheduleHook('cleanup');
  await api.options.delete('greeting');
});

// v0.7: registered meta, early request hooks, head output, the cache, files, tables.
export const seo = definePlugin((api) => {
  api.meta.registerPostMeta('', '_yoast_wpseo_title', {
    type: 'string',
    single: true,
    showInRest: true,
    authCallback: (allowed, _key, postId) => allowed || postId > 0,
  });
  // @ts-expect-error: not a meta type.
  api.meta.register('post', 'x', { type: 'date' });
  api.hooks.addAction('template_redirect', async (request) => {
    if (request.path === '/old/') request.redirect('/new/', 301);
    if ((await request.main()).is404) request.notFound(410);
  });
  api.hooks.addAction('pressbase_404', ({ path, referrer }) => api.logger.info(path, referrer));
  api.hooks.addFilter('pre_handle_404', (preempt, _main, url) => preempt || url.pathname === '/v/');
  api.hooks.addFilter('get_canonical_url', (url, post) => `${url}#${post.id}`);
  api.hooks.removeAction('wp_head', 'rel_canonical');
  api.public.addFile('/llms.txt', () => ({ body: '# Site', contentType: 'text/markdown' }));
  api.cache.addTags(api.cache.pathTag('/llms.txt'));
  void api.cache.purgePaths(['/old/']);
  void api.db?.query<{ id: number }>(api.db.sql`select 1 as id`);
});
