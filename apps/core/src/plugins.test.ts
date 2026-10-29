import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { createZip, readZip, safeEntryPath, ZipError } from './files/zip';
import { Kernel } from './kernel';
import { discoverPlugins } from './plugins/discovery';
import { ACTIVE_PLUGINS, PLUGIN_ERRORS, PLUGIN_MIGRATIONS } from './plugins/manager';
import { parseManifest } from './plugins/manifest';
import { isValidRange, satisfies } from './plugins/semver';
import { SITE, setup, type TestResponse } from './test-utils';

/**
 * The plugin runtime (v0.5): plugin.json, discovery, loading, the lifecycle,
 * migrations, .zip installs, /wp/v2/plugins and dynamic routing of what
 * plugins register. The bundled example, plugins/daily-tips, is used throughout.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

const manifest = (overrides: Record<string, unknown> = {}) => ({
  name: 'sample',
  title: 'Sample',
  version: '1.0.0',
  main: 'index.js',
  ...overrides,
});

/** Writes a plugin into the site's plugins folder. */
async function writePlugin(
  dataDir: string,
  files: Record<string, string>,
  overrides: Record<string, unknown> = {},
) {
  const m = manifest(overrides);
  const dir = path.join(dataDir, 'plugins', String(m.name));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify(m));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

/** Logs in on a fresh cookie and returns headers for raw (multipart) requests. */
async function adminHeaders(ctx: Ctx) {
  const res = await ctx.app.request('/wp-json/pressbase/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pressbase-request': '1' },
    body: JSON.stringify({ login: SITE.username, password: SITE.password }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { cookie, 'x-pressbase-request': '1' };
}

async function upload(ctx: Ctx, zip: Uint8Array, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(zip)], 'plugin.zip', { type: 'application/zip' }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await ctx.app.request('/wp-json/wp/v2/plugins', {
    method: 'POST',
    headers: await adminHeaders(ctx),
    body: form,
  });
  return { status: res.status, body: (await res.json()) as TestResponse['body'] };
}

describe('plugin.json', () => {
  it('accepts a full manifest and fills in defaults', () => {
    const result = parseManifest(
      JSON.stringify(
        manifest({
          requires: '>=0.1.0 <1',
          permissions: ['database'],
          migrations: 'migrations',
          admin: { pages: [{ slug: 'reports', title: 'Reports' }] },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.description).toBe('');
    expect(result.manifest.admin?.pages[0]?.capability).toBe('manage_options');
  });

  it('reports each invalid field', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: 'Not A Slug' }, 'name'],
      [{ name: 'wp' }, 'name'],
      [{ version: 'one' }, 'version'],
      [{ main: '../escape.js' }, 'main'],
      [{ main: 'index.ts' }, 'main'],
      [{ requires: 'soon' }, 'requires'],
      [{ permissions: ['root'] }, 'permissions.0'],
      [{ migrations: 'migrations' }, 'permissions'],
      [{ homepage: 'javascript:alert(1)' }, 'homepage'],
    ];
    for (const [overrides, field] of cases) {
      const result = parseManifest(JSON.stringify(manifest(overrides)));
      expect(result.ok, JSON.stringify(overrides)).toBe(false);
      if (!result.ok) expect(Object.keys(result.errors)).toContain(field);
    }
    expect(parseManifest('{nope').ok).toBe(false);
  });

  it('matches semver ranges', () => {
    expect(satisfies('0.5.0', '>=0.5.0 <1')).toBe(true);
    expect(satisfies('0.4.9', '>=0.5.0')).toBe(false);
    expect(satisfies('0.5.3', '^0.5')).toBe(true);
    expect(satisfies('1.2.0', '~1.1')).toBe(false);
    expect(isValidRange('banana')).toBe(false);
  });
});

describe('discovery', () => {
  it('finds site and bundled plugins; the site copy wins, broken folders are listed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pressbase-plugins-'));
    try {
      const write = async (base: string, slug: string, json: unknown) => {
        await mkdir(path.join(root, base, slug), { recursive: true });
        await writeFile(path.join(root, base, slug, 'plugin.json'), JSON.stringify(json));
      };
      await write('bundled', 'shared', manifest({ name: 'shared', title: 'Bundled copy' }));
      await write('site', 'shared', manifest({ name: 'shared', title: 'Site copy' }));
      await write('site', 'mismatch', manifest({ name: 'other' }));
      await write('site', 'broken', { name: 'broken' });
      await mkdir(path.join(root, 'site', 'not-a-plugin'), { recursive: true });

      const found = await discoverPlugins({
        site: path.join(root, 'site'),
        bundled: path.join(root, 'bundled'),
      });
      expect(found.plugins.map((p) => [p.slug, p.manifest.title, p.source])).toEqual([
        ['shared', 'Site copy', 'site'],
      ]);
      expect(found.invalid.map((p) => p.slug)).toEqual(['broken', 'mismatch']);
      expect(found.invalid[1]?.error).toMatch(/must match/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the Daily Tips example', () => {
  it('activates without a restart, and deactivating removes its hooks, routes and post type', async () => {
    const ctx = await site();
    const { kernel, request } = ctx;
    const events: string[] = [];
    for (const hook of [
      'activate_plugin',
      'activated_plugin',
      'deactivate_plugin',
      'deactivated_plugin',
    ]) {
      kernel.hooks.addAction(hook, (slug: unknown) => {
        events.push(`${hook}:${slug}`);
      });
    }

    const listed = await request('GET', '/wp/v2/plugins');
    expect(listed.status).toBe(200);
    const item = listed.body.find((p: { plugin: string }) => p.plugin === 'daily-tips');
    expect(item).toMatchObject({ status: 'inactive', name: 'Daily Tips', source: 'bundled' });
    expect(item.admin.settings[0].name).toBe('show_in_posts');
    expect((await request('GET', '/daily-tips/v1/tip')).status).toBe(404);

    const activated = await request('PUT', '/wp/v2/plugins/daily-tips', { status: 'active' });
    expect(activated.status).toBe(200);
    expect(activated.body.status).toBe('active');
    expect(await kernel.options.get(ACTIVE_PLUGINS)).toEqual(['daily-tips']);

    // REST route in the plugin's namespace.
    const tip = await request('GET', '/daily-tips/v1/tip');
    expect(tip.status).toBe(200);
    expect(typeof tip.body.tip).toBe('string');
    expect((await request('GET', '/')).body.namespaces).toContain('daily-tips/v1');

    // Custom post type, served by the posts controller at its rest_base.
    const created = await request('POST', '/wp/v2/daily-tips', {
      title: 'Write first, edit later.',
      status: 'publish',
    });
    expect(created.status).toBe(201);
    expect(created.body.type).toBe('daily_tip');
    expect((await request('GET', '/wp/v2/daily-tips')).body).toHaveLength(1);
    expect((await request('GET', '/wp/v2/types/daily_tip')).status).toBe(200);

    // The filter adds a tip to posts.
    const post = await request('POST', '/wp/v2/posts', { title: 'Hello', status: 'publish' });
    expect(typeof post.body.daily_tip).toBe('string');

    const deactivated = await request('PUT', '/wp/v2/plugins/daily-tips', { status: 'inactive' });
    expect(deactivated.body.status).toBe('inactive');
    expect((await request('GET', '/daily-tips/v1/tip')).status).toBe(404);
    expect((await request('GET', '/wp/v2/daily-tips')).status).toBe(404);
    expect(kernel.postTypes.get('daily_tip')).toBeUndefined();
    expect(kernel.hooks.hasFilter('rest_prepare_post')).toBe(false);
    expect((await request('GET', `/wp/v2/posts/${post.body.id}`)).body.daily_tip).toBeUndefined();
    expect((await request('GET', '/')).body.namespaces).not.toContain('daily-tips/v1');

    // And back again: registrations come back, posts of the type were kept.
    await request('PUT', '/wp/v2/plugins/daily-tips', { status: 'active' });
    expect((await request('GET', '/wp/v2/daily-tips')).body).toHaveLength(1);

    expect(events).toEqual([
      'activate_plugin:daily-tips',
      'activated_plugin:daily-tips',
      'deactivate_plugin:daily-tips',
      'deactivated_plugin:daily-tips',
      'activate_plugin:daily-tips',
      'activated_plugin:daily-tips',
    ]);
  });

  it('loads active plugins on boot, before init', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pressbase-boot-'));
    try {
      const first = await setup({ databaseUrl: `pglite:${path.join(dir, 'db')}` });
      await first.install();
      await first.request('PUT', '/wp/v2/plugins/daily-tips', { status: 'active' });
      await first.kernel.shutdown();

      const kernel = new Kernel({ ...first.kernel.config });
      let loadedAtInit = false;
      kernel.hooks.addAction('init', () => {
        loadedAtInit = kernel.plugins.isLoaded('daily-tips');
      });
      await kernel.boot();
      try {
        expect(loadedAtInit).toBe(true);
        const res = await createApp(kernel).request('/wp-json/daily-tips/v1/tip');
        expect(res.status).toBe(200);
      } finally {
        await kernel.shutdown();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('broken plugins', () => {
  it('a plugin that throws while registering is not activated and leaves nothing behind', async () => {
    const ctx = await site();
    await writePlugin(ctx.dataDir, {
      'index.js': `export default function (api) {
        api.hooks.addFilter('the_title', (t) => t + '!');
        api.rest.registerRoute('sample/v1', '/ping', { permission: () => true, handler: () => 'pong' });
        throw new Error('Something is missing.');
      }`,
    });
    const res = await ctx.request('PUT', '/wp/v2/plugins/sample', { status: 'active' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('plugin_activation_failed');
    expect(res.body.message).toMatch(/Something is missing/);
    expect(ctx.kernel.hooks.hasFilter('the_title')).toBe(false);
    expect((await ctx.request('GET', '/sample/v1/ping')).status).toBe(404);
    const item = (await ctx.request('GET', '/wp/v2/plugins/sample')).body;
    expect(item.status).toBe('inactive');
    expect(item.error).toMatchObject({ during: 'activate', message: 'Something is missing.' });
  });

  it('a plugin that fails on boot is deactivated and the site still boots', async () => {
    const ctx = await site();
    const dir = await writePlugin(ctx.dataDir, {
      'index.js': `export default function (api) {
        api.rest.registerRoute('sample/v1', '/ping', { permission: () => true, handler: () => 'pong' });
      }`,
    });
    expect((await ctx.request('PUT', '/wp/v2/plugins/sample', { status: 'active' })).status).toBe(
      200,
    );
    expect((await ctx.request('GET', '/sample/v1/ping')).body).toBe('pong');

    // The code breaks (a bad upgrade, a missing file); then the server restarts.
    await writeFile(path.join(dir, 'index.js'), 'export default function ( {');
    ctx.kernel.plugins.unloadAll();
    await ctx.kernel.plugins.loadActive();

    expect(await ctx.kernel.options.get(ACTIVE_PLUGINS)).toEqual([]);
    expect(
      (await ctx.kernel.options.get<Record<string, unknown>>(PLUGIN_ERRORS)).sample,
    ).toMatchObject({ during: 'load' });
    expect((await ctx.request('GET', '/sample/v1/ping')).status).toBe(404);
    expect((await ctx.request('GET', '/wp/v2/posts')).status).toBe(200);
  });

  it('isolates errors thrown by hooks and routes', async () => {
    const ctx = await site();
    await writePlugin(ctx.dataDir, {
      'index.js': `export default function (api) {
        api.hooks.addFilter('rest_prepare_post', () => { throw new Error('filter broke'); });
        api.rest.registerRoute('sample/v1', '/boom', { permission: () => true, handler: () => { throw new Error('route broke'); } });
        api.rest.registerRoute('sample/v1', '/private', { permission: (c) => api.rest.userCan(c, 'manage_options'), handler: () => 'secret' });
      }`,
    });
    await ctx.request('PUT', '/wp/v2/plugins/sample', { status: 'active' });
    const post = await ctx.request('POST', '/wp/v2/posts', {
      title: 'Still fine',
      status: 'publish',
    });
    expect(post.status).toBe(201);
    expect(post.body.title.raw).toBe('Still fine');
    const boom = await ctx.request('GET', '/sample/v1/boom');
    expect(boom.status).toBe(500);
    expect(boom.body.code).toBe('pressbase_plugin_error');
    expect((await ctx.request('GET', '/sample/v1/private')).body).toBe('secret');
    ctx.clearCookie();
    expect((await ctx.request('GET', '/sample/v1/private')).status).toBe(401);

    const item = (
      await (await ctx.loginAs('boss', 'administrator')).request('GET', '/wp/v2/plugins/sample')
    ).body;
    expect(item.status).toBe('active');
    expect(item.runtime_errors.map((e: { message: string }) => e.message)).toEqual([
      'route broke',
      'filter broke',
    ]);
  });

  it('keeps plugins inside their namespace and away from raw database access', async () => {
    const ctx = await site();
    await writePlugin(ctx.dataDir, {
      'index.js': `export default function (api) {
        if (api.db || api.siteOptions) throw new Error('granted too much');
        api.rest.registerRoute('wp/v2', '/hijack', { permission: () => true, handler: () => 'no' });
      }`,
    });
    const res = await ctx.request('PUT', '/wp/v2/plugins/sample', { status: 'active' });
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/REST namespaces must start with the plugin's name/);
  });
});

describe('permissions and migrations', () => {
  const migrating = (ctx: Ctx, files: Record<string, string>) =>
    writePlugin(
      ctx.dataDir,
      {
        'index.js': `export default function (api) {
          api.rest.registerRoute('sample/v1', '/count', {
            permission: () => true,
            handler: async () => {
              const rows = await api.db.db.execute(api.db.sql\`select count(*)::int as n from sample_items\`);
              return { n: (rows.rows ?? rows)[0].n };
            },
          });
        }`,
        ...files,
      },
      { permissions: ['database'], migrations: 'migrations' },
    );

  it('needs the declared permissions confirmed, records them, and runs each migration once', async () => {
    const ctx = await site();
    const dir = await migrating(ctx, {
      'migrations/0001-create.sql':
        "create table sample_items (id serial primary key, name text not null);\ninsert into sample_items (name) values ('one');",
    });

    const refused = await ctx.request('PUT', '/wp/v2/plugins/sample', { status: 'active' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('pressbase_plugin_permissions_required');
    expect(refused.body.data.permissions).toEqual(['database']);

    const ok = await ctx.request('PUT', '/wp/v2/plugins/sample', {
      status: 'active',
      permissions: ['database'],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.granted_permissions).toEqual(['database']);
    expect((await ctx.request('GET', '/sample/v1/count')).body).toEqual({ n: 1 });

    // Re-activating doesn't run 0001 again (CREATE TABLE would fail); a new file runs once.
    await ctx.request('PUT', '/wp/v2/plugins/sample', { status: 'inactive' });
    await writeFile(
      path.join(dir, 'migrations', '0002-more.sql'),
      "insert into sample_items (name) values ('two');",
    );
    const again = await ctx.request('PUT', '/wp/v2/plugins/sample', {
      status: 'active',
      permissions: ['database'],
    });
    expect(again.status).toBe(200);
    expect((await ctx.request('GET', '/sample/v1/count')).body).toEqual({ n: 2 });
    expect(await ctx.kernel.options.get(PLUGIN_MIGRATIONS)).toEqual({
      sample: ['0001-create.sql', '0002-more.sql'],
    });
  });

  it('a failing migration stops activation', async () => {
    const ctx = await site();
    await migrating(ctx, { 'migrations/0001-bad.sql': 'create tabel nope;' });
    const res = await ctx.request('PUT', '/wp/v2/plugins/sample', {
      status: 'active',
      permissions: ['database'],
    });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('plugin_migration_failed');
    expect(await ctx.kernel.options.get(PLUGIN_MIGRATIONS, {})).toEqual({});
    expect(await ctx.kernel.options.get(ACTIVE_PLUGINS)).toEqual([]);
  });
});

describe('installing from a .zip', () => {
  const pluginZip = (
    prefix = 'sample/',
    extra: { name: string; data?: string; symlink?: boolean }[] = [],
  ) =>
    createZip([
      { name: `${prefix}plugin.json`, data: JSON.stringify(manifest()) },
      {
        name: `${prefix}index.js`,
        data: `export default function (api) { api.rest.registerRoute('sample/v1', '/hi', { permission: () => true, handler: () => 'hi' }); }`,
      },
      ...extra,
    ]);

  it('reads archives and refuses zip-slip paths and symlinks', () => {
    const entries = readZip(createZip([{ name: 'a/b.txt', data: 'hello' }, { name: 'a/' }]));
    expect(entries.map((e) => [e.name, Buffer.from(e.data).toString()])).toEqual([
      ['a/b.txt', 'hello'],
    ]);
    for (const name of ['../evil.js', '/etc/passwd', 'a/../../b', 'C:/win.ini', 'a\\b']) {
      expect(() => safeEntryPath(name), name).toThrow(ZipError);
    }
    expect(() =>
      readZip(createZip([{ name: 'link', data: '/etc/passwd', symlink: true }])),
    ).toThrow(/link or special file/);
    expect(() => readZip(new Uint8Array([1, 2, 3]))).toThrow(ZipError);
  });

  it('installs an uploaded plugin and can activate it in the same request', async () => {
    const ctx = await site();
    const res = await upload(ctx, pluginZip(), { status: 'active' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ plugin: 'sample', status: 'active', source: 'site' });
    expect((await ctx.request('GET', '/sample/v1/hi')).body).toBe('hi');
    expect(await readdir(path.join(ctx.dataDir, 'plugins'))).toEqual(['sample']);

    const again = await upload(ctx, pluginZip(''));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('folder_exists');
  });

  it('rejects unsafe or invalid archives without writing anything', async () => {
    const ctx = await site();
    const cases: [Uint8Array, string][] = [
      [
        pluginZip('sample/', [{ name: 'sample/../../evil.js', data: 'x' }]),
        'incompatible_archive_path',
      ],
      [
        pluginZip('sample/', [{ name: 'sample/link', data: '/etc', symlink: true }]),
        'incompatible_archive_symlink',
      ],
      [createZip([{ name: 'readme.txt', data: 'hi' }]), 'incompatible_archive_no_plugins'],
      [
        createZip([
          { name: 'plugin.json', data: JSON.stringify(manifest({ main: 'missing.js' })) },
        ]),
        'pressbase_invalid_manifest',
      ],
      [new Uint8Array([80, 75, 0, 0]), 'incompatible_archive'],
    ];
    for (const [zip, code] of cases) {
      const res = await upload(ctx, zip);
      expect(res.status, code).toBe(400);
      expect(res.body.code).toBe(code);
    }
    expect(await readdir(path.join(ctx.dataDir, 'plugins')).catch(() => [])).toEqual([]);
  });

  it('refuses archives over the size limit', async () => {
    const ctx = await setup({ maxUploadMb: 1 });
    await ctx.install();
    const big = createZip([
      { name: 'plugin.json', data: JSON.stringify(manifest()) },
      { name: 'index.js', data: 'export default () => {};' },
      {
        name: 'noise.bin',
        data: new Uint8Array(1_200_000).map(() => Math.floor(Math.random() * 256)),
      },
    ]);
    const res = await upload(ctx, big);
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('rest_upload_file_too_big');
  });
});

describe('/wp/v2/plugins permissions', () => {
  it('needs activate_plugins to view or change, install_plugins to upload, delete_plugins to delete', async () => {
    const ctx = await site();
    const editor = await ctx.loginAs('ed', 'editor');
    expect((await editor.request('GET', '/wp/v2/plugins')).body.code).toBe(
      'rest_cannot_view_plugins',
    );
    expect((await editor.request('GET', '/wp/v2/plugins')).status).toBe(403);
    expect(
      (await editor.request('PUT', '/wp/v2/plugins/daily-tips', { status: 'active' })).status,
    ).toBe(403);
    expect((await editor.request('DELETE', '/wp/v2/plugins/daily-tips')).status).toBe(403);
    expect((await editor.request('POST', '/wp/v2/plugins', {})).body.code).toBe(
      'rest_cannot_install_plugin',
    );
    const anonymous = ctx.client();
    expect((await anonymous.request('GET', '/wp/v2/plugins')).status).toBe(401);
    expect((await ctx.request('GET', '/wp/v2/plugins/nope')).status).toBe(404);
    expect((await ctx.request('POST', '/wp/v2/plugins', { slug: 'akismet' })).body.code).toBe(
      'pressbase_plugin_directory_unavailable',
    );
  });

  it('deletes inactive site plugins only, running uninstall', async () => {
    const ctx = await site();
    const dir = await writePlugin(ctx.dataDir, {
      'index.js': `export default function () {}
        export async function uninstall(api) { await api.options.delete('kept'); }`,
    });
    await ctx.kernel.options.set('sample_kept', 'yes');
    const events: string[] = [];
    ctx.kernel.hooks.addAction('pre_uninstall_plugin', (slug: unknown) => {
      events.push(`pre_uninstall_plugin:${slug}`);
    });
    ctx.kernel.hooks.addAction('deleted_plugin', (slug: unknown, ok: unknown) => {
      events.push(`deleted_plugin:${slug}:${ok}`);
    });

    await ctx.request('PUT', '/wp/v2/plugins/sample', { status: 'active' });
    const active = await ctx.request('DELETE', '/wp/v2/plugins/sample');
    expect(active.status).toBe(400);
    expect(active.body.code).toBe('rest_cannot_delete_active_plugin');

    await ctx.request('PUT', '/wp/v2/plugins/sample', { status: 'inactive' });
    const deleted = await ctx.request('DELETE', '/wp/v2/plugins/sample');
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ deleted: true, previous: { plugin: 'sample' } });
    expect(await readdir(dir).catch(() => null)).toBeNull();
    expect(await ctx.kernel.options.get('sample_kept')).toBeUndefined();
    expect(events).toEqual(['pre_uninstall_plugin:sample', 'deleted_plugin:sample:true']);

    const bundled = await ctx.request('DELETE', '/wp/v2/plugins/daily-tips');
    expect(bundled.body.code).toBe('pressbase_cannot_delete_bundled_plugin');
  });
});
