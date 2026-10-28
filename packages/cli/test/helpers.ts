import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setup } from '@pressbase/core/src/test-utils';
import { afterEach } from 'vitest';
import { type MainOptions, main } from '../src/main';

/**
 * Runs `pressbase` in-process and captures what it prints. Tests either pass
 * a kernel booted on in-memory PGlite (fast; `site()`), or a temporary data
 * folder that the CLI configures and boots itself, as it does for real.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions extends Omit<MainOptions, 'stdout' | 'stderr' | 'stdin'> {
  /** Text on standard input. Without it stdin is an empty, non-terminal stream. */
  stdin?: string;
  /** Pretend standard output (and input) is a terminal. */
  tty?: boolean;
}

export async function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const input = options.stdin ?? '';
  const stdin = {
    isTTY: options.tty ?? false,
    async *[Symbol.asyncIterator]() {
      if (input) yield input;
    },
  };
  const code = await main(argv, {
    ...options,
    env: options.env ?? { PATH: process.env.PATH },
    stdin,
    stdout: { write: (t: string) => (stdout += t), isTTY: options.tty ?? false },
    stderr: { write: (t: string) => (stderr += t) },
  });
  return { code, stdout, stderr };
}

/** An installed site on in-memory PGlite, and `cli()` to run commands against it. */
export async function site(overrides: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup(overrides);
  await ctx.install();
  const cli = (argv: string[], options: RunOptions = {}) =>
    run(argv, { ...options, kernel: ctx.kernel, cwd: options.cwd ?? ctx.dataDir });
  /** Runs a command and expects it to succeed; returns standard output. */
  const ok = async (argv: string[], options: RunOptions = {}) => {
    const result = await cli(argv, options);
    if (result.code !== 0) {
      throw new Error(`pressbase ${argv.join(' ')} failed (${result.code}): ${result.stderr}`);
    }
    return result.stdout;
  };
  return { ...ctx, cli, ok };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export async function tempDir(prefix = 'pressbase-cli-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
