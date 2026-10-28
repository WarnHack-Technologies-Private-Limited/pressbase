import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Kernel } from '../kernel';
import { PRESSBASE_VERSION } from '../version';
import { clearPluginJobs } from './background';
import {
  BUNDLED_PLUGINS_DIR,
  type DiscoveredPlugins,
  discoverPlugins,
  type InstalledPlugin,
  listMigrations,
  type PluginDirectories,
  resolveMain,
  sitePluginsDir,
} from './discovery';
import {
  describeManifestErrors,
  MANIFEST_FILE,
  type PluginManifest,
  type PluginPermission,
  parseManifest,
} from './manifest';
import { type PluginModule, PluginRuntime, type RuntimeHost } from './runtime';
import { satisfies } from './semver';
import { readZip, ZipError } from './zip';

/**
 * The plugin manager: activate_plugin(), deactivate_plugins(),
 * delete_plugins(), uninstall_plugin() and the plugin loading wp-settings.php
 * does (wordpress/wp-admin/includes/plugin.php, wp-includes/load.php), for
 * JavaScript plugins described by plugin.json.
 *
 * Options it keeps (WordPress names where WordPress has one):
 * - `active_plugins`: slugs of the active plugins, in activation order.
 * - `pressbase_plugin_migrations`: { slug: [applied .sql file names] }.
 * - `pressbase_plugin_permissions`: { slug: { permissions, granted_at, granted_by } },
 *   what the administrator agreed to on activation.
 * - `pressbase_plugin_errors`: { slug: { message, during, time } }, the last
 *   error that stopped a plugin loading, shown in the admin.
 *
 * See docs/architecture/plugins.md and docs/adr/0009-plugin-runtime.md.
 */

export const ACTIVE_PLUGINS = 'active_plugins';
export const PLUGIN_MIGRATIONS = 'pressbase_plugin_migrations';
export const PLUGIN_PERMISSIONS_OPTION = 'pressbase_plugin_permissions';
export const PLUGIN_ERRORS = 'pressbase_plugin_errors';

export interface PluginErrorRecord {
  message: string;
  /** What Pressbase was doing: "load", "activate", "migration 0001-init.sql", "hook init"… */
  during: string;
  time: string;
}

export interface PermissionGrant {
  permissions: PluginPermission[];
  granted_at: string;
  granted_by: number | null;
}

/** A failed plugin operation, with WordPress's error code and an HTTP status for REST. */
export class PluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 500 = 400,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface PluginStatus {
  plugin: InstalledPlugin;
  active: boolean;
  /** Load or activation error, if the plugin was stopped. */
  error: PluginErrorRecord | null;
  /** Errors thrown by the plugin's hooks and routes since it loaded, most recent first (at most 5). */
  runtimeErrors: PluginErrorRecord[];
  grant: PermissionGrant | null;
  /** Whether this version of Pressbase meets the manifest's `requires`. */
  compatible: boolean;
}

export interface ActivateOptions {
  /** The permissions the administrator agreed to. Must cover the manifest's. */
  permissions?: readonly string[];
  /** The user activating, recorded with the permissions. */
  userId?: number | null;
}

declare module '@pressbase/hooks' {
  interface ActionRegistry {
    activate_plugin: [slug: string];
    activated_plugin: [slug: string];
    deactivate_plugin: [slug: string];
    deactivated_plugin: [slug: string];
    pre_uninstall_plugin: [slug: string, manifest: PluginManifest | null];
    deleted_plugin: [slug: string, deleted: boolean];
    pressbase_plugin_error: [slug: string, error: PluginErrorRecord];
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PluginManager {
  #directories: PluginDirectories | undefined;
  #runtimes = new Map<string, PluginRuntime>();
  #owners = new Map<string, string>();
  #runtimeErrors = new Map<string, PluginErrorRecord[]>();
  #queue: Promise<unknown> = Promise.resolve();
  #imports = 0;

  constructor(private readonly kernel: Kernel) {}

  /** Where plugins are found. Tests point `bundled` at null or a fixture folder. */
  get directories(): PluginDirectories {
    this.#directories ??= {
      site: sitePluginsDir(this.kernel.config.dataDir),
      bundled: BUNDLED_PLUGINS_DIR,
    };
    return this.#directories;
  }

  set directories(value: PluginDirectories) {
    this.#directories = value;
  }

  // ---- Queries -------------------------------------------------------------

  discover(): Promise<DiscoveredPlugins> {
    return discoverPlugins(this.directories);
  }

  async get(slug: string): Promise<InstalledPlugin | undefined> {
    return (await this.discover()).plugins.find((p) => p.slug === slug);
  }

  async activeSlugs(): Promise<string[]> {
    const value = await this.kernel.options.get<unknown>(ACTIVE_PLUGINS, []);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }

  /** Whether the plugin's code is loaded in this process. */
  isLoaded(slug: string): boolean {
    return this.#runtimes.has(slug);
  }

  runtime(slug: string): PluginRuntime | undefined {
    return this.#runtimes.get(slug);
  }

  /** The plugin that registered a post type or taxonomy, if one did. */
  ownerOf(kind: 'postType' | 'taxonomy', name: string): string | undefined {
    return this.#owners.get(`${kind}:${name}`);
  }

  /** REST namespaces of the loaded plugins, for the /wp-json index. */
  namespaces(): string[] {
    return [...this.#runtimes.values()].flatMap((r) => r.namespaces());
  }

  /** The loaded plugin whose namespace serves `path` (the longest match wins). */
  runtimeForPath(path: string): PluginRuntime | undefined {
    let best: { runtime: PluginRuntime; length: number } | undefined;
    for (const runtime of this.#runtimes.values()) {
      for (const ns of runtime.namespaces()) {
        const prefix = `/wp-json/${ns}`;
        if (
          (path === prefix || path.startsWith(`${prefix}/`)) &&
          prefix.length > (best?.length ?? 0)
        ) {
          best = { runtime, length: prefix.length };
        }
      }
    }
    return best?.runtime;
  }

  async errors(): Promise<Record<string, PluginErrorRecord>> {
    return this.kernel.options.get<Record<string, PluginErrorRecord>>(PLUGIN_ERRORS, {});
  }

  async grants(): Promise<Record<string, PermissionGrant>> {
    return this.kernel.options.get<Record<string, PermissionGrant>>(PLUGIN_PERMISSIONS_OPTION, {});
  }

  async status(plugin: InstalledPlugin): Promise<PluginStatus> {
    const [active, errors, grants] = await Promise.all([
      this.activeSlugs(),
      this.errors(),
      this.grants(),
    ]);
    return {
      plugin,
      active: active.includes(plugin.slug),
      error: errors[plugin.slug] ?? null,
      runtimeErrors: this.#runtimeErrors.get(plugin.slug) ?? [],
      grant: grants[plugin.slug] ?? null,
      compatible: satisfies(PRESSBASE_VERSION, plugin.manifest.requires),
    };
  }

  // ---- Loading -------------------------------------------------------------

  /**
   * Loads every active plugin, as wp-settings.php includes
   * wp_get_active_and_valid_plugins(). Runs on boot, before `init`. A plugin
   * that fails to load is deactivated and its error recorded; the site boots.
   */
  loadActive(): Promise<void> {
    return this.#serial(async () => {
      const active = await this.activeSlugs();
      if (!active.length) return;
      const { plugins } = await this.discover();
      const grants = await this.grants();
      const failed: string[] = [];
      for (const slug of active) {
        if (this.#runtimes.has(slug)) continue;
        const plugin = plugins.find((p) => p.slug === slug);
        try {
          if (!plugin)
            throw new Error('The plugin’s folder is missing or its plugin.json is invalid.');
          await this.#load(plugin, grants[slug]?.permissions ?? []);
        } catch (error) {
          failed.push(slug);
          await this.#recordError(slug, 'load', error);
        }
      }
      if (failed.length) {
        // deactivate_plugins( $plugin, true ): silently, without the deactivation hooks.
        await this.kernel.options.set(
          ACTIVE_PLUGINS,
          active.filter((s) => !failed.includes(s)),
        );
      }
    });
  }

  /** Imports the main module and runs `register(api)`. Throws, leaving nothing behind, on failure. */
  async #load(plugin: InstalledPlugin, permissions: readonly PluginPermission[]) {
    const { module, runtime } = await this.#instantiate(plugin, permissions);
    const register = module.register ?? module.default;
    try {
      if (typeof register !== 'function') {
        throw new Error('The plugin’s main module has no default export or `register` function.');
      }
      await register(runtime.api);
    } catch (error) {
      runtime.dispose();
      throw error;
    }
    this.#runtimeErrors.delete(plugin.slug);
    this.#runtimes.set(plugin.slug, runtime);
    runtime.startBackground();
    return runtime;
  }

  async #instantiate(plugin: InstalledPlugin, permissions: readonly PluginPermission[]) {
    if (!satisfies(PRESSBASE_VERSION, plugin.manifest.requires)) {
      throw new PluginError(
        'plugin_wp_incompatible',
        `${plugin.manifest.title} requires Pressbase ${plugin.manifest.requires}; this site runs ${PRESSBASE_VERSION}.`,
      );
    }
    const main = await resolveMain(plugin);
    // The query string makes Node import the file again after a reinstall;
    // earlier copies stay in memory until the process restarts.
    const mtime = (await stat(main)).mtimeMs;
    const url = `${pathToFileURL(main).href}?v=${encodeURIComponent(plugin.manifest.version)}-${mtime}-${++this.#imports}`;
    const module = (await import(/* @vite-ignore */ url)) as PluginModule;
    const runtime = new PluginRuntime(this.kernel, plugin, permissions, module, this.#host());
    return { module, runtime };
  }

  #host(): RuntimeHost {
    return {
      reportError: (slug, during, error) => {
        console.error(`[plugin:${slug}] ${during}:`, error);
        const record = { message: message(error), during, time: new Date().toISOString() };
        const list = [record, ...(this.#runtimeErrors.get(slug) ?? [])].slice(0, 5);
        this.#runtimeErrors.set(slug, list);
        void this.kernel.hooks.doAction('pressbase_plugin_error', slug, record).catch(() => {});
      },
      claim: (kind, name, slug) => this.#owners.set(`${kind}:${name}`, slug),
      release: (kind, name) => this.#owners.delete(`${kind}:${name}`),
    };
  }

  async #recordError(slug: string, during: string, error: unknown) {
    console.error(`[plugin:${slug}] ${during} failed:`, error);
    const record: PluginErrorRecord = {
      message: message(error),
      during,
      time: new Date().toISOString(),
    };
    const errors = await this.errors();
    await this.kernel.options.set(PLUGIN_ERRORS, { ...errors, [slug]: record });
    await this.kernel.hooks.doAction('pressbase_plugin_error', slug, record).catch(() => {});
  }

  async #clearError(slug: string) {
    const errors = await this.errors();
    if (!(slug in errors)) return;
    const { [slug]: _removed, ...rest } = errors;
    await this.kernel.options.set(PLUGIN_ERRORS, rest);
  }

  /** One lifecycle change at a time, so two requests can't activate the same plugin twice. */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }

  // ---- Lifecycle -----------------------------------------------------------

  /**
   * activate_plugin(): checks, `activate_plugin`, migrations, load,
   * the module's `activate(api)`, `active_plugins`, `activated_plugin`.
   * On failure nothing stays registered and the error is recorded.
   */
  activate(slug: string, options: ActivateOptions = {}): Promise<PluginStatus> {
    return this.#serial(async () => {
      const plugin = await this.#require(slug);
      const active = await this.activeSlugs();
      if (active.includes(slug) && this.#runtimes.has(slug)) return this.status(plugin);

      const requested = plugin.manifest.permissions;
      const agreed = new Set(options.permissions ?? []);
      const missing = requested.filter((p) => !agreed.has(p));
      if (missing.length) {
        throw new PluginError(
          'pressbase_plugin_permissions_required',
          `${plugin.manifest.title} asks for these permissions: ${requested.join(', ')}. Confirm them to activate it.`,
          400,
          { permissions: requested },
        );
      }

      await this.kernel.hooks.doAction('activate_plugin', slug);
      let runtime: PluginRuntime | undefined;
      try {
        await this.#migrate(plugin, requested);
        runtime = await this.#load(plugin, requested);
        await runtime.module.activate?.(runtime.api);
      } catch (error) {
        if (runtime) {
          runtime.dispose();
          this.#runtimes.delete(slug);
        }
        await this.#recordError(slug, 'activate', error);
        if (error instanceof PluginError) throw error;
        throw new PluginError(
          'plugin_activation_failed',
          `${plugin.manifest.title} could not be activated: ${message(error)}`,
          500,
        );
      }

      const grants = await this.grants();
      await this.kernel.options.set(PLUGIN_PERMISSIONS_OPTION, {
        ...grants,
        [slug]: {
          permissions: [...requested],
          granted_at: new Date().toISOString(),
          granted_by: options.userId ?? null,
        } satisfies PermissionGrant,
      });
      await this.kernel.options.set(ACTIVE_PLUGINS, [...active.filter((s) => s !== slug), slug]);
      await this.#clearError(slug);
      await this.kernel.hooks.doAction('activated_plugin', slug);
      return this.status(plugin);
    });
  }

  /** deactivate_plugins(): `deactivate_plugin`, the module's `deactivate(api)`, unload, `deactivated_plugin`. */
  deactivate(slug: string): Promise<void> {
    return this.#serial(async () => {
      const active = await this.activeSlugs();
      const runtime = this.#runtimes.get(slug);
      if (!active.includes(slug) && !runtime) return;
      await this.kernel.hooks.doAction('deactivate_plugin', slug);
      if (runtime) {
        try {
          await runtime.module.deactivate?.(runtime.api);
        } catch (error) {
          // The plugin is switched off regardless; WordPress has no way to refuse either.
          await this.#recordError(slug, 'deactivate', error);
        }
        runtime.dispose();
        this.#runtimes.delete(slug);
      }
      await this.kernel.options.set(
        ACTIVE_PLUGINS,
        active.filter((s) => s !== slug),
      );
      await this.kernel.hooks.doAction('deactivated_plugin', slug);
    });
  }

  /**
   * delete_plugins() with uninstall_plugin(): the plugin must be inactive.
   * Runs the module's `uninstall(api)`, removes the folder and what Pressbase
   * recorded about the plugin. Bundled plugins can't be deleted. The plugin's
   * tables and options stay unless its `uninstall` removes them.
   */
  delete(slug: string): Promise<void> {
    return this.#serial(async () => {
      const { plugins, invalid } = await this.discover();
      const plugin = plugins.find((p) => p.slug === slug);
      const broken = invalid.find((p) => p.slug === slug);
      const found = plugin ?? broken;
      if (!found) throw new PluginError('rest_plugin_not_found', 'Plugin not found.', 404);
      if (found.source === 'bundled') {
        throw new PluginError(
          'pressbase_cannot_delete_bundled_plugin',
          'This plugin ships with Pressbase and can’t be deleted. Deactivate it instead.',
          400,
        );
      }
      if ((await this.activeSlugs()).includes(slug) || this.#runtimes.has(slug)) {
        throw new PluginError(
          'rest_cannot_delete_active_plugin',
          'Cannot delete an active plugin. Please deactivate it first.',
          400,
        );
      }

      await this.kernel.hooks.doAction('pre_uninstall_plugin', slug, plugin?.manifest ?? null);
      if (plugin) {
        try {
          const grants = await this.grants();
          const { module, runtime } = await this.#instantiate(
            plugin,
            grants[slug]?.permissions ?? [],
          );
          try {
            await module.uninstall?.(runtime.api);
          } finally {
            runtime.dispose();
          }
        } catch (error) {
          // Deleting goes ahead: a plugin that can't uninstall cleanly must still be removable.
          console.error(`[plugin:${slug}] uninstall failed:`, error);
        }
      }

      // Its jobs and cron events would otherwise wait forever for a handler.
      await clearPluginJobs(this.kernel, slug);

      let deleted = true;
      try {
        await rm(found.dir, { recursive: true, force: true });
      } catch (error) {
        console.error(`[plugin:${slug}] could not remove ${found.dir}:`, error);
        deleted = false;
      }
      for (const option of [PLUGIN_MIGRATIONS, PLUGIN_PERMISSIONS_OPTION, PLUGIN_ERRORS]) {
        const value = await this.kernel.options.get<Record<string, unknown>>(option, {});
        if (slug in value) {
          const { [slug]: _removed, ...rest } = value;
          await this.kernel.options.set(option, rest);
        }
      }
      this.#runtimeErrors.delete(slug);
      await this.kernel.hooks.doAction('deleted_plugin', slug, deleted);
      if (!deleted) {
        throw new PluginError(
          'could_not_remove_plugin',
          'The plugin’s files could not be removed.',
          500,
        );
      }
    });
  }

  async #require(slug: string): Promise<InstalledPlugin> {
    const { plugins, invalid } = await this.discover();
    const plugin = plugins.find((p) => p.slug === slug);
    if (plugin) return plugin;
    const broken = invalid.find((p) => p.slug === slug);
    if (broken) throw new PluginError('plugin_invalid', broken.error, 400);
    throw new PluginError('rest_plugin_not_found', 'Plugin not found.', 404);
  }

  /**
   * Runs the plugin's migrations that haven't run: each .sql file once, in
   * order, recorded in `pressbase_plugin_migrations` after it succeeds.
   */
  async #migrate(plugin: InstalledPlugin, permissions: readonly PluginPermission[]) {
    const files = await listMigrations(plugin);
    if (!files.length) return;
    if (!permissions.includes('database')) {
      throw new PluginError(
        'pressbase_plugin_permission_denied',
        'Plugin migrations need the "database" permission.',
      );
    }
    const dir = path.resolve(plugin.dir, plugin.manifest.migrations ?? '');
    for (const file of files) {
      const record = await this.kernel.options.get<Record<string, string[]>>(PLUGIN_MIGRATIONS, {});
      const applied = record[plugin.slug] ?? [];
      if (applied.includes(file)) continue;
      const script = await readFile(path.join(dir, file), 'utf8');
      try {
        await this.kernel.connection.exec(script);
      } catch (error) {
        throw new PluginError(
          'plugin_migration_failed',
          `The migration ${file} failed: ${message(error)}`,
          500,
        );
      }
      await this.kernel.options.set(PLUGIN_MIGRATIONS, {
        ...record,
        [plugin.slug]: [...applied, file],
      });
    }
  }

  // ---- Installing ----------------------------------------------------------

  /**
   * Plugin_Upgrader::install() for an uploaded .zip: validates the archive
   * (see zip.ts) and the manifest, then unpacks it into
   * `<dataDir>/plugins/<name>/`. The archive holds the plugin either at its
   * root or in one top-level folder, as WordPress plugin zips do.
   */
  async install(data: Uint8Array, options: { maxBytes: number }): Promise<InstalledPlugin> {
    if (data.byteLength > options.maxBytes) {
      throw new PluginError(
        'rest_upload_file_too_big',
        `This file is too big. Plugin archives must be smaller than ${Math.round(options.maxBytes / 1024 / 1024)} MB.`,
        413,
      );
    }
    let entries: ReturnType<typeof readZip>;
    try {
      entries = readZip(data, { maxTotalBytes: options.maxBytes * 4 });
    } catch (error) {
      if (error instanceof ZipError) throw new PluginError(error.code, error.message, 400);
      throw error;
    }

    // One top-level folder holding plugin.json, or plugin.json at the root.
    let root = '';
    if (!entries.some((e) => e.name === MANIFEST_FILE)) {
      const tops = new Set(entries.map((e) => e.name.split('/')[0]));
      const [top] = tops;
      if (tops.size === 1 && top && entries.some((e) => e.name === `${top}/${MANIFEST_FILE}`)) {
        root = `${top}/`;
      } else {
        throw new PluginError(
          'incompatible_archive_no_plugins',
          'No valid plugins were found: the archive has no plugin.json.',
        );
      }
    }
    const files = entries
      .filter((e) => e.name.startsWith(root))
      .map((e) => ({ name: e.name.slice(root.length), data: e.data }));
    const manifestEntry = files.find((f) => f.name === MANIFEST_FILE);
    const parsed = parseManifest(Buffer.from(manifestEntry?.data ?? []).toString('utf8'));
    if (!parsed.ok) {
      throw new PluginError(
        'pressbase_invalid_manifest',
        `plugin.json is invalid. ${describeManifestErrors(parsed.errors)}`,
        400,
        { params: parsed.errors },
      );
    }
    const manifest = parsed.manifest;
    if (!files.some((f) => f.name === manifest.main)) {
      throw new PluginError(
        'pressbase_invalid_manifest',
        `The archive doesn’t contain the plugin’s main file, ${manifest.main}.`,
      );
    }
    if (!satisfies(PRESSBASE_VERSION, manifest.requires)) {
      throw new PluginError(
        'incompatible_wp_required_version',
        `${manifest.title} requires Pressbase ${manifest.requires}; this site runs ${PRESSBASE_VERSION}.`,
      );
    }

    const site = this.directories.site;
    const target = path.join(site, manifest.name);
    const existing = (await this.discover()).plugins.find((p) => p.slug === manifest.name);
    if (existing || (await exists(target))) {
      throw new PluginError(
        'folder_exists',
        `A plugin named "${manifest.name}" is already installed. Delete it first to install this copy.`,
        409,
      );
    }

    // Unpack beside the target, then rename, so a half-written plugin is never discovered.
    await mkdir(site, { recursive: true });
    const staging = path.join(site, `.upload-${randomBytes(6).toString('hex')}`);
    try {
      for (const file of files) {
        if (!file.name) continue;
        const dest = path.resolve(staging, file.name);
        if (!dest.startsWith(staging + path.sep)) {
          throw new PluginError(
            'incompatible_archive_path',
            `Unsafe path in the archive: "${file.name}".`,
          );
        }
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, file.data, { flag: 'wx' });
      }
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    const installed = await this.get(manifest.name);
    if (!installed)
      throw new PluginError('plugin_invalid', 'The plugin could not be read after unpacking.', 500);
    return installed;
  }

  /** Unloads every plugin without running deactivation (process shutdown, tests). */
  unloadAll(): void {
    for (const runtime of this.#runtimes.values()) runtime.dispose();
    this.#runtimes.clear();
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
