import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { renderHtml } from './mail/template';
import { chunkPassword } from './people/application-passwords';
import { isEmail, sanitizeUser, validateUsername } from './people/validation';
import { SITE, setup } from './test-utils';

async function installed() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

const basic = (login: string, password: string) =>
  `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;

/** A request without the CSRF header or cookies, as an API client sends it. */
async function apiClient(
  app: Awaited<ReturnType<typeof setup>>['app'],
  method: string,
  url: string,
  auth: string,
  body?: unknown,
) {
  const res = await app.request(`/wp-json${url}`, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

interface OutboxMail {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

/** Waits for the outbox to hold `n` messages (some are sent without being awaited). */
async function outbox(dataDir: string, n = 1): Promise<OutboxMail[]> {
  const dir = path.join(dataDir, 'outbox');
  for (let i = 0; i < 100; i += 1) {
    const files = await readdir(dir).catch(() => [] as string[]);
    const json = files.filter((f) => f.endsWith('.json')).sort();
    if (json.length >= n) {
      return Promise.all(
        json.map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8')) as OutboxMail),
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Expected ${n} message(s) in the outbox.`);
}

const linkIn = (mail: OutboxMail) => {
  const match = /(http\S+\/reset-password\?\S+)/.exec(mail.text);
  if (!match?.[1]) throw new Error('No reset link in the email.');
  const url = new URL(match[1]);
  return {
    url,
    key: url.searchParams.get('key') ?? '',
    login: url.searchParams.get('login') ?? '',
  };
};

const newUser = {
  username: 'grace',
  email: 'grace@example.com',
  password: 'a long and lovely password',
  first_name: 'Grace',
  last_name: 'Hopper',
  roles: ['editor'],
};

/* ------------------------------------------------------------ validation */

describe('user input checks', () => {
  it('ports validate_username() and is_email()', () => {
    expect(validateUsername('grace')).toBe(true);
    expect(validateUsername('grace.hopper@navy')).toBe(true);
    expect(validateUsername('grace hopper')).toBe(true);
    expect(validateUsername('<b>grace</b>')).toBe(false);
    expect(validateUsername('grâce')).toBe(false);
    expect(validateUsername(' grace')).toBe(false);
    expect(validateUsername('')).toBe(false);
    expect(validateUsername('a'.repeat(61))).toBe(false);
    expect(sanitizeUser('Grâce!')).toBe('Grace');

    expect(isEmail('grace@example.com')).toBe(true);
    expect(isEmail('g+tag@mail.example.co.uk')).toBe(true);
    expect(isEmail('grace@localhost')).toBe(false);
    expect(isEmail('grace@@example.com')).toBe(false);
    expect(isEmail('grace@exa..mple.com')).toBe(false);
    expect(isEmail('@example.com')).toBe(false);
  });

  it('groups application passwords in fours, as WordPress shows them', () => {
    expect(chunkPassword('abcdEFGH1234ijklMNOP5678')).toBe('abcd EFGH 1234 ijkl MNOP 5678');
  });

  it('escapes everything in the HTML email template', () => {
    const html = renderHtml({
      siteName: '<script>x</script>',
      heading: 'Hi & welcome',
      paragraphs: ['"quoted" <b>'],
      action: { label: 'Go', url: 'https://example.com/?a=1&b="2"' },
    });
    expect(html).not.toContain('<script>x');
    expect(html).toContain('Hi &amp; welcome');
    expect(html).toContain('&quot;quoted&quot; &lt;b&gt;');
    expect(html).toContain('a=1&amp;b=&quot;2&quot;');
  });
});

/* ----------------------------------------------------------------- CRUD */

describe('POST /wp/v2/users', () => {
  it('creates a user with profile meta and roles; they can log in', async () => {
    const { request, client, kernel } = await installed();
    const res = await request('POST', '/wp/v2/users', { ...newUser, url: 'grace.example.com' });
    expect(res.status).toBe(201);
    expect(res.headers.get('Location')).toBe(`/wp-json/wp/v2/users/${res.body.id}`);
    expect(res.body).toMatchObject({
      username: 'grace',
      name: 'Grace Hopper',
      first_name: 'Grace',
      last_name: 'Hopper',
      nickname: 'grace',
      email: 'grace@example.com',
      slug: 'grace',
      url: 'http://grace.example.com/',
      roles: ['editor'],
      locale: 'en_US',
    });
    expect(res.body.capabilities.edit_others_posts).toBe(true);
    expect(res.body.capabilities.editor).toBe(true);
    expect(res.body.registered_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(res.body.password).toBeUndefined();

    const [row] = await kernel.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.login, 'grace'));
    expect(row?.pass).toMatch(/^\$scrypt\$/);
    const meta = await kernel.db
      .select()
      .from(schema.usermeta)
      .where(eq(schema.usermeta.userId, res.body.id));
    expect(Object.fromEntries(meta.map((m) => [m.key, m.value]))).toMatchObject({
      first_name: 'Grace',
      last_name: 'Hopper',
      nickname: 'grace',
      capabilities: { editor: true },
    });

    const grace = client();
    const login = await grace.request('POST', '/pressbase/v1/auth/login', {
      login: 'GRACE@example.com',
      password: newUser.password,
    });
    expect(login.status).toBe(200);
  });

  it('defaults to the default_role option and makes nicenames unique', async () => {
    const { request } = await installed();
    const first = await request('POST', '/wp/v2/users', {
      username: 'ada.l',
      email: 'ada@example.com',
      password: 'secret words here',
    });
    expect(first.body.roles).toEqual(['subscriber']);
    expect(first.body.slug).toBe('adal');
    const second = await request('POST', '/wp/v2/users', {
      username: 'ada l',
      email: 'ada2@example.com',
      password: 'secret words here',
    });
    expect(second.body.slug).toBe('ada-l');
    const third = await request('POST', '/wp/v2/users', {
      username: 'adal',
      email: 'ada3@example.com',
      password: 'secret words here',
    });
    expect(third.body.slug).toBe('adal-2');
  });

  it('validates usernames, emails, passwords and roles like WordPress', async () => {
    const { request } = await installed();
    const cases: [Record<string, unknown>, string, string?][] = [
      [{ ...newUser, username: 'bad<name>' }, 'rest_user_invalid_username', 'username'],
      [{ ...newUser, username: 'ADMIN' }, 'existing_user_login', 'username'],
      [{ ...newUser, email: SITE.email.toUpperCase() }, 'existing_user_email', 'email'],
      [{ ...newUser, email: 'not-an-email' }, 'rest_user_invalid_email', 'email'],
      [{ ...newUser, password: 'back\\slash' }, 'rest_user_invalid_password', 'password'],
      [{ ...newUser, roles: ['overlord'] }, 'rest_user_invalid_role', 'roles'],
      [{ username: 'x' }, 'rest_missing_callback_param', 'email'],
    ];
    for (const [body, code, field] of cases) {
      const res = await request('POST', '/wp/v2/users', body);
      expect(res.status, code).toBe(400);
      expect(res.body.code).toBe(code);
      if (field) expect(res.body.data.params[field]).toBeTruthy();
    }
  });

  it('refuses editors and visitors', async () => {
    const { loginAs, client } = await installed();
    const editor = await loginAs('eddie', 'editor');
    const res = await editor.request('POST', '/wp/v2/users', newUser);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('rest_cannot_create_user');
    const visitor = await client().request('POST', '/wp/v2/users', newUser);
    expect(visitor.status).toBe(401);
  });

  it('emails the new user a link to set their password when asked', async () => {
    const { request, dataDir, client } = await installed();
    const res = await request('POST', '/wp/v2/users', {
      ...newUser,
      send_user_notification: true,
    });
    expect(res.status).toBe(201);
    const [mail] = await outbox(dataDir);
    expect(mail?.to).toEqual(['grace@example.com']);
    expect(mail?.subject).toBe('[Test Site] Login details');
    expect(mail?.text).toContain('Username: grace');
    const { key, login, url } = linkIn(mail as OutboxMail);
    expect(url.origin + url.pathname).toBe('http://localhost:3000/reset-password');
    const check = await client().request('POST', '/pressbase/v1/auth/check-reset-key', {
      key,
      login,
    });
    expect(check.status).toBe(200);
  });
});

describe('GET /wp/v2/users', () => {
  it('filters by role and reports role and post counts', async () => {
    const { request, loginAs } = await installed();
    await loginAs('eddie', 'editor');
    await loginAs('ava', 'author');
    const editors = await request('GET', '/wp/v2/users?roles=editor&context=edit');
    expect(editors.body.map((u: { username: string }) => u.username)).toEqual(['eddie']);
    const counts = await request('GET', '/pressbase/v1/user-counts?include=1');
    expect(counts.body).toMatchObject({
      total: 3,
      roles: { administrator: 1, editor: 1, author: 1, contributor: 0, subscriber: 0 },
      posts: { 1: 2 }, // Hello world and the sample page.
    });
  });

  it('keeps role filters and counts for people who can list users', async () => {
    const { loginAs } = await installed();
    const author = await loginAs('ava', 'author');
    expect((await author.request('GET', '/wp/v2/users?roles=administrator')).body.code).toBe(
      'rest_user_cannot_view',
    );
    expect((await author.request('GET', '/pressbase/v1/user-counts')).status).toBe(403);
  });
});

describe('POST /wp/v2/users/{id}', () => {
  it('lets people edit their own profile but not their role', async () => {
    const { loginAs } = await installed();
    const author = await loginAs('ava', 'author');
    const res = await author.request('POST', '/wp/v2/users/me', {
      first_name: 'Ava',
      last_name: 'Lovelace',
      name: 'Ava L.',
      nickname: 'ava',
      description: 'Writes about engines.',
      url: 'https://ava.example',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Ava L.',
      first_name: 'Ava',
      description: 'Writes about engines.',
      url: 'https://ava.example/',
    });
    const roles = await author.request('PATCH', `/wp/v2/users/${author.id}`, {
      roles: ['administrator'],
    });
    expect(roles.status).toBe(403);
    expect(roles.body.code).toBe('rest_cannot_edit_roles');
    const other = await author.request('POST', '/wp/v2/users/1', { first_name: 'Hacked' });
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('rest_cannot_edit');
    const username = await author.request('POST', '/wp/v2/users/me', { username: 'other' });
    expect(username.body.code).toBe('rest_user_invalid_argument');
  });

  it('lets administrators change roles, but not remove their own', async () => {
    const { request, loginAs } = await installed();
    const author = await loginAs('ava', 'author');
    const promoted = await request('PUT', `/wp/v2/users/${author.id}`, { roles: ['editor'] });
    expect(promoted.status).toBe(200);
    expect(promoted.body.roles).toEqual(['editor']);

    const self = await request('POST', '/wp/v2/users/1', { roles: ['editor'] });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('rest_user_invalid_role');

    // With a second administrator, the first still can't demote themselves
    // (WordPress's rule), but can demote the other one.
    await request('POST', `/wp/v2/users/${author.id}`, { roles: ['administrator'] });
    expect((await request('POST', '/wp/v2/users/me', { roles: ['author'] })).status).toBe(403);
    const demoted = await request('POST', `/wp/v2/users/${author.id}`, { roles: ['author'] });
    expect(demoted.body.roles).toEqual(['author']);
  });

  it('refuses an email address another account uses', async () => {
    const { request, loginAs } = await installed();
    const author = await loginAs('ava', 'author');
    const res = await request('POST', `/wp/v2/users/${author.id}`, { email: SITE.email });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('rest_user_invalid_email');
    // Changing only the case of your own address is fine.
    const own = await author.request('POST', '/wp/v2/users/me', { email: 'AVA@example.com' });
    expect(own.body.email).toBe('AVA@example.com');
  });

  it('logs other sessions out on a password change and tells the user', async () => {
    const { request, client, dataDir } = await installed();
    const elsewhere = client();
    await elsewhere.request('POST', '/pressbase/v1/auth/login', {
      login: SITE.username,
      password: SITE.password,
    });
    expect((await elsewhere.request('GET', '/wp/v2/users/me')).status).toBe(200);

    const res = await request('POST', '/wp/v2/users/me', { password: 'a brand new passphrase' });
    expect(res.status).toBe(200);
    expect((await request('GET', '/wp/v2/users/me')).status).toBe(200);
    expect((await elsewhere.request('GET', '/wp/v2/users/me')).status).toBe(401);
    const [mail] = await outbox(dataDir);
    expect(mail?.subject).toBe('[Test Site] Password changed');
  });
});

describe('DELETE /wp/v2/users/{id}', () => {
  it('needs force and reassign, as WordPress does', async () => {
    const { request, loginAs } = await installed();
    const author = await loginAs('ava', 'author');
    const noForce = await request('DELETE', `/wp/v2/users/${author.id}?reassign=1`);
    expect(noForce.status).toBe(501);
    expect(noForce.body.code).toBe('rest_trash_not_supported');
    const noReassign = await request('DELETE', `/wp/v2/users/${author.id}?force=true`);
    expect(noReassign.status).toBe(400);
    const toSelf = await request(
      'DELETE',
      `/wp/v2/users/${author.id}?force=true&reassign=${author.id}`,
    );
    expect(toSelf.body.code).toBe('rest_user_invalid_reassign');
    const toNobody = await request('DELETE', `/wp/v2/users/${author.id}?force=true&reassign=999`);
    expect(toNobody.body.code).toBe('rest_user_invalid_reassign');
  });

  it('moves posts to the reassigned user', async () => {
    const { request, loginAs } = await installed();
    const author = await loginAs('ava', 'author');
    const post = await author.request('POST', '/wp/v2/posts', { title: 'Mine', status: 'publish' });
    const res = await request('DELETE', `/wp/v2/users/${author.id}?force=true&reassign=1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, previous: { username: 'ava' } });
    const moved = await request('GET', `/wp/v2/posts/${post.body.id}`);
    expect(moved.body.author).toBe(1);
    expect((await request('GET', `/wp/v2/users/${author.id}`)).status).toBe(404);
    // Their session went with them.
    expect((await author.request('GET', '/wp/v2/users/me')).status).toBe(401);
  });

  it('deletes posts when reassign is false', async () => {
    const { request, loginAs } = await installed();
    const author = await loginAs('ava', 'author');
    const post = await author.request('POST', '/wp/v2/posts', { title: 'Mine', status: 'draft' });
    const res = await request('DELETE', `/wp/v2/users/${author.id}?force=true&reassign=false`);
    expect(res.status).toBe(200);
    expect((await request('GET', `/wp/v2/posts/${post.body.id}?context=edit`)).status).toBe(404);
  });

  it('refuses people without delete_users, and keeps the last administrator', async () => {
    const { request, loginAs } = await installed();
    const editor = await loginAs('eddie', 'editor');
    const denied = await editor.request('DELETE', '/wp/v2/users/1?force=true&reassign=false');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('rest_user_cannot_delete');
    const last = await request('DELETE', `/wp/v2/users/me?force=true&reassign=${editor.id}`);
    expect(last.status).toBe(403);
    expect(last.body.code).toBe('rest_user_cannot_delete');
  });
});

/* -------------------------------------------------- application passwords */

describe('application passwords', () => {
  async function withPassword() {
    const ctx = await installed();
    const created = await ctx.request('POST', '/wp/v2/users/me/application-passwords', {
      name: 'Deploy script',
    });
    return { ...ctx, created };
  }

  it('shows the new password once, grouped in fours, and stores only a hash', async () => {
    const { request, created, kernel } = await withPassword();
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Deploy script', app_id: '', last_used: null });
    expect(created.body.password).toMatch(/^([A-Za-z0-9]{4} ){5}[A-Za-z0-9]{4}$/);
    expect(created.body.uuid).toMatch(/^[0-9a-f-]{36}$/);

    const list = await request('GET', '/wp/v2/users/1/application-passwords');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].password).toBeUndefined();

    const [meta] = await kernel.db
      .select()
      .from(schema.usermeta)
      .where(eq(schema.usermeta.key, '_application_passwords'));
    const stored = JSON.stringify(meta?.value);
    expect(stored).not.toContain(created.body.password.replace(/ /g, ''));
    expect(stored).toContain('$generic$');

    const duplicate = await request('POST', '/wp/v2/users/me/application-passwords', {
      name: 'Deploy script',
    });
    expect(duplicate.body.code).toBe('application_password_duplicate_name');
  });

  it('accepts application passwords only over HTTPS or on a local host', async () => {
    const { app, created } = await withPassword();
    const auth = basic('admin', created.body.password);
    const send = (headers: Record<string, string>) =>
      app.request('/wp-json/wp/v2/users/me', { headers: { authorization: auth, ...headers } });

    // A public site reached over plain HTTP (through the admin's proxy).
    const plain = await send({ 'x-forwarded-host': 'example.com' });
    expect(plain.status).toBe(401);
    expect(((await plain.json()) as { code: string }).code).toBe('application_passwords_disabled');

    // The same site over HTTPS, and local development over HTTP, both work.
    expect(
      (await send({ 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'https' })).status,
    ).toBe(200);
    expect((await send({ 'x-forwarded-host': 'mysite.test' })).status).toBe(200);
  });

  it('authenticates REST requests over Basic auth, without the CSRF header', async () => {
    const { app, created, request } = await withPassword();
    const auth = basic('admin', created.body.password);
    const me = await apiClient(app, 'GET', '/wp/v2/users/me', auth);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('admin');

    // Spaces are optional, and the email works as the username.
    const compact = basic(SITE.email, created.body.password.replace(/ /g, ''));
    const post = await apiClient(app, 'POST', '/wp/v2/posts', compact, {
      title: 'From the API',
      status: 'publish',
    });
    expect(post.status).toBe(201);

    const intro = await apiClient(
      app,
      'GET',
      '/wp/v2/users/me/application-passwords/introspect',
      auth,
    );
    expect(intro.body.uuid).toBe(created.body.uuid);
    const list = await request('GET', '/wp/v2/users/me/application-passwords');
    expect(list.body[0].last_used).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Cookie requests have no application password to introspect.
    expect((await request('GET', '/wp/v2/users/me/application-passwords/introspect')).status).toBe(
      404,
    );
  });

  it('answers bad credentials with WordPress’s codes', async () => {
    const { app } = await withPassword();
    const wrong = await apiClient(app, 'GET', '/wp/v2/users/me', basic('admin', 'nope'));
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('incorrect_password');
    const unknown = await apiClient(app, 'GET', '/wp/v2/users/me', basic('ghost', 'x'));
    expect(unknown.body.code).toBe('invalid_username');
    const unknownEmail = await apiClient(
      app,
      'GET',
      '/wp/v2/posts',
      basic('ghost@example.com', 'x'),
    );
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body.code).toBe('invalid_email');
    // The account password is not an application password.
    const account = await apiClient(app, 'GET', '/wp/v2/users/me', basic('admin', SITE.password));
    expect(account.body.code).toBe('incorrect_password');
  });

  it('stops working once revoked, and never works on the login form', async () => {
    const { app, created, request, client } = await withPassword();
    const login = await client().request('POST', '/pressbase/v1/auth/login', {
      login: 'admin',
      password: created.body.password,
    });
    expect(login.status).toBe(401);
    expect(login.body.code).toBe('pressbase_invalid_credentials');

    const revoked = await request(
      'DELETE',
      `/wp/v2/users/me/application-passwords/${created.body.uuid}`,
    );
    expect(revoked.body).toMatchObject({ deleted: true, previous: { name: 'Deploy script' } });
    const after = await apiClient(
      app,
      'GET',
      '/wp/v2/users/me',
      basic('admin', created.body.password),
    );
    expect(after.status).toBe(401);
  });

  it('ignores the session cookie when an Authorization header is present', async () => {
    const { request } = await installed();
    // The test client sends its session cookie along with this header.
    const res = await request('GET', '/wp/v2/users/me', undefined, { authorization: 'Bearer x' });
    expect(res.status).toBe(401);
  });

  it('can be managed for yourself, or by people with edit_users', async () => {
    const { request, loginAs } = await installed();
    const author = await loginAs('ava', 'author');
    const own = await author.request('POST', '/wp/v2/users/me/application-passwords', {
      name: 'Phone',
    });
    expect(own.status).toBe(201);
    const others = await author.request('GET', '/wp/v2/users/1/application-passwords');
    expect(others.status).toBe(403);
    expect(others.body.code).toBe('rest_cannot_list_application_passwords');
    const asAdmin = await request('GET', `/wp/v2/users/${author.id}/application-passwords`);
    expect(asAdmin.body.map((p: { name: string }) => p.name)).toEqual(['Phone']);
    const renamed = await request(
      'POST',
      `/wp/v2/users/${author.id}/application-passwords/${own.body.uuid}`,
      { name: 'Old phone' },
    );
    expect(renamed.body.name).toBe('Old phone');
    const all = await request('DELETE', `/wp/v2/users/${author.id}/application-passwords`);
    expect(all.body).toEqual({ deleted: true, count: 1 });
  });

  it('fires WordPress’s hooks, and the errors hook can refuse a password', async () => {
    const { app, created, kernel } = await withPassword();
    const seen: string[] = [];
    kernel.hooks.addAction('application_password_did_authenticate', (_user, item) => {
      seen.push(item.name);
    });
    const auth = basic('admin', created.body.password);
    expect((await apiClient(app, 'GET', '/wp/v2/users/me', auth)).status).toBe(200);
    expect(seen).toEqual(['Deploy script']);
    kernel.hooks.addAction('wp_authenticate_application_password_errors', (errors) => {
      errors.add('ip_not_allowed', 'Not from here.');
    });
    const refused = await apiClient(app, 'GET', '/wp/v2/users/me', auth);
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('ip_not_allowed');
  });
});

/* ------------------------------------------------------------------ mail */

describe('kernel.mail', () => {
  it('writes to the outbox when SMTP isn’t set up, and runs the wp_mail filter', async () => {
    const { kernel, dataDir } = await installed();
    expect(kernel.mail.transport).toBe('outbox');
    kernel.hooks.addFilter('wp_mail', (mail) => ({ ...mail, subject: `${mail.subject}!` }));
    const sent = await kernel.mail.send({
      to: 'someone@example.com',
      subject: 'Hello',
      text: 'Hi',
    });
    expect(sent).toBe(true);
    const [mail] = await outbox(dataDir);
    expect(mail).toMatchObject({ to: ['someone@example.com'], subject: 'Hello!', text: 'Hi' });
    const files = await readdir(path.join(dataDir, 'outbox'));
    const eml = files.find((f) => f.endsWith('.eml')) ?? '';
    const raw = await readFile(path.join(dataDir, 'outbox', eml), 'utf8');
    expect(raw).toContain('Subject: Hello!');
    expect(raw).toMatch(/From: Test Site <pressbase@localhost>/);
  });

  it('can be short-circuited, and reports failures through wp_mail_failed', async () => {
    const { kernel } = await installed();
    const failures: string[] = [];
    kernel.hooks.addAction('wp_mail_failed', (error) => {
      failures.push(error.message);
    });
    expect(await kernel.mail.send({ to: '', subject: 'x', text: 'x' })).toBe(false);
    expect(failures).toHaveLength(1);
    const off = kernel.hooks.addFilter('pre_wp_mail', () => true);
    expect(await kernel.mail.send({ to: '', subject: 'x', text: 'x' })).toBe(true);
    off();
  });
});

/* -------------------------------------------------------- password reset */

describe('lost and reset password', () => {
  it('answers the same whether or not the account exists', async () => {
    const { client, dataDir } = await installed();
    const visitor = client();
    const unknown = await visitor.request('POST', '/pressbase/v1/auth/lost-password', {
      login: 'nobody',
    });
    const known = await visitor.request('POST', '/pressbase/v1/auth/lost-password', {
      login: 'admin',
    });
    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    const mails = await outbox(dataDir);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toEqual([SITE.email]);
    expect(mails[0]?.subject).toBe('[Test Site] Password reset');
    expect(mails[0]?.html).toContain('Choose a new password');
  });

  it('resets the password with the emailed key, once, and logs the user out everywhere', async () => {
    const { client, dataDir, request } = await installed();
    const visitor = client();
    await visitor.request('POST', '/pressbase/v1/auth/lost-password', { login: SITE.email });
    const { key, login } = linkIn((await outbox(dataDir))[0] as OutboxMail);
    expect(login).toBe('admin');

    const check = await visitor.request('POST', '/pressbase/v1/auth/check-reset-key', {
      key,
      login,
    });
    expect(check.body).toEqual({ ok: true, login: 'admin' });
    const weak = await visitor.request('POST', '/pressbase/v1/auth/reset-password', {
      key,
      login,
      password: '',
    });
    expect(weak.body.data.params.password).toBeTruthy();

    const reset = await visitor.request('POST', '/pressbase/v1/auth/reset-password', {
      key,
      login,
      password: 'a fresh new passphrase',
    });
    expect(reset.status).toBe(200);
    expect((await request('GET', '/wp/v2/users/me')).status).toBe(401);
    const again = await visitor.request('POST', '/pressbase/v1/auth/reset-password', {
      key,
      login,
      password: 'yet another one',
    });
    expect(again.body.code).toBe('invalid_key');
    const relogin = await visitor.request('POST', '/pressbase/v1/auth/login', {
      login: 'admin',
      password: 'a fresh new passphrase',
    });
    expect(relogin.status).toBe(200);
  });

  it('refuses wrong and expired keys', async () => {
    const { client, dataDir, kernel } = await installed();
    const visitor = client();
    await visitor.request('POST', '/pressbase/v1/auth/lost-password', { login: 'admin' });
    const { key, login } = linkIn((await outbox(dataDir))[0] as OutboxMail);
    const wrong = await visitor.request('POST', '/pressbase/v1/auth/reset-password', {
      // Change the last character to one it isn't (a fixed 'X' was flaky: 1 key in 64 ends in X).
      key: `${key.slice(0, -1)}${key.endsWith('X') ? 'Y' : 'X'}`,
      login,
      password: 'whatever it is',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('invalid_key');

    const [row] = await kernel.db.select().from(schema.users).where(eq(schema.users.id, 1));
    const [, hash] = (row?.activationKey ?? '').split(/:(.*)/s);
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86_400;
    await kernel.db
      .update(schema.users)
      .set({ activationKey: `${twoDaysAgo}:${hash}` })
      .where(eq(schema.users.id, 1));
    const expired = await visitor.request('POST', '/pressbase/v1/auth/reset-password', {
      key,
      login,
      password: 'whatever it is',
    });
    expect(expired.body.code).toBe('expired_key');
  });

  it('is rate limited', async () => {
    const { client } = await installed();
    const visitor = client();
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      last = (
        await visitor.request('POST', '/pressbase/v1/auth/lost-password', { login: `user${i}` })
      ).status;
    }
    expect(last).toBe(429);
  });
});
