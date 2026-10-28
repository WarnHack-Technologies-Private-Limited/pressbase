import { cookies } from 'next/headers';

const CORE_URL = process.env.CORE_URL ?? 'http://localhost:4000';

export class CoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Could not reach the Pressbase core server at ${CORE_URL}. Is it running?`, { cause });
  }
}

/**
 * Server-side GET against core, forwarding the visitor's cookies so the
 * response is for the logged-in user. Never cached.
 */
export async function coreGet<T>(path: string): Promise<{ status: number; data: T }> {
  const cookieHeader = (await cookies()).toString();
  let res: Response;
  try {
    res = await fetch(`${CORE_URL}/wp-json${path}`, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      cache: 'no-store',
    });
  } catch (error) {
    throw new CoreUnavailableError(error);
  }
  return { status: res.status, data: (await res.json()) as T };
}

export interface InstallStatus {
  state: 'needs-database' | 'needs-install' | 'ready';
  version: string;
  databaseFromEnv: boolean;
  setupTokenRequired: boolean;
  checks: { id: string; label: string; ok: boolean; detail: string }[];
}

export interface Me {
  id: number;
  username: string;
  name: string;
  email: string;
  roles: string[];
  capabilities: Record<string, boolean>;
  /** Registered user meta, e.g. pressbase_admin_color_scheme. */
  meta?: Record<string, unknown>;
}

export interface SiteIndex {
  name: string;
  description: string;
  url: string;
  pressbase: { version: string; state: InstallStatus['state'] };
}
