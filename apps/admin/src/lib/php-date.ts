/**
 * Formats a date with a PHP date() format string, as WordPress stores them in
 * the date_format and time_format options. Supports the characters WordPress
 * offers in its settings; a backslash escapes the next character.
 */

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function parts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'long',
    hourCycle: 'h23',
    timeZoneName: 'short',
  });
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    formatter.formatToParts(date).find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday'),
    zone: get('timeZoneName'),
  };
}

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

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th';
}

/** Month and weekday names in a language (WP_Locale), as wp_date() uses them. */
export interface DateWords {
  month: string[];
  monthAbbrev: string[];
  weekday: string[];
  weekdayAbbrev: string[];
  meridiem: { am: string; pm: string; AM: string; PM: string };
}

export function formatPhpDate(
  format: string,
  date: Date,
  timeZone = 'UTC',
  words?: DateWords,
): string {
  const p = parts(date, timeZone);
  const weekdayIndex = WEEKDAYS.indexOf(p.weekday);
  const hour12 = p.hour % 12 || 12;
  const englishMonth = MONTHS[p.month - 1] ?? '';
  const month = words?.month[p.month - 1] ?? englishMonth;
  const weekday = words?.weekday[weekdayIndex] ?? p.weekday;
  const meridiem = words?.meridiem ?? { am: 'am', pm: 'pm', AM: 'AM', PM: 'PM' };

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
        out += words?.weekdayAbbrev[weekdayIndex] ?? p.weekday.slice(0, 3);
        break;
      case 'l':
        out += weekday;
        break;
      case 'N':
        out += weekdayIndex === 0 ? 7 : weekdayIndex;
        break;
      case 'w':
        out += weekdayIndex;
        break;
      case 'F':
        out += month;
        break;
      case 'M':
        out += words?.monthAbbrev[p.month - 1] ?? englishMonth.slice(0, 3);
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
        out += p.hour < 12 ? meridiem.am : meridiem.pm;
        break;
      case 'A':
        out += p.hour < 12 ? meridiem.AM : meridiem.PM;
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
      case 'T':
        out += p.zone;
        break;
      case 'e':
        out += timeZone;
        break;
      case 'U':
        out += Math.floor(date.getTime() / 1000);
        break;
      case 'c':
        out += date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
        break;
      default:
        out += ch;
    }
  }
  return out;
}
