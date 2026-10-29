import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { readZip, writeEntries, type ZipEntry, ZipError } from '../files/zip';
import type { Kernel } from '../kernel';
import { maxUploadBytes } from '../media/service';
import { readFileHeaders, THEME_HEADERS } from './file-headers';

/**
 * Installing and deleting themes: Theme_Upgrader::install() with
 * check_package() (wordpress/wp-admin/includes/class-theme-upgrader.php,
 * class-wp-upgrader.php), and delete_theme() (wp-admin/includes/theme.php).
 * Used through `kernel.themes.install()` / `kernel.themes.delete()`.
 *
 * Differences from WordPress, documented in docs/architecture/themes.md:
 * - only block themes are accepted (Pressbase never runs PHP);
 * - the folder name is sanitised to the characters Pressbase allows in a
 *   theme's folder name;
 * - themes bundled with Pressbase (the repository's read-only `themes/`
 *   folder) can't be deleted.
 */

declare module '@pressbase/hooks' {
  interface ActionRegistry {
    /**
     * WordPress fires it with the WP_Upgrader instance; Pressbase has none
     * and passes null. `themes` lists the stylesheets that were installed.
     */
    upgrader_process_complete: [
      upgrader: null,
      hookExtra: { action: 'install'; type: 'theme'; themes: string[] },
    ];
    /** After an upload replaced an installed theme (`overwrite`). */
    upgrader_overwrote_package: [
      packageName: string,
      newThemeData: UploadedThemeData,
      packageType: 'theme',
    ];
    delete_theme: [stylesheet: string];
    deleted_theme: [stylesheet: string, deleted: boolean];
  }
}

export class ThemeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 500 = 400,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The headers check_package() reads, as Theme_Installer_Skin::do_overwrite() compares them. */
export interface UploadedThemeData {
  Name: string;
  Version: string;
  Author: string;
  Template: string;
  RequiresWP: string;
  RequiresPHP: string;
}

export interface ThemeSummary {
  stylesheet: string;
  name: string;
  version: string;
  author: string;
  template: string;
  source: 'bundled' | 'site';
}

/** Largest theme archive accepted: the upload limit, at most 32 MB, as for plugins. */
export function maxThemeBytes(kernel: Kernel): number {
  return Math.min(maxUploadBytes(kernel), 32 * 1024 * 1024);
}

/**
 * The folder name for a theme: sanitize_file_name() (wp-includes/formatting.php),
 * then limited to what Pressbase accepts in a theme's folder name
 * (`[A-Za-z0-9_-]`): accents are dropped and anything else becomes a dash.
 */
export function sanitizeThemeSlug(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize_file_name() removes chr(0).
  const special = /[?[\]/\\=<>:;,'"&$#*()|~`!{}%+’«»”“\u0000]/g;
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(special, '')
    .replace(/%20|\+/g, '-')
    .replace(/[\r\n\t -]+/g, '-')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 200);
}

/**
 * Where the theme sits in the archive, as WP_Upgrader::install_package()
 * decides: when everything is inside one top-level folder, that folder's
 * contents (and its name); otherwise the archive's root.
 */
export function themeArchiveRoot(entries: readonly ZipEntry[]): { prefix: string; folder: string } {
  const tops = new Set(entries.map((e) => e.name.split('/')[0] ?? ''));
  const [top] = tops;
  if (tops.size === 1 && top && entries.every((e) => e.name.includes('/'))) {
    return { prefix: `${top}/`, folder: top };
  }
  return { prefix: '', folder: '' };
}

const BLOCK_INDEX = ['templates/index.html', 'block-templates/index.html'];

export interface CheckedThemePackage {
  files: ZipEntry[];
  data: UploadedThemeData;
  /** The folder name it would be installed in. */
  stylesheet: string;
}

/**
 * check_package(): the archive is a valid, safe ZIP holding a block theme
 * with a `style.css` that names it. Throws ThemeError with WordPress's codes.
 */
export function checkThemePackage(
  zip: Uint8Array,
  options: { maxBytes: number; filename?: string },
): CheckedThemePackage {
  if (zip.byteLength > options.maxBytes) {
    throw new ThemeError(
      'rest_upload_file_too_big',
      `This file is too big. Theme archives must be smaller than ${Math.round(options.maxBytes / 1024 / 1024)} MB.`,
      413,
    );
  }
  let entries: ZipEntry[];
  try {
    entries = readZip(zip, { maxTotalBytes: options.maxBytes * 4 });
  } catch (error) {
    if (error instanceof ZipError) throw new ThemeError(error.code, error.message);
    throw error;
  }
  if (!entries.length) {
    throw new ThemeError(
      'incompatible_archive_empty',
      'The package could not be installed. The package contains no files.',
    );
  }

  const { prefix, folder } = themeArchiveRoot(entries);
  const files = entries
    .filter((e) => e.name.startsWith(prefix))
    .map((e) => ({ name: e.name.slice(prefix.length), data: e.data }));
  const has = (name: string) => files.some((f) => f.name === name);

  const style = files.find((f) => f.name === 'style.css');
  if (!style) {
    throw new ThemeError(
      'incompatible_archive_theme_no_style',
      'The package could not be installed. The theme is missing the style.css stylesheet.',
    );
  }
  const headers = readFileHeaders(Buffer.from(style.data).toString('utf8'), THEME_HEADERS);
  if (!headers.name) {
    throw new ThemeError(
      'incompatible_archive_theme_no_name',
      'The package could not be installed. The style.css stylesheet does not contain a valid theme header.',
    );
  }
  const data: UploadedThemeData = {
    Name: headers.name,
    Version: headers.version,
    Author: headers.author,
    Template: headers.template,
    RequiresWP: headers.requiresWp,
    RequiresPHP: headers.requiresPhp,
  };

  if (!BLOCK_INDEX.some(has)) {
    // Pressbase renders block themes only. WordPress would also accept a
    // classic theme (index.php), or a child theme with neither file.
    if (has('index.php')) {
      throw new ThemeError(
        'pressbase_theme_not_block_theme',
        `${data.Name} is a classic theme: it has index.php but no templates/index.html. Pressbase only runs block themes, which build their pages from HTML templates.`,
      );
    }
    throw new ThemeError(
      'incompatible_archive_theme_no_index',
      data.Template
        ? 'The package could not be installed. Template is missing: Pressbase needs a templates/index.html template file in every theme, child themes included.'
        : 'The package could not be installed. Template is missing: block themes need a templates/index.html template file.',
    );
  }

  const fromFile = options.filename ? path.basename(options.filename).replace(/\.zip$/i, '') : '';
  const stylesheet = sanitizeThemeSlug(folder || fromFile || data.Name);
  if (!stylesheet) {
    throw new ThemeError(
      'incompatible_archive',
      'The package could not be installed. Its folder name has no letters or numbers to name the theme after.',
    );
  }
  return { files, data, stylesheet };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

const hex = () => randomBytes(6).toString('hex');

/**
 * Unpacks the files into `<themesDir>/<stylesheet>` through a hidden staging
 * folder and a rename, so a half-written theme is never discovered. With
 * `replace`, an existing folder is moved aside first and removed once the new
 * one is in place (and moved back if that fails).
 */
export async function unpackTheme(
  themesDir: string,
  stylesheet: string,
  files: readonly ZipEntry[],
  replace: boolean,
): Promise<void> {
  await mkdir(themesDir, { recursive: true });
  const target = path.join(themesDir, stylesheet);
  const staging = path.join(themesDir, `.upload-${hex()}`);
  try {
    await writeEntries(staging, files);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof ZipError) throw new ThemeError(error.code, error.message);
    throw error;
  }
  const hadTarget = await exists(target);
  if (hadTarget && !replace) {
    await rm(staging, { recursive: true, force: true });
    throw new ThemeError('folder_exists', 'Destination folder already exists.', 409);
  }
  const aside = path.join(themesDir, `.replaced-${hex()}`);
  try {
    if (hadTarget) await rename(target, aside);
    try {
      await rename(staging, target);
    } catch (error) {
      if (hadTarget) await rename(aside, target);
      throw error;
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  if (hadTarget) await rm(aside, { recursive: true, force: true });
}

/** Locale part of a translation file name: de_DE, pt_BR_formal, ast… */
const LOCALE = '[a-z]{2,3}(?:_[A-Z]{2})?(?:_[A-Za-z0-9]+)?';

/**
 * delete_theme() also removes the theme's translations from
 * `languages/themes` ({stylesheet}-{locale}.po/.mo/.l10n.php and the
 * -{hash}.json files). Silently, as WordPress does.
 */
export async function removeThemeTranslations(
  languagesDir: string,
  stylesheet: string,
): Promise<void> {
  const dir = path.join(languagesDir, 'themes');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const escaped = stylesheet.replace(/[-_]/g, '\\$&');
  const pattern = new RegExp(
    `^${escaped}-${LOCALE}(?:\\.(?:po|mo|l10n\\.php)|-[0-9a-f]{32}\\.json)$`,
  );
  await Promise.all(
    names
      .filter((name) => pattern.test(name))
      .map((name) => rm(path.join(dir, name), { force: true }).catch(() => {})),
  );
}
