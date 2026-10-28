import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadUser } from '../auth/users';
import { savePermalinkSettings } from '../content/permalinks';
import type { Kernel } from '../kernel';
import { type SettingDefinition, sanitizeSettingValue } from '../options/settings';
import type { ImportSite } from './records';
import {
  type FetchOptions,
  fetchRemoteFile,
  type RemoteFile,
  RemoteFileError,
} from './remote-file';
import {
  connectWordPressDatabase,
  redactDatabaseUrl,
  type WordPressCounts,
  type WordPressDatabase,
} from './wordpress-db';
import { WordPressDatabaseSource } from './wordpress-db-reader';
import { ImportError, type ImportOptions, type ImportReport, ImportWriter } from './writer';

/**
 * Migrating a site straight from a WordPress database (`pressbase migrate
 * wordpress`): reads it with WordPressDatabaseSource, carries its settings,
 * and writes everything with the import writer. Files come from a local copy
 * of wp-content/uploads, or are downloaded from the old site.
 * See docs/architecture/import-export.md ("Migrating from a WordPress
 * database") and ADR 0016.
 */

export interface WordPressMigrationOptions {
  /** `mysql://user:password@host/database` (TLS via `?ssl-mode=…`), or a connected database (tests). */
  database: string | WordPressDatabase;
  /** $table_prefix. Default `wp_`. */
  prefix?: string;
  /** The user the migration runs as: needs `import`; `create_users` and `upload_files` to bring users and files. */
  userId: number;
  /** A local copy of the old site's wp-content/uploads. Without it, files are downloaded from the old site. */
  uploads?: string;
  /** Where the old site served uploads from, when it differs from its options (a CDN, a custom WP_CONTENT_URL). */
  uploadsUrl?: string;
  /** Post types to leave out (`attachment`), plus `comments` and `options`. */
  skip?: string[];
  /** Count what would be migrated, and stop. Nothing is written. */
  dryRun?: boolean;
  allowPrivateHosts?: ImportOptions['allowPrivateHosts'];
  onProgress?: ImportOptions['onProgress'];
  signal?: AbortSignal;
  /** Replaces the downloader (tests). */
  fetchFile?: ImportOptions['fetchFile'];
}

export interface WordPressMigrationResult {
  /** The database, password hidden. */
  source: string;
  prefix: string;
  site: ImportSite;
  counts: WordPressCounts;
  dryRun: boolean;
  /** The import report; null on a dry run. */
  report: ImportReport | null;
  /** The settings that were carried, and the ones that weren't (with why). */
  options: { carried: string[]; skipped: { name: string; reason: string }[] };
}

type OptionKind = 'string' | 'int' | 'bool' | 'post' | 'term';

/**
 * The wp_options a migration carries, with how WordPress's string becomes
 * Pressbase's value. Settings Pressbase validates (Settings → General,
 * Reading, Discussion, Media) go through the same checks as the admin.
 * `post` and `term` options name IDs, so they're set after the import, with
 * the new IDs. Permalinks (permalink_structure, category_base, tag_base),
 * the time zone (timezone_string, else gmt_offset) and the language (WPLANG)
 * are handled on their own. Not carried: siteurl and home (the new site
 * keeps its address), admin_email, plugins, themes, roles and widgets.
 */
export const CARRIED_OPTIONS: Record<string, OptionKind> = {
  blogname: 'string',
  blogdescription: 'string',
  date_format: 'string',
  time_format: 'string',
  start_of_week: 'int',
  posts_per_page: 'int',
  posts_per_rss: 'int',
  rss_use_excerpt: 'bool',
  show_on_front: 'string',
  page_on_front: 'post',
  page_for_posts: 'post',
  default_category: 'term',
  default_comment_status: 'string',
  default_ping_status: 'string',
  comment_moderation: 'bool',
  comment_registration: 'bool',
  thread_comments: 'bool',
  thread_comments_depth: 'int',
  comments_per_page: 'int',
  blog_public: 'bool',
  uploads_use_yearmonth_folders: 'bool',
  thumbnail_size_w: 'int',
  thumbnail_size_h: 'int',
  thumbnail_crop: 'bool',
  medium_size_w: 'int',
  medium_size_h: 'int',
  medium_large_size_w: 'int',
  medium_large_size_h: 'int',
  large_size_w: 'int',
  large_size_h: 'int',
};
const SPECIAL_OPTIONS = [
  'permalink_structure',
  'category_base',
  'tag_base',
  'timezone_string',
  'gmt_offset',
  'WPLANG',
];

function convert(kind: OptionKind, raw: string): unknown {
  if (kind === 'string') return raw;
  if (kind === 'bool') return raw === '1' || raw.toLowerCase() === 'true';
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads files from a local copy of wp-content/uploads instead of downloading
 * them: a file's old URL (the uploads URL + its _wp_attached_file) names its
 * place in the folder. Paths can't leave the folder. URLs outside the old
 * uploads URL (files offloaded to a CDN) are downloaded as usual.
 */
export function localUploadsFetcher(
  folder: string,
  uploadsUrl: string,
): (url: string, options: FetchOptions) => Promise<RemoteFile> {
  const base = `${uploadsUrl.replace(/\/+$/, '')}/`;
  return async (url, options) => {
    if (!url.startsWith(base)) return fetchRemoteFile(url, options);
    const root = await realpath(folder);
    const relative = url.slice(base.length).split(/[?#]/)[0] ?? '';
    const wanted = path.resolve(root, relative);
    const file = await realpath(wanted).catch(() => null);
    if (!file) {
      throw new RemoteFileError('import_file_missing', `There’s no file at ${wanted}.`);
    }
    if (!file.startsWith(root + path.sep)) {
      throw new RemoteFileError(
        'import_file_outside_uploads',
        `${relative} is outside the uploads folder, so it wasn’t read.`,
      );
    }
    const info = await stat(file);
    if (!info.isFile()) {
      throw new RemoteFileError('import_file_missing', `There’s no file at ${wanted}.`);
    }
    if (info.size > options.maxBytes) {
      throw new RemoteFileError(
        'import_file_too_big',
        `The file is larger than the upload limit (${Math.round(options.maxBytes / 1024 / 1024)} MB).`,
      );
    }
    const data = await readFile(file);
    return {
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      filename: path.basename(file),
      contentType: '',
      url,
    };
  };
}

/**
 * Migrates a WordPress site from its database into this one. Re-running is
 * safe: whatever is already here (users by login or email, terms, posts,
 * comments, menus) is skipped.
 *
 *   const result = await migrateFromWordPressDatabase(kernel, {
 *     database: 'mysql://reader:secret@db.internal/wordpress',
 *     uploads: '/backups/wp-content/uploads',
 *     userId: 1,
 *   });
 */
export async function migrateFromWordPressDatabase(
  kernel: Kernel,
  options: WordPressMigrationOptions,
): Promise<WordPressMigrationResult> {
  const user = await loadUser(kernel, options.userId);
  if (!user) throw new ImportError('import_invalid_user', 'That user doesn’t exist.');
  const skip = new Set(options.skip ?? []);
  const db =
    typeof options.database === 'string'
      ? await connectWordPressDatabase(options.database, options.prefix ?? 'wp_')
      : options.database;
  try {
    const source = new WordPressDatabaseSource(db, {
      skipTypes: [...skip].filter((s) => s !== 'comments' && s !== 'options'),
      comments: !skip.has('comments'),
      uploadsUrl: options.uploadsUrl,
    });
    await source.check();
    const wpOptions = await source.options([...Object.keys(CARRIED_OPTIONS), ...SPECIAL_OPTIONS]);
    const counts = await source.counts();
    const result: WordPressMigrationResult = {
      source:
        typeof options.database === 'string' ? redactDatabaseUrl(options.database) : '(given)',
      prefix: db.prefix,
      site: {
        title: wpOptions.get('blogname') ?? '',
        link: wpOptions.get('home') ?? '',
        description: wpOptions.get('blogdescription') ?? '',
        language: '',
        wxr_version: '',
        base_site_url: wpOptions.get('siteurl') ?? '',
        base_blog_url: wpOptions.get('home') ?? '',
      },
      counts,
      dryRun: Boolean(options.dryRun),
      report: null,
      options: { carried: [], skipped: [] },
    };
    if (options.dryRun) return result;

    const carry = !skip.has('options');
    if (carry) await carryOptions(kernel, wpOptions, result.options);

    if (options.uploads && !(await stat(options.uploads).catch(() => null))?.isDirectory()) {
      throw new ImportError('import_uploads_missing', `There’s no folder at ${options.uploads}.`);
    }
    const fetchFile =
      options.fetchFile ??
      (options.uploads
        ? localUploadsFetcher(options.uploads, await source.uploadsUrl())
        : undefined);
    const writer = new ImportWriter(kernel, {
      user,
      fetchAttachments: !skip.has('attachment'),
      allowPrivateHosts: options.allowPrivateHosts ?? kernel.config.import?.allowPrivateHosts,
      total: Object.values(counts.posts).reduce((a, b) => a + b, 0),
      onProgress: options.onProgress,
      signal: options.signal,
      fetchFile,
    });
    await writer.begin();
    for await (const record of source.records(options.signal)) await writer.write(record);
    result.report = await writer.finish();
    result.site = result.report.site ?? result.site;

    if (carry) await carryMappedOptions(kernel, writer, wpOptions, result.options);
    return result;
  } finally {
    if (typeof options.database === 'string') await db.close();
  }
}

function settingFor(kernel: Kernel, option: string): SettingDefinition | undefined {
  return kernel.settings.entries().find(([, def]) => def.option === option)?.[1];
}

async function setOption(
  kernel: Kernel,
  name: string,
  value: unknown,
  out: WordPressMigrationResult['options'],
): Promise<void> {
  const setting = settingFor(kernel, name);
  let next = value;
  if (setting) {
    try {
      next = await sanitizeSettingValue(kernel, setting, value);
    } catch (error) {
      out.skipped.push({ name, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
  }
  await kernel.options.set(name, next);
  out.carried.push(name);
}

/** Settings that don't name content: before the import, so dates, folders and sizes follow them. */
async function carryOptions(
  kernel: Kernel,
  wp: Map<string, string>,
  out: WordPressMigrationResult['options'],
): Promise<void> {
  for (const [name, kind] of Object.entries(CARRIED_OPTIONS)) {
    if (kind === 'post' || kind === 'term') continue;
    const raw = wp.get(name);
    if (raw === undefined || (raw === '' && kind !== 'string' && kind !== 'bool')) continue;
    if (raw === '' && (name === 'blogname' || name.endsWith('_format'))) continue;
    const value = convert(kind, raw);
    if (value === undefined) {
      out.skipped.push({ name, reason: `“${raw}” isn’t a number.` });
      continue;
    }
    await setOption(kernel, name, value, out);
  }

  // The time zone: a city (timezone_string), else a UTC offset (gmt_offset) as Etc/GMT±N.
  const zone = wp.get('timezone_string') ?? '';
  const offset = Number(wp.get('gmt_offset') ?? '');
  if (zone && validTimeZone(zone)) {
    await setOption(kernel, 'timezone_string', zone, out);
  } else if (Number.isInteger(offset) && Math.abs(offset) <= 14) {
    // POSIX zone names have the sign the other way round: UTC+2 is Etc/GMT-2.
    const name = offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
    await setOption(kernel, 'timezone_string', name, out);
  } else if (zone || wp.get('gmt_offset')) {
    out.skipped.push({
      name: 'timezone_string',
      reason: `The time zone (${zone || `UTC${offset >= 0 ? '+' : ''}${wp.get('gmt_offset')}`}) has no IANA name; choose one in Settings → General.`,
    });
  }

  // WPLANG: '' means English (United States); other languages must be installed here.
  const locale = wp.get('WPLANG') || 'en_US';
  if (locale === 'en_US' || kernel.i18n.getAvailableLanguages().includes(locale)) {
    await setOption(kernel, 'locale', locale, out);
  } else {
    out.skipped.push({
      name: 'WPLANG',
      reason: `The language ${locale} isn’t installed here. Install it, then choose it in Settings → General.`,
    });
  }

  const permalinks: Record<string, string> = {};
  for (const name of ['permalink_structure', 'category_base', 'tag_base']) {
    const value = wp.get(name);
    if (value !== undefined) permalinks[name] = value;
  }
  const saved = await savePermalinkSettings(kernel, permalinks);
  if (saved.ok) out.carried.push(...Object.keys(permalinks));
  else {
    for (const [name, reason] of Object.entries(saved.params)) out.skipped.push({ name, reason });
  }
}

/** Settings that name a page or a category: after the import, with the new IDs. */
async function carryMappedOptions(
  kernel: Kernel,
  writer: ImportWriter,
  wp: Map<string, string>,
  out: WordPressMigrationResult['options'],
): Promise<void> {
  for (const [name, kind] of Object.entries(CARRIED_OPTIONS)) {
    if (kind !== 'post' && kind !== 'term') continue;
    const old = Number.parseInt(wp.get(name) ?? '', 10);
    if (!old) continue;
    const mapped = kind === 'post' ? writer.postId(old) : writer.termId(old);
    if (!mapped) {
      out.skipped.push({
        name,
        reason: `What it pointed to (ID ${old}) wasn’t migrated.`,
      });
      continue;
    }
    await setOption(kernel, name, mapped, out);
  }
}
