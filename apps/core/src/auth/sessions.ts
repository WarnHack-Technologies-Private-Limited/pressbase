import { createHash, randomBytes } from 'node:crypto';
import { schema } from '@pressbase/db';
import { and, eq, gt } from 'drizzle-orm';
import type { Kernel } from '../kernel';

/**
 * Cookie sessions. The browser holds a random token; the database stores only
 * its SHA-256, so a leaked sessions table cannot be replayed.
 * Lifetimes match WordPress: 14 days with "Remember me", otherwise 2 days and
 * a browser-session cookie.
 */
export const SESSION_COOKIE = 'pressbase_session';
export const REMEMBER_TTL_SECONDS = 14 * 24 * 60 * 60;
export const DEFAULT_TTL_SECONDS = 2 * 24 * 60 * 60;

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  kernel: Kernel,
  userId: number,
  details: { remember: boolean; ip: string; userAgent: string },
): Promise<{ token: string; maxAge: number | undefined }> {
  const token = randomBytes(32).toString('base64url');
  const ttl = details.remember ? REMEMBER_TTL_SECONDS : DEFAULT_TTL_SECONDS;
  await kernel.db.insert(schema.sessions).values({
    id: digest(token),
    userId,
    expiresAt: new Date(Date.now() + ttl * 1000),
    ip: details.ip.slice(0, 100),
    userAgent: details.userAgent.slice(0, 255),
  });
  // Expired sessions are removed by the daily pressbase_delete_expired_sessions event.
  return { token, maxAge: details.remember ? ttl : undefined };
}

/** Returns the session's user ID, or null when the token is unknown or expired. */
export async function resolveSession(kernel: Kernel, token: string): Promise<number | null> {
  const [session] = await kernel.db
    .select({ userId: schema.sessions.userId })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.id, digest(token)), gt(schema.sessions.expiresAt, new Date())));
  return session?.userId ?? null;
}

export async function destroySession(kernel: Kernel, token: string): Promise<void> {
  await kernel.db.delete(schema.sessions).where(eq(schema.sessions.id, digest(token)));
}
