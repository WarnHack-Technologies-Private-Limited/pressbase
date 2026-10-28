import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { loadUser } from '@pressbase/core/src/auth/users';
import type { CurrentUser } from '@pressbase/core/src/auth/users';
import { type Config, loadConfig } from '@pressbase/core/src/config';
import { describeDatabaseError } from '@pressbase/core/src/install/database';
import { Kernel } from '@pressbase/core/src/kernel';
import { DatabaseLockedError, schema } from '@pressbase/db';
import { eq, or, sql } from 'drizzle-orm';
import { CliError } from './command';

/**
 * Loading Pressbase the way the server does (wp-cli's bootstrap loads
 * wp-config.php and wp-settings.php): the same configuration, then the
 * kernel booted in this process. No HTTP server and no job worker start.
 */

/** apps/core: the server's working directory in development and in the Docker image. */
export const CORE_DIR = fileURLToPath(new URL('../../../apps/core/', import.meta.url));

/** The repository's .env, which core's dev and start scripts read too. */
const ENV_FILE = path.resolve(CORE_DIR, '../../.env');

function readEnvFile(): Record<string, string> {
  try {
    return parseEnv(readFileSync(ENV_FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * The configuration core would load, from the environment, the repository's
 * .env and `<dataDir>/config.json`. The data folder is `--data-dir`, else
 * PRESSBASE_DATA_DIR, else core's default: `.pressbase` in core's working
 * directory (apps/core), where `pnpm dev` keeps it. A relative
 * PRESSBASE_DATA_DIR from .env is relative to apps/core, as for the server;
 * one from the shell or --data-dir is relative to where you run the command.
 */
export async function resolveConfig(
  env: NodeJS.ProcessEnv,
  options: { dataDir?: string; cwd: string },
): Promise<Config> {
  const fromFile = readEnvFile();
  const merged: NodeJS.ProcessEnv = { ...fromFile, ...env };
  let dataDir: string;
  if (options.dataDir) dataDir = path.resolve(options.cwd, options.dataDir);
  else if (env.PRESSBASE_DATA_DIR) dataDir = path.resolve(options.cwd, env.PRESSBASE_DATA_DIR);
  else if (fromFile.PRESSBASE_DATA_DIR) dataDir = path.resolve(CORE_DIR, fromFile.PRESSBASE_DATA_DIR);
  else dataDir = path.join(CORE_DIR, '.pressbase');
  try {
    return await loadConfig({ ...merged, PRESSBASE_DATA_DIR: dataDir });
  } catch (error) {
    throw new CliError(
      `Couldn’t read ${path.join(dataDir, 'config.json')}: ${(error as Error).message}. Check that it’s valid JSON.`,
    );
  }
}

/** Turns a database failure into what happened and what to do next. */
export function databaseError(error: unknown): CliError {
  if (error instanceof DatabaseLockedError) return new CliError(error.message);
  const problem = describeDatabaseError(error);
  return new CliError(`${problem.message} ${problem.hint}`);
}

/** Boots a kernel for the configuration. The caller shuts it down. */
export async function bootKernel(config: Config): Promise<Kernel> {
  // Named in the built-in database's lock file, so the server can say who holds it.
  process.env.PRESSBASE_PROCESS ??= 'the pressbase command';
  const kernel = new Kernel(config);
  try {
    await kernel.boot();
  } catch (error) {
    await kernel.shutdown().catch(() => {});
    throw databaseError(error);
  }
  return kernel;
}

/** Why an installed site is needed, in plain words. */
export function requireInstalled(kernel: Kernel): void {
  if (kernel.state === 'needs-database') {
    throw new CliError(
      `No database is set up for the site in ${kernel.config.dataDir}. Run “pressbase core install”, set DATABASE_URL, or point --data-dir at the site’s data folder.`,
    );
  }
  if (kernel.state === 'needs-install') {
    throw new CliError(
      'Pressbase isn’t installed in this database yet. Run “pressbase core install” first.',
    );
  }
}

/** --user=<id|login|email>, as wp-cli accepts it. */
export async function resolveUser(kernel: Kernel, value: string): Promise<CurrentUser> {
  const id = /^\d+$/.test(value) ? Number(value) : undefined;
  const lower = value.toLowerCase();
  const [row] = await kernel.db
    .select({ id: schema.users.id })
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
  const user = row ? await loadUser(kernel, row.id) : null;
  if (!user) {
    throw new CliError(
      `There’s no user “${value}”. Use a login, email address or ID (“pressbase user list” shows them).`,
    );
  }
  return user;
}
