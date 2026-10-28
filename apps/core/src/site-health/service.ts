import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { resultRows } from '@pressbase/db';
import { sql } from 'drizzle-orm';
import type { Kernel } from '../kernel';
import { PRESSBASE_VERSION } from '../version';
import { debugData, directorySizes } from './debug-data';
import { esc, isValidResult, ksesSiteHealth, paragraphs, prepareResult } from './html';
import { coreTests } from './tests';
import type {
  DebugInfo,
  SiteHealthAsyncTest,
  SiteHealthCounts,
  SiteHealthTestCallback,
  SiteHealthTestResult,
  SiteStatusTests,
} from './types';

/**
 * Site Health: WP_Site_Health (wordpress/wp-admin/includes/class-wp-site-health.php)
 * and WP_Debug_Data, as `kernel.siteHealth`. Tests live in ./tests.ts, the
 * Info screen's data in ./debug-data.ts, the routes in routes/site-health.ts.
 * See docs/architecture/site-health.md.
 */

/** The hook of the weekly check, as in WordPress. */
export const SCHEDULED_CHECK = 'wp_site_health_scheduled_check';
/** The counts the Dashboard shows: WordPress's `health-check-site-status-result` transient. */
export const RESULT_TRANSIENT = 'health-check-site-status-result';
const UPDATE_TRANSIENT = 'pressbase_update_check';

/** Where `pressbase_version` looks for releases. */
export const RELEASES_API =
  'https://api.github.com/repos/WarnHack-Technologies-Private-Limited/pressbase/releases/latest';

/** One async test, as the Status screen needs it (WordPress's SiteHealth.site_status.async). */
export interface AsyncTestView {
  id: string;
  label: string;
  /** The REST route to call, under /wp-json. */
  test: string;
  has_rest: true;
  headers?: Record<string, string>;
}

export interface StoredResult extends SiteHealthCounts {
  /** When the counts were saved (ISO 8601). */
  time: string;
}

/**
 * The parts of fetch() Site Health uses. Spelled out, rather than the DOM's
 * Response, so the plugin SDK's type build (which has no DOM types) can follow
 * the kernel's types here.
 */
export interface HealthResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface HealthRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'follow' | 'manual' | 'error';
  signal?: AbortSignal;
}

export type HealthFetch = (url: string, init?: HealthRequestInit) => Promise<HealthResponse>;

export type ReleaseCheck =
  | { state: 'ok'; version: string; url: string }
  | { state: 'error'; error: string }
  | { state: 'off' };

/**
 * The overall rating, as site-health.js's recalculateProgression() works it
 * out: critical issues weigh 1.5, recommended ones 0.5; 80 or more with no
 * critical issue is "Good", anything else "Should be improved".
 */
export function overallStatus(counts: SiteHealthCounts): {
  score: number;
  status: 'good' | 'should_be_improved';
} {
  const total = counts.good + counts.recommended + counts.critical * 1.5;
  const failed = counts.recommended * 0.5 + counts.critical * 1.5;
  const score =
    total === 0 ? 100 : Math.min(100, Math.max(0, 100 - Math.ceil((failed / total) * 100)));
  return { score, status: score >= 80 && counts.critical === 0 ? 'good' : 'should_be_improved' };
}

/** The issue site-health.js shows when a test fails to run (addFailedSiteHealthCheckNotice()). */
export function unavailableResult(
  test: string,
  label: string,
  error: unknown,
): SiteHealthTestResult {
  return {
    label: 'A test is unavailable',
    status: 'recommended',
    badge: { label: 'Unavailable', color: 'red' },
    description: paragraphs(
      esc(label),
      esc(error instanceof Error ? error.message : String(error || 'No details available')),
    ),
    actions: '',
    test,
  };
}

const slugOf = (id: string) => id.replace(/_/g, '-');

export class SiteHealth {
  /** Outgoing HTTP for the async tests. Tests replace it; nothing else should. */
  fetch: HealthFetch = (url, init) =>
    globalThis.fetch(url, init) as unknown as Promise<HealthResponse>;
  /** How long one outgoing request may take. */
  requestTimeoutMs = 5000;

  constructor(readonly kernel: Kernel) {
    kernel.hooks.addAction(SCHEDULED_CHECK, () => this.scheduledCheck());
    // maybe_create_scheduled_event(): weekly, the first run a day after install.
    kernel.hooks.addAction('init', async () => {
      if ((await kernel.cron.nextScheduled(SCHEDULED_CHECK)) === false) {
        await kernel.cron.scheduleEvent(
          Math.floor(Date.now() / 1000) + 86_400,
          'weekly',
          SCHEDULED_CHECK,
        );
      }
    });
  }

  /* ---------------------------------------------------------------- tests */

  /** WP_Site_Health::get_tests(): core's tests through the `site_status_tests` filter. */
  async getTests(): Promise<SiteStatusTests> {
    const filtered = await this.kernel.hooks.applyFilters('site_status_tests', coreTests(this));
    return {
      direct: { ...(filtered?.direct ?? {}) },
      async: { ...(filtered?.async ?? {}) },
    };
  }

  /**
   * perform_test(): runs one test and passes its result through
   * `site_status_test_result`. A test that throws or returns something
   * malformed becomes "A test is unavailable", so one broken plugin test
   * doesn't break the screen.
   */
  async perform(id: string, label: string, callback: SiteHealthTestCallback | undefined) {
    let value: unknown;
    try {
      if (typeof callback !== 'function') throw new Error('The test has no callback.');
      value = await callback();
      if (!isValidResult(value)) throw new Error('The test returned an invalid result.');
    } catch (error) {
      value = unavailableResult(id, label, error);
    }
    const filtered = await this.kernel.hooks.applyFilters(
      'site_status_test_result',
      value as SiteHealthTestResult,
    );
    return prepareResult(isValidResult(filtered) ? filtered : (value as SiteHealthTestResult));
  }

  /** Every direct test's result, in the order the tests are listed. */
  async runDirect(): Promise<SiteHealthTestResult[]> {
    const { direct } = await this.getTests();
    return Promise.all(
      Object.entries(direct).map(([id, test]) => this.perform(id, test?.label ?? id, test?.test)),
    );
  }

  /** The async tests, for the Status screen to call one by one. */
  async asyncTests(): Promise<AsyncTestView[]> {
    const { async } = await this.getTests();
    return Object.entries(async).flatMap(([id, test]) => {
      const route = this.#routeFor(id, test);
      if (!route) return [];
      return [
        {
          id,
          label: test.label ?? id,
          test: route,
          has_rest: true as const,
          ...(test.headers ? { headers: test.headers } : {}),
        },
      ];
    });
  }

  /** The async test served at /wp-site-health/v1/tests/{slug}, if any. */
  async findAsync(slug: string): Promise<{ id: string; test: SiteHealthAsyncTest } | undefined> {
    const { async } = await this.getTests();
    for (const [id, test] of Object.entries(async)) {
      if (slugOf(id) === slug && typeof test?.async_direct_test === 'function') {
        return { id, test };
      }
    }
    return undefined;
  }

  #routeFor(id: string, test: SiteHealthAsyncTest): string | undefined {
    if (test.has_rest && typeof test.test === 'string' && test.test.startsWith('/')) {
      return test.test;
    }
    if (typeof test.async_direct_test === 'function')
      return `/wp-site-health/v1/tests/${slugOf(id)}`;
    return undefined;
  }

  /**
   * wp_cron_scheduled_check(): every test that can run without a browser
   * (direct ones, and async ones with `async_direct_test`), unless marked
   * `skip_cron`; the counts are saved for the Dashboard.
   */
  async scheduledCheck(): Promise<SiteHealthCounts> {
    const tests = await this.getTests();
    const runs: Promise<SiteHealthTestResult>[] = [];
    for (const [id, test] of Object.entries(tests.direct)) {
      if (!test?.skip_cron) runs.push(this.perform(id, test?.label ?? id, test?.test));
    }
    for (const [id, test] of Object.entries(tests.async)) {
      if (!test?.skip_cron && typeof test?.async_direct_test === 'function') {
        runs.push(this.perform(id, test.label ?? id, test.async_direct_test));
      }
    }
    const counts: SiteHealthCounts = { good: 0, recommended: 0, critical: 0 };
    for (const result of await Promise.all(runs)) counts[result.status]++;
    await this.saveResult(counts);
    return counts;
  }

  /* --------------------------------------------------------------- result */

  async storedResult(): Promise<StoredResult | null> {
    const value = await this.#getTransient<StoredResult>(RESULT_TRANSIENT);
    return value ?? null;
  }

  async saveResult(counts: SiteHealthCounts): Promise<StoredResult> {
    const stored = { ...counts, time: new Date().toISOString() };
    await this.#setTransient(RESULT_TRANSIENT, stored);
    return stored;
  }

  /* ------------------------------------------------------------- info tab */

  /** WP_Debug_Data::debug_data(), through the `debug_information` filter. */
  async debugData(): Promise<DebugInfo> {
    const filtered = await this.kernel.hooks.applyFilters(
      'debug_information',
      await debugData(this),
    );
    // Sections without fields are dropped; descriptions are shown as HTML, so they are sanitised.
    const info: DebugInfo = {};
    for (const [key, section] of Object.entries(filtered ?? {})) {
      if (!section || typeof section !== 'object' || !section.fields) continue;
      info[key] = section.description
        ? { ...section, description: ksesSiteHealth(String(section.description)) }
        : section;
    }
    return info;
  }

  /** WP_Debug_Data::get_sizes(). */
  directorySizes() {
    return directorySizes(this);
  }

  /* -------------------------------------------------------------- helpers */

  /** Public site URLs: WEB_URL. */
  webUrls(): string[] {
    return this.kernel.config.webUrls ?? this.kernel.config.revalidate?.urls ?? [];
  }

  /** An outgoing request that never throws: the Response, or the Error that stopped it. */
  async request(url: string, init: HealthRequestInit = {}): Promise<HealthResponse | Error> {
    try {
      return await this.fetch(url, {
        redirect: 'manual',
        ...init,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      if ((error as Error).name === 'TimeoutError') {
        return new Error(`no answer within ${this.requestTimeoutMs / 1000} seconds`);
      }
      return new Error(cause?.code ?? cause?.message ?? (error as Error).message);
    }
  }

  /** The database server's version: `show server_version`. */
  async postgresVersion(): Promise<{ text: string; major: number }> {
    const [row] = resultRows<{ server_version: string }>(
      await this.kernel.db.execute(sql`show server_version`),
    );
    const text = (row?.server_version ?? '0').split(' ')[0] ?? '0';
    return { text, major: Number.parseInt(text, 10) || 0 };
  }

  /** Free bytes on the disk holding the data directory, or null when it can't be read. */
  async freeDiskSpace(): Promise<number | null> {
    let dir = this.kernel.config.dataDir;
    for (;;) {
      try {
        const stats = await statfs(dir);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
      }
    }
  }

  /** sharp's versions and output formats, after resizing a tiny image; or the error it threw. */
  async sharpInfo(): Promise<{ sharp: string; vips: string; formats: string[] } | Error> {
    try {
      const { default: sharp } = await import('sharp');
      await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } })
        .resize(1, 1)
        .webp()
        .toBuffer();
      const formats = ['jpeg', 'png', 'webp', 'avif', 'gif']
        .filter(
          (name) =>
            (sharp.format as unknown as Record<string, { output?: { buffer?: boolean } }>)[name]
              ?.output?.buffer,
        )
        .map((name) => name.toUpperCase());
      return { sharp: sharp.versions.sharp ?? '', vips: sharp.versions.vips, formats };
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * The latest release on GitHub, cached for 12 hours (an hour after a
   * failure), like wp_version_check()'s update_core transient. Off with
   * PRESSBASE_UPDATE_CHECK=off. Never throws: offline sites get an error state.
   */
  async latestRelease(): Promise<ReleaseCheck> {
    if (
      ['off', '0', 'false', 'no'].includes((process.env.PRESSBASE_UPDATE_CHECK ?? '').toLowerCase())
    ) {
      return { state: 'off' };
    }
    const cached = await this.#getTransient<ReleaseCheck>(UPDATE_TRANSIENT);
    if (cached) return cached;
    let check: ReleaseCheck;
    const response = await this.request(RELEASES_API, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `Pressbase/${PRESSBASE_VERSION}`,
      },
    });
    if (response instanceof Error) {
      check = { state: 'error', error: response.message };
    } else if (!response.ok) {
      check = { state: 'error', error: `GitHub answered ${response.status}` };
    } else {
      const body = (await response.json().catch(() => null)) as {
        tag_name?: unknown;
        html_url?: unknown;
      } | null;
      const version = typeof body?.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
      check = version
        ? {
            state: 'ok',
            version,
            url: typeof body?.html_url === 'string' ? body.html_url : RELEASES_API,
          }
        : { state: 'error', error: 'GitHub’s answer had no version' };
    }
    await this.#setTransient(UPDATE_TRANSIENT, check, check.state === 'ok' ? 12 * 3600 : 3600);
    return check;
  }

  /*
   * Transients, stored as `_transient_{name}` options (not autoloaded) with
   * their expiry inside. That prefix keeps them from purging the page cache
   * (cache/invalidation.ts).
   */
  async #getTransient<T>(name: string): Promise<T | undefined> {
    const stored = await this.kernel.options.get<{ value: T; expires: number | null } | undefined>(
      `_transient_${name}`,
      undefined,
    );
    if (!stored || typeof stored !== 'object') return undefined;
    if (stored.expires && stored.expires < Date.now()) return undefined;
    return stored.value;
  }

  async #setTransient(name: string, value: unknown, seconds?: number): Promise<void> {
    await this.kernel.options.set(
      `_transient_${name}`,
      { value, expires: seconds ? Date.now() + seconds * 1000 : null },
      { autoload: false },
    );
  }
}
