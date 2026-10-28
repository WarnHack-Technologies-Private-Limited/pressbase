import {
  SEARCH_REPLACE_COLUMNS,
  SearchReplaceError,
  searchReplace,
} from '@pressbase/core/src/tools/search-replace';
import type { CommandSpec } from '../command';
import { plural } from './shared';

/**
 * `pressbase search-replace`: wp-cli's search-replace-command, on core's
 * JSON-aware search and replace (apps/core/src/tools/search-replace.ts).
 */
export const searchReplaceCommands: CommandSpec[] = [
  {
    name: 'search-replace',
    shortdesc: 'Searches and replaces text in posts, post meta, options and comments.',
    synopsis:
      '<old> <new> [<table>...] [--dry-run] [--include-columns=<columns>] [--skip-columns=<columns>] [--regex] [--regex-flags=<flags>] [--report-changed-only] [--format=<format>]',
    options: {
      old: 'The text to find.',
      new: 'What to put in its place.',
      table: `Only these tables: ${[...new Set(SEARCH_REPLACE_COLUMNS.map((c) => c.table))].join(', ')}.`,
      'dry-run': 'Report what would change, and change nothing.',
      'include-columns': `Only these columns, comma-separated: ${SEARCH_REPLACE_COLUMNS.map(
        (c) => c.column,
      )
        .filter((c, i, a) => a.indexOf(c) === i)
        .join(', ')}.`,
      'skip-columns': 'Leave these columns alone, comma-separated (guid, for example).',
      regex: '<old> is a JavaScript regular expression; <new> can use $1, $2…',
      'regex-flags': 'Flags for --regex: i (ignore case), m, s, u.',
      'report-changed-only': 'Leave unchanged columns out of the report.',
      format: 'table (the report) or count (just the number of replacements).',
    },
    choices: { format: ['table', 'count'] },
    longdesc:
      'Values stored as JSON stay valid: option and meta values, JSON documents in text, and block attributes in post content are replaced inside the JSON. Every cached public page is purged afterwards. Asks before changing anything, unless --yes or --dry-run.',
    examples: [
      [
        'pressbase search-replace http://old.example https://new.example --dry-run',
        'See what moving the site would change',
      ],
      [
        'pressbase search-replace http://old.example https://new.example --skip-columns=guid --yes',
        'Move the site to a new address',
      ],
      [
        'pressbase search-replace "colou?r" shade --regex --include-columns=post_content',
        'Replace with a regular expression',
      ],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(
        'manage_options',
        undefined,
        `${ctx.user?.login} isn’t allowed to run search and replace.`,
      );
      const [search = '', replace = '', ...tables] = ctx.args;
      const dryRun = ctx.flag('dry-run');
      if (search === replace && !ctx.flag('regex')) {
        ctx.error('The old and new values are the same, so there’s nothing to replace.');
      }
      if (!dryRun) {
        await ctx.confirm(
          `Replace “${search}” with “${replace}” across the site’s content and settings? Back up the database first; this can’t be undone.`,
        );
      }
      let report: Awaited<ReturnType<typeof searchReplace>>;
      try {
        report = await searchReplace(ctx.kernel, {
          search,
          replace,
          dryRun,
          regex: ctx.flag('regex'),
          regexFlags: ctx.string('regex-flags'),
          tables: tables.length ? tables : undefined,
          includeColumns: ctx.list('include-columns'),
          skipColumns: ctx.list('skip-columns'),
        });
      } catch (error) {
        if (error instanceof SearchReplaceError) ctx.error(error.message);
        throw error;
      }
      if (!dryRun && report.total) ctx.changedServerState();
      if (ctx.string('format') === 'count') {
        ctx.line(String(report.total));
        return;
      }
      const json = new Map(SEARCH_REPLACE_COLUMNS.map((c) => [`${c.table}.${c.column}`, c.json]));
      const rows = report.rows
        .filter((r) => !ctx.flag('report-changed-only') || r.replacements > 0)
        .map((r) => ({
          Table: r.table,
          Column: r.column,
          Replacements: r.replacements,
          Type: json.get(`${r.table}.${r.column}`) ? 'JSON' : 'text',
        }));
      ctx.formatItems(rows, ['Table', 'Column', 'Replacements', 'Type'], { formats: ['table'] });
      ctx.success(
        dryRun
          ? `${plural(report.total, 'replacement')} to be made.`
          : `Made ${plural(report.total, 'replacement')}.`,
      );
    },
  },
];
