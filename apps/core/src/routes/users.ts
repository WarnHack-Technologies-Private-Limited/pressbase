import { schema } from '@pressbase/db';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { resolveCapabilities } from '../auth/capabilities';
import { currentUserCan } from '../auth/meta-caps';
import { SESSION_COOKIE } from '../auth/sessions';
import { type CurrentUser, userCan } from '../auth/users';
import { type AppEnv, invalidParams, readJson, restError } from '../http';
import type { Kernel } from '../kernel';
import {
  sendEmailChangedEmail,
  sendNewUserEmail,
  sendPasswordChangedEmail,
} from '../people/password-reset';
import {
  administratorIds,
  countPostsByUsers,
  countUsers,
  deleteUser,
  destroyUserSessions,
  insertUser,
  metaFor,
  PROFILE_META_KEYS,
  profileMeta,
  rolesFromGrants,
  siteRoles,
  UserError,
  type UserInput,
  type UserRow,
  updateUser,
} from '../people/users';
import {
  authStatus,
  boolParam,
  contextParam,
  intList,
  pageParam,
  perPageParam,
  queryObject,
  setPaginationHeaders,
  stringList,
} from './rest-util';

/**
 * /wp/v2/users — WP_REST_Users_Controller
 * (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-users-controller.php).
 *
 * Without list_users, only people who have published something are listed,
 * as in WordPress, so the endpoint can't be used to enumerate accounts.
 */

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    rest_prepare_user: [item: Record<string, unknown>, user: UserRow, context: string];
  }
  interface ActionRegistry {
    rest_insert_user: [user: UserRow, body: unknown, creating: boolean];
    rest_after_insert_user: [user: UserRow, body: unknown, creating: boolean];
    rest_delete_user: [user: UserRow, response: Record<string, unknown>];
  }
}

async function prepareMany(
  kernel: Kernel,
  rows: UserRow[],
  edit: boolean,
): Promise<Record<string, unknown>[]> {
  const home = await kernel.options.get<string>('home', '');
  const roles = await siteRoles(kernel);
  const meta = await metaFor(
    kernel,
    rows.map((r) => r.id),
    [...PROFILE_META_KEYS, 'capabilities'],
  );
  return Promise.all(
    rows.map((user) => {
      const m = meta.get(user.id);
      const profile = profileMeta(m);
      const grants = (m?.get('capabilities') as Record<string, boolean> | undefined) ?? {};
      const userRoles = rolesFromGrants(grants, roles);
      const item: Record<string, unknown> = {
        id: user.id,
        ...(edit ? { username: user.login } : {}),
        name: user.displayName || user.login,
        ...(edit
          ? {
              first_name: profile.first_name,
              last_name: profile.last_name,
              email: user.email,
            }
          : {}),
        url: user.url,
        description: profile.description,
        link: `${home}/author/${user.nicename}/`,
        ...(edit
          ? {
              locale: profile.locale || 'en_US',
              nickname: profile.nickname || user.login,
            }
          : {}),
        slug: user.nicename,
        ...(edit
          ? {
              registered_date: user.registeredAt.toISOString().slice(0, 19),
              roles: userRoles,
              capabilities: {
                ...resolveCapabilities(grants, roles).capabilities,
                ...Object.fromEntries(userRoles.map((r) => [r, true])),
              },
              extra_capabilities: grants,
            }
          : {}),
        avatar_urls: {},
        meta: [],
        _links: {
          self: [{ href: `/wp-json/wp/v2/users/${user.id}` }],
          collection: [{ href: '/wp-json/wp/v2/users' }],
        },
      };
      return kernel.hooks.applyFilters('rest_prepare_user', item, user, edit ? 'edit' : 'view');
    }),
  );
}

async function prepareOne(kernel: Kernel, user: UserRow, edit: boolean) {
  const [item] = await prepareMany(kernel, [user], edit);
  return item as Record<string, unknown>;
}

const listArgs = z.object({
  context: contextParam,
  page: pageParam,
  per_page: perPageParam,
  search: z.string().optional(),
  include: intList,
  exclude: intList,
  slug: stringList,
  roles: stringList,
  orderby: z
    .enum(['id', 'include', 'name', 'registered_date', 'slug', 'email', 'username'])
    .default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  has_published_posts: boolParam.optional(),
});

const text = (max: number) => z.string().max(max, `Use ${max} characters or fewer.`);

const writeBody = z.object({
  username: z.string().optional(),
  name: text(250).optional(),
  first_name: text(250).optional(),
  last_name: text(250).optional(),
  email: z.string().optional(),
  url: text(200).optional(),
  description: text(5000).optional(),
  locale: z.string().optional(),
  nickname: text(250).optional(),
  slug: text(50).optional(),
  roles: z.array(z.string()).optional(),
  password: z.string().optional(),
  meta: z.unknown().optional(),
  /** Pressbase extension: email the new user a "set your password" link (wp_new_user_notification). */
  send_user_notification: z.boolean().optional(),
});

function userError(c: Context, error: unknown) {
  if (error instanceof UserError) {
    return restError(
      c,
      error.status,
      error.code,
      error.message,
      error.params ? { params: error.params } : {},
    );
  }
  throw error;
}

async function findUser(kernel: Kernel, id: number): Promise<UserRow | undefined> {
  const [user] = await kernel.db.select().from(schema.users).where(eq(schema.users.id, id));
  return user;
}

/** Resolves `:id`, where `me` means the current user. */
function targetId(c: Context<AppEnv>): number | 'not-logged-in' {
  const raw = c.req.param('id');
  if (raw === 'me') return c.get('user')?.id ?? 'not-logged-in';
  return Number(raw);
}

const notLoggedIn = (c: Context) =>
  restError(c, 401, 'rest_not_logged_in', 'You are not currently logged in.');

/**
 * check_role_update(): every role must exist, and nobody may give themselves
 * a role without edit_users. Pressbase also refuses to leave the site without
 * an administrator.
 */
async function checkRoleUpdate(
  c: Context<AppEnv>,
  target: number,
  roles: string[],
): Promise<Response | undefined> {
  const kernel = c.get('kernel');
  const viewer = c.get('user') as CurrentUser;
  const known = await siteRoles(kernel);
  for (const role of roles) {
    const definition = known[role];
    if (!definition) {
      return restError(c, 400, 'rest_user_invalid_role', `The role ${role} does not exist.`, {
        params: { roles: `The role ${role} does not exist.` },
      });
    }
  }
  if (viewer.id === target && !roles.some((r) => known[r]?.capabilities.edit_users)) {
    return restError(
      c,
      authStatus(c),
      'rest_user_invalid_role',
      'Sorry, you are not allowed to give users that role.',
      { params: { roles: 'You can’t remove your own ability to manage users.' } },
    );
  }
  if (!roles.includes('administrator')) {
    const admins = await administratorIds(kernel);
    if (admins.length === 1 && admins[0] === target) {
      return restError(
        c,
        403,
        'rest_user_invalid_role',
        'The site needs at least one administrator. Make someone else an administrator first.',
        { params: { roles: 'The site needs at least one administrator.' } },
      );
    }
  }
  return undefined;
}

export function userRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  /* ------------------------------------------------------------ list */

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const viewer = c.get('user');
    const parsed = listArgs.safeParse(queryObject(c, ['include', 'exclude', 'slug', 'roles']));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const q = parsed.data;
    const canList = userCan(viewer, 'list_users');
    if (q.context === 'edit' && !canList) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden_context',
        'Sorry, you are not allowed to list users.',
      );
    }
    if (
      (q.orderby === 'email' || q.orderby === 'registered_date' || q.orderby === 'username') &&
      !canList
    ) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden_orderby',
        'Sorry, you are not allowed to order users by this parameter.',
      );
    }
    if (q.roles?.length && !canList) {
      return restError(
        c,
        authStatus(c),
        'rest_user_cannot_view',
        'Sorry, you are not allowed to filter users by role.',
      );
    }

    const { users, posts, usermeta } = schema;
    const where: (SQL | undefined)[] = [];
    if (!canList || q.has_published_posts) {
      where.push(
        sql`exists (select 1 from ${posts} where ${posts.authorId} = ${users.id} and ${posts.status} = 'publish' and ${posts.type} in ('post', 'page'))`,
      );
    }
    if (q.search) {
      const like = `%${q.search.replace(/[%_\\]/g, '\\$&')}%`;
      where.push(
        or(
          ilike(users.displayName, like),
          ilike(users.nicename, like),
          ...(canList ? [ilike(users.login, like), ilike(users.email, like)] : []),
        ),
      );
    }
    if (q.include?.length) where.push(inArray(users.id, q.include));
    if (q.exclude?.length) where.push(notInArray(users.id, q.exclude));
    if (q.slug?.length) where.push(inArray(users.nicename, q.slug));
    if (q.roles?.length) {
      // Any of the roles, as WordPress's role__in.
      where.push(
        or(
          ...q.roles.map(
            (role) =>
              sql`exists (select 1 from ${usermeta} where ${usermeta.userId} = ${users.id} and ${usermeta.key} = 'capabilities' and ${usermeta.value} @> ${JSON.stringify({ [role]: true })}::jsonb)`,
          ),
        ),
      );
    }
    const condition = and(...where);

    const column = {
      id: users.id,
      include: users.id,
      name: users.displayName,
      registered_date: users.registeredAt,
      slug: users.nicename,
      email: users.email,
      username: users.login,
    }[q.orderby];
    const [rows, [total]] = await Promise.all([
      kernel.db
        .select()
        .from(users)
        .where(condition)
        .orderBy(q.order === 'desc' ? desc(column) : asc(column), asc(users.id))
        .limit(q.per_page)
        .offset((q.page - 1) * q.per_page),
      kernel.db.select({ n: count() }).from(users).where(condition),
    ]);
    const found = total?.n ?? 0;
    setPaginationHeaders(c, found, Math.ceil(found / q.per_page), q.page);
    return c.json(await prepareMany(kernel, rows, q.context === 'edit'));
  });

  /* ------------------------------------------------------------- read */

  app.get('/me', async (c) => {
    const user = c.get('user');
    if (!user) return notLoggedIn(c);
    const kernel = c.get('kernel');
    const row = await findUser(kernel, user.id);
    if (!row) return notLoggedIn(c);
    // The admin reads the current user's roles and capabilities from here, so
    // /me always includes the edit fields: they describe the viewer themselves.
    return c.json(await prepareOne(kernel, row, true));
  });

  app.get('/:id{[0-9]+}', async (c) => {
    const kernel = c.get('kernel');
    const viewer = c.get('user');
    const id = Number(c.req.param('id'));
    const user = await findUser(kernel, id);
    if (!user) return restError(c, 404, 'rest_user_invalid_id', 'Invalid user ID.');

    const edit = c.req.query('context') === 'edit';
    if (edit && !(await currentUserCan(kernel, viewer, 'edit_user', id))) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden_context',
        'Sorry, you are not allowed to edit this user.',
      );
    }
    if (!userCan(viewer, 'list_users') && viewer?.id !== id) {
      const [published] = await kernel.db
        .select({ id: schema.posts.id })
        .from(schema.posts)
        .where(and(eq(schema.posts.authorId, id), eq(schema.posts.status, 'publish')))
        .limit(1);
      if (!published)
        return restError(
          c,
          authStatus(c),
          'rest_user_cannot_view',
          'Sorry, you are not allowed to list users.',
        );
    }
    return c.json(await prepareOne(kernel, user, edit));
  });

  /* ----------------------------------------------------------- create */

  app.post('/', async (c) => {
    const kernel = c.get('kernel');
    const viewer = c.get('user');
    if (!userCan(viewer, 'create_users')) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_create_user',
        'Sorry, you are not allowed to create new users.',
      );
    }
    const raw = await readJson(c);
    const parsed = writeBody.safeParse(raw ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    const body = parsed.data;
    if ((raw as { id?: unknown })?.id) {
      return restError(c, 400, 'rest_user_exists', 'Cannot create existing user.');
    }
    const missing = (['username', 'email', 'password'] as const).filter((k) => !body[k]);
    if (missing.length) {
      return restError(
        c,
        400,
        'rest_missing_callback_param',
        `Missing parameter(s): ${missing.join(', ')}`,
        {
          params: Object.fromEntries(
            missing.map((k) => [
              k,
              k === 'username'
                ? 'Choose a username.'
                : k === 'email'
                  ? 'Enter an email address.'
                  : 'Choose a password.',
            ]),
          ),
        },
      );
    }
    if (body.roles?.length && !userCan(viewer, 'promote_users')) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_edit_roles',
        'Sorry, you are not allowed to give users that role.',
      );
    }
    try {
      const user = await insertUser(kernel, body as UserInput);
      await kernel.hooks.doAction('rest_insert_user', user, body, true);
      if (body.send_user_notification) await sendNewUserEmail(kernel, user);
      await kernel.hooks.doAction('rest_after_insert_user', user, body, true);
      c.header('Location', `/wp-json/wp/v2/users/${user.id}`);
      return c.json(await prepareOne(kernel, user, true), 201);
    } catch (error) {
      return userError(c, error);
    }
  });

  /* ----------------------------------------------------------- update */

  const update = async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    const viewer = c.get('user');
    const id = targetId(c);
    if (id === 'not-logged-in') return notLoggedIn(c);
    const existing = await findUser(kernel, id);
    if (!existing) return restError(c, 404, 'rest_user_invalid_id', 'Invalid user ID.');

    const parsed = writeBody.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    const { send_user_notification: _, meta: __, ...body } = parsed.data;
    const hasRoles = Boolean(body.roles?.length);

    // update_item_permissions_check(): changing roles needs promote_user; a
    // request that only changes roles needs nothing else.
    if (hasRoles && !(await currentUserCan(kernel, viewer, 'promote_user', id))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_edit_roles',
        'Sorry, you are not allowed to edit roles of this user.',
      );
    }
    const onlyRoles = hasRoles && Object.keys(body).every((k) => k === 'roles');
    if (!onlyRoles && !(await currentUserCan(kernel, viewer, 'edit_user', id))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_edit',
        'Sorry, you are not allowed to edit this user.',
      );
    }
    if (hasRoles) {
      const refused = await checkRoleUpdate(c, id, body.roles ?? []);
      if (refused) return refused;
    } else {
      body.roles = undefined; // WordPress ignores an empty roles list.
    }

    try {
      const result = await updateUser(kernel, id, body);
      await kernel.hooks.doAction('rest_insert_user', result.user, body, false);
      if (result.passwordChanged) {
        // Log the user out everywhere else; keep the session making this request.
        const keep = viewer?.id === id ? getCookie(c, SESSION_COOKIE) : undefined;
        await destroyUserSessions(kernel, id, keep);
        await sendPasswordChangedEmail(kernel, result.user);
      }
      if (result.emailChanged) {
        await sendEmailChangedEmail(kernel, result.previous.email, result.user);
      }
      await kernel.hooks.doAction('rest_after_insert_user', result.user, body, false);
      return c.json(await prepareOne(kernel, result.user, true));
    } catch (error) {
      return userError(c, error);
    }
  };
  for (const method of ['post', 'put', 'patch'] as const) {
    app[method]('/:id{[0-9]+|me}', update);
  }

  /* ----------------------------------------------------------- delete */

  app.delete('/:id{[0-9]+|me}', async (c) => {
    const kernel = c.get('kernel');
    const viewer = c.get('user');
    const id = targetId(c);
    if (id === 'not-logged-in') return notLoggedIn(c);
    const user = await findUser(kernel, id);
    if (!user) return restError(c, 404, 'rest_user_invalid_id', 'Invalid user ID.');
    // map_meta_cap( 'delete_user' ) → delete_users on a single site.
    if (!userCan(viewer, 'delete_users')) {
      return restError(
        c,
        authStatus(c),
        'rest_user_cannot_delete',
        'Sorry, you are not allowed to delete this user.',
      );
    }

    const force = c.req.query('force');
    if (!(force === 'true' || force === '1')) {
      return restError(
        c,
        501,
        'rest_trash_not_supported',
        "Users do not support trashing. Set 'force=true' to delete.",
      );
    }
    // `reassign` is required, as in WordPress; `false` (or empty) deletes the user's posts.
    const reassignRaw = c.req.query('reassign');
    if (reassignRaw === undefined) {
      return restError(c, 400, 'rest_missing_callback_param', 'Missing parameter(s): reassign', {
        params: { reassign: 'Choose who gets this user’s content, or delete it.' },
      });
    }
    let reassign: number | null = null;
    if (!['false', '', '0'].includes(reassignRaw)) {
      reassign = Number(reassignRaw);
      if (
        !Number.isInteger(reassign) ||
        reassign === id ||
        reassign < 1 ||
        !(await findUser(kernel, reassign))
      ) {
        return restError(c, 400, 'rest_user_invalid_reassign', 'Invalid user ID for reassignment.');
      }
    }
    const admins = await administratorIds(kernel);
    if (admins.length === 1 && admins[0] === id) {
      return restError(
        c,
        403,
        'rest_user_cannot_delete',
        'The site needs at least one administrator. Make someone else an administrator first.',
      );
    }

    const previous = await prepareOne(kernel, user, true);
    try {
      await deleteUser(kernel, id, reassign);
    } catch (error) {
      return userError(c, error);
    }
    const response = { deleted: true, previous };
    await kernel.hooks.doAction('rest_delete_user', user, response);
    return c.json(response);
  });

  return app;
}

/**
 * /pressbase/v1/user-counts — count_users() for the Users screen's role tabs,
 * plus count_many_users_posts() for `?include=1,2,3`.
 */
export function userCountRoutes() {
  const app = new Hono<AppEnv>({ strict: false });
  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    if (!userCan(c.get('user'), 'list_users')) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden',
        'Sorry, you are not allowed to list users.',
      );
    }
    const parsed = z.object({ include: intList }).safeParse(queryObject(c, ['include']));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const [counts, posts] = await Promise.all([
      countUsers(kernel),
      countPostsByUsers(kernel, (parsed.data.include ?? []).slice(0, 100)),
    ]);
    return c.json({ ...counts, posts });
  });
  return app;
}
