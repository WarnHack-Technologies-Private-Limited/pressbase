/**
 * Locale names, text direction and the date words of a language — the data
 * of WP_Locale (wordpress/wp-includes/class-wp-locale.php).
 */

/** A WordPress locale: `de`, `de_DE`, `de_DE_formal`, `pt_PT_ao90`, `ca_valencia`… */
export const LOCALE_PATTERN = /^[a-z]{2,3}(?:_[A-Z]{2})?(?:_[a-z0-9]+)?$/;

export function isLocale(value: string): boolean {
  return LOCALE_PATTERN.test(value);
}

/** sanitize_locale_name() */
export function sanitizeLocaleName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '');
}

/** de_DE → de-DE, de_DE_formal → de-DE; the `lang` attribute (get_bloginfo( 'language' )). */
export function localeToLang(locale: string): string {
  const [language, region] = locale.split('_');
  return region && /^[A-Z]{2}$/.test(region) ? `${language}-${region}` : (language as string);
}

/**
 * Languages written right to left, for when no translation says so. WordPress
 * reads the direction from the translation of `ltr` (context "text
 * direction"); this list answers for a language with no translations yet.
 */
const RTL_LANGUAGES = new Set([
  'ar',
  'arq',
  'ary',
  'azb',
  'ckb',
  'dv',
  'fa',
  'haz',
  'he',
  'ps',
  'sd',
  'skr',
  'ug',
  'ur',
  'yi',
]);

export function isRtlLanguage(locale: string): boolean {
  return RTL_LANGUAGES.has(locale.split('_')[0] as string);
}

/** A language's English and native names, from the runtime's ICU data. */
export function languageNames(locale: string): { english: string; native: string } {
  if (locale === 'en_US')
    return { english: 'English (United States)', native: 'English (United States)' };
  const tag = localeToLang(locale);
  const name = (display: string) => {
    try {
      return new Intl.DisplayNames([display], { type: 'language' }).of(tag) ?? locale;
    } catch {
      return locale;
    }
  };
  const native = name(tag);
  return {
    english: name('en'),
    // Capitalised, as WordPress.org's native names are ("Deutsch", "Français").
    native: native.charAt(0).toLocaleUpperCase(tag) + native.slice(1),
  };
}

/** The words date formats use, in one language (WP_Locale's properties). */
export interface DateWords {
  /** Sunday … Saturday */
  weekday: string[];
  /** Sun … Sat */
  weekdayAbbrev: string[];
  /** S, M, T… */
  weekdayInitial: string[];
  /** January … December */
  month: string[];
  /** The genitive forms some languages use after a day number. */
  monthGenitive: string[];
  /** Jan … Dec */
  monthAbbrev: string[];
  meridiem: { am: string; pm: string; AM: string; PM: string };
}

export const ENGLISH_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
export const ENGLISH_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAY_ABBREV = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_INITIAL = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_ABBREV = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * WP_Locale::init(): the same strings and contexts, so WordPress's own
 * translations (the `default` domain) supply them.
 */
export function dateWords(
  __: (text: string) => string,
  _x: (text: string, context: string) => string,
): DateWords {
  return {
    weekday: ENGLISH_WEEKDAYS.map((day) => __(day)),
    weekdayAbbrev: WEEKDAY_ABBREV.map((day) => __(day)),
    weekdayInitial: WEEKDAY_INITIAL.map((letter, i) =>
      _x(letter, `${ENGLISH_WEEKDAYS[i] as string} initial`),
    ),
    month: ENGLISH_MONTHS.map((month) => __(month)),
    monthGenitive: ENGLISH_MONTHS.map((month) => _x(month, 'genitive')),
    monthAbbrev: MONTH_ABBREV.map((month, i) =>
      _x(month, `${ENGLISH_MONTHS[i] as string} abbreviation`),
    ),
    meridiem: { am: __('am'), pm: __('pm'), AM: __('AM'), PM: __('PM') },
  };
}

export const ENGLISH_DATE_WORDS: DateWords = dateWords(
  (text) => text,
  (text) => text,
);
