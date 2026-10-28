import type { Ability } from '@pressbase/core/src/abilities/registry';
import { AbilityError } from '@pressbase/core/src/abilities/registry';
import { AiError } from '@pressbase/core/src/ai/types';
import type { CommandSpec, Context } from '../command';
import { yaml } from '../format';

/**
 * `pressbase ability` and `pressbase ai`: the Abilities API and the AI client
 * from the terminal (v0.7, docs/architecture/ai.md).
 *
 * `ability run` goes through Ability.execute(): the input is validated against
 * the ability's schema and its permission callback runs for --user. Without
 * --user the command line acts with full trust, as wp-cli does.
 */

const FIELDS = ['name', 'label', 'category', 'description'];
const ALL_FIELDS = [...FIELDS, 'readonly', 'destructive', 'idempotent', 'show_in_rest', 'plugin'];

function row(ability: Ability) {
  const { annotations } = ability.meta;
  return {
    name: ability.name,
    label: ability.label,
    category: ability.category,
    description: ability.description,
    readonly: annotations.readonly ?? '',
    destructive: annotations.destructive ?? '',
    idempotent: annotations.idempotent ?? '',
    show_in_rest: ability.meta.showInRest,
    plugin: ability.plugin ?? '',
  };
}

function find(ctx: Context, name: string): Ability {
  const ability = ctx.kernel.abilities.get(name);
  if (!ability) ctx.error(`There’s no ability “${name}”. See “pressbase ability list”.`);
  return ability;
}

function print(ctx: Context, value: unknown): void {
  const format = ctx.string('format') ?? 'json';
  if (format === 'yaml') ctx.line(yaml(value));
  else if (format === 'plaintext' && typeof value === 'string') ctx.line(value);
  else ctx.line(JSON.stringify(value ?? null, null, 2));
}

export const abilityCommands: CommandSpec[] = [
  {
    name: 'ability list',
    shortdesc: 'Lists registered abilities.',
    synopsis:
      '[--category=<category>] [--namespace=<namespace>] [--fields=<fields>] [--field=<field>] [--format=<format>]',
    options: {
      category: 'Only abilities in this category.',
      namespace: 'Only abilities whose name starts with this namespace, e.g. core.',
    },
    examples: [['pressbase ability list --category=site', 'Abilities about the site']],
    needs: 'installed',
    async run(ctx) {
      const abilities = ctx.kernel.abilities.all({
        category: ctx.string('category'),
        namespace: ctx.string('namespace'),
      });
      ctx.formatItems(abilities.map(row), FIELDS, { all: ALL_FIELDS, idField: 'name' });
    },
  },
  {
    name: 'ability get',
    shortdesc: 'Shows an ability, with its input and output schemas.',
    synopsis: '<name> [--fields=<fields>] [--field=<field>] [--format=<format>]',
    options: { name: 'The ability’s name, e.g. core/get-site-info.' },
    examples: [['pressbase ability get core/get-site-info --format=json', 'Show an ability']],
    needs: 'installed',
    async run(ctx) {
      const ability = find(ctx, ctx.args[0] ?? '');
      ctx.formatItem(
        {
          ...row(ability),
          input_schema: JSON.stringify(ability.inputSchema),
          output_schema: JSON.stringify(ability.outputSchema),
        },
        [...FIELDS, 'input_schema', 'output_schema'],
        { all: [...ALL_FIELDS, 'input_schema', 'output_schema'] },
      );
    },
  },
  {
    name: 'ability run',
    shortdesc: 'Runs an ability and prints its result.',
    synopsis: '<name> [--input=<json>] [--format=<format>]',
    options: {
      name: 'The ability’s name.',
      input:
        'The input as JSON, e.g. --input=\'{"fields":["name"]}\'. Use - to read it from standard input.',
      format: 'How to show the result.',
    },
    choices: { format: ['json', 'yaml', 'plaintext'] },
    defaults: { format: 'json' },
    examples: [
      [
        `pressbase ability run core/get-site-info --input='{"fields":["name","url"]}'`,
        'The site’s name and address',
      ],
      ['pressbase ability run core/get-site-info --user=editor', 'Run it as a user'],
    ],
    needs: 'installed',
    async run(ctx) {
      const ability = find(ctx, ctx.args[0] ?? '');
      const raw = ctx.string('input');
      let input: unknown = null;
      if (raw !== undefined) {
        const text = raw === '-' ? await ctx.readInput('-') : raw;
        try {
          input = JSON.parse(text);
        } catch {
          ctx.error('--input must be JSON, like --input=\'{"fields":["name"]}\'.');
        }
      }
      const context = ctx.kernel.abilities.context(ctx.user, 'cli', { trusted: true });
      try {
        print(ctx, await ability.execute(input, context));
      } catch (error) {
        if (error instanceof AbilityError) ctx.error(`${error.message} (${error.code})`);
        throw error;
      }
    },
  },
  {
    name: 'ability category list',
    shortdesc: 'Lists ability categories.',
    synopsis: '[--fields=<fields>] [--field=<field>] [--format=<format>]',
    needs: 'installed',
    async run(ctx) {
      ctx.formatItems(
        ctx.kernel.abilities.categories().map((c) => ({
          slug: c.slug,
          label: c.label,
          description: c.description,
          plugin: c.plugin ?? '',
        })),
        ['slug', 'label', 'description'],
        { all: ['slug', 'label', 'description', 'plugin'], idField: 'slug' },
      );
    },
  },
  {
    name: 'ai test',
    shortdesc: 'Sends a tiny prompt to the AI provider set in Settings → AI.',
    longdesc:
      'Checks that AI is turned on and that the provider accepts the key. The request counts against the daily limit and is logged without its content.',
    needs: 'installed',
    async run(ctx) {
      await ctx.require('manage_options');
      try {
        const { provider, model } = await ctx.kernel.ai.testConnection(ctx.user);
        ctx.success(`${provider} answered with ${model}.`);
      } catch (error) {
        if (error instanceof AiError) ctx.error(`${error.message} (${error.code})`);
        throw error;
      }
    },
  },
];
