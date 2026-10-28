import type { DateWords } from '../php-date';
import { msgid } from './locale';

/**
 * WP_Locale's month and weekday names (wp-includes/class-wp-locale.php),
 * with the same strings and contexts, so a WordPress language pack
 * translates them for the admin too.
 */
const WEEKDAYS = [
  msgid('Sunday'),
  msgid('Monday'),
  msgid('Tuesday'),
  msgid('Wednesday'),
  msgid('Thursday'),
  msgid('Friday'),
  msgid('Saturday'),
];
const WEEKDAY_ABBREV = [
  msgid('Sun'),
  msgid('Mon'),
  msgid('Tue'),
  msgid('Wed'),
  msgid('Thu'),
  msgid('Fri'),
  msgid('Sat'),
];
const MONTHS = [
  msgid('January'),
  msgid('February'),
  msgid('March'),
  msgid('April'),
  msgid('May'),
  msgid('June'),
  msgid('July'),
  msgid('August'),
  msgid('September'),
  msgid('October'),
  msgid('November'),
  msgid('December'),
];
const MONTH_ABBREV: [string, string][] = [
  [msgid('Jan', 'January abbreviation'), 'January abbreviation'],
  [msgid('Feb', 'February abbreviation'), 'February abbreviation'],
  [msgid('Mar', 'March abbreviation'), 'March abbreviation'],
  [msgid('Apr', 'April abbreviation'), 'April abbreviation'],
  [msgid('May', 'May abbreviation'), 'May abbreviation'],
  [msgid('Jun', 'June abbreviation'), 'June abbreviation'],
  [msgid('Jul', 'July abbreviation'), 'July abbreviation'],
  [msgid('Aug', 'August abbreviation'), 'August abbreviation'],
  [msgid('Sep', 'September abbreviation'), 'September abbreviation'],
  [msgid('Oct', 'October abbreviation'), 'October abbreviation'],
  [msgid('Nov', 'November abbreviation'), 'November abbreviation'],
  [msgid('Dec', 'December abbreviation'), 'December abbreviation'],
];
const MERIDIEM = { am: msgid('am'), pm: msgid('pm'), AM: msgid('AM'), PM: msgid('PM') };

export function dateWords(
  __: (text: string, domain: string) => string,
  _x: (text: string, context: string, domain: string) => string,
): DateWords {
  const domain = 'pressbase-admin';
  return {
    weekday: WEEKDAYS.map((day) => __(day, domain)),
    weekdayAbbrev: WEEKDAY_ABBREV.map((day) => __(day, domain)),
    month: MONTHS.map((month) => __(month, domain)),
    monthAbbrev: MONTH_ABBREV.map(([month, context]) => _x(month, context, domain)),
    meridiem: {
      am: __(MERIDIEM.am, domain),
      pm: __(MERIDIEM.pm, domain),
      AM: __(MERIDIEM.AM, domain),
      PM: __(MERIDIEM.PM, domain),
    },
  };
}
