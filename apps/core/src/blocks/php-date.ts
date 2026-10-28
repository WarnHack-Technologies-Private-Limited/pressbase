/**
 * wp_date(): formats a date with a PHP date() format string in the site's
 * time zone, as WordPress's date_format and time_format options are written.
 * A backslash escapes the next character. The same formatter lives in the
 * admin (apps/admin/src/lib/php-date.ts); this one adds the ISO 8601 and
 * offset characters (c, O, P) that server-rendered blocks need.
 */

import { type DateWords, ENGLISH_DATE_WORDS } from '../i18n/locale';

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');

const MONTHS = [
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
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  /** Minutes east of UTC. */
  offset: number;
}

/** The date's local wall-clock time in a time zone. */
export function wallClock(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'long',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const w = {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const offset = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  return { ...w, offset };
}

export function monthName(month: number, words: DateWords = ENGLISH_DATE_WORDS): string {
  return words.month[month - 1] ?? MONTHS[month - 1] ?? '';
}

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th';
}

function offsetString(minutes: number, colon: boolean): string {
  const sign = minutes < 0 ? '-' : '+';
  return `${sign}${pad(Math.trunc(minutes / 60))}${colon ? ':' : ''}${pad(minutes % 60)}`;
}

/**
 * `words` are the month and weekday names (WP_Locale), so dates read in the
 * site's language as with wp_date(): `kernel.i18n.dateWords()`.
 */
export function formatPhpDate(
  format: string,
  date: Date,
  timeZone = 'UTC',
  words: DateWords = ENGLISH_DATE_WORDS,
): string {
  const p = wallClock(date, timeZone);
  const hour12 = p.hour % 12 || 12;
  const month = monthName(p.month, words);
  const weekday = words.weekday[p.weekday] ?? '';

  let out = '';
  for (let i = 0; i < format.length; i++) {
    const ch = format[i] as string;
    if (ch === '\\') {
      out += format[++i] ?? '';
      continue;
    }
    switch (ch) {
      case 'd':
        out += pad(p.day);
        break;
      case 'j':
        out += p.day;
        break;
      case 'S':
        out += ordinal(p.day);
        break;
      case 'D':
        out += words.weekdayAbbrev[p.weekday] ?? weekday.slice(0, 3);
        break;
      case 'l':
        out += weekday;
        break;
      case 'N':
        out += p.weekday === 0 ? 7 : p.weekday;
        break;
      case 'w':
        out += p.weekday;
        break;
      case 'F':
        out += month;
        break;
      case 'M':
        out += words.monthAbbrev[p.month - 1] ?? month.slice(0, 3);
        break;
      case 'm':
        out += pad(p.month);
        break;
      case 'n':
        out += p.month;
        break;
      case 'Y':
        out += p.year;
        break;
      case 'y':
        out += pad(p.year % 100);
        break;
      case 'a':
        out += p.hour < 12 ? words.meridiem.am : words.meridiem.pm;
        break;
      case 'A':
        out += p.hour < 12 ? words.meridiem.AM : words.meridiem.PM;
        break;
      case 'g':
        out += hour12;
        break;
      case 'h':
        out += pad(hour12);
        break;
      case 'G':
        out += p.hour;
        break;
      case 'H':
        out += pad(p.hour);
        break;
      case 'i':
        out += pad(p.minute);
        break;
      case 's':
        out += pad(p.second);
        break;
      case 'e':
        out += timeZone;
        break;
      case 'O':
        out += offsetString(p.offset, false);
        break;
      case 'P':
        out += offsetString(p.offset, true);
        break;
      case 'U':
        out += Math.floor(date.getTime() / 1000);
        break;
      case 'c':
        out += `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offsetString(p.offset, true)}`;
        break;
      default:
        out += ch;
    }
  }
  return out;
}
