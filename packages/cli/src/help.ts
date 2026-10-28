import { parseSynopsis } from './args';
import type { CommandSpec } from './command';

/** Help in wp-cli's layout (NAME, DESCRIPTION, SYNOPSIS, OPTIONS, EXAMPLES). */

const GLOBALS: [string, string][] = [
  ['--format=<format>', 'table, json, csv, yaml, ids or count, where a command prints data.'],
  ['--fields=<fields>', 'Only these fields, comma-separated.'],
  ['--field=<field>', 'Only this field’s value.'],
  ['--user=<id|login|email>', 'Run as this user, so their capabilities apply.'],
  ['--yes', 'Answer yes to confirmations (needed without a terminal).'],
  ['--quiet', 'Hide informational messages and successes.'],
  ['--data-dir=<path>', 'The site’s data folder (default: PRESSBASE_DATA_DIR, as the server).'],
  ['--debug', 'Show the full error when something fails.'],
  ['--help', 'Show help for a command.'],
];

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

function columns(rows: [string, string][], gap = 4): string {
  const width = Math.max(...rows.map(([a]) => a.length));
  return rows.map(([a, b]) => `${a}${' '.repeat(width - a.length + gap)}${b}`).join('\n');
}

export function commandHelp(spec: CommandSpec): string {
  const out: string[] = [];
  out.push('NAME', '', `  pressbase ${spec.name}`, '');
  out.push('DESCRIPTION', '', `  ${spec.shortdesc}`, '');
  out.push('SYNOPSIS', '', `  pressbase ${spec.name}${spec.synopsis ? ` ${spec.synopsis}` : ''}`, '');
  if (spec.longdesc) out.push(indent(spec.longdesc.trim(), 2), '');

  let tokens: ReturnType<typeof parseSynopsis> = [];
  try {
    tokens = spec.synopsis ? parseSynopsis(spec.synopsis) : [];
  } catch {
    tokens = [];
  }
  if (tokens.length) {
    out.push('OPTIONS', '');
    for (const token of tokens) {
      let label: string;
      let key: string;
      if (token.type === 'positional') {
        key = token.name;
        label = `<${token.name}>${token.repeating ? '...' : ''}`;
      } else if (token.type === 'assoc') {
        key = token.name;
        label = token.valueOptional
          ? `--${token.name}[=<${token.value}>]`
          : `--${token.name}=<${token.value}>`;
      } else if (token.type === 'flag') {
        key = token.name;
        label = `--${token.name}`;
      } else {
        key = '<field>';
        label = '--<field>=<value>';
      }
      out.push(`  ${token.optional ? `[${label}]` : label}`);
      const description = spec.options?.[key];
      if (description) out.push(indent(description, 4));
      const choices = spec.choices?.[key];
      const fallback = spec.defaults?.[key];
      if (choices || fallback !== undefined) {
        out.push('    ---');
        if (fallback !== undefined) out.push(`    default: ${fallback}`);
        if (choices) out.push('    options:', ...choices.map((c) => `      - ${c}`));
        out.push('    ---');
      }
      out.push('');
    }
  }
  if (spec.examples?.length) {
    out.push('EXAMPLES', '');
    for (const [command, what] of spec.examples) {
      out.push(`    # ${what}`, `    $ ${command}`, '');
    }
  }
  out.push('GLOBAL PARAMETERS', '', indent(columns(GLOBALS), 2), '');
  return out.join('\n');
}

export function groupHelp(
  group: string,
  description: string | undefined,
  commands: CommandSpec[],
): string {
  const depth = group.split(' ').length;
  const rows: [string, string][] = commands.map((c) => [
    c.name.split(' ').slice(depth).join(' '),
    c.shortdesc,
  ]);
  return [
    'NAME',
    '',
    `  pressbase ${group}`,
    '',
    ...(description ? ['DESCRIPTION', '', `  ${description}`, ''] : []),
    'SYNOPSIS',
    '',
    `  pressbase ${group} <command>`,
    '',
    'SUBCOMMANDS',
    '',
    indent(columns(rows), 2),
    '',
  ].join('\n');
}

export function topHelp(
  groups: [string, string][],
  pluginCommands: CommandSpec[],
  note?: string,
): string {
  const out = [
    'NAME',
    '',
    '  pressbase',
    '',
    'DESCRIPTION',
    '',
    '  Manage a Pressbase site from the command line.',
    '',
    'SYNOPSIS',
    '',
    '  pressbase <command>',
    '',
    'SUBCOMMANDS',
    '',
    indent(columns(groups), 2),
    '',
  ];
  if (pluginCommands.length) {
    out.push(
      'PLUGIN COMMANDS',
      '',
      indent(
        columns(pluginCommands.map((c) => [c.name, `${c.shortdesc} (${c.plugin})`.trim()])),
        2,
      ),
      '',
    );
  }
  if (note) out.push(`  ${note}`, '');
  out.push('GLOBAL PARAMETERS', '', indent(columns(GLOBALS), 2), '');
  out.push('  See “pressbase help <command>” for a command’s options and examples.', '');
  return out.join('\n');
}
