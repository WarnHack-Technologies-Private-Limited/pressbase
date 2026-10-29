// create-pressbase-plugin: writes a new plugin folder from ../template.
// Plain Node (no dependencies, no network): `npx create-pressbase-plugin my-plugin`.

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = path.join(here, '..', 'template');

/** The scaffolder's version; scaffolded plugins depend on the SDK of the same minor. */
export const VERSION = JSON.parse(
  await readFile(path.join(here, '..', 'package.json'), 'utf8'),
).version;

/**
 * plugin.json's default `requires`. Core still reports version 0.1.0 until the
 * next release bumps PRESSBASE_VERSION, so the floor is 0.1.0; raise it with
 * --requires once your plugin needs a newer API.
 */
export const DEFAULT_REQUIRES = '>=0.1.0 <1';

/** apps/core/src/plugins/manifest.ts: SLUG, RESERVED_NAMES and the 64-character limit. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RESERVED_NAMES = new Set([
  'wp',
  'pressbase',
  'oembed',
  'wp-site-health',
  'wp-abilities',
  'wp-block-editor',
]);

/**
 * Checks a plugin name against plugin.json's rules.
 * @param {string} name
 * @returns {string | null} an error message, or null when the name is valid
 */
export function validateName(name) {
  if (!name) return 'Give the plugin a name, like "reading-time".';
  if (name.length > 64) return 'Plugin names are at most 64 characters.';
  if (!SLUG.test(name)) {
    return `"${name}" isn't a valid plugin name: use lowercase letters, numbers and single dashes, like "reading-time".`;
  }
  if (RESERVED_NAMES.has(name)) return `"${name}" is reserved for Pressbase. Pick another name.`;
  return null;
}

/**
 * reading-time → Reading Time
 * @param {string} name
 */
export function titleFromName(name) {
  return name
    .split('-')
    .map((/** @type {string} */ word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * @typedef {object} ScaffoldOptions
 * @property {string} name the plugin's slug
 * @property {string} [title]
 * @property {string} [description]
 * @property {string} [author]
 * @property {boolean} [database] include the migration and database example (default true)
 * @property {string} [directory] where to write the plugin (default: ./<name>)
 * @property {string} [sdk] the plugin SDK's version range or spec (default ^VERSION)
 * @property {string} [requires] the Pressbase versions it supports (default DEFAULT_REQUIRES)
 */

/**
 * Writes the plugin. Refuses an existing, non-empty folder.
 * @param {ScaffoldOptions} options
 * @returns {Promise<{ directory: string, files: string[] }>}
 */
export async function scaffold(options) {
  const error = validateName(options.name);
  if (error) throw new Error(error);
  const name = options.name;
  const title = options.title?.trim() || titleFromName(name);
  const description = options.description?.trim() || `${title}: a Pressbase plugin.`;
  const database = options.database !== false;
  const directory = path.resolve(options.directory ?? name);

  const existing = await readdir(directory).catch(() => null);
  if (existing?.length) throw new Error(`${directory} already exists and isn't empty.`);
  if (!existing && (await stat(directory).catch(() => null))) {
    throw new Error(`${directory} already exists and isn't a folder.`);
  }

  const replacements = {
    __PLUGIN_SLUG__: name,
    __PLUGIN_TITLE__: title,
    __PLUGIN_DESCRIPTION__: description,
    __PLUGIN_PREFIX__: `${name.replace(/-/g, '_')}_`,
  };
  const fill = (/** @type {string} */ text) =>
    Object.entries(replacements).reduce((out, [key, value]) => out.replaceAll(key, value), text);

  const files = new Map();
  for (const file of await listTemplate(TEMPLATE_DIR)) {
    if (!database && file.startsWith('migrations/')) continue;
    let text = await readFile(path.join(TEMPLATE_DIR, file), 'utf8');
    text = database ? keepBlocks(text) : dropBlocks(text);
    // npm drops .gitignore from published packages, so the template ships it without the dot.
    files.set(file === 'gitignore' ? '.gitignore' : file, fill(text));
  }

  const manifest = {
    name,
    title,
    version: '0.1.0',
    description,
    ...(options.author ? { author: options.author } : {}),
    requires: options.requires ?? DEFAULT_REQUIRES,
    main: 'dist/index.js',
    permissions: database ? ['database'] : [],
    ...(database ? { migrations: 'migrations' } : {}),
  };
  files.set('plugin.json', `${JSON.stringify(manifest, null, 2)}\n`);

  const pkg = {
    name,
    version: '0.1.0',
    private: true,
    description,
    type: 'module',
    scripts: {
      build: 'node build.mjs',
      typecheck: 'tsc',
      pack: 'node build.mjs && node scripts/pack.mjs',
    },
    devDependencies: {
      '@pressbase/plugin-sdk': options.sdk ?? `^${VERSION}`,
      '@types/node': '^22.0.0',
      esbuild: '^0.25.0',
      typescript: '^5.9.0',
    },
  };
  files.set('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

  for (const [file, content] of files) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx' });
  }
  return { directory, files: [...files.keys()].sort() };
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listTemplate(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listTemplate(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

const START = /^\s*(?:\/\/|--) @database-start\s*$/;
const END = /^\s*(?:\/\/|--) @database-end\s*$/;

/**
 * Removes the marker lines, keeping what's between them.
 * @param {string} text
 */
function keepBlocks(text) {
  return text
    .split('\n')
    .filter((line) => !START.test(line) && !END.test(line))
    .join('\n');
}

/**
 * Removes the marked blocks, markers included.
 * @param {string} text
 */
function dropBlocks(text) {
  const out = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (START.test(line)) skipping = true;
    else if (END.test(line)) skipping = false;
    else if (!skipping) out.push(line);
  }
  return out.join('\n');
}

const HELP = `Usage: create-pressbase-plugin <name> [options]

Creates a Pressbase plugin in ./<name>: plugin.json, src/index.ts (typed with
@pressbase/plugin-sdk), an esbuild build, a migration and a pack script that
writes an installable .zip.

Options:
  --title <title>        Shown in the admin (default: from the name)
  --description <text>   One line about the plugin
  --author <name>        The author
  --dir <path>           Where to create it (default: ./<name>)
  --no-database          Leave out the migration and database example
  --requires <range>     Pressbase versions it supports (default: "${DEFAULT_REQUIRES}")
  --sdk <spec>           @pressbase/plugin-sdk version to depend on (default: ^${VERSION})
  -y, --yes              Don't ask questions; use the defaults
  -h, --help             Show this help
  -v, --version          Show the version

Names use lowercase letters, numbers and dashes (at most 64 characters).`;

/**
 * Parses the command line.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Partial<ScaffoldOptions> & { yes?: boolean, help?: boolean, version?: boolean }} */
  const options = {};
  const value = (/** @type {number} */ i, /** @type {string} */ flag) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg];
    const take = () => {
      if (inline !== undefined) return inline;
      const next = value(i, flag ?? arg);
      i++;
      return next;
    };
    switch (flag) {
      case '--title':
        options.title = take();
        break;
      case '--description':
        options.description = take();
        break;
      case '--author':
        options.author = take();
        break;
      case '--dir':
        options.directory = take();
        break;
      case '--sdk':
        options.sdk = take();
        break;
      case '--requires':
        options.requires = take();
        break;
      case '--database':
        options.database = true;
        break;
      case '--no-database':
        options.database = false;
        break;
      case '-y':
      case '--yes':
        options.yes = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}. See --help.`);
        if (options.name) throw new Error(`Give one name; got "${options.name}" and "${arg}".`);
        options.name = arg;
    }
  }
  return options;
}

/**
 * The command: flags, then questions for what's missing when run in a terminal.
 * @param {string[]} argv
 * @param {{ stdin?: NodeJS.ReadableStream & { isTTY?: boolean }, stdout?: NodeJS.WritableStream, cwd?: string }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io = {}) {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const print = (/** @type {string} */ text) => stdout.write(`${text}\n`);
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    print(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (options.help) {
    print(HELP);
    return 0;
  }
  if (options.version) {
    print(VERSION);
    return 0;
  }

  const interactive = !options.yes && Boolean(stdin.isTTY);
  if (interactive) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      while (!options.name || validateName(options.name)) {
        if (options.name) print(validateName(options.name) ?? '');
        options.name = (await rl.question('Plugin name (like reading-time): ')).trim();
      }
      options.title ??=
        (await rl.question(`Title (${titleFromName(options.name)}): `)).trim() || undefined;
      options.description ??= (await rl.question('Description: ')).trim() || undefined;
      if (options.database === undefined) {
        const answer = (await rl.question('Include a database table and migration? (Y/n) ')).trim();
        options.database = !/^n/i.test(answer);
      }
    } finally {
      rl.close();
    }
  }

  const error = validateName(options.name ?? '');
  if (error) {
    print(error);
    if (!options.name) print('Usage: create-pressbase-plugin <name> (see --help)');
    return 1;
  }
  try {
    const name = options.name ?? '';
    const directory = path.resolve(io.cwd ?? process.cwd(), options.directory ?? name);
    const result = await scaffold({ ...options, name, directory });
    const rel = path.relative(io.cwd ?? process.cwd(), result.directory) || '.';
    print(`Created ${options.name} in ${rel}.

Next:
  cd ${rel}
  npm install
  npm run pack      # builds dist/index.js and writes ${options.name}-0.1.0.zip

Then upload the .zip in Plugins → Upload plugin.`);
    return 0;
  } catch (failure) {
    print(failure instanceof Error ? failure.message : String(failure));
    return 1;
  }
}
