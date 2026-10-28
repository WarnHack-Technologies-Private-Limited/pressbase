import { toGmtString, toLocalString } from '@pressbase/core/src/content/dates';
import type { Kernel } from '@pressbase/core/src/kernel';
import type { UserRow } from '@pressbase/core/src/people/users';
import { schema } from '@pressbase/db';
import { eq, or, sql } from 'drizzle-orm';
import { CliError } from '../command';

/** WordPress's MySQL datetime format, "2026-10-28 13:45:21", in the site's time zone. */
export function localDate(date: Date, timeZone: string): string {
  return toLocalString(date, timeZone).replace('T', ' ');
}

export function gmtDate(date: Date): string {
  return toGmtString(date).replace('T', ' ');
}

export async function siteTimeZone(kernel: Kernel): Promise<string> {
  return kernel.options.get<string>('timezone_string', 'UTC');
}

/**
 * Core services throw errors with WordPress's codes and messages (PostError,
 * UserError, TermError…). Shown as the command's error; anything else is a bug.
 */
export function serviceError(error: unknown): never {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    /^[a-z][a-z0-9_]*$/.test((error as { code: string }).code)
  ) {
    const params = (error as { params?: Record<string, string> }).params;
    const detail = params ? Object.values(params).find((m) => m && m !== error.message) : undefined;
    throw new CliError(detail ? `${error.message} ${detail}` : error.message);
  }
  throw error;
}

/** Runs a core service call, turning its errors into command errors. */
export async function service<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof CliError) throw error;
    serviceError(error);
  }
}

/** A user by ID, login or email, as wp-cli's user fetcher finds them. */
export async function findUserRow(kernel: Kernel, value: string): Promise<UserRow> {
  const id = /^\d+$/.test(value) ? Number(value) : undefined;
  const lower = value.toLowerCase();
  const [row] = await kernel.db
    .select()
    .from(schema.users)
    .where(
      id !== undefined
        ? eq(schema.users.id, id)
        : or(
            eq(sql`lower(${schema.users.login})`, lower),
            eq(sql`lower(${schema.users.email})`, lower),
          ),
    )
    .limit(1);
  if (!row) {
    throw new CliError(
      `There’s no user “${value}”. Use a login, email address or ID (“pressbase user list” shows them).`,
    );
  }
  return row;
}

/** "1 post", "3 posts". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** A strong random password, as wp_generate_password( 24 ) would make. */
export function generatePassword(length = 24): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

/** Reports a batch the way wp-cli does: "Success: Deleted 3 of 3 posts." or an error. */
export function batchResult(
  done: number,
  total: number,
  verb: string,
  noun: string,
  nouns = `${noun}s`,
): { ok: boolean; message: string } {
  const message = `${verb} ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${total === 1 ? noun : nouns}.`;
  return { ok: done === total, message };
}
