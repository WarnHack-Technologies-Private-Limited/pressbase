import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import {
  type AuthorChoice,
  type ExportOptions,
  exportFilename,
  exportWxr,
  type ImportReport,
  importWxr,
  scanWxr,
} from '@pressbase/core/src/import-export';
import type { CommandSpec, Context } from '../command';
import { plural, service } from './shared';

/**
 * `pressbase import` and `pressbase export`: wp-cli's import-command and
 * export-command, on importWxr() and exportWxr() (docs/architecture/import-export.md).
 */
export const importExportCommands: CommandSpec[] = [
  {
    name: 'import',
    shortdesc: 'Imports content from WordPress export (WXR) files.',
    synopsis: '<file>... [--authors=<authors>] [--skip=<data-type>]',
    options: {
      file: 'One or more WXR files.',
      authors:
        '`create` (default): each author becomes the user with the same username, created if missing. `current`: everything belongs to the --user running the import.',
      skip: '`attachment`: don’t download attachments from the original site.',
    },
    choices: { authors: ['create', 'current'], skip: ['attachment'] },
    defaults: { authors: 'create' },
    longdesc:
      'Imports run as the --user you give, who needs the `import` capability. Posts that are already on this site are skipped, so you can run an import again.',
    examples: [
      ['pressbase import site.xml --user=admin', 'Import a site, downloading its media'],
      [
        'pressbase import site.xml --user=admin --authors=current --skip=attachment',
        'Import as yourself, without media',
      ],
    ],
    needs: 'installed',
    async run(ctx) {
      const user =
        ctx.user ??
        ctx.error('Imports run as a user. Add --user=<username>, for example --user=admin.');
      await ctx.require('import', undefined, `${user.login} isn’t allowed to import content.`);
      let failed = 0;
      for (const file of ctx.args) {
        const filePath = ctx.resolvePath(file);
        if (!(await stat(filePath).catch(() => null))?.isFile()) {
          ctx.error(`There’s no file at ${filePath}.`);
        }
        ctx.log(`Starting the import of ${file}…`);
        const summary = await service(() => scanWxr({ path: filePath }));
        const authors: Record<string, AuthorChoice> = {};
        if (ctx.string('authors') === 'current') {
          for (const author of summary.authors) {
            authors[author.author_login] = { action: 'map', userId: user.id };
          }
        }
        const report = await service(() =>
          importWxr(
            ctx.kernel,
            { path: filePath },
            {
              userId: user.id,
              authors,
              fetchAttachments: ctx.string('skip') !== 'attachment',
              total: summary.items,
              onProgress: (p) => {
                if (p.phase === 'importing' && p.current) {
                  ctx.log(`${p.done}/${p.total} ${p.current}`);
                }
              },
            },
          ),
        );
        reportImport(ctx, file, report);
        if (report.errors.total) failed += 1;
      }
      if (failed) ctx.error(`${plural(failed, 'import')} finished with errors.`);
      ctx.success(`Imported ${plural(ctx.args.length, 'file')}.`);
    },
  },
  {
    name: 'export',
    shortdesc: 'Exports content to a WordPress export (WXR) file.',
    synopsis:
      '[--dir=<dir>] [--stdout] [--post_type=<post-type>] [--post_author=<author>] [--category=<category>] [--start_date=<date>] [--end_date=<date>] [--post_status=<status>]',
    options: {
      dir: 'Folder to write the file into. Default: the current folder.',
      stdout: 'Write the export to standard output instead of a file.',
      post_type: 'Only this post type (post, page, …). Default: all content.',
      post_author: 'Only posts by this user ID.',
      category: 'Only posts in this category (ID or slug).',
      start_date: 'From this date: YYYY-MM or YYYY-MM-DD.',
      end_date: 'Up to this date: YYYY-MM or YYYY-MM-DD.',
      post_status: 'Only posts with this status.',
    },
    examples: [
      ['pressbase export', 'Export everything to a file in this folder'],
      ['pressbase export --post_type=page --dir=backups', 'Export pages into backups/'],
      ['pressbase export --stdout > site.xml', 'Export to standard output'],
    ],
    needs: 'installed',
    async run(ctx) {
      if (ctx.user) {
        await ctx.require(
          'export',
          undefined,
          `${ctx.user.login} isn’t allowed to export content.`,
        );
      }
      const options: ExportOptions = {
        content: ctx.string('post_type') ?? 'all',
        author: ctx.int('post_author'),
        category: ctx.string('category'),
        start_date: ctx.string('start_date'),
        end_date: ctx.string('end_date'),
        status: ctx.string('post_status'),
      };
      if (ctx.flag('stdout')) {
        await service(() => exportWxr(ctx.kernel, options, (chunk) => ctx.io.stdout.write(chunk)));
        return;
      }
      const dir = ctx.resolvePath(ctx.string('dir') ?? '.');
      if (!(await stat(dir).catch(() => null))?.isDirectory()) {
        ctx.error(`There’s no folder at ${dir}.`);
      }
      const file = path.join(dir, await exportFilename(ctx.kernel));
      const out = createWriteStream(file);
      await service(() => exportWxr(ctx.kernel, options, out));
      // exportWxr() leaves a Node stream open: end it and wait until the file is on disk.
      out.end();
      await finished(out);
      ctx.success(`Exported to ${file}.`);
    },
  },
];

function reportImport(ctx: Context, file: string, report: ImportReport) {
  const posts = Object.values(report.imported.posts).reduce((a, b) => a + b, 0);
  ctx.log(
    `${file}: ${plural(posts, 'post')} (every type), ${plural(report.imported.terms, 'term')}, ${plural(report.imported.comments, 'comment')}, ${plural(report.imported.users, 'new user')}, ${plural(report.imported.menus, 'menu')}.`,
  );
  if (report.skipped.total)
    ctx.log(`Skipped ${report.skipped.total} (already here, or not wanted).`);
  for (const item of report.errors.items) {
    ctx.warning(`${item.kind} “${item.title}”: ${item.reason}`);
  }
}
