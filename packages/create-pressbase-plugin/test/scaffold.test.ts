import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readZip } from '@pressbase/core/src/files/zip';
import { PLUGIN_MIGRATIONS } from '@pressbase/core/src/plugins/manager';
import {
  RESERVED_NAMES as CORE_RESERVED,
  SLUG as CORE_SLUG,
} from '@pressbase/core/src/plugins/manifest';
import { setup } from '@pressbase/core/src/test-utils';
import { afterAll, describe, expect, it } from 'vitest';
import {
  main,
  parseArgs,
  RESERVED_NAMES,
  SLUG,
  scaffold,
  titleFromName,
  validateName,
} from '../src/scaffold.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const SDK_DIR = path.resolve(here, '../../plugin-sdk');
const require = createRequire(import.meta.url);

const temps: string[] = [];
async function temp() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pressbase-scaffold-'));
  temps.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Captures what main() prints. */
function output() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return { stream, text: () => text };
}

/**
 * Stands in for `npm install` without the network: links the workspace's SDK,
 * esbuild, TypeScript and Node's types into the plugin's node_modules.
 */
async function linkDependencies(dir: string) {
  const modules = path.join(dir, 'node_modules');
  await mkdir(path.join(modules, '@pressbase'), { recursive: true });
  await mkdir(path.join(modules, '@types'), { recursive: true });
  const packageDir = async (name: string) =>
    realpath(path.dirname(require.resolve(`${name}/package.json`)));
  await symlink(SDK_DIR, path.join(modules, '@pressbase/plugin-sdk'), 'dir');
  await symlink(await packageDir('esbuild'), path.join(modules, 'esbuild'), 'dir');
  await symlink(await packageDir('typescript'), path.join(modules, 'typescript'), 'dir');
  await symlink(await packageDir('@types/node'), path.join(modules, '@types/node'), 'dir');
}

describe('names', () => {
  it('follow plugin.json’s rules, the same as core’s', () => {
    expect(SLUG.source).toBe(CORE_SLUG.source);
    expect([...RESERVED_NAMES].sort()).toEqual([...CORE_RESERVED].sort());
    expect(validateName('reading-time')).toBeNull();
    expect(validateName('a1')).toBeNull();
    for (const bad of [
      '',
      'Reading',
      'reading_time',
      '-x',
      'x-',
      'a--b',
      'a b',
      'wp',
      'pressbase',
    ]) {
      expect(validateName(bad), bad).toEqual(expect.any(String));
    }
    expect(validateName('a'.repeat(65))).toMatch(/64/);
    expect(titleFromName('reading-time')).toBe('Reading Time');
  });

  it('parses flags', () => {
    expect(
      parseArgs(['my-plugin', '--title', 'Mine', '--description=One line', '--no-database', '-y']),
    ).toEqual({
      name: 'my-plugin',
      title: 'Mine',
      description: 'One line',
      database: false,
      yes: true,
    });
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['a', 'b'])).toThrow(/one name/);
    expect(() => parseArgs(['a', '--title'])).toThrow(/needs a value/);
  });
});

describe('create-pressbase-plugin', () => {
  it('refuses invalid names and existing folders', async () => {
    const cwd = await temp();
    const out = output();
    expect(await main(['Bad_Name', '--yes'], { stdout: out.stream, cwd })).toBe(1);
    expect(out.text()).toMatch(/isn't a valid plugin name/);
    expect(await main(['ok-name', '--yes'], { stdout: out.stream, cwd })).toBe(0);
    expect(await main(['ok-name', '--yes'], { stdout: out.stream, cwd })).toBe(1);
    expect(out.text()).toMatch(/already exists/);
  });

  it('leaves out the database example with --no-database', async () => {
    const cwd = await temp();
    const { files, directory } = await scaffold({
      name: 'no-db',
      database: false,
      directory: path.join(cwd, 'no-db'),
    });
    expect(files).not.toContain('migrations/0001-create-greetings.sql');
    const manifest = JSON.parse(await readFile(path.join(directory, 'plugin.json'), 'utf8'));
    expect(manifest.permissions).toEqual([]);
    expect(manifest.migrations).toBeUndefined();
    const source = await readFile(path.join(directory, 'src/index.ts'), 'utf8');
    expect(source).not.toMatch(/api\.db|@database|TABLE/);
  });

  it('scaffolds a plugin that builds, typechecks, packs, installs and runs', async () => {
    const cwd = await temp();
    const out = output();
    const code = await main(
      ['hello-world', '--yes', '--title', 'Hello World', '--author', 'Ada', '--sdk', 'workspace:*'],
      { stdout: out.stream, cwd },
    );
    expect(code, out.text()).toBe(0);
    const dir = path.join(cwd, 'hello-world');
    const read = (file: string) => readFile(path.join(dir, file), 'utf8');

    const manifest = JSON.parse(await read('plugin.json'));
    expect(manifest).toMatchObject({
      name: 'hello-world',
      title: 'Hello World',
      author: 'Ada',
      main: 'dist/index.js',
      permissions: ['database'],
      migrations: 'migrations',
    });
    const pkg = JSON.parse(await read('package.json'));
    expect(pkg.devDependencies['@pressbase/plugin-sdk']).toBe('workspace:*');
    expect(await read('.gitignore')).toContain('dist/');
    const source = await read('src/index.ts');
    expect(source).toContain("'hello-world/v1'");
    expect(source).not.toMatch(/__PLUGIN_|@database-/);
    expect(await read('migrations/0001-create-greetings.sql')).toContain('hello_world_greetings');

    await linkDependencies(dir);
    await run(process.execPath, ['build.mjs'], { cwd: dir });
    const built = await read('dist/index.js');
    // The SDK's helpers are bundled; none of core is.
    expect(built).toContain('function definePlugin');
    expect(built).not.toMatch(/from ["']@pressbase\//);
    expect(built.length).toBeLessThan(20_000);

    // The scaffolded source typechecks against the SDK's generated types.
    await run(process.execPath, [path.join(dir, 'node_modules/typescript/bin/tsc'), '-p', dir], {
      cwd: dir,
    });

    await run(process.execPath, ['scripts/pack.mjs'], { cwd: dir });
    const zipPath = path.join(dir, 'hello-world-0.1.0.zip');
    expect((await stat(zipPath)).size).toBeGreaterThan(0);
    const zip = new Uint8Array(await readFile(zipPath));
    expect(
      readZip(zip, { maxTotalBytes: 10_000_000 })
        .map((e) => e.name)
        .sort(),
    ).toEqual([
      'hello-world/README.md',
      'hello-world/dist/index.js',
      'hello-world/dist/index.js.map',
      'hello-world/migrations/0001-create-greetings.sql',
      'hello-world/plugin.json',
      'hello-world/public/style.css',
    ]);

    // Install the .zip through core's installer, activate it, use it.
    const ctx = await setup();
    try {
      await ctx.install();
      ctx.kernel.plugins.directories = { site: path.join(ctx.dataDir, 'plugins'), bundled: null };
      const installed = await ctx.kernel.plugins.install(zip, { maxBytes: 32 * 1024 * 1024 });
      expect(installed.slug).toBe('hello-world');
      await ctx.kernel.plugins.activate('hello-world', { permissions: ['database'] });
      expect(await ctx.kernel.options.get(PLUGIN_MIGRATIONS)).toEqual({
        'hello-world': ['0001-create-greetings.sql'],
      });

      const hello = await ctx.request('GET', '/hello-world/v1/hello?name=Ada');
      expect(hello.status).toBe(200);
      expect(hello.body).toEqual({ greeting: 'Hello, Ada!', count: 1 });
      expect((await ctx.request('GET', '/hello-world/v1/hello')).body.count).toBe(2);
      // The authenticated route: the test client is logged in as the administrator.
      const greetings = await ctx.request('GET', '/hello-world/v1/greetings');
      expect(greetings.status).toBe(200);
      expect(greetings.body.map((g: { name: string }) => g.name)).toEqual(['world', 'Ada']);

      const css = await ctx.app.request('/wp-content/plugins/hello-world/style.css?ver=0.1.0');
      expect(css.status).toBe(200);
      const render = await ctx.app.request('/wp-json/pressbase/v1/render?url=%2F');
      const { html } = (await render.json()) as { html: string };
      expect(html).toContain('<meta name="hello-world" content="0.1.0" />');
      expect(html).toContain('/wp-content/plugins/hello-world/style.css?ver=0.1.0');

      await ctx.kernel.plugins.deactivate('hello-world');
      await ctx.kernel.plugins.delete('hello-world');
      expect((await ctx.request('GET', '/hello-world/v1/hello')).status).toBe(404);
    } finally {
      await ctx.kernel.shutdown();
    }
  });
});
