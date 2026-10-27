import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { DEFAULT_ROLES, resolveCapabilities } from './auth/capabilities';
import { hashPassword, needsRehash, verifyPassword } from './auth/password';
import { SITE, setup } from './test-utils';

describe('installer', () => {
  it('reports needs-install when the database is configured but empty', async () => {
    const { request } = await setup();
    const res = await request('GET', '/pressbase/v1/install');
    expect(res.body.state).toBe('needs-install');
    expect(res.body.databaseFromEnv).toBe(true);
    expect(res.body.checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
  });

  it('installs the site, signs the admin in and seeds WordPress-style defaults', async () => {
    const { request, kernel } = await setup();
    const res = await request('POST', '/pressbase/v1/install', { site: SITE });
    expect(res.status).toBe(201);
    expect(kernel.state).toBe('ready');

    const me = await request('GET', '/wp/v2/users/me');
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('admin');
    expect(me.body.roles).toEqual(['administrator']);
    expect(me.body.capabilities.manage_options).toBe(true);

    const dashboard = await request('GET', '/pressbase/v1/dashboard');
    expect(dashboard.body.counts).toMatchObject({ posts: 1, pages: 1, comments: 1 });
    expect(dashboard.body.site).toMatchObject({ title: 'Test Site', url: 'http://localhost:3000' });

    expect(await kernel.options.get('timezone_string')).toBe('Asia/Kolkata');
  });

  it('refuses a second installation', async () => {
    const { request } = await setup();
    await request('POST', '/pressbase/v1/install', { site: SITE });
    const again = await request('POST', '/pressbase/v1/install', { site: SITE });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('pressbase_already_installed');
  });

  it('returns field-level messages for invalid input', async () => {
    const { request } = await setup();
    const res = await request('POST', '/pressbase/v1/install', {
      site: { ...SITE, email: 'not-an-email', password: 'short' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('rest_invalid_param');
    expect(Object.keys(res.body.data.params)).toEqual(
      expect.arrayContaining(['site.email', 'site.password']),
    );
  });

  it('requires the setup code when one is configured', async () => {
    const { request } = await setup({ setupToken: 'open-sesame' });
    const denied = await request('POST', '/pressbase/v1/install', {
      site: SITE,
      setupToken: 'nope',
    });
    expect(denied.status).toBe(403);
    const allowed = await request('POST', '/pressbase/v1/install', {
      site: SITE,
      setupToken: 'open-sesame',
    });
    expect(allowed.status).toBe(201);
  });

  it('sets up an embedded database and saves config.json when none is configured', async () => {
    const { request, kernel, dataDir } = await setup({
      databaseUrl: undefined,
      databaseFromEnv: false,
    });
    expect(kernel.state).toBe('needs-database');

    const res = await request('POST', '/pressbase/v1/install', {
      database: { kind: 'embedded' },
      site: SITE,
    });
    expect(res.status).toBe(201);
    const file = path.join(dataDir, 'config.json');
    expect(JSON.parse(await readFile(file, 'utf8')).databaseUrl).toBe(
      `pglite:${path.join(dataDir, 'db')}`,
    );
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('explains database connection failures in plain language', async () => {
    const { request } = await setup({ databaseUrl: undefined, databaseFromEnv: false });
    const res = await request('POST', '/pressbase/v1/install/database-check', {
      database: {
        kind: 'postgres',
        host: '127.0.0.1',
        port: 1,
        name: 'pressbase',
        user: 'pressbase',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('pressbase_db_refused');
    expect(res.body.data.hint).toMatch(/PostgreSQL is running/);
  });
});

describe('authentication', () => {
  async function installed() {
    const ctx = await setup();
    await ctx.request('POST', '/pressbase/v1/install', { site: SITE });
    ctx.clearCookie();
    return ctx;
  }

  it('logs in with username or email and logs out', async () => {
    const { request, clearCookie } = await installed();
    expect((await request('GET', '/wp/v2/users/me')).status).toBe(401);

    const login = await request('POST', '/pressbase/v1/auth/login', {
      login: 'ADMIN@example.com',
      password: SITE.password,
    });
    expect(login.status).toBe(200);
    expect((await request('GET', '/wp/v2/users/me')).status).toBe(200);

    await request('POST', '/pressbase/v1/auth/logout');
    clearCookie();
    expect((await request('GET', '/wp/v2/users/me')).status).toBe(401);
  });

  it('gives the same answer for an unknown user and a wrong password', async () => {
    const { request } = await installed();
    const unknown = await request('POST', '/pressbase/v1/auth/login', {
      login: 'ghost',
      password: 'x',
    });
    const wrong = await request('POST', '/pressbase/v1/auth/login', {
      login: 'admin',
      password: 'x',
    });
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('locks out after five failed attempts', async () => {
    const { request } = await installed();
    for (let i = 0; i < 5; i++) {
      await request('POST', '/pressbase/v1/auth/login', { login: 'admin', password: 'wrong' });
    }
    const locked = await request('POST', '/pressbase/v1/auth/login', {
      login: 'admin',
      password: SITE.password,
    });
    expect(locked.status).toBe(429);
  });

  it.each([
    ['WordPress 6.8+ bcrypt', '$wp$2y$10$tes3bQytvZ69BqQLRphk/ur0gWONRjw62zyQGjq.qxbHWUqF/bjC6'],
    ['phpass', '$P$BanTSbIFxngeBnrtMEcuNtNlm1dauL/'],
  ])('accepts an imported %s hash once, then re-hashes it with scrypt', async (_, hash) => {
    const { request, kernel } = await installed();
    await kernel.db.update(schema.users).set({ pass: hash }).where(eq(schema.users.login, 'admin'));

    const wrong = await request('POST', '/pressbase/v1/auth/login', {
      login: 'admin',
      password: 'Password',
    });
    expect(wrong.status).toBe(401);
    const ok = await request('POST', '/pressbase/v1/auth/login', {
      login: 'admin',
      password: 'password',
    });
    expect(ok.status).toBe(200);

    const [row] = await kernel.db
      .select({ pass: schema.users.pass })
      .from(schema.users)
      .where(eq(schema.users.login, 'admin'));
    expect(row?.pass).toMatch(/^\$scrypt\$/);
    expect(await verifyPassword('password', row?.pass ?? '')).toBe(true);
  });

  it('rejects unsafe requests without the X-Pressbase-Request header', async () => {
    const { kernel } = await installed();
    const res = await createApp(kernel).request('/wp-json/pressbase/v1/auth/logout', {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });
});

describe('settings', () => {
  it('reads and validates WordPress-compatible settings', async () => {
    const { request } = await setup();
    await request('POST', '/pressbase/v1/install', { site: SITE });

    const current = await request('GET', '/wp/v2/settings');
    expect(current.body).toMatchObject({
      title: 'Test Site',
      timezone: 'Asia/Kolkata',
      posts_per_page: 10,
    });

    const bad = await request('POST', '/wp/v2/settings', {
      title: 'Renamed',
      timezone: 'Mars/Olympus',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.data.params).toHaveProperty('timezone');
    // Nothing is saved when any field is invalid.
    expect((await request('GET', '/wp/v2/settings')).body.title).toBe('Test Site');

    const ok = await request('POST', '/wp/v2/settings', { title: 'Renamed', unknown_field: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.title).toBe('Renamed');
  });

  it('is closed to logged-out visitors', async () => {
    const { request, clearCookie } = await setup();
    await request('POST', '/pressbase/v1/install', { site: SITE });
    clearCookie();
    expect((await request('GET', '/wp/v2/settings')).status).toBe(401);
  });
});

describe('roles', () => {
  it('match WordPress defaults', () => {
    const { capabilities } = resolveCapabilities({ editor: true }, DEFAULT_ROLES);
    expect(capabilities.edit_others_posts).toBe(true);
    expect(capabilities.manage_options).toBeUndefined();
    expect(Object.keys(DEFAULT_ROLES.author!.capabilities).sort()).toEqual(
      [
        'delete_posts',
        'delete_published_posts',
        'edit_posts',
        'edit_published_posts',
        'publish_posts',
        'read',
        'upload_files',
      ].sort(),
    );
  });

  it('honour direct grants and revocations', () => {
    const { roles, capabilities } = resolveCapabilities(
      { author: true, manage_seo: true, upload_files: false },
      DEFAULT_ROLES,
    );
    expect(roles).toEqual(['author']);
    expect(capabilities.manage_seo).toBe(true);
    expect(capabilities.upload_files).toBe(false);
  });
});

describe('passwords', () => {
  it('hash, verify and flag foreign hashes for rehash', async () => {
    const hash = await hashPassword('secret');
    expect(await verifyPassword('secret', hash)).toBe(true);
    expect(await verifyPassword('Secret', hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);
    expect(needsRehash('$P$Bsomething')).toBe(true);
  });
});

describe('routing', () => {
  it('serves the index with and without a trailing slash', async () => {
    const { kernel } = await setup();
    const app = createApp(kernel);
    for (const url of ['/wp-json', '/wp-json/']) {
      const res = await app.request(url);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { pressbase: { state: string } }).pressbase.state).toBe(
        'needs-install',
      );
    }
  });
});
