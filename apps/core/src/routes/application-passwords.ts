import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { type AppEnv, invalidParams, readJson, restError } from '../http';
import {
  type ApplicationPassword,
  applicationPasswordsAvailable,
  applicationPasswordsSupported,
  chunkPassword,
  createApplicationPassword,
  deleteAllApplicationPasswords,
  deleteApplicationPassword,
  listApplicationPasswords,
  updateApplicationPassword,
} from '../people/application-passwords';
import { UserError } from '../people/users';
import { authStatus } from './rest-util';

/**
 * /wp/v2/users/{id|me}/application-passwords — WP_REST_Application_Passwords_Controller
 * (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-application-passwords-controller.php).
 * Managing a user's application passwords needs edit_user on them: yourself,
 * or anyone with edit_users.
 */

/** gmdate( 'Y-m-d\TH:i:s', $time ). */
const gmt = (seconds: number | null) =>
  seconds === null ? null : new Date(seconds * 1000).toISOString().slice(0, 19);

function prepare(userId: number, item: ApplicationPassword, password?: string) {
  return {
    uuid: item.uuid,
    app_id: item.app_id,
    name: item.name,
    created: gmt(item.created),
    last_used: gmt(item.last_used),
    last_ip: item.last_ip,
    ...(password ? { password: chunkPassword(password) } : {}),
    _links: {
      self: [{ href: `/wp-json/wp/v2/users/${userId}/application-passwords/${item.uuid}` }],
    },
  };
}

const createBody = z.object({
  name: z.string({ message: 'Give it a name.' }).max(200, 'Use 200 characters or fewer.'),
  app_id: z.string().max(100).optional(),
});
const updateBody = z.object({ name: z.string().max(200, 'Use 200 characters or fewer.') });

type Action = 'list' | 'read' | 'create' | 'edit' | 'delete';
const DENIED: Record<Action, [string, string]> = {
  list: [
    'rest_cannot_list_application_passwords',
    'Sorry, you are not allowed to list application passwords for this user.',
  ],
  read: [
    'rest_cannot_read_application_password',
    'Sorry, you are not allowed to read this application password.',
  ],
  create: [
    'rest_cannot_create_application_passwords',
    'Sorry, you are not allowed to create application passwords for this user.',
  ],
  edit: [
    'rest_cannot_edit_application_password',
    'Sorry, you are not allowed to edit this application password.',
  ],
  delete: [
    'rest_cannot_delete_application_password',
    'Sorry, you are not allowed to delete this application password.',
  ],
};

/** Resolves the user and checks permission; returns the user ID or an error response. */
async function authorize(c: Context<AppEnv>, action: Action): Promise<number | Response> {
  const kernel = c.get('kernel');
  const viewer = c.get('user');
  const raw = c.req.param('userId');
  if (raw === 'me' && !viewer) {
    return restError(c, 401, 'rest_not_logged_in', 'You are not currently logged in.');
  }
  const id = raw === 'me' ? (viewer?.id ?? 0) : Number(raw);
  const [user] = await kernel.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, id));
  if (!user) return restError(c, 404, 'rest_user_invalid_id', 'Invalid user ID.');
  if (!(await currentUserCan(kernel, viewer, 'edit_user', id))) {
    const [code, message] = DENIED[action];
    return restError(c, authStatus(c), code, message);
  }
  if (!applicationPasswordsSupported(c) || !(await applicationPasswordsAvailable(kernel, id))) {
    return restError(
      c,
      501,
      'application_passwords_disabled',
      'Application passwords are not available.',
    );
  }
  return id;
}

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

export function applicationPasswordRoutes() {
  const app = new Hono<AppEnv>({ strict: false });
  const base = '/:userId{[0-9]+|me}/application-passwords';

  app.get(base, async (c) => {
    const id = await authorize(c, 'list');
    if (typeof id !== 'number') return id;
    const items = await listApplicationPasswords(c.get('kernel'), id);
    return c.json(items.map((item) => prepare(id, item)));
  });

  app.post(base, async (c) => {
    const id = await authorize(c, 'create');
    if (typeof id !== 'number') return id;
    const parsed = createBody.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    try {
      const { password, item } = await createApplicationPassword(c.get('kernel'), id, parsed.data);
      return c.json(prepare(id, item, password), 201);
    } catch (error) {
      return userError(c, error);
    }
  });

  app.delete(base, async (c) => {
    const id = await authorize(c, 'delete');
    if (typeof id !== 'number') return id;
    const deleted = await deleteAllApplicationPasswords(c.get('kernel'), id);
    return c.json({ deleted: true, count: deleted });
  });

  // get_current_item(): the password this request authenticated with.
  app.get(`${base}/introspect`, async (c) => {
    const viewer = c.get('user');
    const raw = c.req.param('userId');
    const id = raw === 'me' ? viewer?.id : Number(raw);
    if (!viewer || viewer.id !== id) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_introspect_app_password_for_non_authenticated_user',
        'The authenticated application password can only be introspected for the current user.',
      );
    }
    const used = c.get('applicationPassword');
    if (!used) {
      return restError(
        c,
        404,
        'rest_no_authenticated_app_password',
        'Cannot introspect application password.',
      );
    }
    const items = await listApplicationPasswords(c.get('kernel'), viewer.id);
    const item = items.find((i) => i.uuid === used.uuid);
    if (!item) {
      return restError(
        c,
        500,
        'rest_application_password_not_found',
        'Application password not found.',
      );
    }
    return c.json(prepare(viewer.id, item));
  });

  const one = `${base}/:uuid{[0-9a-fA-F-]+}`;

  app.get(one, async (c) => {
    const id = await authorize(c, 'read');
    if (typeof id !== 'number') return id;
    const items = await listApplicationPasswords(c.get('kernel'), id);
    const item = items.find((i) => i.uuid === c.req.param('uuid'));
    if (!item) {
      return restError(
        c,
        404,
        'rest_application_password_not_found',
        'Application password not found.',
      );
    }
    return c.json(prepare(id, item));
  });

  const edit = async (c: Context<AppEnv>) => {
    const id = await authorize(c, 'edit');
    if (typeof id !== 'number') return id;
    const parsed = updateBody.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    try {
      const item = await updateApplicationPassword(
        c.get('kernel'),
        id,
        c.req.param('uuid') ?? '',
        parsed.data,
      );
      return c.json(prepare(id, item));
    } catch (error) {
      return userError(c, error);
    }
  };
  for (const method of ['post', 'put', 'patch'] as const) app[method](one, edit);

  app.delete(one, async (c) => {
    const id = await authorize(c, 'delete');
    if (typeof id !== 'number') return id;
    try {
      const item = await deleteApplicationPassword(c.get('kernel'), id, c.req.param('uuid') ?? '');
      return c.json({ deleted: true, previous: prepare(id, item) });
    } catch (error) {
      return userError(c, error);
    }
  });

  return app;
}
