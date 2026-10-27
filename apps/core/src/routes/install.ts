import { createHash, timingSafeEqual } from 'node:crypto';
import { access, constants, mkdir } from 'node:fs/promises';
import { testConnection } from '@pressbase/db';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import { createSession, SESSION_COOKIE } from '../auth/sessions';
import { loadUser } from '../auth/users';
import { writeSiteConfig } from '../config';
import {
  type AppEnv,
  clientIp,
  invalidParams,
  isSecureRequest,
  readJson,
  restError,
} from '../http';
import { databaseInput, databaseUrlFrom, describeDatabaseError } from '../install/database';
import { installSite, siteInput } from '../install/installer';
import type { Kernel, SiteState } from '../kernel';
import { PRESSBASE_VERSION } from '../version';

const MIN_NODE_MAJOR = 22;

interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

async function systemChecks(kernel: Kernel): Promise<Check[]> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  let writable = true;
  try {
    await mkdir(kernel.config.dataDir, { recursive: true });
    await access(kernel.config.dataDir, constants.W_OK);
  } catch {
    writable = false;
  }
  return [
    {
      id: 'node',
      label: 'Node.js version',
      ok: nodeMajor >= MIN_NODE_MAJOR,
      detail: `Running ${process.versions.node}; Pressbase needs ${MIN_NODE_MAJOR} or newer.`,
    },
    {
      id: 'data-dir',
      label: 'Data folder is writable',
      ok: writable,
      detail: kernel.config.dataDir,
    },
  ];
}

function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(given).digest();
  return timingSafeEqual(a, b);
}

const checkBody = z.object({ database: databaseInput, setupToken: z.string().optional() });
const installBody = z.object({
  database: databaseInput.optional(),
  site: siteInput,
  setupToken: z.string().optional(),
});

/**
 * The web installer's API — WordPress's setup-config.php and install.php.
 * Every route here refuses to act once the site is installed.
 */
export function installRoutes() {
  const app = new Hono<AppEnv>();
  let installing = false;

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    return c.json({
      state: kernel.state,
      version: PRESSBASE_VERSION,
      databaseFromEnv: kernel.config.databaseFromEnv,
      setupTokenRequired: Boolean(kernel.config.setupToken),
      checks: kernel.state === 'ready' ? [] : await systemChecks(kernel),
    });
  });

  app.post('/database-check', async (c) => {
    const kernel = c.get('kernel');
    if (kernel.state !== 'needs-database') {
      return restError(c, 409, 'pressbase_database_configured', 'The database is already set up.');
    }
    const parsed = checkBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    if (
      kernel.config.setupToken &&
      !tokenMatches(kernel.config.setupToken, parsed.data.setupToken)
    ) {
      return restError(c, 403, 'pressbase_setup_token_invalid', 'That setup code is not right.');
    }
    if (parsed.data.database.kind === 'embedded') return c.json({ ok: true });
    try {
      await testConnection(databaseUrlFrom(parsed.data.database, kernel.config.dataDir));
      return c.json({ ok: true });
    } catch (error) {
      const problem = describeDatabaseError(error);
      return restError(c, 400, problem.code, problem.message, { hint: problem.hint });
    }
  });

  app.post('/', async (c) => {
    const kernel = c.get('kernel');
    if (kernel.state === 'ready') {
      return restError(
        c,
        409,
        'pressbase_already_installed',
        'Pressbase is already installed. Log in instead.',
      );
    }
    const parsed = installBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const { database, site, setupToken } = parsed.data;
    if (kernel.config.setupToken && !tokenMatches(kernel.config.setupToken, setupToken)) {
      return restError(c, 403, 'pressbase_setup_token_invalid', 'That setup code is not right.');
    }
    if (installing) {
      return restError(
        c,
        409,
        'pressbase_install_in_progress',
        'An installation is already running.',
      );
    }

    installing = true;
    try {
      let newDatabaseUrl: string | undefined;
      if (kernel.state === 'needs-database') {
        if (!database) {
          return restError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): database', {
            params: { database: 'Choose a database.' },
          });
        }
        newDatabaseUrl = databaseUrlFrom(database, kernel.config.dataDir);
        let state: SiteState;
        try {
          state = await kernel.useDatabase(newDatabaseUrl);
        } catch (error) {
          const problem = describeDatabaseError(error);
          return restError(c, 400, problem.code, problem.message, { hint: problem.hint });
        }
        if (state === 'ready') {
          await writeSiteConfig(kernel.config.dataDir, { databaseUrl: newDatabaseUrl });
          return restError(
            c,
            409,
            'pressbase_already_installed',
            'This database already holds a Pressbase site. Log in instead.',
          );
        }
      }

      const { userId } = await installSite(kernel.db, site);
      if (newDatabaseUrl)
        await writeSiteConfig(kernel.config.dataDir, { databaseUrl: newDatabaseUrl });
      await kernel.refreshState();

      // Sign the new administrator in, so the installer can hand over to the dashboard.
      const session = await createSession(kernel, userId, {
        remember: true,
        ip: clientIp(c),
        userAgent: c.req.header('user-agent') ?? '',
      });
      setCookie(c, SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: isSecureRequest(c),
        path: '/',
        maxAge: session.maxAge,
      });
      const user = await loadUser(kernel, userId);
      return c.json({ state: kernel.state, user: { id: user?.id, name: user?.displayName } }, 201);
    } finally {
      installing = false;
    }
  });

  return app;
}
