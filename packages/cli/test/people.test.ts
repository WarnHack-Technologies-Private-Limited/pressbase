import { verifyPassword } from '@pressbase/core/src/auth/password';
import { listApplicationPasswords } from '@pressbase/core/src/people/application-passwords';
import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { site } from './helpers';

/** user and option commands, on an in-memory site. */

describe('user', () => {
  it('lists, shows, creates and updates users', async () => {
    const s = await site();
    expect(await s.ok(['user', 'list', '--fields=ID,user_login,roles', '--format=csv'])).toBe(
      'ID,user_login,roles\n1,admin,administrator\n',
    );
    const created = await s.ok([
      'user',
      'create',
      'sam',
      'sam@example.com',
      '--role=author',
      '--display_name=Sam Rivera',
    ]);
    expect(created).toMatch(/^Success: Created user 2\.\nPassword: \S{24}\n$/);
    expect(
      await s.ok([
        'user',
        'get',
        'sam@example.com',
        '--fields=display_name,roles',
        '--format=json',
      ]),
    ).toBe('{"display_name":"Sam Rivera","roles":"author"}\n');
    expect(
      await s.ok([
        'user',
        'create',
        'kit',
        'kit@example.com',
        '--user_pass=another passphrase',
        '--porcelain',
      ]),
    ).toBe('3\n');
    expect(await s.ok(['user', 'list', '--role=subscriber', '--field=user_login'])).toBe('kit\n');

    const dupe = await s.cli(['user', 'create', 'sam', 'other@example.com']);
    expect(dupe).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/username already exists/),
    });
    const badEmail = await s.cli(['user', 'create', 'lee', 'not-an-email']);
    expect(badEmail.stderr).toMatch(/Invalid email address/);
    const badRole = await s.cli(['user', 'create', 'lee', 'lee@example.com', '--role=wizard']);
    expect(badRole.stderr).toMatch(/There’s no role “wizard”/);

    expect(
      await s.ok(['user', 'update', 'sam', 'kit', '--description=Writes things', '--skip-email']),
    ).toBe('Success: Updated user 2.\nSuccess: Updated user 3.\n');
    expect(await s.ok(['user', 'get', '3', '--field=description'])).toBe('Writes things\n');
    await s.ok(['user', 'update', 'kit', '--user_pass=a fresh passphrase', '--skip-email']);
    const [row] = await s.kernel.db.select().from(schema.users).where(eq(schema.users.id, 3));
    expect(await verifyPassword('a fresh passphrase', row?.pass ?? '')).toBe(true);
  });

  it('sets roles, but never removes the last administrator', async () => {
    const s = await site();
    await s.ok(['user', 'create', 'sam', 'sam@example.com', '--porcelain']);
    expect(await s.ok(['user', 'set-role', 'sam', 'editor'])).toBe(
      'Success: sam (2) now has the editor role.\n',
    );
    expect(await s.ok(['user', 'set-role', 'sam'])).toBe(
      'Success: sam (2) now has the subscriber role.\n',
    );
    const last = await s.cli(['user', 'set-role', 'admin', 'editor']);
    expect(last.stderr).toMatch(/needs at least one administrator/);
    const editorRun = await s.cli(['user', 'set-role', 'admin', 'subscriber', '--user=sam']);
    expect(editorRun.stderr).toBe('Error: sam isn’t allowed to change roles.\n');
  });

  it('deletes users, reassigning their posts or (after confirming) deleting them', async () => {
    const s = await site();
    await s.ok(['user', 'create', 'sam', 'sam@example.com', '--role=author', '--porcelain']);
    await s.ok(['user', 'create', 'kit', 'kit@example.com', '--role=author', '--porcelain']);
    const samPost = (
      await s.ok(['post', 'create', '--post_title=By Sam', '--post_author=2', '--porcelain'])
    ).trim();
    const kitPost = (
      await s.ok(['post', 'create', '--post_title=By Kit', '--post_author=3', '--porcelain'])
    ).trim();

    expect(await s.ok(['user', 'delete', 'sam', '--reassign=admin'])).toBe(
      'Success: Deleted user 2; their content now belongs to user 1.\n',
    );
    expect(await s.ok(['post', 'get', samPost, '--field=post_author'])).toBe('1\n');

    const asked = await s.cli(['user', 'delete', 'kit']);
    expect(asked.code).toBe(1);
    expect(asked.stderr).toMatch(
      /--reassign wasn’t given, so everything kit wrote will be deleted too\. Continue\? Add --yes/,
    );
    expect(await s.ok(['user', 'delete', 'kit', '--yes'])).toBe('Success: Deleted user 3.\n');
    expect((await s.cli(['post', 'get', kitPost])).code).toBe(1);

    const self = await s.cli(['user', 'delete', 'admin', '--yes']);
    expect(self.stderr).toMatch(/needs at least one administrator/);
    const badReassign = await s.cli(['user', 'delete', 'admin', '--reassign=admin']);
    expect(badReassign.stderr).toMatch(/Invalid user ID for reassignment/);
  });

  it('resets passwords', async () => {
    const s = await site();
    const out = await s.ok(['user', 'reset-password', 'admin', '--skip-email', '--porcelain']);
    const [row] = await s.kernel.db.select().from(schema.users).where(eq(schema.users.id, 1));
    expect(await verifyPassword(out.trim(), row?.pass ?? '')).toBe(true);
    expect(await s.ok(['user', 'reset-password', 'admin', '--skip-email'])).toBe(
      'Success: Reset the password of admin.\n',
    );
  });

  it('creates, lists and deletes application passwords', async () => {
    const s = await site();
    const password = (
      await s.ok([
        'user',
        'application-password',
        'create',
        'admin',
        'Deploy script',
        '--porcelain',
      ])
    ).trim();
    expect(password).toMatch(/^(\w{4} ){5}\w{4}$/);
    const list = JSON.parse(
      await s.ok(['user', 'application-password', 'list', 'admin', '--format=json']),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Deploy script', last_used: null });

    // The password works for the REST API.
    const res = await s.app.request('/wp-json/wp/v2/users/me', {
      headers: { authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` },
    });
    expect(res.status).toBe(200);

    const dupe = await s.cli(['user', 'application-password', 'create', 'admin', 'Deploy script']);
    expect(dupe.stderr).toMatch(/unique/);
    expect(await s.ok(['user', 'application-password', 'delete', 'admin', list[0].uuid])).toBe(
      `Success: Deleted application password ${list[0].uuid}.\n`,
    );
    await s.ok(['user', 'application-password', 'create', 'admin', 'One']);
    await s.ok(['user', 'application-password', 'create', 'admin', 'Two']);
    expect(await s.ok(['user', 'application-password', 'delete', 'admin', '--all', '--yes'])).toBe(
      'Success: Deleted 2 application passwords.\n',
    );
    expect(await listApplicationPasswords(s.kernel, 1)).toEqual([]);
  });
});

describe('option', () => {
  it('gets, adds, updates, lists and deletes options', async () => {
    const s = await site();
    expect(await s.ok(['option', 'get', 'blogname'])).toBe('Test Site\n');
    expect(await s.ok(['option', 'get', 'active_plugins', '--format=json'])).toBe('[]\n');
    expect((await s.cli(['option', 'get', 'nope'])).stderr).toBe(
      'Error: There’s no option “nope”.\n',
    );

    expect(await s.ok(['option', 'update', 'blogname', 'Field notes'])).toBe(
      "Success: Updated 'blogname' option.\n",
    );
    expect(await s.ok(['option', 'update', 'blogname', 'Field notes'])).toBe(
      "Success: Value passed for 'blogname' option is unchanged.\n",
    );
    // A registered setting keeps its type and its rules.
    await s.ok(['option', 'update', 'posts_per_page', '5']);
    expect(await s.kernel.options.get('posts_per_page')).toBe(5);
    const refused = await s.cli(['option', 'update', 'timezone_string', 'Mars/Olympus']);
    expect(refused).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/timezone_string: Choose a valid time zone/),
    });

    expect(
      await s.ok(['option', 'add', 'cli_settings', '--format=json'], { stdin: '{"a":[1,2]}\n' }),
    ).toBe("Success: Added 'cli_settings' option.\n");
    expect(await s.kernel.options.get('cli_settings')).toEqual({ a: [1, 2] });
    expect((await s.cli(['option', 'add', 'cli_settings', 'x'])).stderr).toMatch(/already exists/);
    expect(
      (await s.cli(['option', 'update', 'cli_settings', '{', '--format=json'])).stderr,
    ).toMatch(/isn’t valid JSON/);

    expect(await s.ok(['option', 'list', '--search=cli_*', '--format=json'])).toBe(
      '[{"option_name":"cli_settings","option_value":"{\\"a\\":[1,2]}"}]\n',
    );
    expect(await s.ok(['option', 'delete', 'cli_settings'])).toBe(
      "Success: Deleted 'cli_settings' option.\n",
    );
    const gone = await s.cli(['option', 'delete', 'cli_settings']);
    expect(gone).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/Could not delete 'cli_settings' option/),
    });

    await s.loginAs('ed', 'editor');
    expect((await s.cli(['option', 'get', 'blogname', '--user=ed'])).stderr).toMatch(
      /needs the manage_options capability/,
    );
  });
});
