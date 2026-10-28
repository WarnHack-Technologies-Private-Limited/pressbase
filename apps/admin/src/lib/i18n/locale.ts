import { createI18n, type I18n, type LocaleData } from '@wordpress/i18n';

/**
 * The admin's translations: Pressbase's own strings in the `pressbase-admin`
 * text domain, through `@wordpress/i18n`, as WordPress's admin scripts use
 * it. Core sends them (`/pressbase/v1/i18n/admin`) in the user's language.
 *
 *   const { __, _n } = useI18n();          // client components
 *   const { __ } = await getI18n();        // server components
 *   __('Settings', 'pressbase-admin')
 *
 * Always pass the domain: `pnpm i18n:extract` collects the strings by it.
 * See docs/architecture/i18n.md and docs/development/translating.md.
 */

export const ADMIN_DOMAIN = 'pressbase-admin';

/** What core's /pressbase/v1/i18n/admin returns. */
export interface AdminLocale {
  /** WordPress locale, e.g. de_DE. */
  locale: string;
  /** BCP 47 tag for `<html lang>`, e.g. de-DE. */
  lang: string;
  dir: 'ltr' | 'rtl';
  locale_data: Record<string, LocaleData>;
}

export const ENGLISH: AdminLocale = {
  locale: 'en_US',
  lang: 'en-US',
  dir: 'ltr',
  locale_data: {},
};

/**
 * A translator for one locale. Each request (and the browser) gets its own
 * instance, never `@wordpress/i18n`'s shared default one: the server renders
 * pages for people in different languages at the same time.
 */
export function createTranslator(locale: AdminLocale): I18n {
  const i18n = createI18n();
  for (const [domain, data] of Object.entries(locale.locale_data)) {
    i18n.setLocaleData(data, domain);
  }
  return i18n;
}

/**
 * Marks a string in static data (navigation labels, lists) for
 * `pnpm i18n:extract` without translating it; translate it where it's
 * shown: `__(item.label, 'pressbase-admin')`.
 */
export function msgid<T extends string>(text: T, _context?: string): T {
  return text;
}

/** Numbers in the user's language. */
export function formatNumber(value: number, lang: string): string {
  try {
    return value.toLocaleString(lang);
  } catch {
    return value.toLocaleString('en');
  }
}
