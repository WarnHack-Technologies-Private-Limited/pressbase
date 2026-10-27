import { randomInt, randomUUID } from 'node:crypto';
import { schema } from '@pressbase/db';
import { eq, or, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { RateLimiter } from '../auth/rate-limit';
import { type CurrentUser, loadUser } from '../auth/users';
import { type AppEnv, clientIp, isSecureRequest, restError } from '../http';
import type { Kernel } from '../kernel';
import { fastHash, getUserMeta, setUserMeta, UserError, verifyFastHash } from './users';
import { isEmail } from './validation';

/**
 * Application passwords — a port of WP_Application_Passwords
 * (wordpress/wp-includes/class-wp-application-passwords.php) and
 * wp_authenticate_application_password() (wp-includes/user.php).
 *
 * Each user's passwords live in the `_application_passwords` usermeta entry as
 * a list of { uuid, app_id, name, password (hash), created, last_used, last_ip }.
 * Times are Unix seconds, as in WordPress. The plain password is returned
 * once, when it's created, and never stored.
 */

export const USERMETA_KEY_APPLICATION_PASSWORDS = '_application_passwords';
/** WP_Application_Passwords::PW_LENGTH. */
export const PW_LENGTH = 24;
const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export interface ApplicationPassword {
  uuid: string;
  app_id: string;
  name: string;
  password: string;
  created: number;
  last_used: number | null;
  last_ip: string | null;
}

/** What the request authenticated with, for /introspect. */
export interface AuthenticatedAppPassword {
  uuid: string;
  userId: number;
}

declare module 'hono' {
  interface ContextVariableMap {
    /** Set when the request authenticated with an application password. */
    applicationPassword?: AuthenticatedAppPassword;
  }
}

/** The error object passed to `wp_authenticate_application_password_errors`; add to it to refuse. */
export class AuthErrors {
  readonly errors: { code: string; message: string }[] = [];
  add(code: string, message: string): void {
    this.errors.push({ code, message });
  }
  hasErrors(): boolean {
    return this.errors.length > 0;
  }
}

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    wp_is_application_passwords_available: [available: boolean];
    wp_is_application_passwords_available_for_user: [available: boolean, userId: number];
  }
  interface ActionRegistry {
    wp_create_application_password: [
      userId: number,
      item: ApplicationPassword,
      plainPassword: string,
      args: { name: string; app_id: string },
    ];
    wp_update_application_password: [
      userId: number,
      item: ApplicationPassword,
      update: { name: string },
    ];
    wp_delete_application_password: [userId: number, item: ApplicationPassword];
    wp_authenticate_application_password_errors: [
      errors: AuthErrors,
      user: CurrentUser,
      item: ApplicationPassword,
      password: string,
    ];
    application_password_did_authenticate: [user: CurrentUser, item: ApplicationPassword];
    application_password_failed_authentication: [error: { code: string; message: string }];
  }
}

/** wp_generate_password( 24, false ). */
function generate(): string {
  let out = '';
  for (let i = 0; i < PW_LENGTH; i += 1) out += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)];
  return out;
}

/** WP_Application_Passwords::chunk_password(): groups of four, for readability. */
export function chunkPassword(raw: string): string {
  return (raw.match(/.{1,4}/g) ?? []).join(' ');
}

export async function listApplicationPasswords(
  kernel: Kernel,
  userId: number,
): Promise<ApplicationPassword[]> {
  const value = await getUserMeta<ApplicationPassword[]>(
    kernel,
    userId,
    USERMETA_KEY_APPLICATION_PASSWORDS,
  );
  return Array.isArray(value) ? value : [];
}

async function save(kernel: Kernel, userId: number, items: ApplicationPassword[]): Promise<void> {
  await setUserMeta(kernel, userId, USERMETA_KEY_APPLICATION_PASSWORDS, items);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * wp_is_application_passwords_supported(): application passwords travel with
 * every request, so they are only accepted over HTTPS — or on a local
 * development host, as WordPress allows for its 'local' environment.
 * The host comes from X-Forwarded-Host first, because requests reach core
 * through the admin's proxy and would otherwise always look local.
 * PRESSBASE_ALLOW_HTTP_APP_PASSWORDS=1 lifts the rule (e.g. a private network).
 */
export function applicationPasswordsSupported(c: Context): boolean {
  if (process.env.PRESSBASE_ALLOW_HTTP_APP_PASSWORDS === '1' || isSecureRequest(c)) return true;
  const host = (c.req.header('x-forwarded-host') ?? new URL(c.req.url).host)
    .split(',')[0]
    ?.trim()
    .replace(/:\d+$/, '')
    .toLowerCase();
  return Boolean(
    host && (LOCAL_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.test')),
  );
}

export async function applicationPasswordsAvailable(kernel: Kernel, userId?: number) {
  const site = await kernel.hooks.applyFilters('wp_is_application_passwords_available', true);
  if (!site || userId === undefined) return site;
  return kernel.hooks.applyFilters('wp_is_application_passwords_available_for_user', true, userId);
}

/** WP_Application_Passwords::create_new_application_password(). */
export async function createApplicationPassword(
  kernel: Kernel,
  userId: number,
  args: { name: string; app_id?: string },
): Promise<{ password: string; item: ApplicationPassword }> {
  const name = args.name.trim();
  if (!name) {
    throw new UserError(
      'application_password_empty_name',
      'An application name is required to create an application password.',
      400,
      { name: 'Give it a name, like the app or site that will use it.' },
    );
  }
  const items = await listApplicationPasswords(kernel, userId);
  if (items.some((item) => item.name === name)) {
    throw new UserError(
      'application_password_duplicate_name',
      'Each application name should be unique.',
      409,
      { name: 'You already have an application password with this name.' },
    );
  }
  const password = generate();
  const item: ApplicationPassword = {
    uuid: randomUUID(),
    app_id: args.app_id ?? '',
    name: name.slice(0, 200),
    password: fastHash(password),
    created: Math.floor(Date.now() / 1000),
    last_used: null,
    last_ip: null,
  };
  await save(kernel, userId, [...items, item]);
  await kernel.hooks.doAction('wp_create_application_password', userId, item, password, {
    name: item.name,
    app_id: item.app_id,
  });
  return { password, item };
}

export async function updateApplicationPassword(
  kernel: Kernel,
  userId: number,
  uuid: string,
  update: { name: string },
): Promise<ApplicationPassword> {
  const items = await listApplicationPasswords(kernel, userId);
  const item = items.find((i) => i.uuid === uuid);
  if (!item) throw notFound();
  const name = update.name.trim();
  if (!name) {
    throw new UserError(
      'application_password_empty_name',
      'An application name is required.',
      400,
      { name: 'Give it a name.' },
    );
  }
  if (items.some((i) => i.uuid !== uuid && i.name === name)) {
    throw new UserError(
      'application_password_duplicate_name',
      'Each application name should be unique.',
      409,
      { name: 'You already have an application password with this name.' },
    );
  }
  item.name = name.slice(0, 200);
  await save(kernel, userId, items);
  await kernel.hooks.doAction('wp_update_application_password', userId, item, { name });
  return item;
}

function notFound() {
  return new UserError(
    'rest_application_password_not_found',
    'Could not find an application password with that id.',
    404,
  );
}

/** WP_Application_Passwords::delete_application_password(). */
export async function deleteApplicationPassword(
  kernel: Kernel,
  userId: number,
  uuid: string,
): Promise<ApplicationPassword> {
  const items = await listApplicationPasswords(kernel, userId);
  const item = items.find((i) => i.uuid === uuid);
  if (!item) throw notFound();
  await save(
    kernel,
    userId,
    items.filter((i) => i.uuid !== uuid),
  );
  await kernel.hooks.doAction('wp_delete_application_password', userId, item);
  return item;
}

/** WP_Application_Passwords::delete_all_application_passwords(). */
export async function deleteAllApplicationPasswords(kernel: Kernel, userId: number) {
  const items = await listApplicationPasswords(kernel, userId);
  if (items.length) await save(kernel, userId, []);
  for (const item of items)
    await kernel.hooks.doAction('wp_delete_application_password', userId, item);
  return items.length;
}

/**
 * WP_Application_Passwords::record_application_password_usage(): at most one
 * write a day per password and address, so busy API clients don't write on
 * every request.
 */
async function recordUsage(kernel: Kernel, userId: number, uuid: string, ip: string) {
  const items = await listApplicationPasswords(kernel, userId);
  const item = items.find((i) => i.uuid === uuid);
  if (!item) return;
  const now = Math.floor(Date.now() / 1000);
  if (item.last_used && item.last_used + 86_400 > now && item.last_ip === ip) return;
  item.last_used = now;
  item.last_ip = ip;
  await save(kernel, userId, items);
}

export type AuthResult =
  | { ok: true; user: CurrentUser; item: ApplicationPassword }
  | { ok: false; code: string; message: string };

/** wp_authenticate_application_password(): a login (or email) and a password. */
export async function authenticateApplicationPassword(
  kernel: Kernel,
  username: string,
  password: string,
  ip: string,
): Promise<AuthResult> {
  const fail = async (code: string, message: string): Promise<AuthResult> => {
    await kernel.hooks.doAction('application_password_failed_authentication', { code, message });
    return { ok: false, code, message };
  };

  const value = username.trim().toLowerCase();
  const [row] = await kernel.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      or(
        eq(sql`lower(${schema.users.login})`, value),
        isEmail(username) ? eq(sql`lower(${schema.users.email})`, value) : undefined,
      ),
    );
  if (!row) {
    return isEmail(username)
      ? fail('invalid_email', 'Unknown email address. Check again or try your username.')
      : fail('invalid_username', 'Unknown username. Check again or try your email address.');
  }
  if (!(await applicationPasswordsAvailable(kernel))) {
    return fail('application_passwords_disabled', 'Application passwords are not available.');
  }
  if (!(await applicationPasswordsAvailable(kernel, row.id))) {
    return fail(
      'application_passwords_disabled_for_user',
      'Application passwords are not available for your account. Please contact the site administrator for assistance.',
    );
  }

  // Generated passwords are alphanumeric; spaces (the readable grouping) are ignored.
  const normalized = password.replace(/[^a-z\d]/gi, '');
  const items = await listApplicationPasswords(kernel, row.id);
  const item = items.find((i) => verifyFastHash(normalized, i.password));
  const user = item ? await loadUser(kernel, row.id) : null;
  if (!item || !user) {
    return fail('incorrect_password', 'The provided password is an invalid application password.');
  }
  const errors = new AuthErrors();
  await kernel.hooks.doAction(
    'wp_authenticate_application_password_errors',
    errors,
    user,
    item,
    normalized,
  );
  const first = errors.errors[0];
  if (first) return fail(first.code, first.message);

  await recordUsage(kernel, row.id, item.uuid, ip);
  await kernel.hooks.doAction('application_password_did_authenticate', user, item);
  return { ok: true, user, item };
}

/** Decodes `Authorization: Basic base64(login:password)`. */
export function parseBasicAuth(header: string): { username: string; password: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 1) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * Authenticates API clients that send `Authorization: Basic`, after the
 * cookie middleware. A request that carries an Authorization header is
 * authenticated by that header alone: any session cookie it also carries is
 * ignored, because such requests skip the CSRF header check.
 *
 * Bad credentials answer 401 with WordPress's code (invalid_username,
 * invalid_email, incorrect_password) instead of continuing as a visitor, as
 * rest_application_password_check_errors() does. Failures are throttled per
 * address.
 */
export function applicationPasswordAuth(): MiddlewareHandler<AppEnv> {
  const failures = new RateLimiter(50, FIFTEEN_MINUTES);
  return async (c, next) => {
    const header = c.req.header('authorization');
    const kernel = c.get('kernel');
    if (!header || kernel.state !== 'ready') return next();

    c.set('user', null);
    const credentials = parseBasicAuth(header);
    if (!credentials) return next(); // Other schemes are for plugins; the request is anonymous.
    if (!applicationPasswordsSupported(c)) {
      return restError(
        c,
        401,
        'application_passwords_disabled',
        'Application passwords are only accepted over HTTPS.',
      );
    }

    const ip = clientIp(c);
    const wait = failures.retryAfter(ip);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return restError(
        c,
        429,
        'pressbase_too_many_attempts',
        `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`,
        { retryAfter: wait },
      );
    }
    const result = await authenticateApplicationPassword(
      kernel,
      credentials.username,
      credentials.password,
      ip,
    );
    if (!result.ok) {
      failures.hit(ip);
      return restError(c, 401, result.code, result.message);
    }
    c.set('user', result.user);
    c.set('applicationPassword', { uuid: result.item.uuid, userId: result.user.id });
    return next();
  };
}
