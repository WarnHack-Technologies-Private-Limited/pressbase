/**
 * Languages, from core's /pressbase/v1/languages: what's installed (for the
 * Site language and Profile language selects) and WordPress.org's packs.
 */

export interface InstalledLanguage {
  language: string;
  english_name: string;
  native_name: string;
  dir: 'ltr' | 'rtl';
  /** WordPress's own translation (a core language pack) is installed. */
  wordpress: boolean;
}

export interface Languages {
  site_language: string;
  installed: InstalledLanguage[];
  can_install: boolean;
}

export interface AvailableLanguage {
  language: string;
  english_name: string;
  native_name: string;
  version: string;
  updated: string;
  installed: boolean;
}

export interface InstallResult {
  language: string;
  core: boolean;
  themes: string[];
  skipped: { slug: string; reason: string }[];
  installed: InstalledLanguage[];
}

/** "Deutsch (German)", or the one name when they're the same. */
export function languageLabel(language: Pick<InstalledLanguage, 'english_name' | 'native_name'>) {
  return language.native_name === language.english_name
    ? language.native_name
    : `${language.native_name} (${language.english_name})`;
}

/** WordPress.org's packs that aren't installed yet, by English name. */
export function installable(available: AvailableLanguage[], installed: InstalledLanguage[]) {
  const have = new Set(installed.filter((l) => l.wordpress).map((l) => l.language));
  return available
    .filter((l) => !have.has(l.language) && !l.installed)
    .sort((a, b) => a.english_name.localeCompare(b.english_name));
}
