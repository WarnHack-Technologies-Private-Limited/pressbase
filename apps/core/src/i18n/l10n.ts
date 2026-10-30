import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escAttr, escHtml } from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { CurrentUser } from '../auth/users';
import type { Kernel } from '../kernel';
import { readTranslationFile, TranslationController } from './controller';
import { LanguagePacks } from './language-packs';
import {
  type DateWords,
  dateWords,
  ENGLISH_DATE_WORDS,
  isLocale,
  isRtlLanguage,
  sanitizeLocaleName,
} from './locale';
import {
  CONTEXT_GLUE,
  type JedLocaleData,
  parseJed,
  parsePoEntries,
  type TranslationEntries,
  type TranslationFile,
} from './translation-file';

/**
 * Internationalisation: Pressbase's wp-includes/l10n.php (with the text
 * domain registry, WP_Textdomain_Registry, and the locale functions).
 * `kernel.i18n` loads translation files and translates strings:
 *
 *   kernel.i18n.__('Posts')                        // WordPress's `default` domain
 *   kernel.i18n._x('Read', 'verb', 'my-plugin')
 *   kernel.i18n._n('%s comment', '%s comments', 3, 'pressbase')
 *
 * Translating is synchronous, as in WordPress: files are read on first use
 * of a domain in a locale (just in time) and kept in memory.
 *
 * Unlike PHP, one process serves requests in different languages at once,
 * so "the current locale" travels with each request in AsyncLocalStorage
 * (`withLocale()`); outside a request it's the site's locale. See
 * docs/architecture/i18n.md.
 */

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    gettext: [translation: string, text: string, domain: string];
    gettext_with_context: [translation: string, text: string, context: string, domain: string];
    ngettext: [translation: string, single: string, plural: string, number: number, domain: string];
    ngettext_with_context: [
      translation: string,
      single: string,
      plural: string,
      number: number,
      context: string,
      domain: string,
    ];
    locale: [locale: string];
    pre_determine_locale: [locale: string | null];
    determine_locale: [locale: string];
    override_load_textdomain: [
      override: boolean,
      domain: string,
      mofile: string,
      locale: string | null,
    ];
    pre_load_textdomain: [
      loaded: boolean | null,
      domain: string,
      mofile: string,
      locale: string | null,
    ];
    load_textdomain_mofile: [mofile: string, domain: string];
    load_translation_file: [file: string, domain: string, locale: string];
    override_unload_textdomain: [override: boolean, domain: string, reloadable: boolean];
    get_available_languages: [languages: string[], dir: string | null];
    pre_load_script_translations: [
      translations: string | null,
      file: string,
      handle: string,
      domain: string,
    ];
    load_script_translation_file: [file: string, handle: string, domain: string];
    load_script_translations: [translations: string, file: string, handle: string, domain: string];
  }
  interface ActionRegistry {
    load_textdomain: [domain: string, mofile: string];
    unload_textdomain: [domain: string, reloadable: boolean];
  }
}

/** Pressbase's text domains: the server's own strings, and the admin's. */
export const CORE_DOMAIN = 'pressbase';
export const ADMIN_DOMAIN = 'pressbase-admin';

/**
 * Pressbase's domains borrow WordPress's translations: a string the
 * Pressbase translation doesn't have is looked up, unchanged, in the
 * `default` domain of the installed WordPress language pack. Many of
 * Pressbase's strings are WordPress's ("Posts", "Save Changes", "Site Language").
 */
const FALLBACK_DOMAINS: Record<string, string> = {
  [CORE_DOMAIN]: 'default',
  [ADMIN_DOMAIN]: 'default',
};

/** The repository's `languages/` folder: Pressbase's own translations and templates. */
export const BUNDLED_LANGUAGES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../languages',
);

/** `{locale}-{md5}.json`: a core language pack's script translations. */
const SCRIPT_JSON = /^([a-z]{2,3}(?:_[A-Z]{2})?(?:_[a-z0-9]+)?)-([0-9a-f]{32})\.json$/;

/** Script translations Gutenberg's packages need: the editor's scripts in wp-includes/js/dist. */
const EDITOR_SCRIPTS = /^wp-includes\/js\/dist\//;

/** Contexts in the core `.mo` the block editor needs too: block metadata is translated by the server in WordPress. */
const EDITOR_CONTEXTS =
  /^(?:block (?:title|description|keyword|style label|variation title|variation description|variation keyword|pattern category)|text direction)$/;

function readDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export interface RequestLocaleInput {
  user: CurrentUser | null;
  /** The request's query string values. */
  query: Record<string, string | undefined>;
}

export class I18n {
  readonly controller = new TranslationController();
  /** Language packs from WordPress.org (translation-install.php). */
  readonly packs: LanguagePacks;
  #storage = new AsyncLocalStorage<string>();
  #siteLocale = 'en_US';
  /** load_plugin_textdomain() / load_theme_textdomain() paths: domain → folders. */
  #customPaths = new Map<string, string[]>();
  /** locale|domain pairs tried just in time, so a missing file is looked for once. */
  #attempted = new Set<string>();
  /** unload_textdomain() without `reloadable`: never loaded just in time again. */
  #unloaded = new Set<string>();
  #warnedFilters = new Set<string>();
  /** Parsed `.pot` catalogues of Pressbase's domains. */
  #catalogues = new Map<string, string[]>();

  constructor(private readonly kernel: Kernel) {
    this.packs = new LanguagePacks(kernel);
    // Before the themes load on `init`: their patterns are translated as they register.
    kernel.hooks.addAction(
      'init',
      async () => {
        await this.refreshSiteLocale();
      },
      1,
    );
    kernel.hooks.addAction('updated_option', async (name, _old, value) => {
      if (name !== 'locale') return;
      this.#siteLocale = typeof value === 'string' && isLocale(value) ? value : 'en_US';
      // Theme patterns are translated when they're registered.
      if (kernel.state === 'ready') await kernel.themes.reload();
    });
    // The `language` setting (WPLANG): the `locale` option, an installed language.
    kernel.settings.register('language', {
      option: 'locale',
      schema: z.string().max(50),
      default: 'en_US',
      sanitize: (value) => {
        const locale = typeof value === 'string' && value ? value : 'en_US';
        if (locale !== 'en_US' && !this.getAvailableLanguages().includes(locale)) {
          throw new Error(this.__('That language isn’t installed. Install it first.', 'pressbase'));
        }
        return locale;
      },
    });
  }

  /** `<dataDir>/languages`: WordPress's wp-content/languages (WP_LANG_DIR). */
  get languagesDir(): string {
    return path.join(this.kernel.config.dataDir, 'languages');
  }

  /** Reads the `locale` option (WordPress's WPLANG) into memory. */
  async refreshSiteLocale(): Promise<void> {
    const value = await this.kernel.options.get<string>('locale', 'en_US');
    this.#siteLocale = typeof value === 'string' && isLocale(value) ? value : 'en_US';
  }

  #filterSync<T>(name: string, value: T, ...args: unknown[]): T {
    if (!this.kernel.hooks.hasFilter(name)) return value;
    try {
      return this.kernel.hooks.applyFiltersSync(name, value, ...(args as [])) as T;
    } catch (error) {
      if (!this.#warnedFilters.has(name)) {
        this.#warnedFilters.add(name);
        console.warn(`The "${name}" filter must be synchronous; it was skipped.`, error);
      }
      return value;
    }
  }

  // ---------------------------------------------------------------------------
  // Locales

  /** get_locale(): the site's language (the `locale` option), filtered by `locale`. */
  getLocale(): string {
    return this.#filterSync('locale', this.#siteLocale);
  }

  /** get_user_locale(): the user's `locale` meta, or the site's. */
  async getUserLocale(userId: number): Promise<string> {
    const [row] = await this.kernel.db
      .select({ value: schema.usermeta.value })
      .from(schema.usermeta)
      .where(and(eq(schema.usermeta.userId, userId), eq(schema.usermeta.key, 'locale')));
    const value = typeof row?.value === 'string' ? row.value : '';
    return value && isLocale(value) ? value : this.getLocale();
  }

  /**
   * determine_locale() for a REST request: the user's locale when the
   * request asks for it with `_locale=user` (as the block editor's
   * api-fetch and Pressbase's admin do), otherwise the site's.
   */
  async localeForRequest({ user, query }: RequestLocaleInput): Promise<string> {
    if (this.kernel.state !== 'ready') return 'en_US';
    const pre = await this.kernel.hooks.applyFilters('pre_determine_locale', null);
    if (pre && typeof pre === 'string') return pre;
    let locale: string | null = null;
    if (query.wp_lang && !user) {
      // wp-login.php's ?wp_lang=, for the login screen.
      const requested = sanitizeLocaleName(query.wp_lang);
      if (requested === 'en_US' || this.getAvailableLanguages().includes(requested)) {
        locale = requested;
      }
    } else if (query._locale === 'user' && user) {
      locale = await this.getUserLocale(user.id);
    }
    return this.kernel.hooks.applyFilters('determine_locale', locale ?? this.getLocale());
  }

  /** determine_locale(): the current request's locale, or the site's outside a request. */
  determineLocale(): string {
    return this.#storage.getStore() ?? this.getLocale();
  }

  /** Runs `fn` with another current locale (switch_to_locale() … restore_previous_locale()). */
  withLocale<T>(locale: string, fn: () => T): T {
    return this.#storage.run(locale, fn);
  }

  // ---------------------------------------------------------------------------
  // Translating

  #lookup(
    domain: string,
    locale: string,
    find: (domain: string) => string | false,
  ): string | false {
    this.#ensureLoaded(domain, locale);
    const found = find(domain);
    if (found !== false) return found;
    const fallback = FALLBACK_DOMAINS[domain];
    if (!fallback) return false;
    this.#ensureLoaded(fallback, locale);
    return find(fallback);
  }

  /** translate(): a string in `domain`, through the `gettext` filters. */
  translate(text: string, domain = 'default', locale = this.determineLocale()): string {
    const found = this.#lookup(domain, locale, (d) =>
      this.controller.translate(text, '', d, locale),
    );
    let translation = found === false ? text : found;
    translation = this.#filterSync('gettext', translation, text, domain);
    return this.#filterSync(`gettext_${domain}`, translation, text, domain);
  }

  /** translate_with_gettext_context() */
  translateWithContext(
    text: string,
    context: string,
    domain = 'default',
    locale = this.determineLocale(),
  ): string {
    const found = this.#lookup(domain, locale, (d) =>
      this.controller.translate(text, context, d, locale),
    );
    let translation = found === false ? text : found;
    translation = this.#filterSync('gettext_with_context', translation, text, context, domain);
    return this.#filterSync(`gettext_with_context_${domain}`, translation, text, context, domain);
  }

  /** __() */
  __(text: string, domain = 'default'): string {
    return this.translate(text, domain);
  }

  /** _x() */
  _x(text: string, context: string, domain = 'default'): string {
    return this.translateWithContext(text, context, domain);
  }

  /** _n(): the singular or plural form for `number`, in the language's plural rules. */
  _n(single: string, plural: string, number: number, domain = 'default'): string {
    return this.#plural(single, plural, number, '', domain);
  }

  /** _nx() */
  _nx(single: string, plural: string, number: number, context: string, domain = 'default'): string {
    return this.#plural(single, plural, number, context, domain);
  }

  #plural(single: string, plural: string, number: number, context: string, domain: string) {
    const locale = this.determineLocale();
    const found = this.#lookup(domain, locale, (d) =>
      this.controller.translatePlural([single, plural], number, context, d, locale),
    );
    let translation = found === false ? (number === 1 ? single : plural) : found;
    if (context) {
      translation = this.#filterSync(
        'ngettext_with_context',
        translation,
        single,
        plural,
        number,
        context,
        domain,
      );
      return this.#filterSync(
        `ngettext_with_context_${domain}`,
        translation,
        single,
        plural,
        number,
        context,
        domain,
      );
    }
    translation = this.#filterSync('ngettext', translation, single, plural, number, domain);
    return this.#filterSync(`ngettext_${domain}`, translation, single, plural, number, domain);
  }

  /** esc_html__() */
  esc_html__(text: string, domain = 'default'): string {
    return escHtml(this.translate(text, domain));
  }

  /** esc_attr__() */
  esc_attr__(text: string, domain = 'default'): string {
    return escAttr(this.translate(text, domain));
  }

  /** esc_html_x() */
  esc_html_x(text: string, context: string, domain = 'default'): string {
    return escHtml(this.translateWithContext(text, context, domain));
  }

  /** esc_attr_x() */
  esc_attr_x(text: string, context: string, domain = 'default'): string {
    return escAttr(this.translateWithContext(text, context, domain));
  }

  /** has_translation() */
  hasTranslation(text: string, domain = 'default', locale = this.determineLocale()): boolean {
    this.#ensureLoaded(domain, locale);
    return this.controller.locate(text, domain, locale) !== false;
  }

  // ---------------------------------------------------------------------------
  // Loading

  /**
   * load_textdomain(): adds a `.mo` file to a domain for a locale. Pressbase
   * also reads a `.po` file with the same name when there is no `.mo`.
   * Synchronous, like everything translation does.
   */
  loadTextdomain(domain: string, mofile: string, locale: string | null = null): boolean {
    const pre = this.#filterSync<boolean | null>(
      'pre_load_textdomain',
      null,
      domain,
      mofile,
      locale,
    );
    if (pre !== null) {
      if (pre === true) this.#unloaded.delete(domain);
      return pre;
    }
    if (this.#filterSync('override_load_textdomain', false, domain, mofile, locale)) {
      this.#unloaded.delete(domain);
      return true;
    }
    if (this.kernel.hooks.hasAction('load_textdomain')) {
      try {
        this.kernel.hooks.doActionSync('load_textdomain', domain, mofile);
      } catch (error) {
        console.warn('A load_textdomain callback failed.', error);
      }
    }
    const filtered = this.#filterSync('load_textdomain_mofile', mofile, domain);
    const target = locale ?? this.determineLocale();
    const candidates = filtered.endsWith('.mo')
      ? [filtered, `${filtered.slice(0, -3)}.po`]
      : [filtered];
    for (const candidate of candidates) {
      const file = this.#filterSync('load_translation_file', candidate, domain, target);
      if (this.controller.loadFile(file, domain, target)) {
        this.#unloaded.delete(domain);
        return true;
      }
    }
    return false;
  }

  /**
   * unload_textdomain(). With `reloadable`, the domain is loaded again just
   * in time on its next use.
   */
  unloadTextdomain(domain: string, reloadable = false): boolean {
    if (this.#filterSync('override_unload_textdomain', false, domain, reloadable)) {
      if (!reloadable) this.#unloaded.add(domain);
      return true;
    }
    if (this.kernel.hooks.hasAction('unload_textdomain')) {
      try {
        this.kernel.hooks.doActionSync('unload_textdomain', domain, reloadable);
      } catch (error) {
        console.warn('An unload_textdomain callback failed.', error);
      }
    }
    const unloaded = this.controller.unloadTextdomain(domain);
    for (const key of [...this.#attempted]) {
      if (key.endsWith(`|${domain}`)) this.#attempted.delete(key);
    }
    if (!reloadable) this.#unloaded.add(domain);
    return unloaded;
  }

  /** is_textdomain_loaded() */
  isTextdomainLoaded(domain: string, locale = this.determineLocale()): boolean {
    return this.controller.isTextdomainLoaded(domain, locale);
  }

  /**
   * load_plugin_textdomain() / load_theme_textdomain(): where a plugin's or
   * theme's own translations are (`{dir}/{domain}-{locale}.mo`). They load just
   * in time, after any in `languages/plugins` or `languages/themes`.
   * Returns a function that forgets the path again.
   */
  loadPluginTextdomain(domain: string, dir: string): () => void {
    return this.#addCustomPath(domain, dir);
  }

  loadThemeTextdomain(domain: string, dir: string): () => void {
    return this.#addCustomPath(domain, dir);
  }

  #addCustomPath(domain: string, dir: string): () => void {
    this.#customPaths.set(domain, [...(this.#customPaths.get(domain) ?? []), dir]);
    this.#reset(domain);
    return () => {
      const remaining = (this.#customPaths.get(domain) ?? []).filter((d) => d !== dir);
      if (remaining.length) this.#customPaths.set(domain, remaining);
      else this.#customPaths.delete(domain);
      this.controller.unloadTextdomain(domain);
      this.#reset(domain);
    };
  }

  /** A domain's files are looked for again on next use. */
  #reset(domain: string) {
    this.controller.unloadTextdomain(domain);
    for (const key of [...this.#attempted]) {
      if (key.endsWith(`|${domain}`)) this.#attempted.delete(key);
    }
  }

  /** Forgets everything loaded for a locale, after its files changed (a language pack was installed). */
  reloadLocale(locale: string): void {
    this.controller.unloadLocale(locale);
    for (const key of [...this.#attempted]) {
      if (key.startsWith(`${locale}|`)) this.#attempted.delete(key);
    }
  }

  /**
   * The files a domain loads from in a locale, in lookup order
   * (WP_Textdomain_Registry::get() and load_default_textdomain()).
   */
  textdomainFiles(domain: string, locale: string): string[] {
    const lang = this.languagesDir;
    if (domain === 'default') {
      // load_default_textdomain(): the core file, then the admin strings
      // (Pressbase has no separate admin request, so both are always loaded).
      return [path.join(lang, `${locale}.mo`), path.join(lang, `admin-${locale}.mo`)];
    }
    if (domain === ADMIN_DOMAIN) {
      return [
        path.join(lang, 'pressbase', `${domain}-${locale}.mo`),
        path.join(BUNDLED_LANGUAGES_DIR, `${domain}-${locale}.mo`),
      ];
    }
    if (domain === CORE_DOMAIN) {
      // The Pressbase theme shares the domain: its translations come after core's.
      return [
        path.join(lang, 'pressbase', `${domain}-${locale}.mo`),
        path.join(BUNDLED_LANGUAGES_DIR, `${domain}-${locale}.mo`),
        ...this.#themeAndPluginFiles(domain, locale),
      ];
    }
    return this.#themeAndPluginFiles(domain, locale);
  }

  #themeAndPluginFiles(domain: string, locale: string): string[] {
    const lang = this.languagesDir;
    return [
      path.join(lang, 'plugins', `${domain}-${locale}.mo`),
      path.join(lang, 'themes', `${domain}-${locale}.mo`),
      // A plugin's folder has `{domain}-{locale}.mo`; a theme's, `{locale}.mo`.
      ...(this.#customPaths.get(domain) ?? []).flatMap((dir) => [
        path.join(dir, `${domain}-${locale}.mo`),
        path.join(dir, `${locale}.mo`),
      ]),
    ];
  }

  /** _load_textdomain_just_in_time(), once per locale and domain. */
  #ensureLoaded(domain: string, locale: string): void {
    const key = `${locale}|${domain}`;
    if (this.#attempted.has(key)) return;
    this.#attempted.add(key);
    if (this.#unloaded.has(domain)) return;
    for (const file of this.textdomainFiles(domain, locale)) {
      this.loadTextdomain(domain, file, locale);
    }
  }

  // ---------------------------------------------------------------------------
  // Installed languages

  /**
   * get_available_languages(): the locales with a core translation in
   * `languages/` (`de_DE.mo`), plus those Pressbase itself is translated
   * into (`pressbase-admin-de_DE.po`, bundled or installed). `.po` files
   * count as well as `.mo`.
   */
  getAvailableLanguages(): string[] {
    const found = new Set<string>();
    const add = (name: string, prefix = '') => {
      const match = /^(.+)\.(?:mo|po)$/.exec(name);
      if (!match) return;
      const base = match[1] as string;
      if (prefix && !base.startsWith(prefix)) return;
      const locale = base.slice(prefix.length);
      if (isLocale(locale)) found.add(locale);
    };
    for (const name of readDir(this.languagesDir)) add(name);
    for (const dir of [path.join(this.languagesDir, 'pressbase'), BUNDLED_LANGUAGES_DIR]) {
      for (const name of readDir(dir)) add(name, `${ADMIN_DOMAIN}-`);
    }
    found.delete('en_US');
    return this.#filterSync('get_available_languages', [...found].sort(), null);
  }

  /**
   * wp_get_installed_translations(): textdomain → locale → the PO header
   * data (`PO-Revision-Date`, `Project-Id-Version`…) for `core`, `themes` or
   * `plugins`. Like WordPress, only translations with both a `.mo` and a `.po`.
   */
  getInstalledTranslations(
    type: 'core' | 'themes' | 'plugins',
  ): Record<string, Record<string, Record<string, string>>> {
    const dir = type === 'core' ? this.languagesDir : path.join(this.languagesDir, type);
    const out: Record<string, Record<string, Record<string, string>>> = {};
    for (const name of readDir(dir)) {
      const match = /^(?:(.+)-)?([a-z]{2,3}(?:_[A-Z]{2})?(?:_[a-z0-9]+)?)\.mo$/.exec(name);
      if (!match) continue;
      const domain = match[1] ?? 'default';
      const locale = match[2] as string;
      const po = path.join(dir, `${name.slice(0, -3)}.po`);
      if (!existsSync(po)) continue;
      const file = readTranslationFile(po);
      const headers = file?.headers ?? {};
      out[domain] ??= {};
      out[domain][locale] = {
        'POT-Creation-Date': headers['pot-creation-date'] ?? '',
        'PO-Revision-Date': headers['po-revision-date'] ?? '',
        'Project-Id-Version': headers['project-id-version'] ?? '',
        'X-Generator': headers['x-generator'] ?? '',
      };
    }
    return out;
  }

  /** Whether WordPress's core language pack for a locale is installed. */
  hasCorePack(locale: string): boolean {
    return ['mo', 'po'].some((ext) => existsSync(path.join(this.languagesDir, `${locale}.${ext}`)));
  }

  // ---------------------------------------------------------------------------
  // Language data

  /**
   * is_rtl(): WP_Locale reads the direction from the translation of "ltr"
   * (context "text direction"). Without any translation of it, a list of
   * right-to-left languages answers.
   */
  isRtl(locale = this.determineLocale()): boolean {
    for (const domain of ['default', ADMIN_DOMAIN]) {
      this.#ensureLoaded(domain, locale);
      const direction = this.controller.translate('ltr', 'text direction', domain, locale);
      if (direction !== false) return direction === 'rtl';
    }
    return isRtlLanguage(locale);
  }

  /** WP_Locale's month and weekday names in a locale (default: the current one), for wp_date(). */
  dateWords(locale = this.determineLocale()): DateWords {
    if (locale === 'en_US' && !this.kernel.hooks.hasFilter('gettext')) return ENGLISH_DATE_WORDS;
    return dateWords(
      (text) => this.translate(text, 'default', locale),
      (text, context) => this.translateWithContext(text, context, 'default', locale),
    );
  }

  /** WP_Locale's list item separator (", " in English). */
  listItemSeparator(locale = this.determineLocale()): string {
    return this.translate(', ', 'default', locale);
  }

  // ---------------------------------------------------------------------------
  // Translations for JavaScript

  /**
   * A domain's translations as Jed locale data for `@wordpress/i18n`'s
   * setLocaleData() (what wp_set_script_translations() prints).
   *
   * For Pressbase's own domains, `catalogue` lists the strings the source
   * uses (the domain's `.pot`); those the Pressbase translation lacks are
   * taken from WordPress's `default` domain when it has them unchanged.
   */
  jedLocaleData(domain: string, locale: string, catalogue?: Iterable<string>): JedLocaleData {
    this.#ensureLoaded(domain, locale);
    const entries: TranslationEntries = new Map(this.controller.entries(domain, locale));
    const headers = this.controller.headers(domain, locale);
    const fallback = FALLBACK_DOMAINS[domain];
    let pluralForms = headers['plural-forms'];
    if (fallback && catalogue) {
      this.#ensureLoaded(fallback, locale);
      for (const key of catalogue) {
        if (entries.has(key)) continue;
        const found = this.controller.locate(key, fallback, locale);
        if (found) {
          // WordPress's PHP strings are often printed as HTML (`&rsaquo;`,
          // `&#8217;`); the admin renders text, so entities are decoded.
          entries.set(key, key.includes('&') ? found.entries : found.entries.map(decodeEntities));
          pluralForms ??= found.source.headers['plural-forms'];
        }
      }
    }
    return toJed(domain, locale, entries, pluralForms);
  }

  /**
   * The block editor's translations: every script translation of a core
   * language pack for WordPress's editor scripts (`wp-includes/js/dist/*`),
   * merged into the `default` domain, plus the block metadata strings the
   * server translates in WordPress. load_script_translations()'s filters run
   * for each file; the handle is the file's name without `.json`.
   */
  async scriptTranslations(locale: string): Promise<JedLocaleData> {
    const entries: TranslationEntries = new Map();
    let pluralForms: string | undefined;
    const hooks = this.kernel.hooks;
    const merge = (file: TranslationFile) => {
      if (file.source && !EDITOR_SCRIPTS.test(file.source)) return;
      pluralForms ??= file.headers['plural-forms'];
      for (const [key, value] of file.entries) if (!entries.has(key)) entries.set(key, value);
    };
    for (const name of readDir(this.languagesDir).sort()) {
      const match = SCRIPT_JSON.exec(name);
      if (!match || match[1] !== locale) continue;
      let file = path.join(this.languagesDir, name);
      const handle = name.slice(0, -5);
      const pre = await hooks.applyFilters(
        'pre_load_script_translations',
        null,
        file,
        handle,
        'default',
      );
      let json = typeof pre === 'string' ? pre : null;
      if (json === null) {
        file = await hooks.applyFilters('load_script_translation_file', file, handle, 'default');
        if (!file) continue;
        if (!hooks.hasFilter('load_script_translations')) {
          // The common case: the parsed file, cached until it changes.
          const parsed = readTranslationFile(file);
          if (parsed) merge(parsed);
          continue;
        }
        try {
          json = await hooks.applyFilters(
            'load_script_translations',
            await readFile(file, 'utf8'),
            file,
            handle,
            'default',
          );
        } catch {
          continue;
        }
      }
      try {
        merge(parseJed(json, file));
      } catch {
        // A file that isn't valid JSON is skipped, as WordPress's script loader skips it.
      }
    }
    this.#ensureLoaded('default', locale);
    for (const [key, value] of this.controller.entries('default', locale)) {
      const glue = key.indexOf(CONTEXT_GLUE);
      if (glue === -1 || entries.has(key)) continue;
      if (EDITOR_CONTEXTS.test(key.slice(0, glue))) entries.set(key, value);
    }
    pluralForms ??= this.controller.headers('default', locale)['plural-forms'];
    return toJed('default', locale, entries, pluralForms);
  }

  /** The msgids of a `.pot` in the repository's `languages/` folder, as lookup keys. */
  catalogue(domain: string): string[] {
    const file = path.join(BUNDLED_LANGUAGES_DIR, `${domain}.pot`);
    const cached = this.#catalogues.get(file);
    if (cached) return cached;
    let keys: string[] = [];
    try {
      keys = parsePoEntries(readFileSync(file, 'utf8')).entries.map((e) =>
        e.context ? `${e.context}${CONTEXT_GLUE}${e.singular}` : e.singular,
      );
    } catch {
      // No template yet: nothing to borrow.
    }
    this.#catalogues.set(file, keys);
    return keys;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  rsaquo: '›',
  lsaquo: '‹',
  raquo: '»',
  laquo: '«',
  rarr: '→',
  larr: '←',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  sbquo: '‚',
};

/** HTML character references in a translation, as text. Unknown names are left alone. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X'
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

function toJed(
  domain: string,
  locale: string,
  entries: TranslationEntries,
  pluralForms: string | undefined,
): JedLocaleData {
  const data: JedLocaleData = {
    '': {
      domain,
      lang: locale,
      'plural-forms': pluralForms ?? 'nplurals=2; plural=n != 1;',
    },
  };
  for (const [key, value] of entries) data[key] = value;
  return data;
}
