import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { PRESSBASE_VERSION } from '@pressbase/core/src/version';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/bootstrap';
import { run, tempDir } from './helpers';

/**
 * The CLI configuring and booting Pressbase itself, from a data folder:
 * core install, db check and migrate, the built-in database's lock, help,
 * and errors. Each test uses its own temporary data folder.
 */

const INSTALL = [
  'core',
  'install',
  '--builtin-database',
  '--url=http://localhost:4510',
  '--title=Field notes',
  '--admin_user=admin',
  '--admin_email=admin@example.com',
  '--admin_password=a long passphrase',
];

describe('configuration', () => {
  it('resolves the data folder as core does, with --data-dir winning', async () => {
    const cwd = await tempDir();
    expect((await resolveConfig({}, { cwd, dataDir: 'site' })).dataDir).toBe(
      path.join(cwd, 'site'),
    );
    expect((await resolveConfig({ PRESSBASE_DATA_DIR: 'other' }, { cwd })).dataDir).toBe(
      path.join(cwd, 'other'),
    );
    // Without either: core's own default, .pressbase in apps/core.
    expect((await resolveConfig({}, { cwd })).dataDir).toMatch(/apps[\\/]core[\\/]\.pressbase$/);
  });

  it('reads config.json and lets DATABASE_URL win over it', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ databaseUrl: 'pglite:/x' }));
    expect((await resolveConfig({}, { cwd: dir, dataDir: dir })).databaseUrl).toBe('pglite:/x');
    const env = { DATABASE_URL: 'postgres://u:p@db/site' };
    expect((await resolveConfig(env, { cwd: dir, dataDir: dir })).databaseUrl).toBe(
      env.DATABASE_URL,
    );
  });
});

describe('core and db commands', () => {
  it('prints the version without a site', async () => {
    const result = await run(['core', 'version']);
    expect(result).toEqual({ code: 0, stdout: `${PRESSBASE_VERSION}\n`, stderr: '' });
  });

  it('installs on the built-in database, then checks and migrates it', async () => {
    const dir = await tempDir();
    const env = { PRESSBASE_DATA_DIR: dir };

    const check = await run(['db', 'check'], { env });
    expect(check.code).toBe(1);
    expect(check.stderr).toMatch(/No database is set up/);

    const missing = await run(
      [
        'core',
        'install',
        '--url=http://localhost:4510',
        '--title=T',
        '--admin_user=admin',
        '--admin_email=admin@example.com',
      ],
      { env },
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/--database-url=postgres:\/\/… or --builtin-database/);

    const invalid = await run(
      [...INSTALL.slice(0, -2), '--admin_email=nope', '--admin_password=a long passphrase'],
      { env },
    );
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toBe('Error: --admin_email: Enter a valid email address.\n');

    const install = await run(INSTALL, { env });
    expect(install.stderr).toMatch(/isn’t meant for live sites/);
    expect(install.stdout).toBe('Success: Pressbase installed successfully.\n');
    expect(install.code).toBe(0);
    expect(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'))).toEqual({
      databaseUrl: `pglite:${path.join(dir, 'db')}`,
    });

    const again = await run(INSTALL, { env });
    expect(again).toMatchObject({ code: 0, stdout: 'Pressbase is already installed.\n' });

    const status = await run(['db', 'check', '--format=json'], { env });
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout.split('\n')[0] ?? '')).toMatchObject({
      driver: 'built-in',
      connected: true,
      pending: [],
      installed: true,
    });
    expect(await run(['db', 'migrate'], { env })).toMatchObject({
      code: 0,
      stdout: 'Success: The database schema is already up to date.\n',
    });

    // The site works from the command line, and the admin can log in with the password.
    const title = await run(['option', 'get', 'blogname'], { env });
    expect(title.stdout).toBe('Field notes\n');
    const users = await run(['user', 'list', '--field=user_login'], { env });
    expect(users.stdout).toBe('admin\n');
  });

  it('generates and prints a password when none is given', async () => {
    const dir = await tempDir();
    const result = await run(INSTALL.slice(0, -1), { env: { PRESSBASE_DATA_DIR: dir } });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Admin password: \S{24}\n/);
  });

  it('says plainly when the site isn’t installed', async () => {
    const dir = await tempDir();
    const result = await run(['post', 'list'], { env: { PRESSBASE_DATA_DIR: dir } });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /^Error: No database is set up for the site in .+ Run “pressbase core install”/,
    );
  });
});

describe('the built-in database lock', () => {
  it('refuses to open a database the server holds, without touching it', async () => {
    const dir = await tempDir();
    const env = { PRESSBASE_DATA_DIR: dir };
    expect((await run(INSTALL, { env })).code).toBe(0);

    // A live process (standing in for the server) holds the lock.
    const server = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      const lock = path.join(dir, 'db.lock');
      await writeFile(
        lock,
        JSON.stringify({
          pid: server.pid,
          hostname: hostname(),
          process: 'the Pressbase server',
          since: new Date().toISOString(),
        }),
      );
      for (const argv of [
        ['post', 'list'],
        ['db', 'check'],
        ['db', 'migrate'],
      ]) {
        const result = await run(argv, { env });
        expect(result.code).toBe(1);
        expect(result.stderr).toBe(
          `Error: The built-in database is in use by another Pressbase process (the Pressbase server, process ${server.pid}). Stop the Pressbase server first, or use PostgreSQL.\n`,
        );
      }
      expect(JSON.parse(await readFile(lock, 'utf8')).pid).toBe(server.pid);
    } finally {
      server.kill();
    }
    // Once it's gone, the CLI takes the stale lock over.
    await new Promise((resolve) => server.on('exit', resolve));
    expect((await run(['option', 'get', 'blogname'], { env })).stdout).toBe('Field notes\n');
  });
});

describe('help and errors', () => {
  it('lists commands, groups and a command’s options', async () => {
    const dir = await tempDir();
    const top = await run(['help'], { env: { PRESSBASE_DATA_DIR: dir } });
    expect(top.code).toBe(0);
    expect(top.stdout).toMatch(/SUBCOMMANDS[\s\S]+search-replace/);

    const group = await run(['post']);
    expect(group.stdout).toMatch(/pressbase post <command>[\s\S]+list\s+Lists posts\./);

    for (const argv of [
      ['post', 'list', '--help'],
      ['help', 'post', 'list'],
    ]) {
      const help = await run(argv);
      expect(help.code).toBe(0);
      expect(help.stdout).toMatch(/^NAME\n\n {2}pressbase post list\n/);
      expect(help.stdout).toMatch(/\[--post_type=<post_type>\]\n {4}One or more post types/);
      expect(help.stdout).toMatch(/EXAMPLES/);
    }
  });

  it('exits with 1 and says what to do next', async () => {
    expect(await run(['nonsense'], { env: { PRESSBASE_DATA_DIR: await tempDir() } })).toMatchObject(
      {
        code: 1,
        stderr: expect.stringMatching(
          /“nonsense” isn’t a pressbase command\. See “pressbase help”/,
        ),
      },
    );
    expect(await run(['post', 'frobnicate'])).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/“pressbase post” has no command “frobnicate”/),
    });
    expect(await run(['core', 'version', '--colour'])).toMatchObject({
      code: 1,
      stderr:
        '--colour isn’t an option of “pressbase core version”. See “pressbase help core version”.\n'.replace(
          /^/,
          'Error: ',
        ),
    });
  });
});
