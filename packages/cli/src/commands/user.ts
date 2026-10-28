import { currentUserCan } from '@pressbase/core/src/auth/meta-caps';
import {
  applicationPasswordsAvailable,
  chunkPassword,
  createApplicationPassword,
  deleteAllApplicationPasswords,
  deleteApplicationPassword,
  listApplicationPasswords,
} from '@pressbase/core/src/people/application-passwords';
import {
  sendEmailChangedEmail,
  sendNewUserEmail,
  sendPasswordChangedEmail,
} from '@pressbase/core/src/people/password-reset';
import {
  checkRoleChange,
  checkUserDeletion,
  deleteUser,
  destroyUserSessions,
  insertUser,
  metaFor,
  PROFILE_META_KEYS,
  profileMeta,
  rolesFromGrants,
  setUserRoles,
  siteRoles,
  type UserInput,
  type UserRow,
  updateUser,
} from '@pressbase/core/src/people/users';
import { userWriteBody } from '@pressbase/core/src/routes/users';
import { schema } from '@pressbase/db';
import { and, asc, ilike, inArray, or } from 'drizzle-orm';
import type { CommandSpec, Context } from '../command';
import { findUserRow, generatePassword, gmtDate, service } from './shared';

/**
 * `pressbase user`: wp-cli's entity-command for users, on core's people
 * services (wp_insert_user(), wp_update_user(), wp_delete_user()…) with the
 * REST API's validation schema and the same rules for roles and deletion.
 */

const FIELDS = [
  'ID',
  'user_login',
  'display_name',
  'user_email',
  'user_registered',
  'roles',
  'user_nicename',
  'user_url',
  'first_name',
  'last_name',
  'nickname',
  'description',
];
const LIST_FIELDS = ['ID', 'user_login', 'display_name', 'user_email', 'user_registered', 'roles'];

async function rowsFor(ctx: Context, users: UserRow[]) {
  const roles = await siteRoles(ctx.kernel);
  const meta = await metaFor(
    ctx.kernel,
    users.map((u) => u.id),
    [...PROFILE_META_KEYS, 'capabilities'],
  );
  return users.map((u) => {
    const m = meta.get(u.id);
    const profile = profileMeta(m);
    const grants = (m?.get('capabilities') as Record<string, boolean> | undefined) ?? {};
    return {
      ID: u.id,
      user_login: u.login,
      display_name: u.displayName,
      user_email: u.email,
      user_registered: gmtDate(u.registeredAt),
      roles: rolesFromGrants(grants, roles).join(','),
      user_nicename: u.nicename,
      user_url: u.url,
      first_name: profile.first_name,
      last_name: profile.last_name,
      nickname: profile.nickname,
      description: profile.description,
    };
  });
}

/** --user_pass, --display_name… → the REST body, validated by its schema. */
function writeInput(ctx: Context): UserInput & { send_user_notification?: boolean } {
  const body: Record<string, unknown> = {};
  const map: [string, string][] = [
    ['user_email', 'email'],
    ['user_pass', 'password'],
    ['display_name', 'name'],
    ['user_nicename', 'slug'],
    ['user_url', 'url'],
    ['first_name', 'first_name'],
    ['last_name', 'last_name'],
    ['nickname', 'nickname'],
    ['description', 'description'],
    ['locale', 'locale'],
  ];
  for (const [flag, field] of map) {
    const value = ctx.string(flag);
    if (value !== undefined) body[field] = value;
  }
  const parsed = userWriteBody.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? '');
    const flag = map.find(([, f]) => f === field)?.[0] ?? field;
    ctx.error(`--${flag}: ${issue?.message ?? 'This value isn’t valid.'}`);
  }
  const { meta: _meta, ...rest } = parsed.data;
  return rest;
}

/** Checks a role change for --user and for the site (the last administrator stays). */
async function checkRoles(ctx: Context, target: number, roles: string[]) {
  await ctx.require('promote_user', target, `${ctx.user?.login} isn’t allowed to change roles.`);
  await service(() => checkRoleChange(ctx.kernel, target, roles, ctx.user));
}

const OPTIONS_TEXT = {
  user: 'The user’s ID, login or email address.',
  user_pass: 'The password. Left out when creating, a strong one is generated and printed.',
  user_email: 'The email address.',
  display_name: 'The name shown on the site.',
  user_nicename: 'The slug used in author archive addresses.',
  user_url: 'The user’s website.',
  role: 'The role (administrator, editor, author, contributor, subscriber…).',
  porcelain: 'Print only the new user’s ID.',
};

export const userCommands: CommandSpec[] = [
  {
    name: 'user list',
    shortdesc: 'Lists users.',
    synopsis:
      '[--role=<role>] [--include=<ids>] [--search=<text>] [--fields=<fields>] [--field=<field>] [--format=<format>]',
    options: {
      role: 'Only users with this role.',
      include: 'Only these user IDs, comma-separated.',
      search: 'Only users whose login, email or display name contains this text.',
    },
    examples: [
      ['pressbase user list --role=administrator --field=user_login', 'List administrators’ logins'],
      ['pressbase user list --format=csv', 'Export users as CSV'],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require('list_users');
      const { users } = schema;
      const search = ctx.string('search');
      const like = search ? `%${search.replace(/[%_\\]/g, '\\$&')}%` : undefined;
      const include = ctx.ids('include');
      const rows = await ctx.kernel.db
        .select()
        .from(users)
        .where(
          and(
            like
              ? or(ilike(users.login, like), ilike(users.email, like), ilike(users.displayName, like))
              : undefined,
            include ? inArray(users.id, include) : undefined,
          ),
        )
        .orderBy(asc(users.login));
      let items = await rowsFor(ctx, rows);
      const role = ctx.string('role');
      if (role) items = items.filter((i) => i.roles.split(',').includes(role));
      ctx.formatItems(items, LIST_FIELDS, { all: FIELDS });
    },
  },
  {
    name: 'user get',
    shortdesc: 'Shows a user.',
    synopsis: '<user> [--field=<field>] [--fields=<fields>] [--format=<format>]',
    options: { user: OPTIONS_TEXT.user },
    examples: [['pressbase user get admin --field=user_email', 'Show an email address']],
    needs: 'installed',
    async run(ctx) {
      const user = await findUserRow(ctx.kernel, ctx.args[0] ?? '');
      if (ctx.user && ctx.user.id !== user.id) await ctx.require('list_users');
      const [row] = await rowsFor(ctx, [user]);
      ctx.formatItem(row ?? {}, FIELDS, { all: FIELDS });
    },
  },
  {
    name: 'user create',
    shortdesc: 'Creates a user.',
    synopsis:
      '<user-login> <user-email> [--role=<role>] [--user_pass=<password>] [--display_name=<name>] [--user_nicename=<slug>] [--user_url=<url>] [--first_name=<first-name>] [--last_name=<last-name>] [--description=<description>] [--send-email] [--porcelain]',
    options: {
      ...OPTIONS_TEXT,
      'user-login': 'The login name.',
      'user-email': 'The email address.',
      role: 'The role. Default: the site’s default role (Settings → General).',
      'send-email': 'Email the new user a link to set their password.',
    },
    examples: [
      ['pressbase user create sam sam@example.com --role=author', 'Create an author'],
      ['pressbase user create sam sam@example.com --porcelain', 'Create a user and print only the ID'],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require('create_users', undefined, `${ctx.user?.login} isn’t allowed to create users.`);
      const [login = '', email = ''] = ctx.args;
      const input = writeInput(ctx);
      const role = ctx.string('role');
      if (role) {
        await ctx.require('promote_users', undefined, `${ctx.user?.login} isn’t allowed to give users a role.`);
        const known = await siteRoles(ctx.kernel);
        if (!known[role]) ctx.error(`There’s no role “${role}”. Roles: ${Object.keys(known).join(', ')}.`);
      }
      const generated = input.password === undefined;
      const password = input.password ?? generatePassword();
      const user = await service(() =>
        insertUser(ctx.kernel, {
          ...input,
          username: login,
          email,
          password,
          roles: role ? [role] : undefined,
        }),
      );
      await ctx.kernel.hooks.doAction('rest_insert_user', user, { username: login, email }, true);
      if (ctx.flag('send-email')) await sendNewUserEmail(ctx.kernel, user);
      if (ctx.flag('porcelain')) {
        ctx.line(String(user.id));
        return;
      }
      ctx.success(`Created user ${user.id}.`);
      if (generated) ctx.line(`Password: ${password}`);
    },
  },
  {
    name: 'user update',
    shortdesc: 'Updates one or more users.',
    synopsis:
      '<user>... [--user_pass=<password>] [--user_email=<email>] [--display_name=<name>] [--user_nicename=<slug>] [--user_url=<url>] [--first_name=<first-name>] [--last_name=<last-name>] [--nickname=<nickname>] [--description=<description>] [--role=<role>] [--skip-email]',
    options: {
      ...OPTIONS_TEXT,
      'skip-email': 'Don’t send the “password changed” or “email changed” notices.',
    },
    examples: [['pressbase user update sam --display_name="Sam Rivera"', 'Change a display name']],
    needs: 'installed',
    async run(ctx) {
      const input = writeInput(ctx);
      const role = ctx.string('role');
      if (!Object.keys(input).length && !role) {
        ctx.error('Give at least one field to change, such as --display_name=<name>.');
      }
      for (const value of ctx.args) {
        const user = await findUserRow(ctx.kernel, value);
        if (Object.keys(input).length) {
          await ctx.require('edit_user', user.id, `${ctx.user?.login} isn’t allowed to edit ${user.login}.`);
        }
        if (role) await checkRoles(ctx, user.id, [role]);
        const result = await service(() =>
          updateUser(ctx.kernel, user.id, { ...input, roles: role ? [role] : undefined }),
        );
        if (result.passwordChanged) {
          // The user is logged out everywhere, as after a change in the admin.
          await destroyUserSessions(ctx.kernel, user.id);
          if (!ctx.flag('skip-email')) await sendPasswordChangedEmail(ctx.kernel, result.user);
        }
        if (result.emailChanged && !ctx.flag('skip-email')) {
          await sendEmailChangedEmail(ctx.kernel, result.previous.email, result.user);
        }
        ctx.success(`Updated user ${user.id}.`);
      }
    },
  },
  {
    name: 'user delete',
    shortdesc: 'Deletes one or more users, giving their content to someone else or deleting it.',
    synopsis: '<user>... [--reassign=<user>]',
    options: {
      user: OPTIONS_TEXT.user,
      reassign: 'Give the users’ posts and media to this user. Without it, they’re deleted.',
    },
    examples: [
      ['pressbase user delete sam --reassign=admin', 'Delete a user and keep their posts'],
      ['pressbase user delete 7 8 --yes', 'Delete two users and their content, without asking'],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require('delete_users', undefined, `${ctx.user?.login} isn’t allowed to delete users.`);
      const reassignFlag = ctx.string('reassign');
      const reassign = reassignFlag ? (await findUserRow(ctx.kernel, reassignFlag)).id : null;
      const users = [];
      for (const value of ctx.args) users.push(await findUserRow(ctx.kernel, value));
      if (reassign === null) {
        await ctx.confirm(
          `--reassign wasn’t given, so everything ${users.map((u) => u.login).join(', ')} wrote will be deleted too. Continue?`,
        );
      }
      for (const user of users) {
        await service(async () => {
          await checkUserDeletion(ctx.kernel, user.id, reassign);
          await deleteUser(ctx.kernel, user.id, reassign);
        });
        ctx.success(
          reassign ? `Deleted user ${user.id}; their content now belongs to user ${reassign}.` : `Deleted user ${user.id}.`,
        );
      }
    },
  },
  {
    name: 'user set-role',
    shortdesc: 'Sets a user’s role, replacing the roles they had.',
    synopsis: '<user> [<role>]',
    options: { user: OPTIONS_TEXT.user, role: 'The role. Default: the site’s default role.' },
    examples: [['pressbase user set-role sam editor', 'Make someone an editor']],
    needs: 'installed',
    async run(ctx) {
      const user = await findUserRow(ctx.kernel, ctx.args[0] ?? '');
      const role =
        ctx.args[1] ?? (await ctx.kernel.options.get<string>('default_role', 'subscriber'));
      await checkRoles(ctx, user.id, [role]);
      await setUserRoles(ctx.kernel, user.id, [role]);
      ctx.success(`${user.login} (${user.id}) now has the ${role} role.`);
    },
  },
  {
    name: 'user reset-password',
    shortdesc: 'Gives users a new random password and logs them out everywhere.',
    synopsis: '<user>... [--skip-email] [--show-password] [--porcelain]',
    options: {
      user: OPTIONS_TEXT.user,
      'skip-email': 'Don’t send the “password changed” notice.',
      'show-password': 'Print the new password.',
      porcelain: 'Print only the new password.',
    },
    examples: [['pressbase user reset-password sam --skip-email --show-password', 'Reset and show a password']],
    needs: 'installed',
    async run(ctx) {
      for (const value of ctx.args) {
        const user = await findUserRow(ctx.kernel, value);
        await ctx.require('edit_user', user.id, `${ctx.user?.login} isn’t allowed to edit ${user.login}.`);
        const password = generatePassword();
        const result = await service(() => updateUser(ctx.kernel, user.id, { password }));
        await destroyUserSessions(ctx.kernel, user.id);
        if (!ctx.flag('skip-email')) await sendPasswordChangedEmail(ctx.kernel, result.user);
        if (ctx.flag('porcelain')) {
          ctx.line(password);
          continue;
        }
        ctx.success(`Reset the password of ${user.login}.`);
        if (ctx.flag('show-password')) ctx.line(`Password: ${password}`);
      }
    },
  },
  {
    name: 'user application-password create',
    shortdesc: 'Creates an application password, for API clients.',
    synopsis: '<user> <app-name> [--app-id=<app-id>] [--porcelain]',
    options: {
      user: OPTIONS_TEXT.user,
      'app-name': 'A name that says what will use it, unique for the user.',
      'app-id': 'An optional UUID identifying the application.',
      porcelain: 'Print only the password.',
    },
    examples: [['pressbase user application-password create admin "Deploy script" --porcelain', 'Create one for a script']],
    needs: 'installed',
    async run(ctx) {
      const user = await findUserRow(ctx.kernel, ctx.args[0] ?? '');
      await ctx.require('edit_user', user.id, `${ctx.user?.login} isn’t allowed to edit ${user.login}.`);
      if (!(await applicationPasswordsAvailable(ctx.kernel, user.id))) {
        ctx.error(`Application passwords are turned off for ${user.login} on this site.`);
      }
      const { password } = await service(() =>
        createApplicationPassword(ctx.kernel, user.id, {
          name: ctx.args[1] ?? '',
          app_id: ctx.string('app-id'),
        }),
      );
      if (ctx.flag('porcelain')) {
        ctx.line(chunkPassword(password));
        return;
      }
      ctx.success('Created the application password. Copy it now: it won’t be shown again.');
      ctx.line(`Password: ${chunkPassword(password)}`);
    },
  },
  {
    name: 'user application-password list',
    shortdesc: 'Lists a user’s application passwords.',
    synopsis: '<user> [--name=<name>] [--fields=<fields>] [--field=<field>] [--format=<format>]',
    options: { user: OPTIONS_TEXT.user, name: 'Only the one with this name.' },
    examples: [['pressbase user application-password list admin --fields=uuid,name', 'List them']],
    needs: 'installed',
    async run(ctx) {
      const user = await findUserRow(ctx.kernel, ctx.args[0] ?? '');
      await ctx.require('edit_user', user.id, `${ctx.user?.login} isn’t allowed to edit ${user.login}.`);
      const name = ctx.string('name');
      const items = (await listApplicationPasswords(ctx.kernel, user.id))
        .filter((p) => name === undefined || p.name === name)
        .map((p) => ({
          uuid: p.uuid,
          app_id: p.app_id,
          name: p.name,
          created: p.created,
          last_used: p.last_used,
          last_ip: p.last_ip,
        }));
      ctx.formatItems(items, ['uuid', 'app_id', 'name', 'created', 'last_used', 'last_ip'], {
        idField: 'uuid',
      });
    },
  },
  {
    name: 'user application-password delete',
    shortdesc: 'Deletes application passwords, so the apps using them can no longer log in.',
    synopsis: '<user> [<uuid>...] [--all]',
    options: {
      user: OPTIONS_TEXT.user,
      uuid: 'The passwords’ UUIDs (see “pressbase user application-password list”).',
      all: 'Delete all of the user’s application passwords.',
    },
    examples: [['pressbase user application-password delete admin --all --yes', 'Delete all of them']],
    needs: 'installed',
    async run(ctx) {
      const [value = '', ...uuids] = ctx.args;
      const user = await findUserRow(ctx.kernel, value);
      if (ctx.user && !(await currentUserCan(ctx.kernel, ctx.user, 'edit_user', user.id))) {
        ctx.error(`${ctx.user.login} isn’t allowed to edit ${user.login}.`);
      }
      if (ctx.flag('all')) {
        await ctx.confirm(`Delete all application passwords of ${user.login}?`);
        const n = await deleteAllApplicationPasswords(ctx.kernel, user.id);
        ctx.success(`Deleted ${n} application password${n === 1 ? '' : 's'}.`);
        return;
      }
      if (!uuids.length) ctx.error('Give the UUIDs to delete, or --all.');
      for (const uuid of uuids) {
        await service(() => deleteApplicationPassword(ctx.kernel, user.id, uuid));
        ctx.success(`Deleted application password ${uuid}.`);
      }
    },
  },
];
