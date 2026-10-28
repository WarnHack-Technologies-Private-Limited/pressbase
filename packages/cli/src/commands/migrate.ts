import { stat } from 'node:fs/promises';
import {
  connectWordPressDatabase,
  migrateFromWordPressDatabase,
  redactDatabaseUrl,
  type WordPressCounts,
  type WordPressDatabase,
  type WordPressMigrationResult,
} from '@pressbase/core/src/import-export';
import type { CommandSpec, Context } from '../command';
import { plural, service } from './shared';

/**
 * `pressbase migrate wordpress`: a WordPress site straight from its MySQL or
 * MariaDB database, on migrateFromWordPressDatabase()
 * (docs/architecture/import-export.md, ADR 0016).
 */

/** How the command connects; tests replace it with the in-memory fake. */
export const wordpressConnector: {
  connect: (url: string, prefix: string) => Promise<WordPressDatabase>;
} = { connect: connectWordPressDatabase };

/** Read when --db-url isn't given, so the password stays out of shell history and process lists. */
const URL_ENV = 'PRESSBASE_WP_DB_URL';

function sum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

function perType(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `${type} ${n}`)
    .join(', ');
}

function describeCounts(counts: WordPressCounts): string {
  return `${plural(counts.users, 'user')}, ${plural(sum(counts.terms), 'term')} (${perType(counts.terms) || 'none'}), ${plural(sum(counts.posts), 'post')} (${perType(counts.posts) || 'none'}), ${plural(counts.comments, 'comment')}`;
}

export const migrateCommands: CommandSpec[] = [
  {
    name: 'migrate wordpress',
    shortdesc: 'Migrates a WordPress site straight from its MySQL or MariaDB database.',
    synopsis:
      '[--db-url=<url>] [--prefix=<prefix>] [--uploads=<path>] [--uploads-url=<url>] [--skip=<data-type>] [--dry-run]',
    options: {
      'db-url': `mysql://user:password@host:3306/database. Add ?ssl-mode=VERIFY_IDENTITY (or REQUIRED) for TLS. Default: the ${URL_ENV} environment variable, which keeps the password out of your shell history.`,
      prefix: 'The table prefix ($table_prefix in wp-config.php). Default: wp_.',
      uploads:
        'A copy of the old site’s wp-content/uploads folder. Files are read from it instead of downloaded.',
      'uploads-url':
        'Where the old site served uploads from, if not its own address (a CDN, or a custom WP_CONTENT_URL).',
      skip: 'Comma-separated: `attachment` (no files), `comments`, `options` (keep this site’s settings), or any post type.',
      'dry-run': 'Count what would be migrated, and change nothing.',
    },
    defaults: { prefix: 'wp_' },
    longdesc:
      'Reads the database with SELECT queries only, so a MySQL user with just the SELECT privilege is enough. Users keep their passwords; users already here (same username or email address) are kept as they are. Running it again skips everything that’s already here. Multisite networks aren’t supported.',
    examples: [
      [
        'pressbase migrate wordpress --db-url=mysql://reader:secret@localhost/wordpress --uploads=/srv/old/wp-content/uploads --user=admin',
        'Migrate a site, reading files from a local folder',
      ],
      [
        `${URL_ENV}=mysql://reader:secret@db/wordpress pressbase migrate wordpress --dry-run --user=admin`,
        'Count what would be migrated',
      ],
    ],
    needs: 'installed',
    async run(ctx) {
      const user =
        ctx.user ??
        ctx.error('Migrations run as a user. Add --user=<username>, for example --user=admin.');
      await ctx.require('import', undefined, `${user.login} isn’t allowed to import content.`);
      const url = ctx.string('db-url') ?? process.env[URL_ENV];
      if (!url) {
        ctx.error(
          `Say which database to read: --db-url=mysql://user:password@host/database (or set ${URL_ENV}).`,
        );
      }
      const prefix = ctx.string('prefix') ?? 'wp_';
      let uploads: string | undefined;
      const uploadsArg = ctx.string('uploads');
      if (uploadsArg) {
        uploads = ctx.resolvePath(uploadsArg);
        if (!(await stat(uploads).catch(() => null))?.isDirectory()) {
          ctx.error(`There’s no folder at ${uploads}.`);
        }
      }
      const dryRun = ctx.flag('dry-run');

      ctx.log(`Reading ${redactDatabaseUrl(url)} (tables ${prefix}*)…`);
      const db = await service(() => wordpressConnector.connect(url, prefix));
      let result: WordPressMigrationResult;
      try {
        result = await service(() =>
          migrateFromWordPressDatabase(ctx.kernel, {
            database: db,
            userId: user.id,
            uploads,
            uploadsUrl: ctx.string('uploads-url'),
            skip: ctx.list('skip'),
            dryRun,
            onProgress: (p) => {
              if (p.phase === 'importing' && p.current) ctx.log(`${p.done}/${p.total} ${p.current}`);
              if (p.phase === 'finishing') ctx.log('Linking parents, featured images and menus…');
            },
          }),
        );
      } finally {
        await db.close();
      }
      ctx.log(`${result.site.title || 'The site'} (${result.site.base_blog_url}): ${describeCounts(result.counts)}.`);
      if (dryRun) {
        ctx.success('Dry run: nothing was changed.');
        return;
      }
      reportMigration(ctx, result);
    },
  },
];

function reportMigration(ctx: Context, result: WordPressMigrationResult) {
  const report = result.report;
  if (!report) return;
  ctx.log(
    `Migrated ${plural(sum(report.imported.posts), 'post')} (${perType(report.imported.posts) || 'none'}), ${plural(report.imported.terms, 'term')}, ${plural(report.imported.comments, 'comment')}, ${plural(report.imported.users, 'new user')}, ${plural(report.imported.menus, 'menu')}.`,
  );
  if (result.options.carried.length) {
    ctx.log(`Settings carried: ${result.options.carried.join(', ')}.`);
  }
  for (const { name, reason } of result.options.skipped) {
    ctx.warning(`Setting ${name} wasn’t carried: ${reason}`);
  }
  for (const [type, n] of Object.entries(report.skippedPostTypes)) {
    ctx.warning(`${plural(n, `“${type}” post`)} left out: this site has no such post type.`);
  }
  if (report.skipped.total) {
    ctx.log(`Skipped ${report.skipped.total} (already here, or not wanted).`);
  }
  for (const item of report.errors.items) {
    ctx.warning(`${item.kind} “${item.title}”: ${item.reason}`);
  }
  if (report.errors.total) {
    ctx.error(`The migration finished with ${plural(report.errors.total, 'error')}.`);
  }
  ctx.success('Migrated the WordPress site.');
}
