import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { schema } from '@pressbase/db';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config';
import { formatDebugInfo } from './site-health/debug-data';
import { overallStatus, RESULT_TRANSIENT, SCHEDULED_CHECK } from './site-health/service';
import { nodeEnvTest, nodeVersionTest } from './site-health/tests';
import type { DebugInfo, SiteHealthTestResult } from './site-health/types';
import { setup } from './test-utils';

/**
 * Site Health (v0.6): WP_Site_Health's tests, WP_Debug_Data's sections and
 * WP_REST_Site_Health_Controller's routes, adapted to Pressbase.
 * See docs/architecture/site-health.md.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site(overrides: Partial<Config> = {}) {
  const { setupToken, ...rest } = overrides;
  const ctx = await setup(rest);
  await ctx.install();
  // As if PRESSBASE_SETUP_TOKEN had stayed set after installing.
  if (setupToken) ctx.kernel.config.setupToken = setupToken;
  return ctx;
}

const find = (results: SiteHealthTestResult[], test: string) => {
  const found = results.find((r) => r.test === test);
  if (!found) throw new Error(`No result for ${test}`);
  return found;
};

async function status(ctx: Ctx) {
  const res = await ctx.request('GET', '/pressbase/v1/site-health');
  expect(res.status).toBe(200);
  return res.body as { direct: SiteHealthTestResult[]; async: { id: string; test: string }[] };
}

/** Replaces Site Health's outgoing requests with a function of the URL. */
function stubFetch(ctx: Ctx, answer: (url: string, init?: RequestInit) => Response | Error) {
  const calls: string[] = [];
  ctx.kernel.siteHealth.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    const result = answer(url, init);
    if (result instanceof Error) throw result;
    return result;
  };
  return calls;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('view_site_health_checks', () => {
  it('is granted with install_plugins, as wp_maybe_grant_site_health_caps() does', async () => {
    const ctx = await site();
    const me = await ctx.request('GET', '/wp/v2/users/me?context=edit');
    expect(me.body.capabilities.view_site_health_checks).toBe(true);

    const editor = await ctx.loginAs('ed', 'editor');
    expect((await editor.request('GET', '/pressbase/v1/site-health')).status).toBe(403);
    expect((await editor.request('GET', '/wp-site-health/v1/tests/https-status')).status).toBe(403);
    expect((await editor.request('GET', '/pressbase/v1/site-health/info')).status).toBe(403);
    expect((await editor.request('GET', '/wp-site-health/v1/directory-sizes')).status).toBe(403);

    const anonymous = ctx.client();
    const res = await anonymous.request('GET', '/pressbase/v1/site-health/result');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('rest_forbidden');
  });

  it('can be revoked from an administrator directly', async () => {
    const ctx = await site();
    await ctx.kernel.db
      .update(schema.usermeta)
      .set({ value: { administrator: true, view_site_health_checks: false } })
      .where(sql`${schema.usermeta.key} = 'capabilities'`);
    expect((await ctx.request('GET', '/pressbase/v1/site-health')).status).toBe(403);
  });
});

describe('GET /pressbase/v1/site-health', () => {
  it('runs the direct tests and lists the async ones at WordPress’s routes', async () => {
    const ctx = await site();
    const body = await status(ctx);
    for (const result of body.direct) {
      expect(['good', 'recommended', 'critical']).toContain(result.status);
      expect(result.label).toBeTruthy();
      expect(result.badge.label).toBeTruthy();
      expect(typeof result.description).toBe('string');
    }
    expect(body.direct.map((r) => r.test)).toEqual(
      expect.arrayContaining([
        'node_version',
        'node_env',
        'database_driver',
        'sql_server',
        'database_migrations',
        'application_passwords',
        'setup_token',
        'mail',
        'job_worker',
        'scheduled_events',
        'failed_jobs',
        'file_uploads',
        'available_disk_space',
        'image_processing',
        'plugin_errors',
        'inactive_plugins',
        'inactive_themes',
        'search_engine_visibility',
        'timezone',
        'autoloaded_options',
        'insecure_registration',
      ]),
    );
    expect(body.async).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'https_status',
          test: '/wp-site-health/v1/tests/https-status',
        }),
        expect.objectContaining({
          id: 'loopback_requests',
          test: '/wp-site-health/v1/tests/loopback-requests',
        }),
        expect.objectContaining({ id: 'page_cache', test: '/wp-site-health/v1/tests/page-cache' }),
        expect.objectContaining({
          id: 'pressbase_version',
          test: '/wp-site-health/v1/tests/pressbase-version',
        }),
      ]),
    );
  });

  it('flags the built-in database, the outbox and a missing worker, and passes the rest', async () => {
    const ctx = await site();
    // What a worker would have done by now: the daily events are due at midnight UTC.
    await ctx.kernel.jobs.runDue();
    const { direct } = await status(ctx);
    expect(find(direct, 'database_driver')).toMatchObject({
      status: 'recommended',
      label: 'Your site uses the built-in database',
    });
    expect(find(direct, 'sql_server').status).toBe('good');
    expect(find(direct, 'sql_server').label).toMatch(/^The built-in database runs PostgreSQL \d+/);
    expect(find(direct, 'mail').status).toBe('recommended');
    // Tests don't start the worker, and nothing is overdue.
    expect(find(direct, 'job_worker')).toMatchObject({
      status: 'recommended',
      label: 'This process doesn’t run background tasks',
    });
    for (const test of [
      'database_migrations',
      'setup_token',
      'scheduled_events',
      'failed_jobs',
      'file_uploads',
      'image_processing',
      'plugin_errors',
      'inactive_plugins',
      'inactive_themes',
      'search_engine_visibility',
      'timezone',
      'autoloaded_options',
      'insecure_registration',
      'application_passwords',
    ]) {
      expect(find(direct, test).status, test).toBe('good');
    }
  });

  it('is critical about the built-in database and the outbox in production', async () => {
    const ctx = await site();
    vi.stubEnv('NODE_ENV', 'production');
    const { direct } = await status(ctx);
    expect(find(direct, 'database_driver').status).toBe('critical');
    expect(find(direct, 'mail').status).toBe('critical');
    expect(find(direct, 'node_env').status).toBe('good');
  });

  it('notices the setup code, HTTP application passwords and open privileged registration', async () => {
    const ctx = await site({ setupToken: 'a-setup-code-for-tests' });
    vi.stubEnv('PRESSBASE_ALLOW_HTTP_APP_PASSWORDS', '1');
    await ctx.kernel.options.set('users_can_register', true);
    await ctx.kernel.options.set('default_role', 'editor');
    const { direct } = await status(ctx);
    expect(find(direct, 'setup_token')).toMatchObject({
      status: 'recommended',
      label: 'The setup code is still set',
      badge: { label: 'Security' },
    });
    expect(find(direct, 'application_passwords').status).toBe('recommended');
    expect(find(direct, 'insecure_registration').status).toBe('critical');
    // The code itself is never shown.
    expect(JSON.stringify(direct)).not.toContain('a-setup-code-for-tests');
  });

  it('notices search engines discouraged and a time zone that is missing', async () => {
    const ctx = await site();
    await ctx.request('POST', '/wp/v2/settings', { blog_public: false });
    await ctx.kernel.options.delete('timezone_string');
    const { direct } = await status(ctx);
    expect(find(direct, 'search_engine_visibility')).toMatchObject({
      status: 'recommended',
      badge: { label: 'Privacy' },
    });
    expect(find(direct, 'search_engine_visibility').actions).toContain('/admin/settings/reading');
    expect(find(direct, 'timezone').status).toBe('recommended');
  });

  it('reports late scheduled events, overdue work without a worker, and failed jobs', async () => {
    const ctx = await site();
    const { kernel } = ctx;
    // A cron event due ten minutes ago that nobody ran.
    await kernel.cron.scheduleSingleEvent(Math.floor(Date.now() / 1000) - 600, 'site_health_probe');
    kernel.jobs.register('test/broken', () => {
      throw new Error('Broken on purpose.\nstack');
    });
    await kernel.jobs.enqueue('test/broken', {}, { maxAttempts: 1 });
    await kernel.jobs.runDue({ now: new Date() });
    // runDue ran the probe too; schedule another overdue one.
    await kernel.cron.scheduleSingleEvent(Math.floor(Date.now() / 1000) - 600, 'site_health_late');

    const { direct } = await status(ctx);
    expect(find(direct, 'scheduled_events')).toMatchObject({
      status: 'recommended',
      label: 'A scheduled event didn’t run',
    });
    expect(find(direct, 'scheduled_events').description).toContain('site_health_late');
    expect(find(direct, 'job_worker')).toMatchObject({
      status: 'critical',
      label: 'Background tasks aren’t running',
    });
    const failed = find(direct, 'failed_jobs');
    expect(failed).toMatchObject({
      status: 'recommended',
      label: 'A background task failed recently',
    });
    expect(failed.description).toContain('Broken on purpose.');
    expect(failed.description).not.toContain('stack');
  });

  it('flags database updates that haven’t been applied', async () => {
    const ctx = await site();
    await ctx.kernel.db.execute(
      sql`delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`,
    );
    const { direct } = await status(ctx);
    const result = find(direct, 'database_migrations');
    expect(result.status).toBe('critical');
    expect(result.description).toContain('0002_ai_requests');
  });

  it('recommends removing inactive plugins and themes from the data directory', async () => {
    const ctx = await site();
    const plugin = path.join(ctx.dataDir, 'plugins', 'unused-widget');
    await mkdir(plugin, { recursive: true });
    await writeFile(
      path.join(plugin, 'plugin.json'),
      JSON.stringify({
        name: 'unused-widget',
        title: 'Unused Widget',
        version: '1.0.0',
        main: 'index.js',
      }),
    );
    await writeFile(path.join(plugin, 'index.js'), 'export default function register() {}');
    const theme = path.join(ctx.dataDir, 'themes', 'spare-theme');
    await mkdir(path.join(theme, 'templates'), { recursive: true });
    await writeFile(path.join(theme, 'style.css'), '/*\nTheme Name: Spare Theme\nVersion: 1.0\n*/');
    await writeFile(path.join(theme, 'templates', 'index.html'), '<!-- wp:post-content /-->');

    const { direct } = await status(ctx);
    expect(find(direct, 'inactive_plugins')).toMatchObject({
      status: 'recommended',
      label: 'You should remove inactive plugins',
      badge: { label: 'Security' },
    });
    expect(find(direct, 'inactive_themes')).toMatchObject({
      status: 'recommended',
      label: 'You should remove inactive themes',
    });
    expect(find(direct, 'inactive_themes').description).toContain('Spare Theme');
  });

  it('reports plugins stopped by an error', async () => {
    const ctx = await site();
    await ctx.kernel.options.set('pressbase_plugin_errors', {
      'broken-thing': {
        message: 'Cannot find module',
        during: 'load',
        time: new Date().toISOString(),
      },
    });
    const { direct } = await status(ctx);
    const result = find(direct, 'plugin_errors');
    expect(result.status).toBe('critical');
    expect(result.description).toContain('broken-thing');
  });
});

describe('async tests: /wp-site-health/v1/tests/{test}', () => {
  it('https-status: an http:// site address is recommended to move to HTTPS', async () => {
    const ctx = await site();
    const res = await ctx.request('GET', '/wp-site-health/v1/tests/https-status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      test: 'https_status',
      status: 'recommended',
      label: 'Your website does not use HTTPS',
      badge: { label: 'Security', color: 'blue' },
    });

    await ctx.kernel.options.set('home', 'https://example.com');
    await ctx.kernel.options.set('siteurl', 'https://example.com');
    const secure = await ctx.request('GET', '/wp-site-health/v1/tests/https-status');
    expect(secure.body.status).toBe('good');
  });

  it('answers 404 for a test that doesn’t exist', async () => {
    const ctx = await site();
    const res = await ctx.request('GET', '/wp-site-health/v1/tests/not-a-test');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('rest_no_route');
  });

  it('loopback-requests: reaches core through the site address and the public site', async () => {
    const ctx = await site({ webUrls: ['http://web.internal:3001'] });
    const calls = stubFetch(ctx, (url) =>
      url.endsWith('/robots.txt')
        ? new Response('User-agent: *\nDisallow: /admin/\n')
        : Response.json({ name: 'Test Site', pressbase: { version: '0.1.0' } }),
    );
    const ok = await ctx.request('GET', '/wp-site-health/v1/tests/loopback-requests');
    expect(ok.body).toMatchObject({
      status: 'good',
      label: 'Your site can perform loopback requests',
    });
    expect(calls).toEqual([
      'http://localhost:3000/wp-json/',
      'http://web.internal:3001/robots.txt',
    ]);

    stubFetch(ctx, (url) =>
      url.endsWith('/robots.txt')
        ? Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
        : Response.json({ pressbase: {} }),
    );
    const failed = await ctx.request('GET', '/wp-site-health/v1/tests/loopback-requests');
    expect(failed.body).toMatchObject({
      status: 'critical',
      label: 'Your site could not complete a loopback request',
    });
    expect(failed.body.description).toContain('ECONNREFUSED');
  });

  it('page-cache: off without a secret; checks apps/web accepts core’s purges', async () => {
    const off = await site();
    const res = await off.request('GET', '/wp-site-health/v1/tests/page-cache');
    expect(res.body).toMatchObject({ status: 'recommended', label: 'Page caching is off' });

    const ctx = await site({
      revalidate: { urls: ['http://web.internal:3001'], secret: 'a-very-long-shared-secret' },
    });
    let answer = 200;
    const sent: RequestInit[] = [];
    const calls = stubFetch(ctx, (_url, init) => {
      sent.push(init ?? {});
      return Response.json({ purged: 0 }, { status: answer });
    });
    const good = await ctx.request('GET', '/wp-site-health/v1/tests/page-cache');
    expect(good.body).toMatchObject({ status: 'good', label: 'Page caching is on' });
    expect(calls).toEqual(['http://web.internal:3001/_pressbase/revalidate']);
    expect((sent[0]?.headers as Record<string, string> | undefined)?.authorization).toBe(
      'Bearer a-very-long-shared-secret',
    );
    // The secret is used, never shown.
    expect(JSON.stringify(good.body)).not.toContain('a-very-long-shared-secret');

    answer = 401;
    const mismatch = await ctx.request('GET', '/wp-site-health/v1/tests/page-cache');
    expect(mismatch.body.status).toBe('critical');
    answer = 404;
    const webOff = await ctx.request('GET', '/wp-site-health/v1/tests/page-cache');
    expect(webOff.body).toMatchObject({
      status: 'recommended',
      label: 'The public site doesn’t cache pages',
    });
  });

  it('pressbase-version: compares with GitHub’s latest release, cached', async () => {
    const ctx = await site();
    const calls = stubFetch(ctx, () =>
      Response.json({
        tag_name: 'v99.0.0',
        html_url: 'https://github.com/example/releases/v99.0.0',
      }),
    );
    const res = await ctx.request('GET', '/wp-site-health/v1/tests/pressbase-version');
    expect(res.body).toMatchObject({
      status: 'recommended',
      label: 'Pressbase 99.0.0 is available',
    });
    expect(res.body.actions).toContain('https://github.com/example/releases/v99.0.0');
    await ctx.request('GET', '/wp-site-health/v1/tests/pressbase-version');
    expect(calls).toHaveLength(1);
  });

  it('pressbase-version: stays calm offline, and makes no request when turned off', async () => {
    const ctx = await site();
    const offline = await ctx.request('GET', '/wp-site-health/v1/tests/pressbase-version');
    expect(offline.body.status).toBe('good');
    expect(offline.body.description).toContain('couldn’t check GitHub');

    const other = await site();
    vi.stubEnv('PRESSBASE_UPDATE_CHECK', 'off');
    const calls = stubFetch(other, () => Response.json({ tag_name: 'v99.0.0' }));
    const res = await other.request('GET', '/wp-site-health/v1/tests/pressbase-version');
    expect(res.body.status).toBe('good');
    expect(calls).toHaveLength(0);
  });
});

describe('extensibility', () => {
  it('site_status_tests adds direct and async tests; async ones get a route', async () => {
    const ctx = await site();
    ctx.kernel.hooks.addFilter('site_status_tests', (tests) => {
      tests.direct.example_backups = {
        label: 'Backups',
        test: () => ({
          label: 'Backups are recent',
          status: 'good',
          badge: { label: 'Security', color: 'blue' },
          description: '<p>The last backup ran today.</p><script>alert(1)</script>',
          actions: '',
          test: 'example_backups',
        }),
      };
      tests.async.example_remote = {
        label: 'Remote service',
        async_direct_test: () => ({
          label: 'The remote service answers',
          status: 'recommended',
          badge: { label: 'Performance', color: 'orange' },
          description: '<p>It is slow.</p>',
          actions: '',
          test: 'example_remote',
        }),
      };
      delete tests.direct.timezone;
      return tests;
    });
    const body = await status(ctx);
    const backups = find(body.direct, 'example_backups');
    expect(backups.description).toBe('<p>The last backup ran today.</p>');
    expect(body.direct.some((r) => r.test === 'timezone')).toBe(false);
    expect(body.async).toContainEqual(
      expect.objectContaining({
        id: 'example_remote',
        test: '/wp-site-health/v1/tests/example-remote',
      }),
    );
    const remote = await ctx.request('GET', '/wp-site-health/v1/tests/example-remote');
    expect(remote.body).toMatchObject({ status: 'recommended', badge: { color: 'orange' } });
  });

  it('a test that throws or returns nonsense becomes “A test is unavailable”', async () => {
    const ctx = await site();
    ctx.kernel.hooks.addFilter('site_status_tests', (tests) => {
      tests.direct.example_throws = {
        label: 'Throws',
        test: () => {
          throw new Error('Database exploded.');
        },
      };
      tests.direct.example_nonsense = {
        label: 'Nonsense',
        test: () => ({ nope: true }) as unknown as SiteHealthTestResult,
      };
      return tests;
    });
    const { direct } = await status(ctx);
    expect(find(direct, 'example_throws')).toMatchObject({
      label: 'A test is unavailable',
      status: 'recommended',
      badge: { label: 'Unavailable', color: 'red' },
    });
    expect(find(direct, 'example_throws').description).toContain('Database exploded.');
    expect(find(direct, 'example_nonsense').label).toBe('A test is unavailable');
  });

  it('site_status_test_result changes results, including async ones', async () => {
    const ctx = await site();
    ctx.kernel.hooks.addFilter('site_status_test_result', (result) =>
      result.test === 'mail' || result.test === 'https_status'
        ? { ...result, status: 'good' as const, label: `${result.test} handled by the host` }
        : result,
    );
    const { direct } = await status(ctx);
    expect(find(direct, 'mail')).toMatchObject({
      status: 'good',
      label: 'mail handled by the host',
    });
    const https = await ctx.request('GET', '/wp-site-health/v1/tests/https-status');
    expect(https.body.label).toBe('https_status handled by the host');
  });

  it('site_health_test_rest_capability_{check} changes who may run a test', async () => {
    const ctx = await site();
    ctx.kernel.hooks.addFilter('site_health_test_rest_capability_https_status', () => 'edit_posts');
    const editor = await ctx.loginAs('ed', 'editor');
    expect((await editor.request('GET', '/wp-site-health/v1/tests/https-status')).status).toBe(200);
    expect((await editor.request('GET', '/wp-site-health/v1/tests/page-cache')).status).toBe(403);
  });

  it('plugins add tests and information through their hooks', async () => {
    const ctx = await site();
    const dir = path.join(ctx.dataDir, 'plugins', 'health-extra');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'plugin.json'),
      JSON.stringify({
        name: 'health-extra',
        title: 'Health Extra',
        version: '1.0.0',
        main: 'index.js',
      }),
    );
    await writeFile(
      path.join(dir, 'index.js'),
      `export default function register(api) {
  api.hooks.addFilter('site_status_tests', (tests) => {
    tests.direct.health_extra_check = {
      label: 'Extra',
      test: () => ({ label: 'Extra is fine', status: 'good', badge: { label: 'Performance', color: 'blue' },
        description: '<p>Fine.</p>', actions: '', test: 'health_extra_check' }),
    };
    return tests;
  });
  api.hooks.addFilter('debug_information', (info) => {
    info['health-extra'] = { label: 'Health Extra', fields: {
      api_key: { label: 'API key', value: 'shown-on-screen-only', private: true },
      mode: { label: 'Mode', value: 'live' },
    } };
    return info;
  });
}`,
    );
    await ctx.kernel.plugins.activate('health-extra');
    const { direct } = await status(ctx);
    expect(find(direct, 'health_extra_check').label).toBe('Extra is fine');
    const info = await ctx.request('GET', '/pressbase/v1/site-health/info');
    expect(info.body.info['health-extra'].fields.api_key.value).toBe('shown-on-screen-only');
    expect(info.body.copy).toContain('### health-extra ###');
    expect(info.body.copy).toContain('mode: live');
    expect(info.body.copy).not.toContain('shown-on-screen-only');
  });
});

describe('the saved result and the weekly check', () => {
  it('saves the Status tab’s counts for the Dashboard, as a transient that purges nothing', async () => {
    const ctx = await site();
    expect((await ctx.request('GET', '/pressbase/v1/site-health/result')).body).toBeNull();
    const purges: string[][] = [];
    ctx.kernel.hooks.addAction('pressbase_cache_purge', (tags) => {
      purges.push(tags);
    });

    const bad = await ctx.request('POST', '/pressbase/v1/site-health/result', {
      counts: { good: -1 },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('rest_invalid_param');

    const saved = await ctx.request('POST', '/pressbase/v1/site-health/result', {
      counts: { good: 18, recommended: 4, critical: 0 },
    });
    expect(saved.status).toBe(200);
    const res = await ctx.request('GET', '/pressbase/v1/site-health/result');
    expect(res.body).toMatchObject({
      good: 18,
      recommended: 4,
      critical: 0,
      status: 'good',
      score: 90,
    });
    expect(Date.parse(res.body.time)).toBeGreaterThan(Date.now() - 60_000);
    expect(await ctx.kernel.options.get(`_transient_${RESULT_TRANSIENT}`)).toBeTruthy();
    expect(purges).toEqual([]);

    const editor = await ctx.loginAs('ed', 'editor');
    const denied = await editor.request('POST', '/pressbase/v1/site-health/result', {
      counts: { good: 1, recommended: 0, critical: 0 },
    });
    expect(denied.status).toBe(403);
  });

  it('schedules wp_site_health_scheduled_check weekly, and the check saves counts', async () => {
    const ctx = await site();
    expect(await ctx.kernel.cron.getSchedule(SCHEDULED_CHECK)).toBe('weekly');
    const next = await ctx.kernel.cron.nextScheduled(SCHEDULED_CHECK);
    expect(next).toBeGreaterThan(Date.now() / 1000 + 86_000);

    await ctx.kernel.hooks.doAction(SCHEDULED_CHECK);
    const res = await ctx.request('GET', '/pressbase/v1/site-health/result');
    // Direct tests and the async tests' direct versions all ran.
    expect(res.body.good + res.body.recommended + res.body.critical).toBeGreaterThanOrEqual(25);
    expect(res.body.status).toMatch(/^(good|should_be_improved)$/);
  });

  it('works out the overall rating as site-health.js does', () => {
    expect(overallStatus({ good: 20, recommended: 0, critical: 0 })).toEqual({
      score: 100,
      status: 'good',
    });
    expect(overallStatus({ good: 10, recommended: 4, critical: 0 })).toEqual({
      score: 85,
      status: 'good',
    });
    // Any critical issue means "Should be improved", whatever the score.
    expect(overallStatus({ good: 30, recommended: 0, critical: 1 }).status).toBe(
      'should_be_improved',
    );
    expect(overallStatus({ good: 2, recommended: 8, critical: 0 })).toEqual({
      score: 60,
      status: 'should_be_improved',
    });
    expect(overallStatus({ good: 0, recommended: 0, critical: 0 }).score).toBe(100);
  });
});

describe('GET /pressbase/v1/site-health/info', () => {
  it('returns WP_Debug_Data’s sections, adapted', async () => {
    const ctx = await site();
    const res = await ctx.request('GET', '/pressbase/v1/site-health/info');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.info)).toEqual([
      'wp-core',
      'wp-paths-sizes',
      'wp-active-theme',
      'wp-themes-inactive',
      'wp-plugins-active',
      'wp-plugins-inactive',
      'wp-media',
      'wp-server',
      'wp-database',
      'wp-constants',
      'pressbase-environment',
      'wp-filesystem',
    ]);
    const { info } = res.body;
    expect(info['wp-core'].fields.version.value).toBe('0.1.0');
    expect(info['wp-active-theme'].fields.name.value).toContain('twentytwentyfive');
    expect(info['wp-server'].fields.node_version.value).toBe(process.versions.node);
    expect(info['wp-database'].fields.extension.debug).toBe('pglite');
    expect(info['wp-filesystem'].fields.data.value).toBe('Writable');
    expect(info['wp-paths-sizes'].fields.uploads_size.debug).toBe('loading...');
    expect(info['wp-plugins-inactive'].show_count).toBe(true);
  });

  it('never includes secret values, and leaves private ones out of the copied text', async () => {
    const ctx = await site({
      setupToken: 'setup-code-XYZ123',
      revalidate: { urls: ['http://web.internal:3001'], secret: 'revalidate-secret-ABC987' },
      mail: {
        smtpUrl: 'smtps://mailer:smtp-pass-QRS456@smtp.example.com:465',
        from: 'Site <site@example.com>',
      },
    });
    vi.stubEnv('PRESSBASE_SMTP_PASS', 'env-pass-LMN654');
    vi.stubEnv('PRESSBASE_CUSTOM_THING', 'custom-value-DEF321');
    const res = await ctx.request('GET', '/pressbase/v1/site-health/info');
    const json = JSON.stringify(res.body);
    for (const secret of [
      'setup-code-XYZ123',
      'revalidate-secret-ABC987',
      'smtp-pass-QRS456',
      'env-pass-LMN654',
      'custom-value-DEF321',
      'pglite:memory',
    ]) {
      expect(json).not.toContain(secret);
    }
    const env = res.body.info['pressbase-environment'].fields;
    expect(env.PRESSBASE_SMTP_PASS.value).toBe('Set');
    expect(env.PRESSBASE_CUSTOM_THING.value).toBe('Set');

    const constants = res.body.info['wp-constants'].fields;
    expect(constants.SMTP_HOST).toMatchObject({ value: 'smtp.example.com', private: true });
    expect(res.body.copy).not.toContain('smtp.example.com');
    expect(res.body.copy).not.toContain('site@example.com');
    expect(res.body.copy).not.toContain('http://localhost:3000');
    expect(res.body.copy).toContain('### wp-core ###');
    expect(res.body.copy).toContain('version: 0.1.0');
  });

  it('directory-sizes: sizes for the Info tab', async () => {
    const ctx = await site();
    const res = await ctx.request('GET', '/wp-site-health/v1/directory-sizes');
    expect(res.status).toBe(200);
    for (const key of [
      'data_size',
      'uploads_size',
      'themes_size',
      'plugins_size',
      'database_size',
      'total_size',
    ]) {
      expect(res.body[key].raw, key).toBeGreaterThanOrEqual(0);
      expect(res.body[key].size, key).toMatch(/B$/);
    }
    expect(res.body.database_size.raw).toBeGreaterThan(0);
  });
});

describe('helpers', () => {
  it('rates Node.js versions', () => {
    expect(nodeVersionTest('24.15.0').status).toBe('good');
    expect(nodeVersionTest('22.12.0').status).toBe('good');
    expect(nodeVersionTest('22.11.0').status).toBe('critical');
    expect(nodeVersionTest('20.18.1').status).toBe('critical');
    expect(nodeVersionTest('25.1.0').status).toBe('recommended');
  });

  it('rates NODE_ENV', () => {
    expect(nodeEnvTest('production').status).toBe('good');
    expect(nodeEnvTest(undefined).status).toBe('recommended');
    expect(nodeEnvTest('development').description).toContain('<code>development</code>');
  });

  it('formats the copied text like WP_Debug_Data::format()', () => {
    const info: DebugInfo = {
      'wp-core': {
        label: 'Pressbase',
        fields: {
          version: { label: 'Version', value: '0.1.0' },
          home_url: { label: 'Home URL', value: 'https://example.com', private: true },
          https: { label: 'HTTPS?', value: 'Yes', debug: true },
          empty: { label: 'Empty', value: '' },
          zero: { label: 'Zero string', value: '0' },
          sizes: { label: 'Image sizes', value: { thumbnail: '150×150', medium: '300×300' } },
        },
      },
      'secret-section': {
        label: 'Secret',
        private: true,
        fields: { key: { label: 'Key', value: 'k' } },
      },
      'wp-plugins-active': {
        label: 'Active Plugins',
        show_count: true,
        fields: { a: { label: 'A', value: 'Version 1' } },
      },
      'no-fields': { label: 'Nothing', fields: {} },
    };
    expect(formatDebugInfo(info, 'debug')).toBe(
      '`\n### wp-core ###\n\nversion: 0.1.0\nhttps: true\nempty: undefined\nzero: 0\nsizes: \n\tthumbnail: 150×150\n\tmedium: 300×300\n\n### wp-plugins-active (1) ###\n\na: Version 1\n\n`',
    );
    expect(formatDebugInfo(info, 'info')).toContain(
      '### Pressbase ###\n\nVersion: 0.1.0\nHTTPS?: Yes\n',
    );
  });
});
