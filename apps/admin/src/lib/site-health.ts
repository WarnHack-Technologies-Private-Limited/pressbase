/**
 * Tools → Site Health: the shapes core's Site Health routes return, and the
 * small pieces of site-health.js (wp-admin/js/site-health.js) the screens
 * need. See docs/architecture/site-health.md.
 */

export type HealthStatus = 'good' | 'recommended' | 'critical';

export interface TestResult {
  label: string;
  status: HealthStatus;
  badge: { label: string; color: string };
  /** Sanitised HTML from core. */
  description: string;
  /** Sanitised HTML from core. */
  actions: string;
  test: string;
}

export interface AsyncTest {
  id: string;
  label: string;
  /** REST route under /wp-json. */
  test: string;
  has_rest: true;
  headers?: Record<string, string>;
}

export interface SiteStatus {
  direct: TestResult[];
  async: AsyncTest[];
}

export interface Counts {
  good: number;
  recommended: number;
  critical: number;
}

export interface StoredResult extends Counts {
  time: string;
  score: number;
  status: 'good' | 'should_be_improved';
}

export type DebugValue = string | number | boolean | Record<string, string | number | boolean>;

export interface DebugField {
  label: string;
  value: DebugValue;
  debug?: DebugValue;
  private?: boolean;
}

export interface DebugSection {
  label: string;
  description?: string;
  show_count?: boolean;
  private?: boolean;
  fields: Record<string, DebugField>;
}

export interface SiteInfo {
  info: Record<string, DebugSection>;
  /** The text "Copy site info to clipboard" copies, private values left out. */
  copy: string;
}

export interface DirectorySize {
  size: string;
  debug: string;
  raw: number;
}

export function countResults(results: TestResult[]): Counts {
  const counts: Counts = { good: 0, recommended: 0, critical: 0 };
  for (const r of results) counts[r.status]++;
  return counts;
}

/**
 * recalculateProgression(): critical issues weigh 1.5, recommended ones 0.5;
 * 80 or more with no critical issue is "Good". Same formula as core's
 * overallStatus().
 */
export function overallStatus(counts: Counts): { score: number; good: boolean } {
  const total = counts.good + counts.recommended + counts.critical * 1.5;
  const failed = counts.recommended * 0.5 + counts.critical * 1.5;
  const score =
    total === 0 ? 100 : Math.min(100, Math.max(0, 100 - Math.ceil((failed / total) * 100)));
  return { score, good: score >= 80 && counts.critical === 0 };
}

/** "1 critical issue", "3 recommended improvements", "18 items with no issues detected". */
export function countHeading(status: HealthStatus, n: number): string {
  const formatted = n.toLocaleString('en');
  if (status === 'critical') return `${formatted} critical ${n === 1 ? 'issue' : 'issues'}`;
  if (status === 'recommended')
    return `${formatted} recommended ${n === 1 ? 'improvement' : 'improvements'}`;
  return `${formatted} ${n === 1 ? 'item' : 'items'} with no issues detected`;
}

/** addFailedSiteHealthCheckNotice(): an async test whose request failed. */
export function unavailableResult(test: AsyncTest, message: string): TestResult {
  const escapeHtml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    label: 'A test is unavailable',
    status: 'recommended',
    badge: { label: 'Unavailable', color: 'red' },
    description: `<p>${escapeHtml(test.label)}</p><p>${escapeHtml(message || 'No details available')}</p>`,
    actions: '',
    test: test.id,
  };
}

/** The Dashboard's sentence, from wp_dashboard_site_health(). */
export function dashboardMessage(counts: Counts): string {
  if (counts.recommended + counts.critical <= 0)
    return 'Great job! Your site currently passes all site health checks.';
  if (counts.critical === 1)
    return 'Your site has a critical issue that should be addressed as soon as possible to improve its performance and security.';
  if (counts.critical > 1)
    return 'Your site has critical issues that should be addressed as soon as possible to improve its performance and security.';
  if (counts.recommended === 1)
    return 'Your site’s health is looking good, but there is still one thing you can do to improve its performance and security.';
  return 'Your site’s health is looking good, but there are still some things you can do to improve its performance and security.';
}

/**
 * updateDirSizes(): puts the sizes into the Info sections and the copied
 * text, which carry "loading..." until they arrive.
 */
export function applySizes(
  data: SiteInfo,
  sizes: Record<string, DirectorySize | number>,
): SiteInfo {
  const section = data.info['wp-paths-sizes'];
  if (!section) return data;
  const fields = { ...section.fields };
  let copy = data.copy;
  for (const [name, size] of Object.entries(sizes)) {
    if (typeof size !== 'object' || !fields[name]) continue;
    fields[name] = { ...fields[name], value: size.size, debug: size.debug };
    copy = copy.replace(`${name}: loading...`, `${name}: ${size.debug}`);
  }
  return { info: { ...data.info, 'wp-paths-sizes': { ...section, fields } }, copy };
}

/** A field's value as text for the Info tables (name/value pairs come out as a list). */
export function displayValue(value: DebugValue): string | [string, string][] {
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([k, v]) => [k, String(v)]);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}
