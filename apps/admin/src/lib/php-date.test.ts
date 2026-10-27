import { describe, expect, it } from 'vitest';
import { formatPhpDate } from './php-date';

const date = new Date('2026-10-27T15:04:05Z');

describe('formatPhpDate', () => {
  it('formats the WordPress default date and time formats', () => {
    expect(formatPhpDate('F j, Y', date)).toBe('October 27, 2026');
    expect(formatPhpDate('g:i a', date)).toBe('3:04 pm');
    expect(formatPhpDate('Y-m-d H:i', date)).toBe('2026-10-27 15:04');
    expect(formatPhpDate('m/d/Y', date)).toBe('10/27/2026');
  });

  it('applies the site time zone', () => {
    expect(formatPhpDate('H:i', date, 'Asia/Kolkata')).toBe('20:34');
    expect(formatPhpDate('jS M', new Date('2026-01-01T00:00:00Z'), 'America/New_York')).toBe(
      '31st Dec',
    );
  });

  it('honours backslash escapes', () => {
    expect(formatPhpDate('\\D\\a\\y j', date)).toBe('Day 27');
  });
});
