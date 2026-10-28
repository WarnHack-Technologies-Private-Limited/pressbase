import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { schema } from '@pressbase/db';
import { afterEach } from 'vitest';
import { createApp } from './app';
import { hashPassword } from './auth/password';
import type { Config } from './config';
import { Kernel } from './kernel';

/**
 * Shared harness for API tests: a fresh kernel on in-memory PostgreSQL, and
 * HTTP clients that keep their own session cookie and send the CSRF header.
 */

export const SITE = {
  title: 'Test Site',
  username: 'admin',
  password: 'correct horse battery staple',
  email: 'admin@example.com',
  url: 'http://localhost:3000/',
  timezone: 'Asia/Kolkata',
};

const kernels: Kernel[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(kernels.splice(0).map((k) => k.shutdown()));
  // Notification mail is sent without being awaited, so the outbox can still be
  // receiving files while the directory is removed (ENOTEMPTY); retry briefly.
  await Promise.all(
    dirs
      .splice(0)
      .map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

export interface TestResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: tests inspect arbitrary JSON.
  body: any;
  headers: Headers;
}

export async function setup(overrides: Partial<Config> = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'pressbase-test-'));
  dirs.push(dataDir);
  const kernel = new Kernel({
    dataDir,
    port: 0,
    databaseUrl: 'pglite:memory',
    databaseFromEnv: true,
    setupToken: undefined,
    ...overrides,
  });
  kernels.push(kernel);
  // No network in API tests: Site Health's outgoing requests fail unless a test stubs them.
  kernel.siteHealth.fetch = () => Promise.reject(new Error('The network is off in tests.'));
  await kernel.boot();
  const app = createApp(kernel);

  /** An HTTP client with its own cookie jar. */
  const client = () => {
    let cookie = '';
    const request = async (
      method: string,
      url: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ): Promise<TestResponse> => {
      const res = await app.request(`/wp-json${url}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-pressbase-request': '1',
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0] ?? '';
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    return { request, clearCookie: () => (cookie = '') };
  };

  const main = client();

  /** Creates a user with a role and returns a client logged in as them. */
  const loginAs = async (login: string, role: string) => {
    const [user] = await kernel.db
      .insert(schema.users)
      .values({
        login,
        pass: await hashPassword('password-123'),
        nicename: login,
        email: `${login}@example.com`,
        displayName: login,
      })
      .returning({ id: schema.users.id });
    await kernel.db
      .insert(schema.usermeta)
      .values({ userId: user?.id ?? 0, key: 'capabilities', value: { [role]: true } });
    const c = client();
    const res = await c.request('POST', '/pressbase/v1/auth/login', {
      login,
      password: 'password-123',
    });
    if (res.status !== 200)
      throw new Error(`Could not log in as ${login}: ${JSON.stringify(res.body)}`);
    return { ...c, id: user?.id ?? 0 };
  };

  /** Installs the site; the main client is then logged in as the administrator. */
  const install = async () => {
    const res = await main.request('POST', '/pressbase/v1/install', { site: SITE });
    if (res.status !== 201) throw new Error(`Install failed: ${JSON.stringify(res.body)}`);
  };

  return {
    kernel,
    app,
    dataDir,
    client,
    loginAs,
    install,
    request: main.request,
    clearCookie: main.clearCookie,
  };
}
