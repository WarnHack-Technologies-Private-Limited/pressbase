/**
 * Site Health's shapes, ported from WP_Site_Health and WP_Debug_Data
 * (wordpress/wp-admin/includes/class-wp-site-health.php,
 * class-wp-debug-data.php). Field names follow WordPress, so a test result
 * reads the same as the JSON WordPress's REST route
 * (WP_REST_Site_Health_Controller) returns.
 */

/** `good`, `recommended` or `critical`, as in WordPress. */
export type SiteHealthStatus = 'good' | 'recommended' | 'critical';

/** The badge colours WP_REST_Site_Health_Controller's schema allows. */
export type SiteHealthBadgeColor = 'blue' | 'orange' | 'red' | 'green' | 'purple' | 'gray';

/** What one test reports (the `site_status_test_result` filter's value). */
export interface SiteHealthTestResult {
  /** A headline describing the result: "Your site is using HTTPS". */
  label: string;
  status: SiteHealthStatus;
  /** The category: `Security`, `Performance`, `Privacy`… */
  badge: { label: string; color: SiteHealthBadgeColor };
  /** Why it matters, as basic HTML (`<p>`, `<a>`, `<code>`, lists). */
  description: string;
  /** Where to fix it: HTML, usually a `<p>` with a link. Empty when there's nothing to do. */
  actions: string;
  /** The test's identifier. */
  test: string;
}

export type SiteHealthTestCallback = () => SiteHealthTestResult | Promise<SiteHealthTestResult>;

/** A test that runs while the Status screen loads (`$tests['direct']`). */
export interface SiteHealthDirectTest {
  /** The friendly name of the test, shown while it runs. */
  label: string;
  /** Runs the test. (WordPress also takes a method name; Pressbase takes a function.) */
  test: SiteHealthTestCallback;
  /** Leave the test out of the weekly scheduled check. */
  skip_cron?: boolean;
}

/** A slower test the screen runs afterwards, one at a time, through REST (`$tests['async']`). */
export interface SiteHealthAsyncTest {
  label: string;
  /**
   * The REST route that runs the test, under `/wp-json` (for example
   * `/my-plugin/v1/health`). Optional when `async_direct_test` is given: core
   * then serves it at `/wp-site-health/v1/tests/{test-id}`.
   */
  test?: string;
  /** Whether `test` is a REST route. Pressbase only calls REST routes. */
  has_rest?: boolean;
  /** Runs the test in-process: for the scheduled check, and for core's generic route. */
  async_direct_test?: SiteHealthTestCallback;
  /** Extra request headers for the REST call. */
  headers?: Record<string, string>;
  skip_cron?: boolean;
}

/** The `site_status_tests` filter's value: WP_Site_Health::get_tests(). */
export interface SiteStatusTests {
  direct: Record<string, SiteHealthDirectTest>;
  async: Record<string, SiteHealthAsyncTest>;
}

/** A plain value for the Info screen: text, a number, a yes/no, or one level of name/value pairs. */
export type DebugValue = string | number | boolean | Record<string, string | number | boolean>;

/** One row of an Info section. */
export interface DebugField {
  label: string;
  /** What the screen shows. */
  value: DebugValue;
  /** What "Copy site info" copies instead: shorter, untranslated. Defaults to `value`. */
  debug?: DebugValue;
  /** Shown on screen but left out of the copied text (API keys, database credentials). */
  private?: boolean;
}

/** One section of the Info screen. */
export interface DebugSection {
  label: string;
  /** May hold inline HTML. */
  description?: string;
  /** Adds the number of fields to the title: "Active plugins (3)". */
  show_count?: boolean;
  /** Leave the whole section out of the copied text. */
  private?: boolean;
  fields: Record<string, DebugField>;
}

/**
 * The `debug_information` filter's value: sections keyed by ID. Core's IDs
 * start with `wp-` (WordPress's) or `pressbase-`; plugins should prefix
 * theirs with their slug.
 */
export type DebugInfo = Record<string, DebugSection>;

/** The counts the Status screen saves for the Dashboard (`health-check-site-status-result`). */
export interface SiteHealthCounts {
  good: number;
  recommended: number;
  critical: number;
}

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    /** Which tests run: add, replace or remove direct and async tests. */
    site_status_tests: [tests: SiteStatusTests];
    /** Every finished test's result, before it is shown or counted. */
    site_status_test_result: [result: SiteHealthTestResult];
    /** The Info screen's sections: add your own, or fields to core's. */
    debug_information: [info: DebugInfo];
  }
  interface ActionRegistry {
    /** The weekly scheduled check (WP_Site_Health::wp_cron_scheduled_check()). */
    wp_site_health_scheduled_check: [];
  }
}
