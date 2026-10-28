import type { CurrentUser } from '../auth/users';

/**
 * Commands plugins add to the `pressbase` CLI — WP_CLI::add_command()
 * (wp-cli/php/class-wp-cli.php). A plugin registers them in `register(api)`
 * with `api.cli.addCommand()`; they live in `kernel.cli` while the plugin is
 * loaded and go away when it is deactivated, like its hooks. The CLI
 * (packages/cli) boots the kernel, so active plugins' commands are there.
 *
 *   api.cli.addCommand('daily-tips rotate', async (args, assoc, io) => {
 *     io.success(`Rotated ${await rotate(assoc.count ?? 1)} tips.`);
 *   }, { shortdesc: 'Picks new tips.', synopsis: '[--count=<number>]' });
 */

/** wp-cli's `$assoc_args`: `--key=value` is a string, `--flag` is true, `--no-flag` false. */
export type PluginCliAssocArgs = Record<string, string | boolean>;

/** What a command handler gets to talk to the terminal: WP_CLI's static helpers. */
export interface PluginCliIo {
  /** WP_CLI::log(): a line on standard output (hidden by --quiet). */
  log(message: string): void;
  /** WP_CLI::success(): "Success: …". */
  success(message: string): void;
  /** WP_CLI::warning(): "Warning: …" on standard error. */
  warning(message: string): void;
  /** WP_CLI::error(): prints "Error: …" and stops the command with exit code 1. */
  error(message: string): never;
  /**
   * WP_CLI\Utils\format_items(): prints rows in the --format the user asked
   * for (table, json, csv, yaml, ids, count), limited to --fields if given.
   */
  formatItems(items: Record<string, unknown>[], fields: string[]): void;
  /** WP_CLI::confirm(): asks before going on, unless --yes. Stops the command on "no". */
  confirm(question: string): Promise<void>;
  /** The --user the command runs as, or null (the command line acts as no user). */
  readonly user: CurrentUser | null;
}

export type PluginCliHandler = (
  args: string[],
  assocArgs: PluginCliAssocArgs,
  io: PluginCliIo,
) => unknown;

/** WP_CLI::add_command()'s `$args`. */
export interface PluginCliCommandArgs {
  /** One line, shown in `pressbase help`. */
  shortdesc?: string;
  /** wp-cli's synopsis string: `<file> [--count=<number>] [--dry-run]`. Shown in --help. */
  synopsis?: string;
  /** Shown in --help after the synopsis. */
  longdesc?: string;
}

export interface CliCommand extends PluginCliCommandArgs {
  /** Words separated by spaces: `daily-tips rotate`. */
  name: string;
  handler: PluginCliHandler;
  /** The plugin that added it. */
  plugin: string;
}

/** Top-level command names Pressbase's CLI uses (or reserves), which plugins can't take. */
export const CORE_CLI_COMMANDS = new Set([
  'cache',
  'cli',
  'comment',
  'core',
  'cron',
  'db',
  'eval',
  'export',
  'help',
  'import',
  'media',
  'option',
  'plugin',
  'post',
  'rewrite',
  'search-replace',
  'term',
  'theme',
  'user',
]);

const NAME = /^[a-z0-9][a-z0-9-]*(?: [a-z0-9][a-z0-9-]*)*$/;

/** The registry behind `kernel.cli`. */
export class CliCommands {
  #commands = new Map<string, CliCommand>();

  /**
   * Adds a plugin's command. Its first word must be the plugin's slug.
   * Returns a function that removes it.
   */
  add(command: CliCommand): () => void {
    const { name, plugin } = command;
    if (!NAME.test(name)) {
      throw new Error(
        `Command names are lowercase words separated by single spaces, like "${plugin} sync": "${name}".`,
      );
    }
    const [first] = name.split(' ');
    if (first !== plugin) {
      throw new Error(`A plugin’s commands start with its name: "${plugin} …", not "${name}".`);
    }
    if (CORE_CLI_COMMANDS.has(first)) {
      throw new Error(`"${first}" is one of Pressbase’s own commands.`);
    }
    if (typeof command.handler !== 'function') {
      throw new Error(`The command "${name}" has no handler.`);
    }
    if (this.#commands.has(name)) throw new Error(`The command "${name}" already exists.`);
    this.#commands.set(name, command);
    return () => {
      if (this.#commands.get(name) === command) this.#commands.delete(name);
    };
  }

  get(name: string): CliCommand | undefined {
    return this.#commands.get(name);
  }

  all(): CliCommand[] {
    return [...this.#commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
