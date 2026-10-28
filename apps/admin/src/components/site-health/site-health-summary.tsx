import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { coreGet } from '@/lib/core';
import { relativeTime } from '@/lib/cron';
import { dashboardMessage, type StoredResult } from '@/lib/site-health';
import styles from './site-health.module.css';

/**
 * The Dashboard's Site health card body (wp_dashboard_site_health()): the
 * rating saved by the last check and a link to Tools → Site Health. Shows
 * nothing to people without view_site_health_checks.
 */
export async function SiteHealthSummary() {
  const res = await coreGet<StoredResult | null>('/pressbase/v1/site-health/result').catch(
    () => null,
  );
  if (res?.status !== 200) return null;
  const result = res.data;

  if (!result) {
    return (
      <div className={styles.summary}>
        <p className={styles.summaryRating}>No information yet…</p>
        <p className={styles.summaryText}>
          Site health checks will automatically run periodically to gather information about your
          site. You can also{' '}
          <Link href="/admin/tools/site-health">visit the Site Health screen</Link> to gather
          information about your site now.
        </p>
      </div>
    );
  }

  const issues = result.recommended + result.critical;
  const good = result.status === 'good';
  const Icon = good ? CheckCircle2 : AlertTriangle;
  return (
    <div className={styles.summary}>
      <p className={styles.summaryRating} data-state={good ? 'good' : 'improvable'}>
        <Icon size={18} aria-hidden="true" />
        {good ? 'Good' : 'Should be improved'}
      </p>
      <p className={styles.summaryText}>{dashboardMessage(result)}</p>
      <p className={styles.summaryText}>
        {issues > 0 ? (
          <>
            Take a look at the{' '}
            <strong>
              {issues} {issues === 1 ? 'item' : 'items'}
            </strong>{' '}
            on the <Link href="/admin/tools/site-health">Site Health screen</Link>.
          </>
        ) : (
          <Link href="/admin/tools/site-health">Open Site Health</Link>
        )}{' '}
        <span className={styles.summaryMeta}>
          Checked {relativeTime(Date.parse(result.time), Date.now()).replace(/^now$/, 'just now')}.
        </span>
      </p>
    </div>
  );
}
