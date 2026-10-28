import { createHash, timingSafeEqual } from 'node:crypto';
import { schema } from '@pressbase/db';
import { and, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { DEFAULT_ROLES, type RoleMap } from '../auth/capabilities';
import { hashPassword } from '../auth/password';
import { stripTags } from '../content/sanitize';
import type { Kernel } from '../kernel';
import { deleteAttachment } from '../media/service';
import { isEmail, passwordProblem, sanitizeUserUrl, validateUsername } from './validation';

/**
 * Creating, updating and deleting people: wp_insert_user(), wp_update_user()
 * and wp_delete_user() (wordpress/wp-includes/user.php and
 * wp-admin/includes/user.php). Profile fields live in usermeta under
 * WordPress's keys: first_name, last_name, nickname, description, locale.
 */

export type UserRow = typeof schema.users.$inferSelect;

export const PROFILE_META_KEYS = [
  'first_name',
  'last_name',
  'nickname',
  'description',
  'locale',
] as const;
export type ProfileMetaKey = (typeof PROFILE_META_KEYS)[number];
export type ProfileMeta = Record<ProfileMetaKey, string>;

export class UserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 500 = 400,
    /** Field → message, so forms can show the problem next to its field. */
    readonly params?: Record<string, string>,
  ) {
    super(message);
  }
}

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    illegal_user_logins: [logins: string[]];
  }
  interface ActionRegistry {
    user_register: [userId: number];
    profile_update: [userId: number, oldUser: UserRow];
    set_user_role: [userId: number, role: string, oldRoles: string[]];
    delete_user: [userId: number, reassign: number | null, user: UserRow];
    deleted_user: [userId: number, reassign: number | null, user: UserRow];
  }
}

/* ------------------------------------------------------------- hashing */

/**
 * A fast, keyless digest for long random secrets (application passwords and
 * reset keys). It's what WordPress 6.8 switched to (wp_fast_hash): when the
 * secret has 100+ bits of entropy, a slow hash adds nothing but CPU time.
 * Never use it for passwords people choose.
 */
export function fastHash(secret: string): string {
  return `$generic$${createHash('sha256').update(secret).digest('hex')}`;
}

/** wp_verify_fast_hash(), compared in constant time. */
export function verifyFastHash(secret: string, hash: string): boolean {
  const expected = Buffer.from(hash);
  const actual = Buffer.from(fastHash(secret));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* ---------------------------------------------------------------- meta */

export async function getUserMeta<T = unknown>(
  kernel: Kernel,
  userId: number,
  key: string,
): Promise<T | undefined> {
  const [row] = await kernel.db
    .select({ value: schema.usermeta.value })
    .from(schema.usermeta)
    .where(and(eq(schema.usermeta.userId, userId), eq(schema.usermeta.key, key)));
  return row ? (row.value as T) : undefined;
}

/** update_user_meta(): one row per key, replaced in place. */
export async function setUserMeta(
  kernel: Kernel,
  userId: number,
  key: string,
  value: unknown,
): Promise<void> {
  const updated = await kernel.db
    .update(schema.usermeta)
    .set({ value })
    .where(and(eq(schema.usermeta.userId, userId), eq(schema.usermeta.key, key)))
    .returning({ id: schema.usermeta.id });
  if (!updated.length) await kernel.db.insert(schema.usermeta).values({ userId, key, value });
}

export async function deleteUserMeta(kernel: Kernel, userId: number, key: string): Promise<void> {
  await kernel.db
    .delete(schema.usermeta)
    .where(and(eq(schema.usermeta.userId, userId), eq(schema.usermeta.key, key)));
}

/** Several keys for several users in one query: Map<userId, Map<key, value>>. */
export async function metaFor(
  kernel: Kernel,
  ids: number[],
  keys: readonly string[],
): Promise<Map<number, Map<string, unknown>>> {
  const out = new Map<number, Map<string, unknown>>();
  if (!ids.length) return out;
  const rows = await kernel.db
    .select()
    .from(schema.usermeta)
    .where(and(inArray(schema.usermeta.userId, ids), inArray(schema.usermeta.key, [...keys])));
  for (const row of rows) {
    const map = out.get(row.userId) ?? new Map();
    map.set(row.key, row.value);
    out.set(row.userId, map);
  }
  return out;
}

export function profileMeta(meta: Map<string, unknown> | undefined): ProfileMeta {
  const get = (key: ProfileMetaKey) => {
    const value = meta?.get(key);
    return typeof value === 'string' ? value : '';
  };
  return {
    first_name: get('first_name'),
    last_name: get('last_name'),
    nickname: get('nickname'),
    description: get('description'),
    locale: get('locale'),
  };
}

/* --------------------------------------------------------------- roles */

export async function siteRoles(kernel: Kernel): Promise<RoleMap> {
  return kernel.options.get<RoleMap>('user_roles', DEFAULT_ROLES);
}

/** The roles in a `capabilities` grant map (role keys set to true). */
export function rolesFromGrants(grants: Record<string, boolean>, roles: RoleMap): string[] {
  return Object.keys(grants).filter((key) => grants[key] && roles[key]);
}

/** WP_User::set_role() for a list: replaces role keys, keeps directly granted capabilities. */
export async function setUserRoles(kernel: Kernel, userId: number, next: string[]): Promise<void> {
  const roles = await siteRoles(kernel);
  const grants = (await getUserMeta<Record<string, boolean>>(kernel, userId, 'capabilities')) ?? {};
  const old = rolesFromGrants(grants, roles);
  const updated: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(grants)) if (!roles[key]) updated[key] = value;
  for (const role of next) updated[role] = true;
  await setUserMeta(kernel, userId, 'capabilities', updated);
  if (old.join() !== next.join()) {
    await kernel.hooks.doAction('set_user_role', userId, next[0] ?? '', old);
  }
}

/** IDs of users holding the administrator role. */
export async function administratorIds(kernel: Kernel): Promise<number[]> {
  const rows = await kernel.db
    .select({ userId: schema.usermeta.userId })
    .from(schema.usermeta)
    .where(
      and(
        eq(schema.usermeta.key, 'capabilities'),
        sql`${schema.usermeta.value} @> '{"administrator": true}'::jsonb`,
      ),
    );
  return rows.map((r) => r.userId);
}

/** count_users(): the total and the number of users in each role. */
export async function countUsers(
  kernel: Kernel,
): Promise<{ total: number; roles: Record<string, number> }> {
  const roles = await siteRoles(kernel);
  const [[total], grants] = await Promise.all([
    kernel.db.select({ n: count() }).from(schema.users),
    kernel.db
      .select({ value: schema.usermeta.value })
      .from(schema.usermeta)
      .where(eq(schema.usermeta.key, 'capabilities')),
  ]);
  const counts: Record<string, number> = Object.fromEntries(Object.keys(roles).map((r) => [r, 0]));
  let none = 0;
  for (const { value } of grants) {
    const userRoles = rolesFromGrants((value as Record<string, boolean>) ?? {}, roles);
    if (!userRoles.length) none += 1;
    for (const role of userRoles) counts[role] = (counts[role] ?? 0) + 1;
  }
  const n = total?.n ?? 0;
  // Users with no capabilities row at all also have no role.
  counts.none = none + Math.max(0, n - grants.length);
  return { total: n, roles: counts };
}

/** count_many_users_posts(): published-or-not posts and pages per author. */
export async function countPostsByUsers(
  kernel: Kernel,
  ids: number[],
): Promise<Record<number, number>> {
  const out: Record<number, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  if (!ids.length) return out;
  const rows = await kernel.db
    .select({ authorId: schema.posts.authorId, n: count() })
    .from(schema.posts)
    .where(
      and(
        inArray(schema.posts.authorId, ids),
        inArray(schema.posts.type, ['post', 'page']),
        inArray(schema.posts.status, ['publish', 'future', 'draft', 'pending', 'private']),
      ),
    )
    .groupBy(schema.posts.authorId);
  for (const row of rows) if (row.authorId) out[row.authorId] = row.n;
  return out;
}

/* ------------------------------------------------------------ sessions */

/**
 * WP_Session_Tokens::destroy_all() / destroy_others(): logs a user out
 * everywhere, optionally keeping the session making the request.
 */
export async function destroyUserSessions(
  kernel: Kernel,
  userId: number,
  keepToken?: string,
): Promise<void> {
  const keep = keepToken ? createHash('sha256').update(keepToken).digest('hex') : undefined;
  await kernel.db
    .delete(schema.sessions)
    .where(
      keep
        ? and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, keep))
        : eq(schema.sessions.userId, userId),
    );
}

/* ---------------------------------------------------------- validation */

async function checkUsername(kernel: Kernel, login: string): Promise<void> {
  if (!validateUsername(login)) {
    throw new UserError(
      'rest_user_invalid_username',
      'This username is invalid because it uses illegal characters. Please enter a valid username.',
      400,
      { username: 'Use letters, numbers, spaces and . - _ @ only (60 at most).' },
    );
  }
  const illegal = await kernel.hooks.applyFilters('illegal_user_logins', []);
  if (illegal.map((l) => l.toLowerCase()).includes(login.toLowerCase())) {
    throw new UserError('rest_user_invalid_username', 'Sorry, that username is not allowed.', 400, {
      username: 'Sorry, that username is not allowed.',
    });
  }
  const [taken] = await kernel.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.login})`, login.toLowerCase()));
  if (taken) {
    throw new UserError('existing_user_login', 'Sorry, that username already exists!', 400, {
      username: 'That username is taken. Try another.',
    });
  }
}

async function checkEmail(kernel: Kernel, email: string, ownerId?: number): Promise<void> {
  if (!isEmail(email) || email.length > 100) {
    throw new UserError('rest_user_invalid_email', 'Invalid email address.', 400, {
      email: 'Enter a valid email address, like name@example.com.',
    });
  }
  const [owner] = await kernel.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.email})`, email.toLowerCase()));
  if (owner && owner.id !== ownerId) {
    // wp_insert_user() says existing_user_email; the REST update route says rest_user_invalid_email.
    const [code, message] =
      ownerId === undefined
        ? ['existing_user_email', 'Sorry, that email address is already used!']
        : ['rest_user_invalid_email', 'Invalid email address.'];
    throw new UserError(code, message, 400, {
      email: 'Another account already uses this email address.',
    });
  }
}

function checkPassword(password: string): void {
  const problem = passwordProblem(password);
  if (problem)
    throw new UserError('rest_user_invalid_password', problem, 400, { password: problem });
}

async function checkRoles(kernel: Kernel, roles: string[]): Promise<void> {
  const known = await siteRoles(kernel);
  for (const role of roles) {
    if (!known[role]) {
      throw new UserError('rest_user_invalid_role', `The role ${role} does not exist.`, 400, {
        roles: `The role ${role} does not exist.`,
      });
    }
  }
}

async function uniqueNicename(kernel: Kernel, base: string, exceptId?: number): Promise<string> {
  const root = base.slice(0, 50).replace(/-$/, '') || 'user';
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? root : `${root.slice(0, 50 - String(n).length - 1)}-${n}`;
    const [row] = await kernel.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.nicename, candidate));
    if (!row || row.id === exceptId) return candidate;
  }
}

/** sanitize_title() for nicenames: also drops '@' and '.', as WordPress does. */
function nicenameFrom(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const plain = (value: string, max = 250) => stripTags(value).replace(/\s+/g, ' ').slice(0, max);

/**
 * A user's language: '' (the site's), en_US or an installed language, as
 * WP_REST_Users_Controller's schema allows (get_available_languages()).
 */
function cleanLocale(kernel: Kernel, locale: string): string {
  if (locale === '' || locale === 'en_US' || kernel.i18n.getAvailableLanguages().includes(locale))
    return locale;
  throw new UserError('rest_invalid_param', 'Invalid parameter(s): locale', 400, {
    locale: kernel.i18n.__('Choose a language from the list.', 'pressbase'),
  });
}

/** The display name WordPress picks when none is given (wp_insert_user()). */
function defaultDisplayName(login: string, first: string, last: string): string {
  if (first && last) return `${first} ${last}`;
  return first || last || login;
}

/* -------------------------------------------------------------- writes */

export interface UserInput {
  username?: string;
  email?: string;
  password?: string;
  url?: string;
  /** display_name. */
  name?: string;
  /** user_nicename. */
  slug?: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
  description?: string;
  locale?: string;
  roles?: string[];
}

function uniqueViolation(error: unknown): UserError | undefined {
  const text = String((error as { message?: string })?.message ?? '');
  const code = (error as { code?: string; cause?: { code?: string } })?.code;
  if (code !== '23505' && !text.includes('duplicate key')) return undefined;
  return text.includes('users_email_key')
    ? new UserError('existing_user_email', 'Sorry, that email address is already used!', 400, {
        email: 'Another account already uses this email address.',
      })
    : new UserError('existing_user_login', 'Sorry, that username already exists!', 400, {
        username: 'That username is taken. Try another.',
      });
}

/** wp_insert_user(). The username, email and password are required. */
export async function insertUser(kernel: Kernel, input: UserInput): Promise<UserRow> {
  const login = (input.username ?? '').trim();
  const email = (input.email ?? '').trim();
  const password = input.password ?? '';
  await checkUsername(kernel, login);
  await checkEmail(kernel, email);
  checkPassword(password);
  const roles = input.roles ?? [await kernel.options.get<string>('default_role', 'subscriber')];
  await checkRoles(kernel, roles);

  const first = plain(input.first_name ?? '');
  const last = plain(input.last_name ?? '');
  const nicename = await uniqueNicename(kernel, nicenameFrom(input.slug || login));
  let user: UserRow | undefined;
  try {
    user = await kernel.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.users)
        .values({
          login,
          pass: await hashPassword(password),
          email,
          nicename,
          url: sanitizeUserUrl(input.url ?? ''),
          displayName: plain(input.name ?? '') || defaultDisplayName(login, first, last),
        })
        .returning();
      if (!row) throw new UserError('rest_user_create', 'Error creating new user.', 500);
      await tx.insert(schema.usermeta).values([
        { userId: row.id, key: 'nickname', value: plain(input.nickname ?? '') || login },
        { userId: row.id, key: 'first_name', value: first },
        { userId: row.id, key: 'last_name', value: last },
        { userId: row.id, key: 'description', value: (input.description ?? '').trim() },
        { userId: row.id, key: 'locale', value: cleanLocale(kernel, input.locale ?? '') },
        {
          userId: row.id,
          key: 'capabilities',
          value: Object.fromEntries(roles.map((r) => [r, true])),
        },
      ]);
      return row;
    });
  } catch (error) {
    throw uniqueViolation(error) ?? error;
  }
  await kernel.hooks.doAction('user_register', user.id);
  return user;
}

export interface UpdateResult {
  user: UserRow;
  passwordChanged: boolean;
  emailChanged: boolean;
  previous: UserRow;
}

/** wp_update_user(). Only the fields present in `input` change. */
export async function updateUser(
  kernel: Kernel,
  id: number,
  input: UserInput,
): Promise<UpdateResult> {
  const [previous] = await kernel.db.select().from(schema.users).where(eq(schema.users.id, id));
  if (!previous) throw new UserError('rest_user_invalid_id', 'Invalid user ID.', 404);
  if (input.username !== undefined && input.username !== previous.login) {
    throw new UserError('rest_user_invalid_argument', 'Username is not editable.', 400, {
      username: 'Usernames can’t be changed.',
    });
  }

  const changes: Partial<typeof schema.users.$inferInsert> = {};
  const email = input.email?.trim();
  if (email !== undefined && email.toLowerCase() !== previous.email.toLowerCase()) {
    await checkEmail(kernel, email, id);
    changes.email = email;
  } else if (email !== undefined && email !== previous.email) {
    changes.email = email;
  }
  if (input.password !== undefined) {
    checkPassword(input.password);
    changes.pass = await hashPassword(input.password);
    // A new password invalidates any reset link in flight.
    changes.activationKey = '';
  }
  if (input.url !== undefined) changes.url = sanitizeUserUrl(input.url);
  if (input.name !== undefined) changes.displayName = plain(input.name) || previous.login;
  if (input.slug !== undefined && input.slug !== previous.nicename) {
    const slug = nicenameFrom(input.slug);
    const [taken] = await kernel.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.nicename, slug));
    if (!slug || (taken && taken.id !== id)) {
      throw new UserError('rest_user_invalid_slug', 'Invalid slug.', 400, {
        slug: 'That slug is taken or empty.',
      });
    }
    changes.nicename = slug;
  }
  if (input.roles !== undefined) await checkRoles(kernel, input.roles);
  const locale = input.locale !== undefined ? cleanLocale(kernel, input.locale) : undefined;

  let user = previous;
  if (Object.keys(changes).length) {
    try {
      const [row] = await kernel.db
        .update(schema.users)
        .set(changes)
        .where(eq(schema.users.id, id))
        .returning();
      if (row) user = row;
    } catch (error) {
      throw uniqueViolation(error) ?? error;
    }
  }
  const meta: Partial<ProfileMeta> = {};
  if (input.first_name !== undefined) meta.first_name = plain(input.first_name);
  if (input.last_name !== undefined) meta.last_name = plain(input.last_name);
  if (input.nickname !== undefined) meta.nickname = plain(input.nickname) || previous.login;
  if (input.description !== undefined) meta.description = input.description.trim();
  if (locale !== undefined) meta.locale = locale;
  for (const [key, value] of Object.entries(meta)) await setUserMeta(kernel, id, key, value);
  if (input.roles !== undefined) await setUserRoles(kernel, id, input.roles);

  await kernel.hooks.doAction('profile_update', id, previous);
  return {
    user,
    previous,
    passwordChanged: input.password !== undefined,
    emailChanged: changes.email !== undefined && changes.email !== previous.email,
  };
}

/**
 * wp_delete_user( $id, $reassign ): with `reassign`, every post the user wrote
 * moves to that user; without it, their posts (and media) are deleted.
 */
export async function deleteUser(
  kernel: Kernel,
  id: number,
  reassign: number | null,
): Promise<UserRow> {
  const [user] = await kernel.db.select().from(schema.users).where(eq(schema.users.id, id));
  if (!user) throw new UserError('rest_user_invalid_id', 'Invalid user ID.', 404);
  await kernel.hooks.doAction('delete_user', id, reassign, user);

  if (reassign) {
    await kernel.db
      .update(schema.posts)
      .set({ authorId: reassign })
      .where(eq(schema.posts.authorId, id));
  } else {
    const owned = await kernel.db
      .select({ id: schema.posts.id, type: schema.posts.type })
      .from(schema.posts)
      .where(and(eq(schema.posts.authorId, id), ne(schema.posts.type, 'revision')));
    for (const post of owned) {
      const current = await kernel.posts.get(post.id);
      if (!current) continue; // Already gone with a parent.
      if (post.type === 'attachment') await deleteAttachment(kernel, current);
      else await kernel.posts.delete(post.id);
    }
    // Revisions the user made of other people's posts.
    await kernel.db
      .delete(schema.posts)
      .where(and(eq(schema.posts.authorId, id), eq(schema.posts.type, 'revision')));
  }
  // Usermeta and sessions go with the row (ON DELETE CASCADE).
  await kernel.db.delete(schema.users).where(eq(schema.users.id, id));
  await kernel.hooks.doAction('deleted_user', id, reassign, user);
  return user;
}
