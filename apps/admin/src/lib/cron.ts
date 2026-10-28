/** GET /pressbase/v1/cron (apps/core/src/routes/cron.ts). */
export interface CronEventView {
  hook: string;
  /** Unix seconds. */
  timestamp: number;
  schedule: string | false;
  interval: number | null;
  args: unknown[];
}

export interface FailedJobView {
  id: number;
  name: string;
  hook: string | null;
  attempts: number;
  max_attempts: number;
  error: string;
  finished: string | null;
}

export interface CronOverview {
  events: CronEventView[];
  schedules: Record<string, { interval: number; display: string }>;
  failed: FailedJobView[];
  counts: { pending: number; running: number; completed: number; failed: number };
  worker: boolean;
}

/** Plain-language names for the events core schedules; others show their hook. */
const CORE_HOOKS: Record<string, string> = {
  publish_future_post: 'Publish a scheduled post',
  pressbase_delete_expired_sessions: 'Remove expired login sessions',
  pressbase_prune_jobs: 'Clear out old task records',
};

export function describeHook(hook: string): string | undefined {
  return CORE_HOOKS[hook];
}

/** "Oct 27, 2026 at 3:04 PM" in the site's time zone (UTC when it isn't a named zone). */
export function formatTimestamp(ms: number, timeZone: string): string {
  const format = (zone: string) => {
    const value = new Date(ms);
    const day = value.toLocaleDateString('en-US', {
      timeZone: zone,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const clock = value.toLocaleTimeString('en-US', {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
    });
    return `${day} at ${clock}`;
  };
  try {
    return format(timeZone || 'UTC');
  } catch {
    return `${format('UTC')} UTC`;
  }
}

/** "in 5 minutes", "3 hours ago", "now". */
export function relativeTime(ms: number, now: number): string {
  const diff = Math.round((ms - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 60) return 'now';
  const [value, unit] =
    abs < 3600
      ? [Math.round(abs / 60), 'minute']
      : abs < 86400
        ? [Math.round(abs / 3600), 'hour']
        : [Math.round(abs / 86400), 'day'];
  const label = `${value} ${unit}${value === 1 ? '' : 's'}`;
  return diff > 0 ? `in ${label}` : `${label} ago`;
}
