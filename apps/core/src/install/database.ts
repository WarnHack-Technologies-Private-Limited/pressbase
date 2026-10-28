import path from 'node:path';
import { z } from 'zod';

/** What the installer's database step can submit. */
export const databaseInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('embedded') }),
  z.object({
    kind: z.literal('postgres'),
    host: z.string().trim().min(1, 'Enter the database host.'),
    port: z.coerce.number().int().min(1).max(65535).default(5432),
    name: z.string().trim().min(1, 'Enter the database name.'),
    user: z.string().trim().min(1, 'Enter the database username.'),
    password: z.string().default(''),
    ssl: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('url'),
    url: z
      .string()
      .trim()
      .regex(/^postgres(ql)?:\/\//i, 'The URL must start with postgres://'),
  }),
]);

export type DatabaseInput = z.infer<typeof databaseInput>;

export function databaseUrlFrom(input: DatabaseInput, dataDir: string): string {
  switch (input.kind) {
    case 'embedded':
      return `pglite:${path.join(dataDir, 'db')}`;
    case 'url':
      return input.url;
    case 'postgres': {
      const auth = `${encodeURIComponent(input.user)}:${encodeURIComponent(input.password)}`;
      const query = input.ssl ? '?sslmode=require' : '';
      return `postgres://${auth}@${input.host}:${input.port}/${encodeURIComponent(input.name)}${query}`;
    }
  }
}

export interface DatabaseProblem {
  code: string;
  message: string;
  hint: string;
}

/**
 * Turns driver errors into something a site owner can act on. The installer
 * shows `message` as the headline and `hint` as the next step.
 */
export function describeDatabaseError(error: unknown): DatabaseProblem {
  // Drizzle wraps driver errors; the useful code is on the innermost cause.
  let err = error as { code?: string; message?: string; cause?: unknown };
  while (!err.code && err.cause && typeof err.cause === 'object') {
    err = err.cause as typeof err;
  }
  switch (err.code) {
    case 'ECONNREFUSED':
      return {
        code: 'pressbase_db_refused',
        message: 'The database server refused the connection.',
        hint: 'Check that PostgreSQL is running and that the host and port are right.',
      };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        code: 'pressbase_db_host_not_found',
        message: 'That database host could not be found.',
        hint: 'Check the spelling of the host name. For a database on this machine, use localhost.',
      };
    case 'CONNECT_TIMEOUT':
    case 'ETIMEDOUT':
      return {
        code: 'pressbase_db_timeout',
        message: 'The database server did not answer in time.',
        hint: 'A firewall may be blocking the port, or the server may be overloaded.',
      };
    case '28P01':
    case '28000':
      return {
        code: 'pressbase_db_auth_failed',
        message: 'The username or password was not accepted.',
        hint: 'Check the credentials with your host. Passwords are case-sensitive.',
      };
    case '3D000':
      return {
        code: 'pressbase_db_missing',
        message: 'That database does not exist yet.',
        hint: 'Create it first, for example with: createdb <name>',
      };
    case 'PRESSBASE_DB_LOCKED':
      return {
        code: 'pressbase_db_locked',
        message: 'Another Pressbase process is using the built-in database.',
        hint: 'Stop the Pressbase server or the pressbase command first, or use PostgreSQL.',
      };
    case '42501':
      return {
        code: 'pressbase_db_permission',
        message: 'The database user is not allowed to create tables.',
        hint: 'Grant the user CREATE on the database, or use the database owner.',
      };
    default:
      if (err.message && /ssl|tls|certificate/i.test(err.message)) {
        return {
          code: 'pressbase_db_ssl',
          message: 'A secure connection could not be set up.',
          hint: 'Try switching "Require SSL" off for local servers, or on for hosted databases.',
        };
      }
      return {
        code: 'pressbase_db_error',
        message: 'Pressbase could not connect to the database.',
        hint: err.message ?? 'Check the connection details and try again.',
      };
  }
}
