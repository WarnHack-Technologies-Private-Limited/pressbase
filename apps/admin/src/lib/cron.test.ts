import { describe, expect, it } from 'vitest';
import { describeHook, formatTimestamp, relativeTime } from './cron';

describe('cron helpers', () => {
  it('formats times in the site time zone, falling back to UTC', () => {
    const ms = Date.UTC(2026, 9, 27, 9, 34);
    expect(formatTimestamp(ms, 'Asia/Kolkata')).toBe('Oct 27, 2026 at 3:04 PM');
    expect(formatTimestamp(ms, 'Not/AZone')).toBe('Oct 27, 2026 at 9:34 AM UTC');
  });

  it('describes relative times', () => {
    const now = Date.UTC(2026, 0, 1);
    expect(relativeTime(now + 30_000, now)).toBe('now');
    expect(relativeTime(now + 5 * 60_000, now)).toBe('in 5 minutes');
    expect(relativeTime(now - 3600_000, now)).toBe('1 hour ago');
    expect(relativeTime(now + 2 * 86400_000, now)).toBe('in 2 days');
  });

  it('names core hooks', () => {
    expect(describeHook('publish_future_post')).toBe('Publish a scheduled post');
    expect(describeHook('my_plugin_hook')).toBeUndefined();
  });
});
