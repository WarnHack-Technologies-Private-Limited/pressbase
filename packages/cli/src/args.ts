import { parseArgs } from 'node:util';

/**
 * wp-cli's argument grammar: positional words, `--key=value` associative
 * arguments, `--flag` (true) and `--no-flag` (false). `--key value` is a flag
 * followed by a positional, as in wp-cli. Tokenising is node:util's
 * parseArgs (non-strict), so nothing here re-implements quoting or `--`.
 * See docs/adr/0014-pressbase-cli.md for why no third-party parser.
 */

export type AssocValue = string | boolean;
export type AssocArgs = Record<string, AssocValue>;

export interface ParsedArgv {
  positionals: string[];
  assoc: AssocArgs;
}

export function parseArgv(argv: string[]): ParsedArgv {
  const { tokens } = parseArgs({
    args: argv,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const positionals: string[] = [];
  const assoc: AssocArgs = {};
  for (const token of tokens ?? []) {
    if (token.kind === 'positional') positionals.push(token.value);
    else if (token.kind === 'option') {
      // -h is the one short option wp-cli users expect.
      const name = token.name === 'h' && token.rawName === '-h' ? 'help' : token.name;
      if (token.value !== undefined) assoc[name] = token.value;
      else if (name.startsWith('no-') && name.length > 3) assoc[name.slice(3)] = false;
      else assoc[name] = true;
    }
  }
  return { positionals, assoc };
}

/* --------------------------------------------------------------- synopsis */

/**
 * One part of a command's synopsis, in wp-cli's docblock syntax
 * (wp-cli/php/WP_CLI/SynopsisParser.php):
 * `<id>`, `[<id>...]`, `--title=<title>`, `[--status=<status>]`, `[--force]`,
 * `[--<field>=<value>]` (any other `--key=value`).
 */
export type SynopsisToken =
  | { type: 'positional'; name: string; optional: boolean; repeating: boolean }
  | { type: 'assoc'; name: string; value: string; optional: boolean; valueOptional: boolean }
  | { type: 'flag'; name: string; optional: true }
  | { type: 'generic'; optional: boolean };

export function parseSynopsis(synopsis: string): SynopsisToken[] {
  const out: SynopsisToken[] = [];
  for (const raw of synopsis.split(/\s+/).filter(Boolean)) {
    let token = raw;
    let optional = false;
    if (token.startsWith('[') && token.endsWith(']') && !/^\[--[^=[]+\[=/.test(token)) {
      optional = true;
      token = token.slice(1, -1);
    } else if (/^\[--[^=[]+\[=<[^>]+>\]\]$/.test(token)) {
      // [--name[=<value>]]
      const name = token.slice(3, token.indexOf('[', 1));
      const value = token.slice(token.indexOf('<') + 1, token.indexOf('>'));
      out.push({ type: 'assoc', name, value, optional: true, valueOptional: true });
      continue;
    }
    const repeating = token.endsWith('...');
    if (repeating) token = token.slice(0, -3);
    let match = /^<([^>]+)>$/.exec(token);
    if (match?.[1]) {
      out.push({ type: 'positional', name: match[1], optional, repeating });
      continue;
    }
    if (/^--<[^>]+>=<[^>]+>$/.test(token)) {
      out.push({ type: 'generic', optional });
      continue;
    }
    match = /^--([a-z0-9_-]+)=<([^>]+)>$/i.exec(token);
    if (match?.[1] && match[2]) {
      out.push({ type: 'assoc', name: match[1], value: match[2], optional, valueOptional: false });
      continue;
    }
    match = /^--([a-z0-9_-]+)$/i.exec(token);
    if (match?.[1]) {
      out.push({ type: 'flag', name: match[1], optional: true });
      continue;
    }
    throw new Error(`Unreadable synopsis part "${raw}" in "${synopsis}".`);
  }
  return out;
}
