import { startRevalidationNotifier } from '@pressbase/core/src/cache/notifier';
import type { Kernel } from '@pressbase/core/src/kernel';
import type { PluginCliIo } from '@pressbase/core/src/plugins/cli';
import { type AssocArgs, parseArgv, parseSynopsis } from './args';
import { bootKernel, requireInstalled, resolveConfig, resolveUser } from './bootstrap';
import {
  CliError,
  type CommandSpec,
  Context,
  GLOBAL_FLAGS,
  type Io,
  type Reader,
  type Session,
  type Writer,
} from './command';
import { COMMANDS, GROUPS } from './commands';
import { commandHelp, groupHelp, topHelp } from './help';

export interface MainOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: Writer;
  stderr?: Writer;
  stdin?: Reader;
  cwd?: string;
  /**
   * A kernel that is already booted (tests). It is used as it is and not
   * shut down; configuration and the database lock are left to its owner.
   */
  kernel?: Kernel;
}

/** Longest command name that the words start with. */
function match<T extends { name: string }>(words: string[], specs: T[]): T | undefined {
  for (let n = Math.min(words.length, 4); n > 0; n--) {
    const name = words.slice(0, n).join(' ');
    const spec = specs.find((s) => s.name === name);
    if (spec) return spec;
  }
  return undefined;
}

/** Checks the arguments against the command's synopsis and fills in defaults. */
function validate(spec: CommandSpec, args: string[], assoc: AssocArgs): void {
  let tokens: ReturnType<typeof parseSynopsis>;
  try {
    tokens = parseSynopsis(spec.synopsis ?? '');
  } catch {
    if (spec.plugin) return; // A plugin's free-form synopsis: its handler checks.
    throw new Error(`The synopsis of "${spec.name}" can’t be read.`);
  }
  const usage = `Usage: pressbase ${spec.name}${spec.synopsis ? ` ${spec.synopsis}` : ''}`;
  const positionals = tokens.filter((t) => t.type === 'positional');
  const required = positionals.filter((t) => !t.optional);
  if (args.length < required.length) {
    const missing = required[args.length];
    throw new CliError(`Give <${missing?.name}>. ${usage}`);
  }
  if (!positionals.some((t) => t.repeating) && args.length > positionals.length) {
    throw new CliError(
      `Too many arguments: “${args.slice(positionals.length).join(' ')}”. ${usage}`,
    );
  }
  const generic = tokens.some((t) => t.type === 'generic');
  const named = new Map(
    tokens.flatMap((t) => (t.type === 'assoc' || t.type === 'flag' ? [[t.name, t]] : [])),
  );
  for (const [key, value] of Object.entries(assoc)) {
    if ((GLOBAL_FLAGS as readonly string[]).includes(key)) continue;
    const token = named.get(key);
    if (!token) {
      if (generic) continue;
      throw new CliError(
        `--${key} isn’t an option of “pressbase ${spec.name}”. See “pressbase help ${spec.name}”.`,
      );
    }
    if (token.type === 'assoc' && !token.valueOptional && typeof value !== 'string') {
      throw new CliError(`--${key} needs a value: --${key}=<${token.value}>.`);
    }
    const choices = spec.choices?.[key];
    if (choices && typeof value === 'string' && !choices.includes(value)) {
      throw new CliError(`--${key} can be ${choices.join(', ')}; “${value}” isn’t one of them.`);
    }
  }
  for (const [key, value] of Object.entries(spec.defaults ?? {})) {
    if (assoc[key] === undefined) assoc[key] = value;
  }
  for (const token of tokens) {
    if (token.type === 'assoc' && !token.optional && assoc[token.name] === undefined) {
      throw new CliError(`Give --${token.name}=<${token.value}>. ${usage}`);
    }
  }
}

/** A plugin's command as a CommandSpec, with WP_CLI's helpers as its io. */
function pluginSpec(kernel: Kernel, name: string): CommandSpec | undefined {
  const words = name.split(' ');
  const command = match(words, kernel.cli.all());
  if (!command) return undefined;
  return {
    name: command.name,
    shortdesc: command.shortdesc ?? '',
    synopsis: command.synopsis,
    longdesc: command.longdesc,
    needs: 'installed',
    plugin: command.plugin,
    run: async (ctx) => {
      const assoc = Object.fromEntries(
        Object.entries(ctx.assoc).filter(
          ([k]) => !['user', 'quiet', 'yes', 'help', 'data-dir', 'debug'].includes(k),
        ),
      );
      const io: PluginCliIo = {
        log: (m) => ctx.log(m),
        success: (m) => ctx.success(m),
        warning: (m) => ctx.warning(m),
        error: (m) => ctx.error(m),
        formatItems: (items, fields) => ctx.formatItems(items, fields),
        confirm: (q) => ctx.confirm(q),
        user: ctx.user,
      };
      await command.handler(ctx.args, assoc, io);
    },
  };
}

function pluginSpecs(kernel: Kernel): CommandSpec[] {
  return kernel.cli
    .all()
    .map((c) => pluginSpec(kernel, c.name))
    .filter((s): s is CommandSpec => Boolean(s));
}

/**
 * Runs one `pressbase` command line and returns its exit code: 0 on
 * success, 1 on an error. Never throws.
 */
export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const io: Io = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    stdin: options.stdin ?? (process.stdin as unknown as Reader),
    cwd: options.cwd ?? env.INIT_CWD ?? process.cwd(),
  };
  const { positionals, assoc } = parseArgv(argv);
  const session: Session = {
    io,
    quiet: assoc.quiet === true,
    kernel: options.kernel,
    config: options.kernel?.config,
    user: null,
    purgeWarnings: [],
  };
  const ownsKernel = !options.kernel;
  const print = (text: string) => io.stdout.write(text.endsWith('\n') ? text : `${text}\n`);

  const loadConfig = async () => {
    session.config ??= await resolveConfig(env, {
      dataDir: typeof assoc['data-dir'] === 'string' ? assoc['data-dir'] : undefined,
      cwd: io.cwd,
    });
    return session.config;
  };
  let notifying = false;
  const boot = async () => {
    session.kernel ??= await bootKernel(await loadConfig());
    const revalidate = session.kernel.config.revalidate;
    // Changes made here purge the public site's page cache, as the server's do.
    if (revalidate && !notifying) {
      notifying = true;
      session.stopNotifier = startRevalidationNotifier(session.kernel, {
        ...revalidate,
        log: (message) => {
          const text = message.replace(/^\[cache\] /, '');
          session.purgeWarnings.push(text);
          io.stderr.write(`Warning: ${text}\n`);
        },
      });
    }
    return session.kernel;
  };

  try {
    const words = positionals[0] === 'help' ? positionals.slice(1) : positionals;
    const wantsHelp = positionals[0] === 'help' || assoc.help === true;

    let spec = match(words, COMMANDS);
    const group = words.join(' ');
    const inGroup = COMMANDS.filter((c) => c.name.startsWith(`${group} `));

    if (!words.length) {
      // `pressbase` or `pressbase help`: list commands, with plugins' when a site loads.
      let plugins: CommandSpec[] = [];
      let note: string | undefined;
      try {
        const config = await loadConfig();
        if (config.databaseUrl) {
          const kernel = await boot();
          if (kernel.state === 'ready') plugins = pluginSpecs(kernel);
        }
      } catch (error) {
        note = `Plugin commands aren’t listed: ${(error as Error).message}`;
      }
      print(topHelp(GROUPS, plugins, note));
      return 0;
    }

    if (!spec && inGroup.length) {
      print(groupHelp(group, GROUPS.find(([g]) => g === group)?.[1], inGroup));
      return 0;
    }

    if (!spec) {
      const top = words[0] as string;
      if (COMMANDS.some((c) => c.name.split(' ')[0] === top)) {
        throw new CliError(
          `“pressbase ${top}” has no command “${words.slice(1).join(' ')}”. See “pressbase help ${top}”.`,
        );
      }
      // Not one of ours: a plugin's command, found once the site is loaded.
      const kernel = await boot();
      if (kernel.state === 'ready') spec = pluginSpec(kernel, words.join(' '));
      if (!spec) {
        throw new CliError(`“${top}” isn’t a pressbase command. See “pressbase help” for the list.`);
      }
    }

    if (wantsHelp) {
      print(commandHelp(spec));
      return 0;
    }

    const args = words.slice(spec.name.split(' ').length);
    validate(spec, args, assoc);

    if (spec.needs === 'config') await loadConfig();
    if (spec.needs === 'kernel' || spec.needs === 'installed') {
      const kernel = await boot();
      if (spec.needs === 'installed') requireInstalled(kernel);
      if (typeof assoc.user === 'string') session.user = await resolveUser(kernel, assoc.user);
      else if (assoc.user !== undefined) throw new CliError('--user needs a value: --user=<login>.');
    }

    await spec.run(new Context(spec, args, assoc, session));
    if (session.serverMayBeStale) {
      io.stderr.write(
        'Warning: A Pressbase server running on this database keeps settings, plugins and the theme in memory. Restart it to pick up this change.\n',
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      if (error.message) io.stderr.write(`Error: ${error.message}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`Error: Something went wrong: ${message}\n`);
    if (assoc.debug === true && error instanceof Error && error.stack) {
      io.stderr.write(`${error.stack}\n`);
    } else {
      io.stderr.write('Run the command again with --debug to see the details.\n');
    }
    return 1;
  } finally {
    await session.stopNotifier?.().catch(() => {});
    if (ownsKernel) await session.kernel?.shutdown().catch(() => {});
  }
}
