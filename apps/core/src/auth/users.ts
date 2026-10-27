import { schema } from '@pressbase/db';
import { and, eq, or, sql } from 'drizzle-orm';
import type { Kernel } from '../kernel';
import { DEFAULT_ROLES, type RoleMap, resolveCapabilities } from './capabilities';

export interface CurrentUser {
  id: number;
  login: string;
  email: string;
  displayName: string;
  nicename: string;
  roles: string[];
  capabilities: Record<string, boolean>;
}

export async function loadUser(kernel: Kernel, id: number): Promise<CurrentUser | null> {
  const [user] = await kernel.db.select().from(schema.users).where(eq(schema.users.id, id));
  if (!user) return null;
  const [grants] = await kernel.db
    .select({ value: schema.usermeta.value })
    .from(schema.usermeta)
    .where(and(eq(schema.usermeta.userId, id), eq(schema.usermeta.key, 'capabilities')));
  const roles = await kernel.options.get<RoleMap>('user_roles', DEFAULT_ROLES);
  const resolved = resolveCapabilities((grants?.value as Record<string, boolean>) ?? {}, roles);
  return {
    id: user.id,
    login: user.login,
    email: user.email,
    displayName: user.displayName,
    nicename: user.nicename,
    ...resolved,
  };
}

/** Finds a user by login or email, case-insensitively, as WordPress's login form does. */
export async function findUserForLogin(kernel: Kernel, identifier: string) {
  const value = identifier.trim().toLowerCase();
  const [user] = await kernel.db
    .select({ id: schema.users.id, pass: schema.users.pass })
    .from(schema.users)
    .where(
      or(
        eq(sql`lower(${schema.users.login})`, value),
        eq(sql`lower(${schema.users.email})`, value),
      ),
    );
  return user;
}

export function userCan(user: CurrentUser | null, capability: string): boolean {
  return Boolean(user?.capabilities[capability]);
}
