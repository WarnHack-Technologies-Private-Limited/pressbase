import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeManifestErrors,
  MANIFEST_FILE,
  type PluginManifest,
  parseManifest,
  SLUG,
} from './manifest';

/**
 * Finding plugins: get_plugins() (wordpress/wp-admin/includes/plugin.php).
 *
 * A plugin is a folder holding a `plugin.json`. Pressbase looks in
 * `<dataDir>/plugins` (uploads land there) and in the repository's bundled
 * `plugins/` folder (examples that ship with Pressbase). A plugin in the data
 * directory wins over a bundled one of the same name. The folder name must be
 * the manifest's `name`.
 */

export const BUNDLED_PLUGINS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../plugins',
);

export type PluginSource = 'site' | 'bundled';

export interface InstalledPlugin {
  slug: string;
  /** Absolute, real path of the plugin folder. */
  dir: string;
  manifest: PluginManifest;
  source: PluginSource;
}

/** A folder that looks like a plugin but can't be loaded. Listed so the admin can explain why. */
export interface InvalidPlugin {
  slug: string;
  dir: string;
  source: PluginSource;
  error: string;
}

export interface DiscoveredPlugins {
  plugins: InstalledPlugin[];
  invalid: InvalidPlugin[];
}

export interface PluginDirectories {
  site: string;
  /** null leaves bundled plugins out (tests do this). */
  bundled: string | null;
}

export function sitePluginsDir(dataDir: string): string {
  return path.join(dataDir, 'plugins');
}

async function readFolder(
  root: string,
  slug: string,
  source: PluginSource,
): Promise<InstalledPlugin | InvalidPlugin | null> {
  const dir = path.join(root, slug);
  let text: string;
  try {
    text = await readFile(path.join(dir, MANIFEST_FILE), 'utf8');
  } catch {
    return null; // Not a plugin: no manifest.
  }
  const real = await realpath(dir);
  if (!SLUG.test(slug)) {
    return {
      slug,
      dir: real,
      source,
      error: 'Plugin folder names use lowercase letters, numbers and dashes.',
    };
  }
  const parsed = parseManifest(text);
  if (!parsed.ok) {
    return { slug, dir: real, source, error: describeManifestErrors(parsed.errors) };
  }
  if (parsed.manifest.name !== slug) {
    return {
      slug,
      dir: real,
      source,
      error: `The folder is "${slug}" but plugin.json names "${parsed.manifest.name}". They must match.`,
    };
  }
  return { slug, dir: real, manifest: parsed.manifest, source };
}

async function scan(root: string, source: PluginSource) {
  let names: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    // Real folders only: a symlinked plugin folder could point anywhere.
    names = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
  const found = await Promise.all(names.map((name) => readFolder(root, name, source)));
  return found.filter((p): p is InstalledPlugin | InvalidPlugin => p !== null);
}

/** get_plugins(): every plugin folder, sorted by title (or slug when invalid). */
export async function discoverPlugins(dirs: PluginDirectories): Promise<DiscoveredPlugins> {
  const site = await scan(dirs.site, 'site');
  const bundled = dirs.bundled ? await scan(dirs.bundled, 'bundled') : [];
  const bySlug = new Map<string, InstalledPlugin | InvalidPlugin>();
  for (const plugin of [...bundled, ...site]) bySlug.set(plugin.slug, plugin);
  const plugins: InstalledPlugin[] = [];
  const invalid: InvalidPlugin[] = [];
  for (const plugin of bySlug.values()) {
    if ('manifest' in plugin) plugins.push(plugin);
    else invalid.push(plugin);
  }
  plugins.sort((a, b) => a.manifest.title.localeCompare(b.manifest.title));
  invalid.sort((a, b) => a.slug.localeCompare(b.slug));
  return { plugins, invalid };
}

/**
 * The plugin's entry module, resolved and checked: it must exist and, after
 * following links, still be inside the plugin folder.
 */
export async function resolveMain(plugin: InstalledPlugin): Promise<string> {
  const file = path.resolve(plugin.dir, plugin.manifest.main);
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    throw new Error(`The plugin’s main file, ${plugin.manifest.main}, is missing.`);
  }
  if (!real.startsWith(plugin.dir + path.sep)) {
    throw new Error(`The plugin’s main file, ${plugin.manifest.main}, is outside its folder.`);
  }
  if (!(await stat(real)).isFile()) {
    throw new Error(`The plugin’s main file, ${plugin.manifest.main}, is not a file.`);
  }
  return real;
}

/** The plugin's migration files, sorted so 0002 runs after 0001 and 0010 after 0009. */
export async function listMigrations(plugin: InstalledPlugin): Promise<string[]> {
  if (!plugin.manifest.migrations) return [];
  const dir = path.resolve(plugin.dir, plugin.manifest.migrations);
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    return [];
  }
  if (real !== plugin.dir && !real.startsWith(plugin.dir + path.sep)) {
    throw new Error('The plugin’s migrations folder is outside the plugin.');
  }
  const entries = await readdir(real, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}
