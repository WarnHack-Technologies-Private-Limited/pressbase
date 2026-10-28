import { SettingSanitizeError, sanitizeSettingValue } from '@pressbase/core/src/options/settings';
import { schema } from '@pressbase/db';
import { asc, eq, ilike } from 'drizzle-orm';
import type { CommandSpec, Context } from '../command';
import { yaml } from '../format';

/**
 * `pressbase option`: wp-cli's option-command, on the Options API
 * (get_option(), update_option(), add_option(), delete_option()).
 *
 * Pressbase stores option values as JSON, so values keep their type. With
 * the default `--format=plaintext` a value is text; for an option that
 * already holds a number, a boolean, or JSON, or that a setting describes
 * (`posts_per_page`, `blog_public`…), text that reads as that type is
 * stored as it (`5`, `true`). `--format=json` always parses the value.
 * Updating a registered setting runs what saving it in the admin runs: its
 * validation, sanitize callback and `sanitize_option_{option}` filters.
 */

const CAP = 'manage_options';

function display(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** The registered setting that stores this option, if any. */
function settingFor(ctx: Context, name: string) {
  return ctx.kernel.settings.entries().find(([, s]) => s.option === name)?.[1];
}

async function readValue(ctx: Context, raw: string | undefined): Promise<string> {
  if (raw !== undefined) return raw;
  if (ctx.io.stdin.isTTY) ctx.error('Give a value, or pipe one in on standard input.');
  return (await ctx.readInput('-')).replace(/\r?\n$/, '');
}

/** The value to store for text from the command line (see the note above). */
async function parseValue(ctx: Context, name: string, text: string, current: unknown) {
  if (ctx.string('format') === 'json') {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      ctx.error(
        'That value isn’t valid JSON. With --format=json, give a JSON value like 5, true or {"a":1}.',
      );
    }
  }
  const typed = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  })();
  const setting = settingFor(ctx, name);
  if (setting) {
    if (setting.schema.safeParse(text).success) return text;
    if (typed !== undefined && setting.schema.safeParse(typed).success) return typed;
    return text; // Refused with the setting's own message when saved.
  }
  if (current !== undefined && typeof current !== 'string' && typed !== undefined) {
    if (typeof typed === typeof current) return typed;
  }
  return text;
}

async function exists(ctx: Context, name: string) {
  const [row] = await ctx.kernel.db
    .select({ id: schema.options.id })
    .from(schema.options)
    .where(eq(schema.options.name, name));
  return Boolean(row);
}

/** update_option(): a registered setting's rules first. */
async function save(ctx: Context, name: string, value: unknown, autoload?: boolean) {
  const setting = settingFor(ctx, name);
  let next = value;
  if (setting) {
    try {
      next = await sanitizeSettingValue(ctx.kernel, setting, value);
    } catch (error) {
      if (error instanceof SettingSanitizeError) ctx.error(`${name}: ${error.message}`);
      throw error;
    }
  }
  await ctx.kernel.options.set(name, next, autoload === undefined ? {} : { autoload });
  ctx.changedServerState();
}

function autoloadFlag(ctx: Context): boolean | undefined {
  const value = ctx.string('autoload');
  if (value === undefined) return undefined;
  return value === 'yes' || value === 'on';
}

export const optionCommands: CommandSpec[] = [
  {
    name: 'option get',
    shortdesc: 'Shows the value of an option.',
    synopsis: '<key> [--format=<format>]',
    options: { key: 'The option’s name.', format: 'How to show the value.' },
    choices: { format: ['plaintext', 'json', 'yaml'] },
    defaults: { format: 'plaintext' },
    examples: [
      ['pressbase option get blogname', 'Show the site title'],
      ['pressbase option get active_plugins --format=json', 'Show a list as JSON'],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(CAP);
      const [name = ''] = ctx.args;
      if (!(await exists(ctx, name))) ctx.error(`There’s no option “${name}”.`);
      const value = await ctx.kernel.options.get(name);
      const format = ctx.string('format');
      ctx.line(
        format === 'json'
          ? JSON.stringify(value)
          : format === 'yaml'
            ? yaml(value)
            : display(value),
      );
    },
  },
  {
    name: 'option add',
    shortdesc: 'Adds an option that doesn’t exist yet.',
    synopsis: '<key> [<value>] [--format=<format>] [--autoload=<autoload>]',
    options: {
      key: 'The option’s name.',
      value: 'The value. Left out, it’s read from standard input.',
      format: 'How to read the value.',
      autoload: 'Load the option on every request.',
    },
    choices: { format: ['plaintext', 'json'], autoload: ['yes', 'no'] },
    examples: [['pressbase option add my_option "a value"', 'Add an option']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(CAP);
      const [name = '', raw] = ctx.args;
      if (await exists(ctx, name)) {
        ctx.error(
          `The option “${name}” already exists. Use “pressbase option update” to change it.`,
        );
      }
      const value = await parseValue(ctx, name, await readValue(ctx, raw), undefined);
      await save(ctx, name, value, autoloadFlag(ctx));
      ctx.success(`Added '${name}' option.`);
    },
  },
  {
    name: 'option update',
    shortdesc: 'Updates an option’s value, adding it if needed.',
    synopsis: '<key> [<value>] [--format=<format>] [--autoload=<autoload>]',
    options: {
      key: 'The option’s name.',
      value: 'The new value. Left out, it’s read from standard input.',
      format: 'How to read the value.',
      autoload: 'Load the option on every request.',
    },
    choices: { format: ['plaintext', 'json'], autoload: ['yes', 'no'] },
    examples: [
      ['pressbase option update blogname "Field notes"', 'Change the site title'],
      ['pressbase option update posts_per_page 5', 'Store a number'],
      [
        'echo \'{"a":1}\' | pressbase option update my_option --format=json',
        'Store JSON from standard input',
      ],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(CAP);
      const [name = '', raw] = ctx.args;
      const had = await exists(ctx, name);
      const current = had ? await ctx.kernel.options.get(name) : undefined;
      const value = await parseValue(ctx, name, await readValue(ctx, raw), current);
      if (had && JSON.stringify(current) === JSON.stringify(value) && !ctx.has('autoload')) {
        ctx.success(`Value passed for '${name}' option is unchanged.`);
        return;
      }
      await save(ctx, name, value, autoloadFlag(ctx));
      ctx.success(`Updated '${name}' option.`);
    },
  },
  {
    name: 'option delete',
    shortdesc: 'Deletes one or more options.',
    synopsis: '<key>...',
    options: { key: 'The options’ names.' },
    examples: [['pressbase option delete my_option', 'Delete an option']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(CAP);
      let missing = 0;
      for (const name of ctx.args) {
        if (!(await exists(ctx, name))) {
          ctx.warning(`Could not delete '${name}' option. Does it exist?`);
          missing += 1;
          continue;
        }
        await ctx.kernel.options.delete(name);
        ctx.changedServerState();
        ctx.success(`Deleted '${name}' option.`);
      }
      if (missing) ctx.error(`${missing} of ${ctx.args.length} options couldn’t be deleted.`);
    },
  },
  {
    name: 'option list',
    shortdesc: 'Lists options and their values.',
    synopsis:
      '[--search=<pattern>] [--autoload=<autoload>] [--fields=<fields>] [--field=<field>] [--format=<format>]',
    options: {
      search: 'Only options whose names match. * matches anything: --search="pressbase_*".',
      autoload: 'Only options that are (on) or aren’t (off) loaded on every request.',
    },
    choices: { autoload: ['on', 'off'] },
    examples: [
      ['pressbase option list --search="*_size_w"', 'List image width settings'],
      ['pressbase option list --autoload=off --format=count', 'Count options loaded on demand'],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(CAP);
      const search = ctx.string('search');
      const rows = await ctx.kernel.db
        .select()
        .from(schema.options)
        .where(
          search
            ? ilike(schema.options.name, search.replace(/[%_\\]/g, '\\$&').replace(/\*/g, '%'))
            : undefined,
        )
        .orderBy(asc(schema.options.name));
      const autoload = ctx.string('autoload');
      const items = rows
        .filter((r) => autoload === undefined || r.autoload === (autoload === 'on'))
        .map((r) => ({
          option_id: r.id,
          option_name: r.name,
          option_value: typeof r.value === 'string' ? r.value : JSON.stringify(r.value),
          autoload: r.autoload ? 'on' : 'off',
        }));
      ctx.formatItems(items, ['option_name', 'option_value'], {
        all: ['option_id', 'option_name', 'option_value', 'autoload'],
        idField: 'option_id',
      });
    },
  },
];
