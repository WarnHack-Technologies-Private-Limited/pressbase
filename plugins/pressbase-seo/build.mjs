// Builds Pressbase SEO: the server module (src/index.ts → dist/index.js) and
// the admin's browser modules (src/admin/*.tsx → dist/admin/*.js), which use
// the admin's own React through window.pressbase instead of bundling one.
//
//   node build.mjs           build once
//   node build.mjs --watch   rebuild on change (pnpm dev)
//   node build.mjs --pot     also write languages/pressbase-seo.pot
//
// esbuild only strips types: `pnpm typecheck` checks them.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/** react, react-dom and react/jsx-runtime resolve to the admin's copies on window.pressbase. */
const hostReact = {
  name: 'host-react',
  setup(b) {
    const shims = {
      react: 'module.exports = window.pressbase.React;',
      'react-dom': 'module.exports = window.pressbase.ReactDOM;',
      'react/jsx-runtime': 'module.exports = window.pressbase.jsxRuntime;',
    };
    b.onResolve({ filter: /^react(-dom)?(\/jsx-runtime)?$/ }, (args) => ({
      path: args.path,
      namespace: 'host-react',
    }));
    b.onLoad({ filter: /.*/, namespace: 'host-react' }, (args) => ({
      contents: shims[args.path],
      loader: 'js',
    }));
  },
};

const server = {
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(root, 'dist/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'bundle',
  sourcemap: true,
  logLevel: 'warning',
};

const admin = {
  entryPoints: ['index', 'settings', 'tools'].map((name) => ({
    in: path.join(root, `src/admin/${name}.tsx`),
    out: name,
  })),
  outdir: path.join(root, 'dist/admin'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  plugins: [hostReact],
  sourcemap: true,
  logLevel: 'warning',
};

async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Translatable strings: every __('…') / _x('…', '…') call with a literal.
 * The admin's are written to dist/admin-strings.json, which the server
 * translates through api.i18n for the browser (src/i18n.ts).
 */
async function extract() {
  const call = /\b(__|_x)\(\s*'((?:[^'\\]|\\.)*)'(?:\s*,\s*'((?:[^'\\]|\\.)*)')?/g;
  const strings = new Map();
  const adminStrings = new Set();
  for (const file of await files(path.join(root, 'src'))) {
    const text = await readFile(file, 'utf8');
    const rel = path.relative(root, file);
    const browser =
      rel.startsWith(`src${path.sep}admin`) ||
      rel.includes(`${path.sep}analysis${path.sep}`) ||
      rel.endsWith('vars.ts') ||
      rel.endsWith('shared.ts');
    for (const m of text.matchAll(call)) {
      const msgid = m[2].replace(/\\'/g, "'");
      const ctx = m[1] === '_x' ? (m[3] ?? '').replace(/\\'/g, "'") : '';
      const key = `${ctx}\u0004${msgid}`;
      const line = text.slice(0, m.index).split('\n').length;
      const refs = strings.get(key)?.refs ?? [];
      refs.push(`${rel.split(path.sep).join('/')}:${line}`);
      strings.set(key, { msgid, ctx, refs });
      if (browser && !ctx) adminStrings.add(msgid);
    }
  }
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(
    path.join(root, 'dist/admin-strings.json'),
    `${JSON.stringify([...adminStrings].sort())}\n`,
  );
  return strings;
}

async function writePot(strings) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  let pot = `# Translation template for Pressbase SEO.\n# This file is distributed under the GPL-2.0-or-later license.\nmsgid ""\nmsgstr ""\n"Project-Id-Version: Pressbase SEO\\n"\n"MIME-Version: 1.0\\n"\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Content-Transfer-Encoding: 8bit\\n"\n"X-Domain: pressbase-seo\\n"\n`;
  for (const { msgid, ctx, refs } of [...strings.values()].sort((a, b) =>
    a.msgid.localeCompare(b.msgid),
  )) {
    pot += `\n#: ${refs.join(' ')}\n`;
    if (ctx) pot += `msgctxt "${esc(ctx)}"\n`;
    pot += `msgid "${esc(msgid)}"\nmsgstr ""\n`;
  }
  await mkdir(path.join(root, 'languages'), { recursive: true });
  await writeFile(path.join(root, 'languages/pressbase-seo.pot'), pot);
}

const strings = await extract();
if (process.argv.includes('--pot')) await writePot(strings);

if (watch) {
  const contexts = await Promise.all([context(server), context(admin)]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[pressbase-seo] watching src/ for changes');
} else {
  await Promise.all([build(server), build(admin)]);
}
