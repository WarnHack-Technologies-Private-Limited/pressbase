import {
  connect,
  type DatabaseConnection,
  driverFor,
  migrationStatus,
  schema,
} from '@pressbase/db';
import { eq, sql } from 'drizzle-orm';
import { databaseError } from '../bootstrap';
import type { CommandSpec, Context } from '../command';
import { plural } from './shared';

/**
 * `pressbase db`: the parts of wp-cli's db-command that make sense for
 * Pressbase. `db migrate` applies pending schema migrations (the server also
 * does this on boot); `db check` connects and reports the schema's state
 * without changing anything. Neither boots the kernel or loads plugins.
 */

/** The database URL with its password hidden. */
export function redact(url: string): string {
  return url.replace(/^(postgres(?:ql)?:\/\/[^:/@]+:)[^@]*@/i, '$1***@');
}

async function open(ctx: Context): Promise<{ connection: DatabaseConnection; url: string }> {
  const url = ctx.config.databaseUrl;
  if (!url) {
    ctx.error(
      `No database is set up for ${ctx.config.dataDir}. Run “pressbase core install”, set DATABASE_URL, or point --data-dir at the site’s data folder.`,
    );
  }
  try {
    driverFor(url);
  } catch (error) {
    ctx.error(`${(error as Error).message} Check DATABASE_URL or config.json.`);
  }
  try {
    const connection = await connect(url, { maxConnections: 1, connectTimeout: 10 });
    try {
      await connection.db.execute(sql`select 1`);
    } catch (error) {
      await connection.close();
      throw error;
    }
    return { connection, url };
  } catch (error) {
    throw databaseError(error);
  }
}

async function installed(connection: DatabaseConnection): Promise<boolean> {
  try {
    const [row] = await connection.db
      .select({ id: schema.options.id })
      .from(schema.options)
      .where(eq(schema.options.name, 'pressbase_db_version'));
    return Boolean(row);
  } catch {
    return false;
  }
}

export const dbCommands: CommandSpec[] = [
  {
    name: 'db check',
    shortdesc: 'Checks the database connection and whether the schema is up to date.',
    synopsis: '[--format=<format>]',
    options: { format: 'How to show the result.' },
    choices: { format: ['table', 'json', 'yaml'] },
    longdesc:
      'Exits with an error when Pressbase can’t connect or migrations are pending, so scripts can rely on it.',
    examples: [['pressbase db check', 'Check the database']],
    needs: 'config',
    async run(ctx) {
      const { connection, url } = await open(ctx);
      try {
        const status = await migrationStatus(connection);
        const report = {
          database: redact(url),
          driver: connection.driver === 'pglite' ? 'built-in' : 'postgresql',
          connected: true,
          migrations: status.migrations.length,
          pending: status.pending,
          installed: await installed(connection),
        };
        if (ctx.has('format')) {
          ctx.formatItem(report, Object.keys(report));
        } else {
          ctx.log(`Database: ${report.database} (${report.driver})`);
          ctx.log(
            `Migrations: ${status.migrations.length - status.pending.length} of ${status.migrations.length} applied`,
          );
          ctx.log(`Site installed: ${report.installed ? 'yes' : 'no'}`);
        }
        if (status.pending.length) {
          ctx.error(
            `${plural(status.pending.length, 'migration')} pending: ${status.pending.join(', ')}. Run “pressbase db migrate”.`,
          );
        }
        ctx.success('The database is reachable and its schema is up to date.');
      } finally {
        await connection.close();
      }
    },
  },
  {
    name: 'db migrate',
    shortdesc: 'Applies pending database migrations.',
    longdesc:
      'The server applies migrations when it starts, so this is for upgrades you want to run (and check) before starting it.',
    examples: [['pressbase db migrate', 'Bring the schema up to date']],
    needs: 'config',
    async run(ctx) {
      const { connection } = await open(ctx);
      try {
        const { pending } = await migrationStatus(connection);
        if (!pending.length) {
          ctx.success('The database schema is already up to date.');
          return;
        }
        try {
          await connection.migrate();
        } catch (error) {
          throw databaseError(error);
        }
        ctx.success(`Applied ${plural(pending.length, 'migration')}: ${pending.join(', ')}.`);
      } finally {
        await connection.close();
      }
    },
  },
];
