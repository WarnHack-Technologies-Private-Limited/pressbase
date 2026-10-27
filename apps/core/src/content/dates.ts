/**
 * Dates in the REST API follow WordPress: `date` is the site's local time and
 * `date_gmt` is UTC, both as "YYYY-MM-DDTHH:MM:SS" with no zone suffix.
 * The database stores a single timestamptz.
 */

const pad = (n: number) => String(n).padStart(2, '0');

function wallClock(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

export function toGmtString(date: Date): string {
  return date.toISOString().slice(0, 19);
}

export function toLocalString(date: Date, timeZone: string): string {
  const w = wallClock(date, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parses a REST date. Strings with an explicit zone ("Z", "+05:30") are taken
 * as given; bare ones are read as UTC (`asGmt`) or as the site's local time.
 * Returns undefined for anything unparseable.
 */
export function parseRestDate(value: string, timeZone: string, asGmt: boolean): Date | undefined {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const match = DATE_TIME.exec(value.trim());
  if (!match) return undefined;
  const [y, mo, d, h, mi, s = '0'] = match.slice(1).map(Number) as number[];
  const asUtc = Date.UTC(y as number, (mo as number) - 1, d, h, mi, s as number);
  if (asGmt) return new Date(asUtc);
  // Local wall-clock time → UTC: correct by the zone offset, twice to settle DST edges.
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(guess), timeZone);
    const shown = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    guess += asUtc - shown;
  }
  return new Date(guess);
}
