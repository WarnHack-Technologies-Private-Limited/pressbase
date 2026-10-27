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
import { Hono } from 'hono';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { userCan } from '../auth/users';
import { type AppEnv, invalidParams, restError } from '../http';
import type { Kernel } from '../kernel';
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
 * /wp/v2/users — the read side of WP_REST_Users_Controller
 * (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-users-controller.php).
 * Creating and editing users arrives with the Users screen.
 *
 * Without list_users, only people who have published something are listed,
 * as in WordPress, so the endpoint can't be used to enumerate accounts.
 */

type UserRow = typeof schema.users.$inferSelect;

async function roleGrants(
  kernel: Kernel,
  ids: number[],
): Promise<Map<number, Record<string, boolean>>> {
  if (!ids.length) return new Map();
  const rows = await kernel.db
    .select({ userId: schema.usermeta.userId, value: schema.usermeta.value })
    .from(schema.usermeta)
    .where(and(inArray(schema.usermeta.userId, ids), eq(schema.usermeta.key, 'capabilities')));
  return new Map(rows.map((r) => [r.userId, (r.value as Record<string, boolean>) ?? {}]));
}

function prepare(user: UserRow, home: string, edit: boolean, grants?: Record<string, boolean>) {
  return {
    id: user.id,
    name: user.displayName || user.login,
    url: user.url,
    description: '',
    link: `${home}/author/${user.nicename}/`,
    slug: user.nicename,
    avatar_urls: {},
    ...(edit
      ? {
          username: user.login,
          email: user.email,
          registered_date: user.registeredAt.toISOString().slice(0, 19),
          roles: Object.keys(grants ?? {}).filter((k) => grants?.[k]),
        }
      : {}),
    meta: [],
    _links: {
      self: [{ href: `/wp-json/wp/v2/users/${user.id}` }],
      collection: [{ href: '/wp-json/wp/v2/users' }],
    },
  };
}

const listArgs = z.object({
  context: contextParam,
  page: pageParam,
  per_page: perPageParam,
  search: z.string().optional(),
  include: intList,
  exclude: intList,
  slug: stringList,
  orderby: z.enum(['id', 'include', 'name', 'registered_date', 'slug', 'email']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  has_published_posts: boolParam.optional(),
});

export function userRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  app.get('/me', async (c) => {
    const user = c.get('user');
    if (!user) return restError(c, 401, 'rest_not_logged_in', 'You are not currently logged in.');
    const home = await c.get('kernel').options.get<string>('home', '');
    return c.json({
      id: user.id,
      username: user.login,
      name: user.displayName,
      slug: user.nicename,
      email: user.email,
      link: `${home}/author/${user.nicename}/`,
      roles: user.roles,
      capabilities: user.capabilities,
    });
  });

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const viewer = c.get('user');
    const parsed = listArgs.safeParse(queryObject(c, ['include', 'exclude', 'slug']));
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
    if ((q.orderby === 'email' || q.orderby === 'registered_date') && !canList) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden_orderby',
        'Sorry, you are not allowed to order users by this parameter.',
      );
    }

    const { users, posts } = schema;
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
    const condition = and(...where);

    const column = {
      id: users.id,
      include: users.id,
      name: users.displayName,
      registered_date: users.registeredAt,
      slug: users.nicename,
      email: users.email,
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
    const home = await kernel.options.get<string>('home', '');
    const grants =
      q.context === 'edit'
        ? await roleGrants(
            kernel,
            rows.map((r) => r.id),
          )
        : undefined;
    return c.json(rows.map((u) => prepare(u, home, q.context === 'edit', grants?.get(u.id))));
  });

  app.get('/:id{[0-9]+}', async (c) => {
    const kernel = c.get('kernel');
    const viewer = c.get('user');
    const id = Number(c.req.param('id'));
    const [user] = await kernel.db.select().from(schema.users).where(eq(schema.users.id, id));
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
    const home = await kernel.options.get<string>('home', '');
    const grants = edit ? await roleGrants(kernel, [id]) : undefined;
    return c.json(prepare(user, home, edit, grants?.get(id)));
  });

  return app;
}
