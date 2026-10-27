import { randomInt } from 'node:crypto';
import { schema } from '@pressbase/db';
import { eq, sql } from 'drizzle-orm';
import { hashPassword } from '../auth/password';
import type { Kernel } from '../kernel';
import { destroyUserSessions, fastHash, type UserRow, verifyFastHash } from './users';

/**
 * Password reset — get_password_reset_key(), check_password_reset_key() and
 * reset_password() from wordpress/wp-includes/user.php, and the
 * lostpassword / resetpass flows of wp-login.php.
 *
 * The key is 20 random characters. Only `<unix time>:<hash>` is stored in
 * users.activation_key, as WordPress stores it, so a database leak doesn't
 * leak working links. Keys expire after a day (password_reset_expiration).
 */

const KEY_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const RESET_KEY_TTL_SECONDS = 24 * 60 * 60;

export interface ResetUser {
  id: number;
  login: string;
  email: string;
  displayName: string;
}

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    password_reset_expiration: [seconds: number];
    retrieve_password_title: [title: string, login: string, user: ResetUser];
    retrieve_password_message: [message: string, key: string, login: string, user: ResetUser];
  }
  interface ActionRegistry {
    lostpassword_post: [user: ResetUser | null];
    retrieve_password: [login: string];
    retrieve_password_key: [login: string, key: string];
    /** The new password is not passed, unlike WordPress: core never hands plain passwords to hooks. */
    password_reset: [user: ResetUser];
    after_password_reset: [user: ResetUser];
  }
}

function toResetUser(row: UserRow): ResetUser {
  return { id: row.id, login: row.login, email: row.email, displayName: row.displayName };
}

/** Finds a user by login or email, case-insensitively (retrieve_password() accepts both). */
export async function findUserByLoginOrEmail(
  kernel: Kernel,
  identifier: string,
): Promise<UserRow | undefined> {
  const value = identifier.trim().toLowerCase();
  if (!value) return undefined;
  const column = value.includes('@') ? schema.users.email : schema.users.login;
  const [row] = await kernel.db
    .select()
    .from(schema.users)
    .where(eq(sql`lower(${column})`, value));
  if (row || !value.includes('@')) return row;
  // Usernames may contain '@' too.
  const [byLogin] = await kernel.db
    .select()
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.login})`, value));
  return byLogin;
}

/** get_password_reset_key(): stores a fresh key (replacing any older one) and returns it. */
export async function createResetKey(kernel: Kernel, user: UserRow): Promise<string> {
  let key = '';
  for (let i = 0; i < 20; i += 1) key += KEY_CHARS[randomInt(KEY_CHARS.length)];
  await kernel.hooks.doAction('retrieve_password', user.login);
  const stored = `${Math.floor(Date.now() / 1000)}:${fastHash(key)}`;
  await kernel.db
    .update(schema.users)
    .set({ activationKey: stored })
    .where(eq(schema.users.id, user.id));
  await kernel.hooks.doAction('retrieve_password_key', user.login, key);
  return key;
}

export type KeyCheck =
  | { ok: true; user: UserRow }
  | { ok: false; code: 'invalid_key' | 'expired_key'; message: string };

const INVALID = {
  ok: false,
  code: 'invalid_key',
  message: 'This password reset link is not valid.',
} as const;

/** check_password_reset_key(): the key is compared in constant time. */
export async function checkResetKey(kernel: Kernel, login: string, key: string): Promise<KeyCheck> {
  const cleanKey = key.replace(/[^a-z0-9]/gi, '');
  if (!cleanKey || !login) return INVALID;
  const [user] = await kernel.db
    .select()
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.login})`, login.trim().toLowerCase()));
  if (!user?.activationKey.includes(':')) {
    // Same work either way, so response times don't reveal which logins exist.
    verifyFastHash(cleanKey, fastHash('pressbase-timing-equaliser'));
    return INVALID;
  }
  const [issued, hash = ''] = user.activationKey.split(/:(.*)/s);
  const valid = verifyFastHash(cleanKey, hash);
  if (!valid) return INVALID;
  const ttl = await kernel.hooks.applyFilters('password_reset_expiration', RESET_KEY_TTL_SECONDS);
  if (Number(issued) + ttl < Math.floor(Date.now() / 1000)) {
    return {
      ok: false,
      code: 'expired_key',
      message: 'This password reset link has expired. Ask for a new one.',
    };
  }
  return { ok: true, user };
}

/**
 * reset_password(): sets the password, clears the key and logs the user out
 * everywhere, so whoever knew the old password loses access.
 */
export async function resetPassword(kernel: Kernel, user: UserRow, password: string) {
  const resetUser = toResetUser(user);
  await kernel.hooks.doAction('password_reset', resetUser);
  await kernel.db
    .update(schema.users)
    .set({ pass: await hashPassword(password), activationKey: '' })
    .where(eq(schema.users.id, user.id));
  await destroyUserSessions(kernel, user.id);
  await kernel.hooks.doAction('after_password_reset', resetUser);
}

/** The admin's address, where /reset-password and /login live. */
export async function adminBaseUrl(kernel: Kernel): Promise<string> {
  const url = await kernel.options.get<string>('siteurl', '');
  return (url || (await kernel.options.get<string>('home', ''))).replace(/\/+$/, '');
}

export async function resetUrl(kernel: Kernel, key: string, login: string): Promise<string> {
  const q = new URLSearchParams({ key, login });
  return `${await adminBaseUrl(kernel)}/reset-password?${q}`;
}

/** retrieve_password(): emails the reset link. Resolves to whether the mail was sent. */
export async function sendResetEmail(kernel: Kernel, user: UserRow, key: string) {
  const siteName = (await kernel.options.get<string>('blogname', '')) || 'Pressbase';
  const url = await resetUrl(kernel, key, user.login);
  const resetUser = toResetUser(user);
  const { text, html } = kernel.mail.compose({
    siteName,
    heading: 'Reset your password',
    paragraphs: [
      `Someone asked to reset the password for this account on ${siteName}.`,
      `Username: ${user.login}`,
      'To choose a new password, open the link below. It works once and expires in 24 hours.',
    ],
    action: { label: 'Choose a new password', url },
    footnote: 'If you didn’t ask for this, you can ignore this email. Your password won’t change.',
  });
  const title = await kernel.hooks.applyFilters(
    'retrieve_password_title',
    `[${siteName}] Password reset`,
    user.login,
    resetUser,
  );
  const message = await kernel.hooks.applyFilters(
    'retrieve_password_message',
    text,
    key,
    user.login,
    resetUser,
  );
  // A filtered message is plain text; only keep the HTML when it wasn't changed.
  return kernel.mail.send({
    to: user.email,
    subject: title,
    text: message,
    html: message === text ? html : undefined,
  });
}

/** wp_new_user_notification(): the new user gets their username and a link to set a password. */
export async function sendNewUserEmail(kernel: Kernel, user: UserRow) {
  const siteName = (await kernel.options.get<string>('blogname', '')) || 'Pressbase';
  const key = await createResetKey(kernel, user);
  const url = await resetUrl(kernel, key, user.login);
  const { text, html } = kernel.mail.compose({
    siteName,
    heading: `Welcome to ${siteName}`,
    paragraphs: [
      `An account has been created for you on ${siteName}.`,
      `Username: ${user.login}`,
      'To set your password and log in, open the link below. It expires in 24 hours; after that, use “Forgot your password?” on the login screen.',
    ],
    action: { label: 'Set your password', url },
  });
  return kernel.mail.send({
    to: user.email,
    subject: `[${siteName}] Login details`,
    text,
    html,
  });
}

/** wp_password_change_notification() / send_password_change_email, to the account's address. */
export async function sendPasswordChangedEmail(kernel: Kernel, user: UserRow) {
  const siteName = (await kernel.options.get<string>('blogname', '')) || 'Pressbase';
  const login = `${await adminBaseUrl(kernel)}/lost-password`;
  const { text, html } = kernel.mail.compose({
    siteName,
    heading: 'Your password was changed',
    paragraphs: [
      `The password for ${user.login} on ${siteName} was just changed.`,
      'If you did this, there’s nothing else to do.',
      'If you didn’t, reset your password now and tell the site administrator.',
    ],
    action: { label: 'Reset your password', url: login },
  });
  return kernel.mail.send({
    to: user.email,
    subject: `[${siteName}] Password changed`,
    text,
    html,
  });
}

/** send_email_change_email: tells the old address that the account's email changed. */
export async function sendEmailChangedEmail(kernel: Kernel, oldEmail: string, user: UserRow) {
  const siteName = (await kernel.options.get<string>('blogname', '')) || 'Pressbase';
  const { text, html } = kernel.mail.compose({
    siteName,
    heading: 'Your email address was changed',
    paragraphs: [
      `The email address for ${user.login} on ${siteName} was changed to ${user.email}.`,
      'If you didn’t make this change, contact the site administrator.',
    ],
  });
  return kernel.mail.send({ to: oldEmail, subject: `[${siteName}] Email changed`, text, html });
}
