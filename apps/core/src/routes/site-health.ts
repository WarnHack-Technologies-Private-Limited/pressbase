import { Hono } from 'hono';
import { z } from 'zod';
import { userCan } from '../auth/users';
import { type AppEnv, invalidParams, readJson, requireCapability, restError } from '../http';
import { formatDebugInfo } from '../site-health/debug-data';
import { overallStatus } from '../site-health/service';

/**
 * Site Health's REST API (Tools → Site Health). See docs/architecture/site-health.md.
 *
 * - `/pressbase/v1/site-health`: what wp-admin/site-health.php prints into the
 *   page: the direct tests' results, the async tests to run, the saved counts
 *   (the `health-check-site-status-result` transient, saved through
 *   wp_ajax_health_check_site_status_result() in WordPress) and the Info tab.
 * - `/wp-site-health/v1`: WP_REST_Site_Health_Controller's routes, at
 *   WordPress's paths: one per async test and `directory-sizes`.
 */

const CAPABILITY = 'view_site_health_checks';

const forbidden = (c: Parameters<typeof restError>[0], loggedIn: boolean) =>
  restError(c, loggedIn ? 403 : 401, 'rest_forbidden', 'Sorry, you are not allowed to do that.');

const countsBody = z.object({
  counts: z.object({
    good: z.number().int().min(0).max(10_000),
    recommended: z.number().int().min(0).max(10_000),
    critical: z.number().int().min(0).max(10_000),
  }),
});

export function siteHealthRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  app.use(requireCapability(CAPABILITY));

  /** The Status tab: direct results and the async tests (WP_Site_Health::enqueue_scripts()). */
  app.get('/', async (c) => {
    const health = c.get('kernel').siteHealth;
    const [direct, async] = await Promise.all([health.runDirect(), health.asyncTests()]);
    return c.json({ direct, async });
  });

  /** The saved counts and the overall rating, for the Dashboard. */
  app.get('/result', async (c) => {
    const stored = await c.get('kernel').siteHealth.storedResult();
    return c.json(stored ? { ...stored, ...overallStatus(stored) } : null);
  });

  /** wp_ajax_health_check_site_status_result(): the Status tab saves its counts when done. */
  app.post('/result', async (c) => {
    const parsed = countsBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const stored = await c.get('kernel').siteHealth.saveResult(parsed.data.counts);
    return c.json({ ...stored, ...overallStatus(stored) });
  });

  /** The Info tab: WP_Debug_Data::debug_data(), plus the text "Copy site info" copies. */
  app.get('/info', async (c) => {
    const info = await c.get('kernel').siteHealth.debugData();
    return c.json({ info, copy: formatDebugInfo(info, 'debug') });
  });

  return app;
}

export function wpSiteHealthRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  /**
   * validate_request_permission(): view_site_health_checks, unless the
   * `site_health_test_rest_capability_{check}` filter names another.
   */
  const allowed = async (c: Parameters<typeof restError>[0], check: string) => {
    const kernel = c.get('kernel');
    const capability = await kernel.hooks.applyFilters(
      `site_health_test_rest_capability_${check}`,
      CAPABILITY,
      check,
    );
    return userCan(c.get('user'), String(capability));
  };

  app.get('/directory-sizes', async (c) => {
    if (!(await allowed(c, 'directory_sizes'))) return forbidden(c, Boolean(c.get('user')));
    // A folder that takes too long reports a timeout message instead of a size.
    return c.json({ raw: 0, ...(await c.get('kernel').siteHealth.directorySizes()) });
  });

  app.get('/tests/:test', async (c) => {
    const health = c.get('kernel').siteHealth;
    const found = await health.findAsync(c.req.param('test'));
    if (!found) {
      return restError(c, 404, 'rest_no_route', 'No route was found matching the URL and request method.');
    }
    if (!(await allowed(c, found.id))) return forbidden(c, Boolean(c.get('user')));
    return c.json(await health.perform(found.id, found.test.label, found.test.async_direct_test));
  });

  return app;
}
