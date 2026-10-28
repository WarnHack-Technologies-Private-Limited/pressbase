import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSetting, settingSchema } from './plugins/admin';
import { parseManifest } from './plugins/manifest';
import { setup } from './test-utils';

/**
 * Plugin admin extensions (v0.5): the Settings API (api.settings and
 * plugin.json's admin.settings), admin pages and their capabilities,
 * /pressbase/v1/admin-extensions, /pressbase/v1/plugin-pages and the
 * browser modules served from /wp-content/plugins/. See ADR 0011.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

/** Writes a plugin into the site's plugins folder. */
async function writePlugin(
  ctx: Ctx,
  name: string,
  files: Record<string, string>,
  manifest: Record<string, unknown> = {},
) {
  const dir = path.join(ctx.dataDir, 'plugins', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ name, title: name, version: '1.0.0', main: 'index.js', ...manifest }),
  );
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
}

async function activate(ctx: Ctx, name: string, permissions: string[] = []) {
  return ctx.request('PUT', `/wp/v2/plugins/${name}`, { status: 'active', permissions });
}

const asset = (ctx: Ctx, url: string, init?: RequestInit) => ctx.app.request(url, init);

describe('setting definitions', () => {
  const context = { prefix: 'demo_', permissions: [] as const };

  it('fills in the control, type, option name and default', () => {
    const toggle = resolveSetting('demo', 'enabled', { type: 'boolean' }, context);
    expect(toggle).toMatchObject({ control: 'toggle', option: 'demo_enabled', default: false });
    const select = resolveSetting(
      'demo',
      'size',
      {
        control: 'select',
        options: [
          { value: 1, label: 'One' },
          { value: 2, label: 'Two' },
        ],
      },
      context,
    );
    expect(select).toMatchObject({ type: 'integer', default: 1, page: 'demo', section: 'default' });
    expect(resolveSetting('demo', 'colour', { control: 'color' }, context).default).toBe('');
  });

  it('refuses mistakes with a message that names the setting', () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['Bad Name', {}, /lowercase/],
      ['x', { control: 'slider' }, /unknown control/],
      ['x', { type: 'boolean', control: 'text' }, /can’t edit/],
      ['x', { control: 'select' }, /needs `options`/],
      ['x', { control: 'number', default: 'many' }, /default of "x"/],
      ['x', { option: 'blogname' }, /"options" permission/],
      ['x', { sanitize: 'trim' }, /sanitize/],
    ];
    for (const [name, args, message] of cases) {
      expect(() => resolveSetting('demo', name, args, context), name).toThrow(message);
    }
    // With the options permission, another option is allowed.
    expect(
      resolveSetting('demo', 'x', { option: 'blogname' }, { ...context, permissions: ['options'] })
        .option,
    ).toBe('blogname');
  });

  it('validates each control', () => {
    const schema = (args: Record<string, unknown>) =>
      settingSchema(resolveSetting('demo', 'x', args, context));
    expect(schema({ control: 'url' }).safeParse('ftp://x').success).toBe(false);
    expect(schema({ control: 'url' }).safeParse('').success).toBe(true);
    expect(schema({ control: 'url', required: true }).safeParse('').success).toBe(false);
    expect(schema({ control: 'email' }).safeParse('me@example.com').success).toBe(true);
    expect(schema({ control: 'color' }).parse('#ABCDEF')).toBe('#abcdef');
    expect(schema({ control: 'color' }).safeParse('red').success).toBe(false);
    expect(schema({ control: 'number', min: 1, max: 5 }).safeParse(6).success).toBe(false);
    expect(schema({ type: 'integer' }).safeParse(1.5).success).toBe(false);
    expect(schema({ control: 'text' }).parse('  padded  ')).toBe('padded');
    expect(schema({ control: 'text', maxLength: 3 }).safeParse('long').success).toBe(false);
    expect(
      schema({ control: 'radio', options: [{ value: 'a', label: 'A' }] }).safeParse('b').success,
    ).toBe(false);
    expect(schema({ type: 'array' }).safeParse([1]).success).toBe(true);
  });

  it('accepts admin.module, sections and the full settings in plugin.json', () => {
    const parsed = parseManifest(
      JSON.stringify({
        name: 'demo',
        title: 'Demo',
        version: '1.0.0',
        admin: {
          module: 'admin/index.js',
          pages: [
            { slug: 'reports', title: 'Reports', parent: 'tools', entry: 'admin/reports.js' },
          ],
          sections: [{ id: 'look', title: 'Look' }],
          settings: [{ name: 'tone', control: 'radio', options: [{ value: 'a', label: 'A' }] }],
        },
      }),
    );
    expect(parsed.ok).toBe(true);
    for (const admin of [
      { module: '../escape.js' },
      { module: 'admin/.hidden/x.js' },
      { module: 'admin/style.css' },
      { pages: [{ slug: 'x', title: 'X', parent: 'appearance' }] },
    ]) {
      expect(
        parseManifest(JSON.stringify({ name: 'demo', title: 'Demo', version: '1.0.0', admin })).ok,
        JSON.stringify(admin),
      ).toBe(false);
    }
  });
});

describe('the Settings API', () => {
  it('serves the daily-tips settings page schema and saves through validation and sanitize', async () => {
    const ctx = await site();
    expect((await activate(ctx, 'daily-tips')).status).toBe(200);

    const extensions = await ctx.request('GET', '/pressbase/v1/admin-extensions');
    expect(extensions.status).toBe(200);
    expect(extensions.body.pages).toEqual([
      expect.objectContaining({
        plugin: 'daily-tips',
        slug: 'daily-tips',
        title: 'Daily Tips',
        parent: 'settings',
        module: null,
        has_settings: true,
      }),
    ]);
    expect(extensions.body.modules).toEqual([
      {
        plugin: 'daily-tips',
        title: 'Daily Tips',
        url: '/wp-content/plugins/daily-tips/admin/index.js?ver=1.1.0',
      },
    ]);

    const page = await ctx.request('GET', '/pressbase/v1/plugin-pages/daily-tips/daily-tips');
    expect(page.status).toBe(200);
    expect(page.body.sections.map((s: { id: string }) => s.id)).toEqual(['where', 'tips']);
    const fields = page.body.sections.flatMap((s: { fields: { name: string }[] }) => s.fields);
    expect(fields.map((f: { name: string }) => f.name)).toEqual([
      'daily_tips_show_in_posts',
      'daily_tips_accent',
      'daily_tips_source',
      'daily_tips_own_tips',
    ]);
    expect(fields[2]).toMatchObject({ control: 'radio', default: 'all' });
    expect(page.body.values).toMatchObject({
      daily_tips_show_in_posts: true,
      daily_tips_accent: '#3858e9',
      daily_tips_own_tips: '',
    });

    // A refused field saves nothing, and errors are keyed by option for the form.
    const bad = await ctx.request('POST', '/pressbase/v1/plugin-pages/daily-tips/daily-tips', {
      daily_tips_accent: 'blue',
      daily_tips_source: 'own',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('rest_invalid_param');
    expect(bad.body.data.params.daily_tips_accent).toMatch(/colour/);
    expect(await ctx.kernel.options.get('daily_tips_source')).toBeUndefined();

    // The plugin's sanitize callback refuses too many tips, with its own message.
    const many = Array.from({ length: 21 }, (_, i) => `Tip ${i}`).join('\n');
    const tooMany = await ctx.request('POST', '/pressbase/v1/plugin-pages/daily-tips/daily-tips', {
      daily_tips_own_tips: many,
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.data.params.daily_tips_own_tips).toBe('Keep it to 20 tips; you have 21.');

    // sanitize_option_{option} and pre_update_option_{option} run, as in update_option().
    const seen: string[] = [];
    ctx.kernel.hooks.addFilter('sanitize_option_daily_tips_own_tips', (value: unknown) => {
      seen.push('sanitize');
      return value;
    });
    ctx.kernel.hooks.addFilter('pre_update_option_daily_tips_own_tips', (value: unknown) => {
      seen.push('pre_update');
      return `${value}\nAdded by a filter.`;
    });
    const saved = await ctx.request('POST', '/pressbase/v1/plugin-pages/daily-tips/daily-tips', {
      daily_tips_own_tips: '  Only my tip.  \n\n',
      daily_tips_source: 'own',
      daily_tips_accent: '#ABC',
      unknown_option: 'ignored',
    });
    expect(saved.status).toBe(200);
    expect(seen).toEqual(['sanitize', 'pre_update']);
    expect(saved.body.values).toMatchObject({
      daily_tips_own_tips: 'Only my tip.\nAdded by a filter.',
      daily_tips_source: 'own',
      daily_tips_accent: '#abc',
    });
    expect(await ctx.kernel.options.get('unknown_option')).toBeUndefined();

    // The plugin reads them back: only your tips now.
    const tips = new Set<string>();
    for (let i = 0; i < 10; i++)
      tips.add((await ctx.request('GET', '/daily-tips/v1/tip')).body.tip);
    expect([...tips].every((t) => ['Only my tip.', 'Added by a filter.'].includes(t))).toBe(true);
    const widget = await ctx.request('GET', '/daily-tips/v1/widget');
    expect(widget.body.accent).toBe('#abc');
  });

  it('exposes showInRest settings at /wp/v2/settings, sanitized there too, until deactivation', async () => {
    const ctx = await site();
    await activate(ctx, 'daily-tips');
    const settings = await ctx.request('GET', '/wp/v2/settings');
    expect(settings.body.daily_tips_show_in_posts).toBe(true);
    // Not shown in REST: no showInRest.
    expect(settings.body).not.toHaveProperty('daily_tips_accent');

    const bad = await ctx.request('POST', '/wp/v2/settings', { daily_tips_show_in_posts: 'yes' });
    expect(bad.status).toBe(400);
    const off = await ctx.request('POST', '/wp/v2/settings', { daily_tips_show_in_posts: false });
    expect(off.body.daily_tips_show_in_posts).toBe(false);
    const post = await ctx.request('POST', '/wp/v2/posts', { title: 'Hi', status: 'publish' });
    expect(post.body).not.toHaveProperty('daily_tip');

    await ctx.request('PUT', '/wp/v2/plugins/daily-tips', { status: 'inactive' });
    expect((await ctx.request('GET', '/wp/v2/settings')).body).not.toHaveProperty(
      'daily_tips_show_in_posts',
    );
    expect((await ctx.request('GET', '/pressbase/v1/admin-extensions')).body).toEqual({
      pages: [],
      modules: [],
    });
    expect(
      (await ctx.request('GET', '/pressbase/v1/plugin-pages/daily-tips/daily-tips')).status,
    ).toBe(404);
  });

  it('fires register_setting, and api.settings.get / set apply the default and the rules', async () => {
    const ctx = await site();
    const registered: string[] = [];
    ctx.kernel.hooks.addAction('register_setting', (group: unknown, option: unknown) => {
      registered.push(`${group}:${option}`);
    });
    await writePlugin(ctx, 'counter', {
      'index.js': `
          export default function register(api) {
            api.settings.register('limit', { control: 'number', type: 'integer', min: 1, max: 9, default: 3 });
            api.rest.registerRoute('counter/v1', '/try', {
              permission: () => true,
              handler: async (c) => {
                const before = await api.settings.get('limit');
                let error = null;
                try { await api.settings.set('limit', Number(c.req.query('to'))); }
                catch (e) { error = e.message; }
                return { before, after: await api.settings.get('limit'), error };
              },
            });
          }`,
    });
    expect((await activate(ctx, 'counter')).status).toBe(200);
    expect(registered).toEqual(['counter:counter_limit']);
    expect((await ctx.request('GET', '/counter/v1/try?to=12')).body).toEqual({
      before: 3,
      after: 3,
      error: 'Enter 9 or less.',
    });
    expect((await ctx.request('GET', '/counter/v1/try?to=5')).body).toMatchObject({ after: 5 });
  });

  it('refuses an activation whose settings are invalid, leaving nothing registered', async () => {
    const ctx = await site();
    await writePlugin(ctx, 'greedy', {
      'index.js': `export default function register(api) {
          api.settings.register('ok', { type: 'boolean', showInRest: true });
          api.settings.register('title', { option: 'blogname' });
        }`,
    });
    const res = await activate(ctx, 'greedy');
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/"options" permission/);
    expect(ctx.kernel.settings.get('greedy_ok')).toBeUndefined();
  });
});

describe('admin pages', () => {
  async function pagesPlugin(ctx: Ctx) {
    await writePlugin(
      ctx,
      'reports',
      {
        'index.js': `export default function register(api) {
          api.admin.addPage({ slug: 'stats', title: 'Stats', capability: 'edit_posts', entry: 'admin/stats.js' });
          api.settings.register('period', { control: 'select', page: 'export', options: [{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }] });
        }`,
        'admin/stats.js': 'export default function Stats() { return null; }',
        'admin/chunk.js': 'export const x = 1;',
        'admin/style.css': 'body{}',
        'helper.js': 'export const secret = 1;',
      },
      {
        admin: {
          pages: [{ slug: 'export', title: 'Export reports', parent: 'tools' }],
        },
      },
    );
    expect((await activate(ctx, 'reports')).status).toBe(200);
  }

  it('lists pages per capability and checks it on the page itself', async () => {
    const ctx = await site();
    await pagesPlugin(ctx);
    const admin = await ctx.request('GET', '/pressbase/v1/admin-extensions');
    expect(
      admin.body.pages.map((p: { slug: string; parent: string | null }) => [p.slug, p.parent]),
    ).toEqual([
      ['export', 'tools'],
      ['stats', null],
    ]);
    expect(admin.body.pages[1].module).toBe('/wp-content/plugins/reports/admin/stats.js?ver=1.0.0');

    const editor = await ctx.loginAs('ed', 'editor');
    const forEditor = await editor.request('GET', '/pressbase/v1/admin-extensions');
    expect(forEditor.body.pages.map((p: { slug: string }) => p.slug)).toEqual(['stats']);
    expect((await editor.request('GET', '/pressbase/v1/plugin-pages/reports/stats')).status).toBe(
      200,
    );
    const denied = await editor.request('GET', '/pressbase/v1/plugin-pages/reports/export');
    expect(denied.status).toBe(403);
    expect(
      (await editor.request('POST', '/pressbase/v1/plugin-pages/reports/export', {})).status,
    ).toBe(403);

    ctx.clearCookie();
    expect((await ctx.request('GET', '/pressbase/v1/admin-extensions')).status).toBe(401);
    expect((await ctx.request('GET', '/pressbase/v1/plugin-pages/reports/stats')).status).toBe(401);
    expect((await editor.request('GET', '/pressbase/v1/plugin-pages/reports/nope')).status).toBe(
      404,
    );
  });

  it('serves module files of active plugins only, never main or files outside module folders', async () => {
    const ctx = await site();
    await pagesPlugin(ctx);

    const module = await asset(ctx, '/wp-content/plugins/reports/admin/stats.js?ver=1.0.0');
    expect(module.status).toBe(200);
    expect(module.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(module.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(module.headers.get('x-content-type-options')).toBe('nosniff');
    expect(module.headers.get('access-control-allow-origin')).toBeNull();
    expect(await module.text()).toContain('Stats');

    // Another version (or none) must be revalidated.
    const stale = await asset(ctx, '/wp-content/plugins/reports/admin/stats.js?ver=0.9.0');
    expect(stale.headers.get('cache-control')).toBe('no-cache');
    // Siblings in the module's folder: chunks and CSS.
    expect((await asset(ctx, '/wp-content/plugins/reports/admin/chunk.js')).status).toBe(200);
    expect((await asset(ctx, '/wp-content/plugins/reports/admin/style.css')).status).toBe(200);

    for (const url of [
      '/wp-content/plugins/reports/index.js',
      '/wp-content/plugins/reports/helper.js',
      '/wp-content/plugins/reports/plugin.json',
      '/wp-content/plugins/reports/admin/../index.js',
      '/wp-content/plugins/reports/admin/..%2findex.js',
      '/wp-content/plugins/reports/admin/%2e%2e/index.js',
      '/wp-content/plugins/reports/admin/..%5cindex.js',
      '/wp-content/plugins/reports/admin/missing.js',
      '/wp-content/plugins/daily-tips/admin/index.js',
      '/wp-content/plugins/../../plugins/daily-tips/index.js',
    ]) {
      expect((await asset(ctx, url)).status, url).toBe(404);
    }

    await ctx.request('PUT', '/wp/v2/plugins/reports', { status: 'inactive' });
    expect((await asset(ctx, '/wp-content/plugins/reports/admin/stats.js')).status).toBe(404);
  });

  it('serves the daily-tips admin module while it is active', async () => {
    const ctx = await site();
    expect((await asset(ctx, '/wp-content/plugins/daily-tips/admin/index.js')).status).toBe(404);
    await activate(ctx, 'daily-tips');
    const res = await asset(ctx, '/wp-content/plugins/daily-tips/admin/index.js?ver=1.1.0');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("registerPlugin('daily-tips'");
    expect((await asset(ctx, '/wp-content/plugins/daily-tips/index.js')).status).toBe(404);
  });

  it('refuses pages with an unknown parent or a duplicate slug', async () => {
    const ctx = await site();
    await writePlugin(ctx, 'odd', {
      'index.js': `export default function register(api) {
        api.admin.addPage({ slug: 'a', title: 'A', parent: 'appearance' });
      }`,
    });
    const res = await activate(ctx, 'odd');
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/"settings" or "tools"/);

    await writePlugin(ctx, 'twice', {
      'index.js': `export default function register(api) {
        api.admin.addPage({ slug: 'a', title: 'A' });
        api.admin.addPage({ slug: 'a', title: 'Again' });
      }`,
    });
    expect((await activate(ctx, 'twice')).body.message).toMatch(/already registered/);
  });
});
