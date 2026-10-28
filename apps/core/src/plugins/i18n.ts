import path from 'node:path';
import type { Kernel } from '../kernel';

/**
 * `api.i18n`: a plugin's translations. Its text domain is its slug, and its
 * `languages/` folder is registered when it loads (load_plugin_textdomain()),
 * so `daily-tips/languages/daily-tips-de_DE.mo` (or `.po`) is used without a
 * call. A file in `<dataDir>/languages/plugins/` wins over the plugin's own.
 * Strings are translated into the current request's language.
 */
export interface PluginI18n {
  /** The plugin's text domain: its slug. */
  readonly domain: string;
  /** __(): `domain` defaults to the plugin's. */
  __(text: string, domain?: string): string;
  /** _x(): a string with a context that tells translators how it's used. */
  _x(text: string, context: string, domain?: string): string;
  /** _n(): the singular or plural form for `number`, by the language's plural rules. */
  _n(single: string, plural: string, number: number, domain?: string): string;
  /** _nx() */
  _nx(single: string, plural: string, number: number, context: string, domain?: string): string;
  /** determine_locale(): the language being served, e.g. `de_DE`. */
  locale(): string;
  /** is_rtl() */
  isRtl(): boolean;
}

export function createPluginI18n({
  kernel,
  slug,
  dir,
  track,
}: {
  kernel: Kernel;
  slug: string;
  dir: string;
  track: (dispose: () => void) => void;
}): PluginI18n {
  const i18n = kernel.i18n;
  track(i18n.loadPluginTextdomain(slug, path.join(dir, 'languages')));
  return Object.freeze({
    domain: slug,
    __: (text: string, domain = slug) => i18n.__(text, domain),
    _x: (text: string, context: string, domain = slug) => i18n._x(text, context, domain),
    _n: (single: string, plural: string, number: number, domain = slug) =>
      i18n._n(single, plural, number, domain),
    _nx: (single: string, plural: string, number: number, context: string, domain = slug) =>
      i18n._nx(single, plural, number, context, domain),
    locale: () => i18n.determineLocale(),
    isRtl: () => i18n.isRtl(),
  });
}
