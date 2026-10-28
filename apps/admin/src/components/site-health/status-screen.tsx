'use client';

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Spinner } from '@/components/ui/button';
import { Badge, Card, Notice } from '@/components/ui/surface';
import { ApiError, api } from '@/lib/api';
import {
  type AsyncTest,
  countHeading,
  countResults,
  type HealthStatus,
  overallStatus,
  type SiteStatus,
  type TestResult,
  unavailableResult,
} from '@/lib/site-health';
import { AccordionItem } from './accordion-item';
import styles from './site-health.module.css';

const ICONS = { critical: XCircle, recommended: AlertTriangle, good: CheckCircle2 };
const ICON_LABELS = { critical: 'Critical', recommended: 'Recommended', good: 'Passed' };

const INTROS: Record<Exclude<HealthStatus, 'good'>, string> = {
  critical:
    'Critical issues are items that may have a high impact on your site’s performance or security. Resolving these issues should be prioritized.',
  recommended:
    'Recommended items are considered beneficial to your site, although not as important to prioritize as a critical issue. They may include improvements in areas such as security, performance, and user experience.',
};

/** Runs one async test through REST, as maybeRunNextAsyncTest() does. */
async function runAsyncTest(test: AsyncTest): Promise<TestResult> {
  try {
    const res = await fetch(`/wp-json${test.test}`, {
      credentials: 'same-origin',
      headers: { ...test.headers, 'x-pressbase-request': '1' },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body.label !== 'string' || typeof body.test !== 'string') {
      return unavailableResult(test, body?.message ?? `The test answered ${res.status}.`);
    }
    return body as TestResult;
  } catch {
    return unavailableResult(test, 'Pressbase could not be reached.');
  }
}

function Issue({ result }: { result: TestResult }) {
  const Icon = ICONS[result.status];
  return (
    <AccordionItem
      title={result.label}
      icon={
        <Icon
          size={18}
          className={styles.statusIcon}
          data-status={result.status}
          role="img"
          aria-label={ICON_LABELS[result.status]}
        />
      }
      badge={result.badge.label ? <Badge>{result.badge.label}</Badge> : undefined}
    >
      {/* Sanitised by core (site-health/html.ts): a few tags and links. */}
      <div dangerouslySetInnerHTML={{ __html: result.description }} />
      {result.actions && (
        <div className={styles.actions} dangerouslySetInnerHTML={{ __html: result.actions }} />
      )}
    </AccordionItem>
  );
}

/** The overall rating: a ring, "Good" or "Should be improved", and what's left to run. */
function Overview({ results, pending }: { results: TestResult[]; pending: number }) {
  const counts = countResults(results);
  const { score, good } = overallStatus(counts);
  const done = pending === 0;
  const circumference = 2 * Math.PI * 42;
  const state = !done ? 'loading' : good ? 'good' : 'improvable';
  return (
    <div className={styles.overview} data-state={state}>
      <svg className={styles.ring} viewBox="0 0 100 100" aria-hidden="true">
        <circle className={styles.ringTrack} cx="50" cy="50" r="42" fill="none" strokeWidth="10" />
        <circle
          className={styles.ringBar}
          cx="50"
          cy="50"
          r="42"
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={done ? ((100 - score) / 100) * circumference : circumference}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className={styles.overviewText}>
        <p className={styles.rating}>
          {!done ? 'Results are still loading…' : good ? 'Good' : 'Should be improved'}
        </p>
        <p className={styles.overviewMeta}>
          {done ? (
            [
              counts.critical > 0 && countHeading('critical', counts.critical),
              counts.recommended > 0 && countHeading('recommended', counts.recommended),
              `${counts.good.toLocaleString('en')} passed`,
            ]
              .filter(Boolean)
              .join(' · ')
          ) : (
            <span className={styles.running}>
              <Spinner /> Running {pending} more {pending === 1 ? 'test' : 'tests'}…
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Tools → Site Health → Status (wp-admin/site-health.php with site-health.js):
 * shows the direct tests' results, runs the async ones one at a time, then
 * saves the counts for the Dashboard.
 */
export function StatusScreen({ initial }: { initial: SiteStatus }) {
  const [results, setResults] = useState<TestResult[]>(initial.direct);
  const [pending, setPending] = useState(initial.async.length);
  const [announcement, setAnnouncement] = useState('');
  const [showPassed, setShowPassed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const run = useRef(0);
  const passedId = useId();

  const runAll = useCallback(async (status: SiteStatus) => {
    const id = ++run.current;
    setResults(status.direct);
    setPending(status.async.length);
    setAnnouncement('');
    const collected = [...status.direct];
    for (const test of status.async) {
      const result = await runAsyncTest(test);
      if (run.current !== id) return;
      collected.push(result);
      setResults([...collected]);
      setPending((n) => n - 1);
    }
    const counts = countResults(collected);
    // wp_ajax_health_check_site_status_result(): the Dashboard shows these.
    void api('/pressbase/v1/site-health/result', { method: 'POST', body: { counts } }).catch(
      () => {},
    );
    setAnnouncement(
      overallStatus(counts).good
        ? 'All site health tests have finished running. Your site is looking good.'
        : 'All site health tests have finished running. There are items that should be addressed.',
    );
  }, []);

  useEffect(() => {
    void runAll(initial);
    return () => {
      run.current++;
    };
  }, [initial, runAll]);

  const checkAgain = async () => {
    setChecking(true);
    setError('');
    try {
      await runAll(await api<SiteStatus>('/pressbase/v1/site-health'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The checks couldn’t run. Try again.');
    } finally {
      setChecking(false);
    }
  };

  const group = (status: HealthStatus) => results.filter((r) => r.status === status);
  const critical = group('critical');
  const recommended = group('recommended');
  const passed = group('good');

  return (
    <div className={styles.stack}>
      <Card
        title="Site health status"
        description="The site health check shows information about your Pressbase configuration and items that may need your attention."
        actions={
          <Button size="sm" onClick={checkAgain} loading={checking} disabled={pending > 0}>
            {checking ? 'Checking…' : 'Check again'}
          </Button>
        }
      >
        <Overview results={results} pending={pending} />
        <p className="visually-hidden" role="status">
          {announcement}
        </p>
      </Card>

      {error && <Notice tone="danger" title={error} />}

      {pending === 0 && critical.length === 0 && recommended.length === 0 && (
        <Card title="Great job!">
          <p className={styles.allClear}>Everything is running smoothly here.</p>
        </Card>
      )}

      {(['critical', 'recommended'] as const).map((status) => {
        const items = status === 'critical' ? critical : recommended;
        if (!items.length) return null;
        return (
          <Card key={status} title={countHeading(status, items.length)}>
            <p className={styles.groupIntro}>{INTROS[status]}</p>
            <div className={styles.accordion}>
              {items.map((r, i) => (
                <Issue key={`${r.test}-${i}`} result={r} />
              ))}
            </div>
          </Card>
        );
      })}

      <div>
        <Button
          variant="secondary"
          aria-expanded={showPassed}
          aria-controls={passedId}
          onClick={() => setShowPassed(!showPassed)}
        >
          Passed tests
        </Button>
      </div>
      <div id={passedId} hidden={!showPassed}>
        <Card title={countHeading('good', passed.length)}>
          <div className={styles.accordion}>
            {passed.map((r, i) => (
              <Issue key={`${r.test}-${i}`} result={r} />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
