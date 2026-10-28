import { databaseUrlFrom } from '@pressbase/core/src/install/database';
import { InstallError, installPressbase, siteInput } from '@pressbase/core/src/install/installer';
import { DB_VERSION, PRESSBASE_VERSION } from '@pressbase/core/src/version';
import type { CommandSpec } from '../command';
import { generatePassword } from './shared';

/**
 * `pressbase core`: wp-cli's core-command (`wp core version`, `wp core install`).
 */
export const coreCommands: CommandSpec[] = [
  {
    name: 'core version',
    shortdesc: 'Shows the Pressbase version.',
    synopsis: '[--extra]',
    options: { extra: 'Also show the data version and the Node.js version.' },
    examples: [['pressbase core version', 'Show the version']],
    needs: 'none',
    run(ctx) {
      if (!ctx.flag('extra')) {
        ctx.line(PRESSBASE_VERSION);
        return;
      }
      ctx.line(
        [
          `Pressbase version:\t${PRESSBASE_VERSION}`,
          `Data version:\t${DB_VERSION}`,
          `Node.js version:\t${process.versions.node}`,
        ].join('\n'),
      );
    },
  },
  {
    name: 'core install',
    shortdesc: 'Installs Pressbase: the administrator, default settings and sample content.',
    synopsis:
      '--url=<url> --title=<site-title> --admin_user=<username> [--admin_password=<password>] --admin_email=<email> [--timezone=<timezone>] [--database-url=<url>] [--builtin-database] [--discourage-search-engines]',
    options: {
      url: 'The site’s address, such as https://example.com.',
      title: 'The site title.',
      admin_user: 'The administrator’s username.',
      admin_password:
        'The administrator’s password. Left out, a strong one is generated and printed.',
      admin_email: 'The administrator’s email address.',
      timezone: 'The site’s time zone, such as Europe/London. Default: this computer’s.',
      'database-url':
        'When no database is set up yet: a PostgreSQL URL (postgres://user:pass@host/db). Saved to config.json.',
      'builtin-database':
        'When no database is set up yet: use the built-in database. Fine for trying Pressbase; not meant for live sites.',
      'discourage-search-engines': 'Ask search engines not to index the site.',
    },
    longdesc:
      'Runs the same steps as the web installer. When DATABASE_URL or config.json already names a database, that one is used; otherwise choose one with --database-url or --builtin-database.',
    examples: [
      [
        'pressbase core install --url=https://example.com --title="Field notes" --admin_user=editor --admin_email=editor@example.com',
        'Install with the configured database; the password is generated',
      ],
      [
        'pressbase core install --builtin-database --url=http://localhost:3000 --title=Trial --admin_user=admin --admin_email=admin@example.com --admin_password="a long passphrase"',
        'Try Pressbase on the built-in database',
      ],
    ],
    needs: 'kernel',
    async run(ctx) {
      const kernel = ctx.kernel;
      if (kernel.state === 'ready') {
        ctx.log('Pressbase is already installed.');
        return;
      }
      const generated = ctx.string('admin_password') === undefined;
      const password = ctx.string('admin_password') ?? generatePassword();
      const parsed = siteInput.safeParse({
        title: ctx.string('title'),
        username: ctx.string('admin_user'),
        password,
        email: ctx.string('admin_email'),
        url: ctx.string('url'),
        timezone: ctx.string('timezone') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        discourageSearchEngines: ctx.flag('discourage-search-engines'),
      });
      if (!parsed.success) {
        const flags: Record<string, string> = {
          title: 'title',
          username: 'admin_user',
          password: 'admin_password',
          email: 'admin_email',
          url: 'url',
        };
        const issue = parsed.error.issues[0];
        const key = String(issue?.path[0] ?? '');
        return ctx.error(`--${flags[key] ?? key}: ${issue?.message ?? 'This value isn’t valid.'}`);
      }

      let databaseUrl: string | undefined;
      if (kernel.state === 'needs-database') {
        const url = ctx.string('database-url');
        if (url && ctx.flag('builtin-database')) {
          ctx.error('Choose one database: --database-url or --builtin-database, not both.');
        }
        if (url) {
          if (!/^postgres(ql)?:\/\//i.test(url)) {
            ctx.error('--database-url must start with postgres:// (or use --builtin-database).');
          }
          databaseUrl = url;
        } else if (ctx.flag('builtin-database')) {
          databaseUrl = databaseUrlFrom({ kind: 'embedded' }, kernel.config.dataDir);
        } else {
          ctx.error(
            `No database is set up for ${kernel.config.dataDir}. Add --database-url=postgres://… or --builtin-database.`,
          );
        }
      } else if (ctx.has('database-url') || ctx.flag('builtin-database')) {
        ctx.warning('A database is already configured, so --database-url and --builtin-database are ignored.');
      }

      try {
        await installPressbase(kernel, { site: parsed.data, databaseUrl });
      } catch (error) {
        if (error instanceof InstallError) {
          ctx.error(error.hint ? `${error.message} ${error.hint}` : error.message);
        }
        throw error;
      }
      if (generated) ctx.line(`Admin password: ${password}`);
      if (kernel.connection.driver === 'pglite') {
        ctx.warning(
          'This site uses the built-in database, which isn’t meant for live sites. Use PostgreSQL before you launch.',
        );
      }
      ctx.success('Pressbase installed successfully.');
    },
  },
];
