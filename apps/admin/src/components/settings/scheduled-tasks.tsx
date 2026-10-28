import { CalendarClock } from 'lucide-react';
import { Badge, Card, EmptyState, Notice } from '@/components/ui/surface';
import { type CronOverview, describeHook, formatTimestamp, relativeTime } from '@/lib/cron';
import list from '../content/list.module.css';
import styles from './settings.module.css';

/**
 * Settings → Scheduled tasks: a read-only view of the cron events waiting to
 * run and the background tasks that failed recently (docs/architecture/jobs.md).
 */
export function ScheduledTasks({ data, timeZone }: { data: CronOverview; timeZone: string }) {
  const now = Date.now();
  const scheduleName = (schedule: string | false) =>
    schedule === false ? 'Once' : (data.schedules[schedule]?.display ?? schedule);

  return (
    <div className={styles.form}>
      {!data.worker && (
        <Notice tone="warning" title="Tasks don’t run in this process.">
          The worker is turned off here (PRESSBASE_WORKER=off), so another Pressbase process must
          run it. Scheduled posts still go live when someone next views your content.
        </Notice>
      )}

      <Card
        title="Scheduled tasks"
        description="Work Pressbase and plugins have planned, soonest first. Times are in your site’s time zone."
      >
        {data.events.length === 0 ? (
          <EmptyState icon={<CalendarClock size={28} />} title="Nothing is scheduled">
            <p>Scheduled posts and regular clean-up tasks appear here.</p>
          </EmptyState>
        ) : (
          <div className={styles.tableScroll}>
            <table className={list.table}>
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Next run</th>
                  <th scope="col" className={list.hideNarrow}>
                    Repeats
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => {
                  const ms = event.timestamp * 1000;
                  const label = describeHook(event.hook);
                  return (
                    <tr key={`${event.hook}:${event.timestamp}:${JSON.stringify(event.args)}`}>
                      <td>
                        <div>{label ?? <code>{event.hook}</code>}</div>
                        <div className={styles.taskMeta}>
                          {label && <code>{event.hook}</code>}
                          {event.args.length > 0 && (
                            <span>
                              {label ? ' · ' : ''}
                              Arguments: <code>{JSON.stringify(event.args)}</code>
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <time dateTime={new Date(ms).toISOString()}>
                          {formatTimestamp(ms, timeZone)}
                        </time>
                        <div className={styles.taskMeta}>
                          {ms <= now ? 'Due now' : relativeTime(ms, now)}
                        </div>
                      </td>
                      <td className={list.hideNarrow}>{scheduleName(event.schedule)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Recent failures"
        description="Tasks that failed on their last attempt in the past week."
        actions={
          data.failed.length > 0 ? <Badge tone="warning">{data.failed.length}</Badge> : undefined
        }
      >
        {data.failed.length === 0 ? (
          <p className={styles.taskMeta}>No tasks have failed recently.</p>
        ) : (
          <div className={styles.tableScroll}>
            <table className={list.table}>
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Error</th>
                  <th scope="col" className={list.hideNarrow}>
                    Failed
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.failed.map((job) => {
                  const hook = job.hook ?? job.name;
                  return (
                    <tr key={job.id}>
                      <td>
                        <div>{describeHook(hook) ?? <code>{hook}</code>}</div>
                        <div className={styles.taskMeta}>
                          {job.attempts} of {job.max_attempts}{' '}
                          {job.max_attempts === 1 ? 'attempt' : 'attempts'}
                        </div>
                      </td>
                      <td>{job.error || 'No error message was recorded.'}</td>
                      <td className={list.hideNarrow}>
                        {job.finished && (
                          <time dateTime={job.finished}>
                            {formatTimestamp(Date.parse(job.finished), timeZone)}
                          </time>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
