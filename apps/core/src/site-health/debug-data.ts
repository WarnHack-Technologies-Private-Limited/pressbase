import { access, constants, lstat, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resultRows, schema } from '@pressbase/db';
import { count, sql } from 'drizzle-orm';
import { registeredImageSizes } from '../media/images';
import { maxUploadBytes, mediaStorage } from '../media/service';
import { LocalStorage } from '../media/storage';
import { DB_VERSION, PRESSBASE_VERSION } from '../version';
import { sizeFormat } from './html';
import type { SiteHealth } from './service';
import type { DebugField, DebugInfo, DebugSection, DebugValue } from './types';

/**
 * The Info tab: a port of WP_Debug_Data (wordpress/wp-admin/includes/
 * class-wp-debug-data.php) for Node.js and PostgreSQL. Section IDs keep
 * WordPress's where there is one (`wp-core`, `wp-paths-sizes`, …); the
 * sections WordPress doesn't have start with `pressbase-`.
 *
 * Nothing secret is ever put here: no database password or URL, no SMTP
 * password, setup code or cache secret. Values that identify the server
 * (database host, name and user, hostnames) are marked `private`, so they
 * show on screen but are left out of "Copy site info".
 */

/** The Pressbase checkout (apps/core/src/site-health → repository root). */
const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const LOADING = { value: 'Loading…', debug: 'loading...' };

/**
 * The environment variables Pressbase reads. The Info tab lists whether each
 * is set, never its value.
 */
export const KNOWN_ENV = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'PRESSBASE_DATA_DIR',
  'PRESSBASE_SETUP_TOKEN',
  'PRESSBASE_MAX_UPLOAD_MB',
  'PRESSBASE_WORKER',
  'PRESSBASE_REVALIDATE_SECRET',
  'WEB_URL',
  'CORE_URL',
  'ADMIN_URL',
  'PRESSBASE_SMTP_URL',
  'PRESSBASE_SMTP_HOST',
  'PRESSBASE_SMTP_PORT',
  'PRESSBASE_SMTP_USER',
  'PRESSBASE_SMTP_PASS',
  'PRESSBASE_SMTP_SECURE',
  'PRESSBASE_MAIL_FROM',
  'PRESSBASE_ALLOW_HTTP_APP_PASSWORDS',
  'PRESSBASE_UPDATE_CHECK',
  'PRESSBASE_PAGE_CACHE_MB',
];

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

function field(label: string, value: DebugValue, extra: Partial<DebugField> = {}): DebugField {
  return { label, value, ...extra };
}

async function writable(dir: string): Promise<{ value: string; debug: string }> {
  try {
    await access(dir, constants.W_OK);
    return { value: 'Writable', debug: 'writable' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { value: 'Doesn’t exist yet', debug: 'missing' }
      : { value: 'Not writable', debug: 'not writable' };
  }
}

/* --------------------------------------------------------------- sections */

async function core(health: SiteHealth): Promise<DebugSection> {
  const { kernel } = health;
  const get = <T>(name: string, fallback: T) => kernel.options.get<T>(name, fallback);
  const home = await get('home', '');
  const siteurl = await get('siteurl', home);
  const [users] = await kernel.db.select({ n: count() }).from(schema.users);
  const permalinks = await get('permalink_structure', '');
  return {
    label: 'Pressbase',
    fields: {
      version: field('Version', PRESSBASE_VERSION),
      db_version: field('Database version', await get('pressbase_db_version', DB_VERSION)),
      site_language: field('Site language', await get('locale', 'en_US')),
      timezone: field('Timezone', await get('timezone_string', 'UTC')),
      home_url: field('Home URL', home, { private: true }),
      site_url: field('Site URL', siteurl, { private: true }),
      permalink: field('Permalink structure', permalinks || 'No permalink structure set', {
        debug: permalinks,
      }),
      https_status: field(
        'Is this site using HTTPS?',
        yesNo(home.startsWith('https://') && siteurl.startsWith('https://')),
        { debug: home.startsWith('https://') && siteurl.startsWith('https://') },
      ),
      multisite: field('Is this a multisite?', 'No', { debug: false }),
      user_registration: field(
        'Can anyone register on this site?',
        yesNo(await get('users_can_register', false)),
        { debug: await get('users_can_register', false) },
      ),
      blog_public: field(
        'Is this site discouraging search engines?',
        yesNo(!(await get('blog_public', true))),
        { debug: !(await get('blog_public', true)) },
      ),
      default_comment_status: field(
        'Default comment status',
        (await get('default_comment_status', 'open')) === 'open' ? 'Open' : 'Closed',
        { debug: await get('default_comment_status', 'open') },
      ),
      environment_type: field('Environment type', process.env.NODE_ENV || 'development'),
      user_count: field('User count', users?.n ?? 0),
      update_check: field(
        'Checks for new releases',
        ['off', '0', 'false', 'no'].includes((process.env.PRESSBASE_UPDATE_CHECK ?? '').toLowerCase())
          ? 'Off'
          : 'GitHub releases',
      ),
    },
  };
}

function pathsSizes(health: SiteHealth): DebugSection {
  const { kernel } = health;
  const storage = mediaStorage(kernel);
  const { site, bundled } = kernel.plugins.directories;
  return {
    label: 'Directories and Sizes',
    fields: {
      pressbase_path: field('Pressbase directory location', INSTALL_DIR),
      data_path: field('Data directory location', kernel.config.dataDir),
      data_size: field('Data directory size', LOADING.value, { debug: LOADING.debug }),
      uploads_path: field(
        'Uploads directory location',
        storage instanceof LocalStorage ? storage.root : storage.constructor.name,
      ),
      uploads_size: field('Uploads directory size', LOADING.value, { debug: LOADING.debug }),
      themes_path: field('Themes directory location', kernel.themes.directories().join(', ')),
      themes_size: field('Themes directory size', LOADING.value, { debug: LOADING.debug }),
      plugins_path: field(
        'Plugins directory location',
        [site, bundled].filter(Boolean).join(', '),
      ),
      plugins_size: field('Plugins directory size', LOADING.value, { debug: LOADING.debug }),
      database_size: field('Database size', LOADING.value, { debug: LOADING.debug }),
      total_size: field('Total installation size', LOADING.value, { debug: LOADING.debug }),
    },
  };
}

async function themes(health: SiteHealth): Promise<DebugInfo> {
  const { kernel } = health;
  const [all, active] = await Promise.all([kernel.themes.all(), kernel.themes.activeStylesheet()]);
  const theme = all.find((t) => t.stylesheet === active);
  const parent = theme && theme.template !== theme.stylesheet
    ? all.find((t) => t.stylesheet === theme.template)
    : undefined;
  const describe = (t: (typeof all)[number]) => ({
    value: `Version ${t.version || 'unknown'} by ${t.author || 'unknown'}`,
    debug: `version: ${t.version || 'undefined'}, author: ${t.author || 'undefined'}`,
  });
  const info: DebugInfo = {
    'wp-active-theme': {
      label: 'Active Theme',
      fields: theme
        ? {
            name: field('Name', `${theme.name} (${theme.stylesheet})`),
            version: field('Version', theme.version || 'Unknown'),
            author: field('Author', theme.author || 'Unknown'),
            author_website: field('Author website', theme.authorUri || 'Undefined', {
              debug: theme.authorUri || '(undefined)',
            }),
            parent_theme: field(
              'Parent theme',
              parent ? `${parent.name} (${parent.stylesheet})` : 'None',
              { debug: parent?.stylesheet ?? 'none' },
            ),
            block_theme: field('Block theme', yesNo(theme.isBlockTheme), {
              debug: theme.isBlockTheme,
            }),
            theme_path: field('Theme directory location', theme.dir),
          }
        : { name: field('Name', active || 'None') },
    },
  };
  const inactive = all.filter(
    (t) => t.stylesheet !== active && t.stylesheet !== parent?.stylesheet,
  );
  info['wp-themes-inactive'] = {
    label: 'Inactive Themes',
    show_count: true,
    fields: Object.fromEntries(
      inactive.map((t) => {
        const d = describe(t);
        return [t.stylesheet, field(`${t.name} (${t.stylesheet})`, d.value, { debug: d.debug })];
      }),
    ),
  };
  return info;
}

async function plugins(health: SiteHealth): Promise<DebugInfo> {
  const { plugins: manager } = health.kernel;
  const [{ plugins: installed }, active, errors] = await Promise.all([
    manager.discover(),
    manager.activeSlugs(),
    manager.errors(),
  ]);
  const row = (p: (typeof installed)[number]) => {
    const author = p.manifest.author || 'unknown';
    const error = errors[p.slug];
    return field(p.manifest.title || p.slug, `Version ${p.manifest.version} by ${author}${
      p.source === 'bundled' ? ' (ships with Pressbase)' : ''
    }${error ? ` — stopped: ${error.message}` : ''}`, {
      debug: `version: ${p.manifest.version}, author: ${author}, source: ${p.source}${
        error ? `, error: ${error.message}` : ''
      }`,
    });
  };
  const section = (label: string, list: typeof installed): DebugSection => ({
    label,
    show_count: true,
    fields: Object.fromEntries(list.map((p) => [p.slug, row(p)])),
  });
  return {
    'wp-plugins-active': section(
      'Active Plugins',
      installed.filter((p) => active.includes(p.slug)),
    ),
    'wp-plugins-inactive': section(
      'Inactive Plugins',
      installed.filter((p) => !active.includes(p.slug)),
    ),
  };
}

async function media(health: SiteHealth): Promise<DebugSection> {
  const { kernel } = health;
  const storage = mediaStorage(kernel);
  const sharp = await health.sharpInfo();
  const sizes = await registeredImageSizes(kernel);
  const maxUpload = maxUploadBytes(kernel);
  return {
    label: 'Media Handling',
    fields: {
      image_editor: field('Active editor', 'sharp'),
      sharp_version: field('sharp version', sharp instanceof Error ? 'Not available' : sharp.sharp, {
        debug: sharp instanceof Error ? `error: ${sharp.message}` : sharp.sharp,
      }),
      libvips_version: field('libvips version', sharp instanceof Error ? 'Not available' : sharp.vips),
      output_formats: field(
        'Output formats',
        sharp instanceof Error ? 'None' : sharp.formats.join(', '),
      ),
      storage: field(
        'Storage',
        storage instanceof LocalStorage ? 'Local disk' : storage.constructor.name,
      ),
      max_upload_size: field('Max size of an uploaded file', sizeFormat(maxUpload), {
        debug: maxUpload,
      }),
      image_sizes: field(
        'Image sizes',
        Object.fromEntries(
          Object.entries(sizes).map(([name, s]) => [
            name,
            `${s.width}×${s.height}${s.crop ? ' cropped' : ''}`,
          ]),
        ),
      ),
    },
  };
}

function server(health: SiteHealth): DebugSection {
  const memory = process.memoryUsage();
  return {
    label: 'Server',
    description:
      'The options shown below relate to your server setup. If changes are required, you may need your web host’s assistance.',
    fields: {
      server_architecture: field('Server architecture', `${os.type()} ${os.release()} ${os.arch()}`),
      hostname: field('Hostname', os.hostname(), { private: true }),
      node_version: field('Node.js version', process.versions.node),
      v8_version: field('V8 version', process.versions.v8),
      openssl_version: field('OpenSSL version', process.versions.openssl ?? 'Unknown'),
      icu_version: field('ICU version', process.versions.icu ?? 'Unknown'),
      cpus: field('CPUs', os.cpus().length),
      total_memory: field('Total memory', sizeFormat(os.totalmem()), { debug: os.totalmem() }),
      free_memory: field('Free memory', sizeFormat(os.freemem()), { debug: os.freemem() }),
      process_memory: field('Memory used by core', sizeFormat(memory.rss), { debug: memory.rss }),
      uptime: field('Core uptime', `${Math.round(process.uptime() / 60)} minutes`, {
        debug: Math.round(process.uptime()),
      }),
      server_timezone: field(
        'Server time zone',
        Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Unknown',
      ),
      current: field('Current time', new Date().toISOString()),
      worker: field('Job worker in this process', yesNo(health.kernel.jobs.workerRunning), {
        debug: health.kernel.jobs.workerRunning,
      }),
    },
  };
}

async function database(health: SiteHealth): Promise<DebugSection> {
  const { kernel } = health;
  const builtIn = kernel.connection.driver === 'pglite';
  const version = await health.postgresVersion();
  const show = async (name: string) => {
    try {
      const [row] = resultRows<Record<string, string>>(
        await kernel.db.execute(sql.raw(`show ${name}`)),
      );
      return row ? (Object.values(row)[0] ?? '') : '';
    } catch {
      return '';
    }
  };
  const fields: Record<string, DebugField> = {
    extension: field('Database', builtIn ? 'Built-in (PGlite)' : 'PostgreSQL (postgres-js)', {
      debug: kernel.connection.driver,
    }),
    server_version: field('Server version', version.text),
  };
  const url = kernel.config.databaseUrl ?? '';
  if (builtIn) {
    const target = url.slice('pglite:'.length);
    fields.database_path = field('Database location', target === 'memory' ? 'In memory' : target, {
      private: true,
    });
  } else {
    try {
      const parsed = new URL(url);
      fields.database_host = field('Database host', parsed.hostname, { private: true });
      fields.database_name = field('Database name', decodeURIComponent(parsed.pathname.slice(1)), {
        private: true,
      });
      fields.database_user = field('Database username', decodeURIComponent(parsed.username), {
        private: true,
      });
      fields.database_ssl = field('SSL', parsed.searchParams.get('sslmode') ?? 'Not set');
    } catch {
      // A URL that doesn't parse shows no connection details.
    }
    fields.database_from_env = field(
      'Connection set by',
      kernel.config.databaseFromEnv ? 'DATABASE_URL' : 'config.json',
    );
  }
  fields.max_connections = field('Max connections', (await show('max_connections')) || 'Unknown');
  fields.encoding = field('Server encoding', (await show('server_encoding')) || 'Unknown');
  fields.timezone = field('Database time zone', (await show('timezone')) || 'Unknown');
  return { label: 'Database', fields };
}

function configuration(health: SiteHealth): DebugSection {
  const { config, mail } = health.kernel;
  const set = (value: unknown) => (value ? 'Set' : 'Not set');
  return {
    label: 'Pressbase Constants',
    description: 'These settings control how Pressbase runs. They come from environment variables and the data directory’s config.json.',
    fields: {
      PRESSBASE_DATA_DIR: field('Data directory (PRESSBASE_DATA_DIR)', config.dataDir),
      PORT: field('Core port (PORT)', config.port),
      NODE_ENV: field('NODE_ENV', process.env.NODE_ENV || 'Not set', {
        debug: process.env.NODE_ENV || 'undefined',
      }),
      PRESSBASE_WORKER: field('Job worker (PRESSBASE_WORKER)', config.worker === false ? 'Off' : 'On'),
      PRESSBASE_MAX_UPLOAD_MB: field(
        'Upload limit (PRESSBASE_MAX_UPLOAD_MB)',
        `${config.maxUploadMb ?? 64} MB`,
        { debug: config.maxUploadMb ?? 64 },
      ),
      DATABASE: field('Database connection', set(config.databaseUrl), {
        debug: config.databaseFromEnv ? 'environment' : 'config.json',
      }),
      PRESSBASE_SETUP_TOKEN: field('Setup code (PRESSBASE_SETUP_TOKEN)', set(config.setupToken)),
      MAIL: field('Email delivery', mail.transport === 'smtp' ? 'SMTP' : 'Outbox folder', {
        debug: mail.transport,
      }),
      SMTP_HOST: field(
        'SMTP host',
        config.mail?.host ?? (config.mail?.smtpUrl ? hostOf(config.mail.smtpUrl) : 'Not set'),
        { private: true },
      ),
      PRESSBASE_MAIL_FROM: field('From address (PRESSBASE_MAIL_FROM)', config.mail?.from ?? 'Not set', {
        private: true,
      }),
      PAGE_CACHE: field('Page cache purges', config.revalidate ? 'On' : 'Off'),
      WEB_URL: field('Public site (WEB_URL)', health.webUrls().join(', ') || 'Not set', {
        private: true,
      }),
      PRESSBASE_ALLOW_HTTP_APP_PASSWORDS: field(
        'Application passwords over HTTP',
        process.env.PRESSBASE_ALLOW_HTTP_APP_PASSWORDS === '1' ? 'Allowed' : 'Not allowed',
      ),
    },
  };
}

/** The host of an SMTP URL, without its credentials. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'Set';
  }
}

/** Names only: whether each variable is set, never its value. */
function environment(env: NodeJS.ProcessEnv = process.env): DebugSection {
  const names = [
    ...KNOWN_ENV,
    ...Object.keys(env)
      .filter((name) => name.startsWith('PRESSBASE_') && !KNOWN_ENV.includes(name))
      .sort(),
  ];
  return {
    label: 'Environment Variables',
    description:
      'Which of the variables Pressbase reads are set for core. Values are never shown here.',
    fields: Object.fromEntries(
      names.map((name) => [
        name,
        field(name, env[name] !== undefined && env[name] !== '' ? 'Set' : 'Not set', {
          debug: env[name] !== undefined && env[name] !== '' ? 'set' : 'not set',
        }),
      ]),
    ),
  };
}

/** get_wp_filesystem(): can core write where it needs to? */
async function filesystem(health: SiteHealth): Promise<DebugSection> {
  const { kernel } = health;
  const storage = mediaStorage(kernel);
  const dirs: [string, string, string][] = [
    ['pressbase', 'The Pressbase directory', INSTALL_DIR],
    ['data', 'The data directory', kernel.config.dataDir],
    ...(storage instanceof LocalStorage
      ? [['uploads', 'The uploads directory', storage.root] as [string, string, string]]
      : []),
    ['plugins', 'The plugins directory', kernel.plugins.directories.site],
    ['themes', 'The themes directory', path.join(kernel.config.dataDir, 'themes')],
    ['outbox', 'The email outbox', kernel.mail.outboxDir],
  ];
  const fields: Record<string, DebugField> = {};
  for (const [key, label, dir] of dirs) {
    const state = await writable(dir);
    fields[key] = field(label, state.value, { debug: state.debug });
  }
  // config.json holds database credentials: it should be readable by core alone.
  const config = path.join(kernel.config.dataDir, 'config.json');
  try {
    const mode = (await stat(config)).mode & 0o777;
    fields.config_json = field(
      'config.json permissions',
      `${mode.toString(8).padStart(4, '0')}${mode & 0o077 ? ' (readable by other users)' : ''}`,
      { debug: mode.toString(8) },
    );
  } catch {
    fields.config_json = field('config.json permissions', 'No config.json', { debug: 'none' });
  }
  return {
    label: 'Filesystem Permissions',
    description: 'Shows whether Pressbase is able to write to the directories it needs access to.',
    fields,
  };
}

/** WP_Debug_Data::debug_data(), before the `debug_information` filter. */
export async function debugData(health: SiteHealth): Promise<DebugInfo> {
  const [coreSection, themeSections, pluginSections, mediaSection, databaseSection, fsSection] =
    await Promise.all([
      core(health),
      themes(health),
      plugins(health),
      media(health),
      database(health),
      filesystem(health),
    ]);
  return {
    'wp-core': coreSection,
    'wp-paths-sizes': pathsSizes(health),
    ...themeSections,
    ...pluginSections,
    'wp-media': mediaSection,
    'wp-server': server(health),
    'wp-database': databaseSection,
    'wp-constants': configuration(health),
    'pressbase-environment': environment(),
    'wp-filesystem': fsSection,
  };
}

/* ------------------------------------------------------------------ sizes */

/**
 * recurse_dirsize(): bytes under a folder, without following symlinks, or
 * null once `deadline` passes (WordPress stops at max_execution_time).
 */
export async function directorySize(dir: string, deadline: number): Promise<number | null> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) return null;
    const current = stack.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += (await lstat(full)).size;
        } catch {
          // Removed while counting.
        }
      }
    }
  }
  return total;
}

export interface DirectorySize {
  size: string;
  debug: string;
  raw: number;
}

/** WP_Debug_Data::get_sizes(): the sizes the Info tab loads after the page. */
export async function directorySizes(
  health: SiteHealth,
  budgetMs = 10_000,
): Promise<Record<string, DirectorySize>> {
  const { kernel } = health;
  const deadline = Date.now() + budgetMs;
  const storage = mediaStorage(kernel);
  const sum = async (dirs: (string | null)[]) => {
    let total = 0;
    for (const dir of dirs) {
      if (!dir) continue;
      const size = await directorySize(dir, deadline);
      if (size === null) return null;
      total += size;
    }
    return total;
  };
  const [row] = resultRows<{ size: string | number }>(
    await kernel.db.execute(sql`select pg_database_size(current_database())::bigint as size`),
  );
  const databaseBytes = Number(row?.size ?? 0);
  const sizes: Record<string, number | null> = {
    data_size: await sum([kernel.config.dataDir]),
    uploads_size: storage instanceof LocalStorage ? await sum([storage.root]) : 0,
    themes_size: await sum(kernel.themes.directories()),
    plugins_size: await sum([kernel.plugins.directories.site, kernel.plugins.directories.bundled]),
    database_size: databaseBytes,
  };
  // The built-in database lives in the data directory: count it once.
  const dbInData =
    kernel.connection.driver === 'pglite' &&
    path
      .resolve((kernel.config.databaseUrl ?? '').slice('pglite:'.length))
      .startsWith(kernel.config.dataDir);
  const data = sizes.data_size ?? null;
  sizes.total_size = data === null ? null : data + (dbInData ? 0 : databaseBytes);

  const out: Record<string, DirectorySize> = {};
  for (const [name, bytes] of Object.entries(sizes)) {
    out[name] =
      bytes === null
        ? {
            size: 'The directory size calculation has timed out. Usually caused by a very large number of sub-directories and files.',
            debug: 'timeout',
            raw: -1,
          }
        : { size: sizeFormat(bytes), debug: `${sizeFormat(bytes)} (${bytes} bytes)`, raw: bytes };
  }
  return out;
}

/* ----------------------------------------------------------------- format */

/**
 * WP_Debug_Data::format(): the text "Copy site info to clipboard" copies.
 * Private sections and fields are left out. `debug` uses section and field
 * keys and the `debug` values; `info` the labels and displayed values.
 */
export function formatDebugInfo(info: DebugInfo, type: 'info' | 'debug'): string {
  let out = '`\n';
  for (const [key, section] of Object.entries(info)) {
    const fields = Object.entries(section.fields ?? {});
    if (!fields.length || section.private) continue;
    const label = type === 'debug' ? key : section.label;
    out += `### ${label}${section.show_count ? ` (${fields.length})` : ''} ###\n\n`;
    for (const [name, f] of fields) {
      if (f.private === true) continue;
      const data = type === 'debug' && f.debug !== undefined ? f.debug : f.value;
      let value: string;
      if (data && typeof data === 'object') {
        value = Object.entries(data)
          .map(([k, v]) => `\n\t${k}: ${v}`)
          .join('');
      } else if (typeof data === 'boolean') {
        value = data ? 'true' : 'false';
      } else if (data === '' || data === 0 || data === undefined || data === null) {
        // empty() in PHP, except that the string '0' is kept.
        value = 'undefined';
      } else {
        value = String(data);
      }
      out += `${type === 'debug' ? name : f.label}: ${value}\n`;
    }
    out += '\n';
  }
  return `${out}\``;
}
