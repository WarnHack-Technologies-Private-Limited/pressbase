import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readZip, ZipError } from '../files/zip';
import type { Kernel } from '../kernel';
import { isLocale, languageNames } from './locale';

/**
 * Language packs from WordPress.org — a port of translations_api(),
 * wp_get_available_translations() and wp_download_language_pack()
 * (wordpress/wp-admin/includes/translation-install.php) with the parts of
 * Language_Pack_Upgrader they use.
 *
 * Installing a language is an explicit action of a user with
 * `install_languages`; nothing is downloaded in the background. A core pack
 * holds WordPress's translations (`de_DE.mo`, `admin-de_DE.mo`) and the
 * block editor's script translations (`de_DE-{md5}.json`). Themes from
 * WordPress.org have packs too (they go to `languages/themes`).
 * Only `.mo`, `.po` and `.json` files are written: Pressbase never runs the
 * packs' `.l10n.php` files.
 */

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    translations_api: [
      result: false | TranslationsApiResult,
      type: TranslationType,
      args: { version: string; slug?: string },
    ];
    translations_api_result: [
      result: TranslationsApiResult,
      type: TranslationType,
      args: { version: string; slug?: string },
    ];
  }
  interface ActionRegistry {
    /** A language pack was installed (WordPress fires upgrader_process_complete). */
    pressbase_language_pack_installed: [
      language: string,
      type: TranslationType,
      slug: string | null,
    ];
  }
}

/**
 * The WordPress release whose translations match the bundled block editor
 * packages (and the reference copy Pressbase is ported from). Bump it with
 * the `@wordpress/*` packages.
 */
export const WORDPRESS_TRANSLATIONS_VERSION = '7.1.3';

const API = 'https://api.wordpress.org/translations';
/** Packages are only downloaded from WordPress.org. */
const PACKAGE_HOSTS = new Set(['downloads.wordpress.org']);
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
/** Files a pack may contain that Pressbase keeps: flat names, translation formats only. */
const PACK_FILE = /^[A-Za-z0-9_.@-]+\.(?:mo|po|json)$/;
/** WordPress caches the list for three hours (the `available_translations` site transient). */
const CACHE_SECONDS = 3 * 60 * 60;

/** The slice of fetch() language packs use (typed here so the plugin SDK needs no DOM types). */
export interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type HttpFetch = (
  url: URL,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<HttpResponse>;

export type TranslationType = 'core' | 'themes' | 'plugins';

export interface AvailableTranslation {
  language: string;
  version: string;
  updated: string;
  english_name: string;
  native_name: string;
  package: string;
  iso: Record<string, string>;
  strings?: { continue?: string };
}

export interface TranslationsApiResult {
  translations: AvailableTranslation[];
}

export class LanguagePackError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface InstallResult {
  language: string;
  /** Whether WordPress's core pack was downloaded (false when it was already installed). */
  core: boolean;
  /** Themes whose translations were installed. */
  themes: string[];
  /** Themes without a pack for this language, or whose download failed, with the reason. */
  skipped: { slug: string; reason: string }[];
}

export class LanguagePacks {
  /**
   * The HTTP client. Tests replace it; nothing else should. Requests go to
   * api.wordpress.org and downloads.wordpress.org only.
   */
  fetch: HttpFetch = (url, init) =>
    globalThis.fetch(url, init as never) as unknown as Promise<HttpResponse>;

  constructor(private readonly kernel: Kernel) {}

  /** translations_api() */
  async translationsApi(
    type: TranslationType,
    args: { version: string; slug?: string },
  ): Promise<TranslationsApiResult> {
    const hooks = this.kernel.hooks;
    const pre = await hooks.applyFilters('translations_api', false, type, args);
    let result: TranslationsApiResult;
    if (pre !== false) {
      result = pre;
    } else {
      const url = new URL(`${API}/${type}/1.0/`);
      url.searchParams.set('version', args.version);
      if (type !== 'core' && args.slug) url.searchParams.set('slug', args.slug);
      url.searchParams.set('locale', this.kernel.i18n.getLocale());
      let response: HttpResponse;
      try {
        response = await this.fetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        throw new LanguagePackError(
          'translations_api_failed',
          /* translators: %s: the network error. */
          this.kernel.i18n
            .__('WordPress.org couldn’t be reached: %s', 'pressbase')
            .replace('%s', error instanceof Error ? error.message : String(error)),
          502,
        );
      }
      const body = (await response.json().catch(() => null)) as TranslationsApiResult | null;
      if (!response.ok || !body || !Array.isArray(body.translations)) {
        throw new LanguagePackError(
          'translations_api_failed',
          this.kernel.i18n.__(
            'WordPress.org sent an unexpected answer. Try again later.',
            'pressbase',
          ),
          502,
        );
      }
      result = body;
    }
    return hooks.applyFilters('translations_api_result', result, type, args);
  }

  /**
   * wp_get_available_translations(): core packs by language, cached for
   * three hours in the `_site_transient_available_translations` option.
   */
  async available(): Promise<Record<string, AvailableTranslation>> {
    const options = this.kernel.options;
    const timeout = await options.get<number>('_site_transient_timeout_available_translations', 0);
    const cached = await options.get<Record<string, AvailableTranslation> | null>(
      '_site_transient_available_translations',
      null,
    );
    if (cached && timeout > Date.now() / 1000) return cached;
    const api = await this.translationsApi('core', { version: WORDPRESS_TRANSLATIONS_VERSION });
    const translations: Record<string, AvailableTranslation> = {};
    for (const translation of api.translations) {
      if (translation && isLocale(String(translation.language))) {
        translations[translation.language] = translation;
      }
    }
    await options.set('_site_transient_available_translations', translations, { autoload: false });
    await options.set(
      '_site_transient_timeout_available_translations',
      Math.floor(Date.now() / 1000) + CACHE_SECONDS,
      { autoload: false },
    );
    return translations;
  }

  /** Downloads a pack and writes its translation files into `dir`. */
  async #installPackage(packageUrl: string, dir: string): Promise<string[]> {
    let url: URL;
    try {
      url = new URL(packageUrl);
    } catch {
      throw new LanguagePackError(
        'download_failed',
        this.kernel.i18n.__('The language pack’s address is invalid.', 'pressbase'),
      );
    }
    if (url.protocol !== 'https:' || !PACKAGE_HOSTS.has(url.hostname)) {
      throw new LanguagePackError(
        'download_failed',
        this.kernel.i18n.__(
          'Language packs are only downloaded from downloads.wordpress.org.',
          'pressbase',
        ),
      );
    }
    let response: HttpResponse;
    try {
      response = await this.fetch(url, { signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      throw new LanguagePackError(
        'download_failed',
        /* translators: %s: the network error. */
        this.kernel.i18n
          .__('The language pack couldn’t be downloaded: %s', 'pressbase')
          .replace('%s', error instanceof Error ? error.message : String(error)),
        502,
      );
    }
    if (!response.ok) {
      throw new LanguagePackError(
        'download_failed',
        /* translators: %d: an HTTP status code. */
        this.kernel.i18n
          .__('The language pack couldn’t be downloaded (HTTP %d).', 'pressbase')
          .replace('%d', String(response.status)),
        502,
      );
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_PACKAGE_BYTES) {
      throw new LanguagePackError(
        'download_failed',
        this.kernel.i18n.__('The language pack is too large.', 'pressbase'),
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PACKAGE_BYTES) {
      throw new LanguagePackError(
        'download_failed',
        this.kernel.i18n.__('The language pack is too large.', 'pressbase'),
      );
    }
    let entries: ReturnType<typeof readZip>;
    try {
      entries = readZip(bytes, { maxEntries: 2000, maxTotalBytes: 200 * 1024 * 1024 });
    } catch (error) {
      throw new LanguagePackError(
        'incompatible_archive',
        error instanceof ZipError
          ? error.message
          : this.kernel.i18n.__('The language pack isn’t a valid .zip file.', 'pressbase'),
      );
    }
    await mkdir(dir, { recursive: true });
    const written: string[] = [];
    for (const entry of entries) {
      if (entry.name.includes('/') || !PACK_FILE.test(entry.name)) continue;
      const target = path.join(dir, entry.name);
      // Written next to the target, then renamed: a reader never sees half a file.
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, entry.data);
      await rename(temporary, target);
      written.push(entry.name);
    }
    if (!written.some((name) => name.endsWith('.mo') || name.endsWith('.json'))) {
      throw new LanguagePackError(
        'incompatible_archive',
        this.kernel.i18n.__('The language pack holds no translation files.', 'pressbase'),
      );
    }
    return written;
  }

  /**
   * wp_download_language_pack(), then the language's packs for installed
   * themes from WordPress.org (Language_Pack_Upgrader's theme updates).
   */
  async install(language: string): Promise<InstallResult> {
    if (!isLocale(language) || language === 'en_US') {
      throw new LanguagePackError(
        'invalid_language',
        this.kernel.i18n.__('Choose a language from the list.', 'pressbase'),
      );
    }
    const i18n = this.kernel.i18n;
    const result: InstallResult = { language, core: false, themes: [], skipped: [] };
    if (!i18n.hasCorePack(language)) {
      const translation = (await this.available())[language];
      if (!translation) {
        throw new LanguagePackError(
          'language_not_available',
          this.kernel.i18n.__('WordPress.org has no translation for that language.', 'pressbase'),
          404,
        );
      }
      await this.#installPackage(translation.package, i18n.languagesDir);
      result.core = true;
      await this.kernel.hooks.doAction('pressbase_language_pack_installed', language, 'core', null);
    }
    for (const theme of await this.kernel.themes.all()) {
      // Bundled themes aren't on WordPress.org: their translations ship with Pressbase.
      if (!theme.version || theme.source === 'bundled') continue;
      try {
        const api = await this.translationsApi('themes', {
          slug: theme.stylesheet,
          version: theme.version,
        });
        const pack = api.translations.find((t) => t?.language === language);
        if (!pack) {
          result.skipped.push({
            slug: theme.stylesheet,
            reason: this.kernel.i18n.__('No translation for this language.', 'pressbase'),
          });
          continue;
        }
        await this.#installPackage(pack.package, path.join(i18n.languagesDir, 'themes'));
        result.themes.push(theme.stylesheet);
        await this.kernel.hooks.doAction(
          'pressbase_language_pack_installed',
          language,
          'themes',
          theme.stylesheet,
        );
      } catch (error) {
        result.skipped.push({
          slug: theme.stylesheet,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    i18n.reloadLocale(language);
    // Patterns are translated when the theme loads; the site's pages may change.
    if (language === i18n.getLocale()) {
      await this.kernel.themes.reload();
      await this.kernel.hooks.doAction('pressbase_cache_purge', ['site'], 'language_pack');
    }
    return result;
  }
}

/** The installed languages, with their names, for language selects (wp_dropdown_languages()). */
export async function installedLanguages(
  kernel: Kernel,
  available: Record<string, AvailableTranslation> | null,
) {
  const i18n = kernel.i18n;
  return ['en_US', ...i18n.getAvailableLanguages()].map((language) => {
    const known = available?.[language];
    const names = languageNames(language);
    return {
      language,
      english_name: known?.english_name ?? names.english,
      native_name: known?.native_name ?? names.native,
      dir: i18n.isRtl(language) ? ('rtl' as const) : ('ltr' as const),
      /** Whether WordPress's own translation (core pack) is installed. */
      wordpress: language === 'en_US' || i18n.hasCorePack(language),
    };
  });
}
