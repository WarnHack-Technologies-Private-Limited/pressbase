import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { currentUserCan } from '@pressbase/core/src/auth/meta-caps';
import type { CurrentUser } from '@pressbase/core/src/auth/users';
import type { Config } from '@pressbase/core/src/config';
import type { Kernel } from '@pressbase/core/src/kernel';
import type { AssocArgs } from './args';
import { FORMATS, type Format, formatItem, formatItems, type Row } from './format';

/** Stops a command: "Error: …" on standard error and a non-zero exit (WP_CLI::error()). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * What a command needs before it runs:
 * - `none`: nothing (help, `core version`);
 * - `config`: the resolved configuration, no database (`db check`, `db migrate`);
 * - `kernel`: a booted kernel, installed or not (`core install`);
 * - `installed`: a booted kernel on an installed site (everything else).
 */
export type Needs = 'none' | 'config' | 'kernel' | 'installed';

export interface CommandSpec {
  /** Words separated by spaces: `post list`, `user application-password create`. */
  name: string;
  /** One sentence, shown in lists. */
  shortdesc: string;
  /** wp-cli synopsis syntax (see args.ts), without the global flags. */
  synopsis?: string;
  /** Help text for each option or positional (`id`, `post_type`, `dry-run`). */
  options?: Record<string, string>;
  /** Allowed values per option. */
  choices?: Record<string, readonly string[]>;
  /** Values used when an option isn't given. */
  defaults?: Record<string, string>;
  longdesc?: string;
  /** [command line, what it does] */
  examples?: [string, string][];
  needs: Needs;
  /** The plugin that added it (plugin commands only). */
  plugin?: string;
  run(ctx: Context): unknown;
}

export interface Writer {
  write(text: string): unknown;
  isTTY?: boolean;
}

export interface Reader extends AsyncIterable<string | Uint8Array> {
  isTTY?: boolean;
}

export interface Io {
  stdout: Writer;
  stderr: Writer;
  stdin: Reader;
  /** Where relative paths in arguments are resolved. */
  cwd: string;
}

/** Global flags every command accepts (wp-cli's global parameters, plus Pressbase's). */
export const GLOBAL_FLAGS = [
  'format',
  'fields',
  'field',
  'user',
  'quiet',
  'yes',
  'help',
  'data-dir',
  'debug',
] as const;

/** What the runner sets up for a command; the Context is the command's view of it. */
export interface Session {
  io: Io;
  quiet: boolean;
  config?: Config;
  kernel?: Kernel;
  user: CurrentUser | null;
}

/**
 * The command's toolbox: its arguments, the kernel, the --user, output in
 * wp-cli's style (WP_CLI::log/success/warning/error, format_items) and
 * confirmations.
 */
export class Context {
  constructor(
    readonly spec: CommandSpec,
    readonly args: string[],
    readonly assoc: AssocArgs,
    private readonly session: Session,
  ) {}

  get io(): Io {
    return this.session.io;
  }

  get config(): Config {
    if (!this.session.config) throw new Error('The configuration is not loaded.');
    return this.session.config;
  }

  get kernel(): Kernel {
    if (!this.session.kernel) throw new Error('The kernel is not booted.');
    return this.session.kernel;
  }

  /** The --user this command runs as; null when none was given (no capability checks). */
  get user(): CurrentUser | null {
    return this.session.user;
  }

  /* --------------------------------------------------------- arguments */

  /** A string option, or undefined. `--key` without a value counts as missing. */
  string(name: string): string | undefined {
    const value = this.assoc[name];
    return typeof value === 'string' ? value : undefined;
  }

  flag(name: string): boolean {
    const value = this.assoc[name];
    return value === true || value === 'true' || value === '1';
  }

  has(name: string): boolean {
    return this.assoc[name] !== undefined;
  }

  /** A whole number option; an error names the option when it isn't one. */
  int(name: string): number | undefined {
    const value = this.string(name);
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n)) this.error(`--${name} must be a whole number, like --${name}=10.`);
    return n;
  }

  /** A comma-separated option as a list. */
  list(name: string): string[] | undefined {
    const value = this.string(name);
    return value === undefined
      ? undefined
      : value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
  }

  /** A comma-separated list of IDs. */
  ids(name: string): number[] | undefined {
    const list = this.list(name);
    if (!list) return undefined;
    return list.map((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) this.error(`--${name} takes IDs, like --${name}=1,2,3.`);
      return n;
    });
  }

  /** Positional IDs (`<id>...`), checked to be whole numbers. */
  positionalIds(): number[] {
    return this.args.map((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) this.error(`“${v}” isn’t an ID. IDs are whole numbers.`);
      return n;
    });
  }

  /** A path from an argument, resolved against the directory the command was run from. */
  resolvePath(file: string): string {
    return path.resolve(this.io.cwd, file);
  }

  /** The contents of a file, or of standard input for `-`. */
  async readInput(file: string): Promise<string> {
    if (file === '-') {
      let text = '';
      for await (const chunk of this.io.stdin) {
        text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      }
      return text;
    }
    try {
      return await readFile(this.resolvePath(file), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') this.error(`There’s no file at ${this.resolvePath(file)}.`);
      throw error;
    }
  }

  /* ------------------------------------------------------------ output */

  /** Data output: always printed, even with --quiet (WP_CLI::line()). */
  line(text: string): void {
    this.io.stdout.write(`${text}\n`);
  }

  /** WP_CLI::log(): informational, hidden by --quiet. */
  log(text: string): void {
    if (!this.session.quiet) this.io.stdout.write(`${text}\n`);
  }

  /** WP_CLI::success() */
  success(text: string): void {
    if (!this.session.quiet) this.io.stdout.write(`Success: ${text}\n`);
  }

  /** WP_CLI::warning(): on standard error, shown even with --quiet. */
  warning(text: string): void {
    this.io.stderr.write(`Warning: ${text}\n`);
  }

  /** WP_CLI::error(): stops the command. */
  error(text: string): never {
    throw new CliError(text);
  }

  /** The --format asked for, checked against what this command offers. */
  format(fallback: Format = 'table', allowed: readonly Format[] = FORMATS): Format {
    const value = this.string('format') ?? fallback;
    if (!(allowed as readonly string[]).includes(value)) {
      this.error(`The format “${value}” isn’t available here. Use ${listWords(allowed)}.`);
    }
    return value as Format;
  }

  #fields(defaults: string[], all: string[] | undefined): string[] {
    const fields = this.list('fields') ?? defaults;
    const known = all ?? defaults;
    for (const field of [...fields, ...(this.string('field') ? [this.string('field') as string] : [])]) {
      if (all && !known.includes(field)) {
        this.error(`There’s no field “${field}”. Available fields: ${known.join(', ')}.`);
      }
    }
    return fields;
  }

  /**
   * WP_CLI\Utils\format_items(): prints rows in the chosen --format,
   * limited to --fields (or the defaults), or one --field per line.
   * `all` lists every field a row has, for checking --fields.
   */
  formatItems(
    rows: Row[],
    defaults: string[],
    options: { all?: string[]; idField?: string; formats?: readonly Format[] } = {},
  ): void {
    const output = formatItems(rows, {
      format: this.format('table', options.formats),
      fields: this.#fields(defaults, options.all),
      field: this.string('field'),
      idField: options.idField,
      tty: Boolean(this.io.stdout.isTTY),
    });
    if (output !== '') this.line(output);
  }

  /** One object: a Field | Value table, or JSON/YAML, or one --field. */
  formatItem(row: Row, defaults: string[], options: { all?: string[] } = {}): void {
    const format = this.format('table', ['table', 'json', 'csv', 'yaml']);
    const output = formatItem(row, {
      format,
      fields: this.#fields(defaults, options.all),
      field: this.string('field'),
      tty: Boolean(this.io.stdout.isTTY),
    });
    this.line(output);
  }

  /**
   * WP_CLI::confirm(): asks before something destructive. --yes answers
   * for the user; without a terminal to ask, the command stops and says to
   * add --yes. Answering anything but "y" stops with exit code 0.
   */
  async confirm(question: string): Promise<void> {
    if (this.flag('yes')) return;
    if (!this.io.stdin.isTTY) {
      this.error(`${question} Add --yes to confirm when running without a terminal.`);
    }
    const rl = createInterface({
      input: this.io.stdin as unknown as NodeJS.ReadableStream,
      output: this.io.stdout as unknown as NodeJS.WritableStream,
    });
    try {
      const answer = await rl.question(`${question} [y/n] `);
      if (!/^y(es)?$/i.test(answer.trim())) throw new CliError('', 0);
    } finally {
      rl.close();
    }
  }

  /* ------------------------------------------------------- permissions */

  /**
   * current_user_can() for --user. Without --user the command line acts
   * with full trust, as wp-cli does, so every check passes.
   */
  async can(capability: string, objectId?: number): Promise<boolean> {
    if (!this.user) return true;
    return currentUserCan(this.kernel, this.user, capability, objectId);
  }

  /** Stops the command when --user lacks a capability. */
  async require(capability: string, objectId?: number, message?: string): Promise<void> {
    if (await this.can(capability, objectId)) return;
    this.error(
      message ??
        `${this.user?.login ?? 'This user'} isn’t allowed to do that (it needs the ${capability} capability).`,
    );
  }
}

export function listWords(values: readonly string[]): string {
  if (values.length < 2) return values.join('');
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}
