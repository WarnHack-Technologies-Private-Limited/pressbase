import { readFileSync, realpathSync, statSync } from 'node:fs';
import {
  CONTEXT_GLUE,
  parseTranslationFile,
  type TranslationEntries,
  type TranslationFile,
} from './translation-file';

/**
 * Loaded translations per locale and text domain — a port of
 * WP_Translation_Controller (wordpress/wp-includes/l10n/class-wp-translation-controller.php).
 *
 * WordPress keeps one controller per PHP request. Pressbase serves many
 * requests at once in several languages, so translations are keyed by
 * locale as WordPress's controller already is, and the locale is always
 * passed in. Several files can serve one domain; the first that has a
 * string wins (WP_Translation_Controller::locate_translation()).
 *
 * Parsed files are cached by path and modification time, so reloading a
 * domain after a language pack update reads only what changed.
 */

interface CachedFile {
  mtimeMs: number;
  size: number;
  file: TranslationFile | null;
  error?: string;
}

const parsed = new Map<string, CachedFile>();

/**
 * Reads and parses a translation file, cached until it changes on disk.
 * Returns null when it doesn't exist or can't be parsed.
 */
export function readTranslationFile(file: string): TranslationFile | null {
  let real: string;
  let stat: { mtimeMs: number; size: number; isFile(): boolean };
  try {
    real = realpathSync(file);
    stat = statSync(real);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const cached = parsed.get(real);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.file;
  let result: CachedFile;
  try {
    result = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      file: parseTranslationFile(readFileSync(real), real),
    };
  } catch (error) {
    result = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      file: null,
      error: error instanceof Error ? error.message : String(error),
    };
    console.warn(`Could not read the translation file ${real}: ${result.error}`);
  }
  parsed.set(real, result);
  return result.file;
}

export interface LocatedTranslation {
  entries: string[];
  source: TranslationFile;
}

export class TranslationController {
  /** locale → domain → files, in lookup order. */
  #loaded = new Map<string, Map<string, TranslationFile[]>>();

  #files(domain: string, locale: string): TranslationFile[] {
    return this.#loaded.get(locale)?.get(domain) ?? [];
  }

  /** WP_Translation_Controller::load_file(). Synchronous: translation must be. */
  loadFile(path: string, domain: string, locale: string): boolean {
    const file = readTranslationFile(path);
    if (!file) return false;
    let domains = this.#loaded.get(locale);
    if (!domains) {
      domains = new Map();
      this.#loaded.set(locale, domains);
    }
    const files = domains.get(domain) ?? [];
    if (files.some((f) => f.file === file.file)) return true;
    domains.set(domain, [...files, file]);
    return true;
  }

  /** Adds translations built in memory (tests, plugins that bring their own). */
  addFile(file: TranslationFile, domain: string, locale: string): void {
    let domains = this.#loaded.get(locale);
    if (!domains) {
      domains = new Map();
      this.#loaded.set(locale, domains);
    }
    domains.set(domain, [...(domains.get(domain) ?? []), file]);
  }

  /** WP_Translation_Controller::unload_textdomain(): one locale, or every locale. */
  unloadTextdomain(domain: string, locale?: string): boolean {
    let unloaded = false;
    for (const [l, domains] of this.#loaded) {
      if (locale !== undefined && l !== locale) continue;
      if (domains.delete(domain)) unloaded = true;
    }
    return unloaded;
  }

  /** Forgets every domain of a locale (after its language pack changed). */
  unloadLocale(locale: string): void {
    this.#loaded.delete(locale);
  }

  isTextdomainLoaded(domain: string, locale: string): boolean {
    return this.#files(domain, locale).length > 0;
  }

  /** WP_Translation_Controller::locate_translation() */
  locate(key: string, domain: string, locale: string): LocatedTranslation | false {
    for (const file of this.#files(domain, locale)) {
      const entries = file.entries.get(key);
      if (entries) return { entries, source: file };
    }
    return false;
  }

  /** WP_Translation_Controller::translate() */
  translate(text: string, context: string, domain: string, locale: string): string | false {
    const found = this.locate(context ? `${context}${CONTEXT_GLUE}${text}` : text, domain, locale);
    return found ? (found.entries[0] as string) : false;
  }

  /** WP_Translation_Controller::translate_plural() */
  translatePlural(
    plurals: [string, string],
    n: number,
    context: string,
    domain: string,
    locale: string,
  ): string | false {
    const prefix = context ? `${context}${CONTEXT_GLUE}` : '';
    const found =
      this.locate(`${prefix}${plurals.join('\0')}`, domain, locale) ||
      this.locate(`${prefix}${plurals[0]}`, domain, locale);
    if (!found) return false;
    const index = found.source.pluralForm(n);
    return found.entries[index] ?? (found.entries[0] as string);
  }

  /** WP_Translation_Controller::get_headers(): later files' headers win, as there. */
  headers(domain: string, locale: string): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const file of this.#files(domain, locale)) Object.assign(headers, file.headers);
    return headers;
  }

  /** Every entry of a domain; the first file with a key wins, as lookups do. */
  entries(domain: string, locale: string): TranslationEntries {
    const out: TranslationEntries = new Map();
    for (const file of this.#files(domain, locale)) {
      for (const [key, value] of file.entries) if (!out.has(key)) out.set(key, value);
    }
    return out;
  }

  /** The files serving a domain, in lookup order. */
  files(domain: string, locale: string): readonly TranslationFile[] {
    return this.#files(domain, locale);
  }
}
