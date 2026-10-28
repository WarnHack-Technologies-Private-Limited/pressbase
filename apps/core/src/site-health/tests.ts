import { access, constants, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pendingMigrations, resultRows, schema } from '@pressbase/db';
import { and, count, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { mediaStorage } from '../media/service';
import { LocalStorage } from '../media/storage';
import { compareVersions, parseVersion } from '../plugins/semver';
import { DEFAULT_THEME } from '../themes/service';
import { DB_VERSION, PRESSBASE_VERSION } from '../version';
import { actionLink, esc, paragraphs, sizeFormat } from './html';
import type { HealthResponse, SiteHealth } from './service';
import type { SiteHealthTestResult, SiteStatusTests } from './types';

/**
 * Core's Site Health tests: the ones WP_Site_Health::get_tests() runs that
 * mean something on Node.js and PostgreSQL (wordpress/wp-admin/includes/
 * class-wp-site-health.php), under WordPress's names where they exist, plus
 * Pressbase's own. Each returns WordPress's result shape.
 */

const SECURITY = { label: 'Security', color: 'blue' } as const;
const PERFORMANCE = { label: 'Performance', color: 'blue' } as const;
const PRIVACY = { label: 'Privacy', color: 'blue' } as const;

/** Node.js majors before this, or 22 before 22.12, can't run Pressbase (package.json engines). */
export const MIN_NODE = { major: 22, minor: 12 };
/** PostgreSQL 14+ is the supported database (ADR 0002). */
export const MIN_POSTGRES_MAJOR = 14;
/** WordPress's site_status_autoloaded_options_size_limit default. */
export const AUTOLOAD_LIMIT = 800_000;

const DAY = 86_400_000;

function result(
  test: string,
  badge: SiteHealthTestResult['badge'],
  label: string,
  description: string,
  actions = '',
): SiteHealthTestResult {
  return { label, status: 'good', badge: { ...badge }, description, actions, test };
}

const isProduction = () => process.env.NODE_ENV === 'production';

/** Hosts where HTTP is expected: wp_is_application_passwords_supported()'s local environment. */
export function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      ['localhost', '127.0.0.1', '::1'].includes(host) ||
      host.endsWith('.localhost') ||
      host.endsWith('.test')
    );
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- runtime */

/** get_test_php_version(), for Node.js. */
export function nodeVersionTest(version = process.versions.node): SiteHealthTestResult {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const r = result(
    'node_version',
    PERFORMANCE,
    `Your site is running a current version of Node.js (${version})`,
    paragraphs(
      'Node.js runs Pressbase’s core. Newer long-term support (LTS) releases are faster and get security fixes.',
    ),
    actionLink(
      'https://nodejs.org/en/about/previous-releases',
      'Learn more about Node.js releases',
    ),
  );
  if (major < MIN_NODE.major || (major === MIN_NODE.major && minor < MIN_NODE.minor)) {
    r.status = 'critical';
    r.label = `Your site is running an unsupported version of Node.js (${version})`;
    r.description = paragraphs(
      `Pressbase needs Node.js ${MIN_NODE.major}.${MIN_NODE.minor} or newer. Some features may fail, and this version no longer gets security fixes. Update to the current LTS release.`,
    );
  } else if (major % 2 === 1) {
    r.status = 'recommended';
    r.label = `Your site is running a short-lived Node.js release (${version})`;
    r.description = paragraphs(
      'Odd-numbered Node.js releases are supported for only a few months and never become long-term support (LTS) releases. Use an even-numbered LTS release for a live site.',
    );
  }
  return r;
}

/** Pressbase: NODE_ENV (WordPress's get_test_is_in_debug_mode() plays this role). */
export function nodeEnvTest(value = process.env.NODE_ENV): SiteHealthTestResult {
  const r = result(
    'node_env',
    PERFORMANCE,
    'Node.js is running in production mode',
    paragraphs(
      '<code>NODE_ENV</code> is <code>production</code>, so libraries skip development-only checks and logging.',
    ),
  );
  if (value !== 'production') {
    r.status = 'recommended';
    r.label = 'Node.js isn’t running in production mode';
    r.description = paragraphs(
      `<code>NODE_ENV</code> is ${value ? `<code>${esc(value)}</code>` : 'not set'}. In development mode, libraries run extra checks and log more, which slows a live site down.`,
      'Set <code>NODE_ENV=production</code> where you start Pressbase’s core.',
    );
  }
  return r;
}

/* --------------------------------------------------------------- database */

function databaseDriverTest(health: SiteHealth): SiteHealthTestResult {
  const r = result(
    'database_driver',
    PERFORMANCE,
    'Your site uses PostgreSQL',
    paragraphs(
      'PostgreSQL keeps your content safe, can be backed up while the site runs, and lets several Pressbase processes share one database.',
    ),
  );
  if (health.kernel.connection.driver === 'pglite') {
    r.status = isProduction() ? 'critical' : 'recommended';
    r.label = 'Your site uses the built-in database';
    r.description = paragraphs(
      'The built-in database is for trying Pressbase and for tests. It runs inside the core process, only that one process can use it, and it can’t be backed up while the site runs.',
      'Move to PostgreSQL before your site goes live.',
    );
    r.actions = actionLink(
      'https://github.com/WarnHack-Technologies-Private-Limited/pressbase/blob/main/docs/architecture/database.md',
      'Read about databases',
    );
  }
  return r;
}

/** get_test_sql_server(), for PostgreSQL. */
async function sqlServerTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const version = await health.postgresVersion();
  const builtIn = health.kernel.connection.driver === 'pglite';
  const r = result(
    'sql_server',
    PERFORMANCE,
    builtIn
      ? `The built-in database runs PostgreSQL ${version.text}`
      : `PostgreSQL is up to date (${version.text})`,
    paragraphs(
      `Pressbase needs PostgreSQL ${MIN_POSTGRES_MAJOR} or newer. Newer versions are faster and get security fixes.`,
    ),
  );
  if (version.major < MIN_POSTGRES_MAJOR) {
    r.status = 'critical';
    r.label = `Your PostgreSQL version is too old (${version.text})`;
    r.description = paragraphs(
      `Pressbase needs PostgreSQL ${MIN_POSTGRES_MAJOR} or newer, and some features won’t work on ${esc(version.text)}. Ask your host to upgrade the database server.`,
    );
  }
  return r;
}

async function databaseMigrationsTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const { kernel } = health;
  const pending = await pendingMigrations(kernel.db);
  const dataVersion = await kernel.options.get<number>('pressbase_db_version', 0);
  const r = result(
    'database_migrations',
    PERFORMANCE,
    'Your database is up to date',
    paragraphs('Pressbase applies database updates each time core starts.'),
  );
  if (pending.length || dataVersion < DB_VERSION) {
    r.status = 'critical';
    r.label = 'Database updates haven’t been applied';
    const items = [
      ...pending.map((tag) => `<li><code>${esc(tag)}</code></li>`),
      ...(dataVersion < DB_VERSION
        ? [`<li>Data upgrade from version ${dataVersion} to ${DB_VERSION}</li>`]
        : []),
    ];
    r.description = `${paragraphs(
      'Pressbase expects a newer database than this one. Parts of your site may fail until these updates run:',
    )}<ul>${items.join('')}</ul>${paragraphs(
      'Restart Pressbase’s core: it applies pending updates when it starts. If they fail again, its log says why.',
    )}`;
  }
  return r;
}

/* --------------------------------------------------------------- security */

/** get_test_https_status(), from the Site Address and WordPress Address options. */
async function httpsStatusTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const { options } = health.kernel;
  const home = await options.get<string>('home', '');
  const siteurl = await options.get<string>('siteurl', home);
  const r = result(
    'https_status',
    SECURITY,
    'Your website is using an active HTTPS connection',
    paragraphs(
      'An HTTPS connection is a more secure way of browsing the web. It protects your visitors’ privacy and your logins, and browsers warn about sites without it.',
    ),
    actionLink(
      'https://developer.wordpress.org/advanced-administration/security/https/',
      'Learn more about why you should use HTTPS',
    ),
  );
  const insecure = [home, siteurl].filter((url) => !url.startsWith('https://'));
  if (insecure.length) {
    const local = insecure.every(isLocalHost);
    r.status = isProduction() && !local ? 'critical' : 'recommended';
    r.label = 'Your website does not use HTTPS';
    r.description = paragraphs(
      `Your site address (<code>${esc(home)}</code>) is not set up to use HTTPS.`,
      local
        ? 'That’s fine on this computer, but use HTTPS once the site is online: session cookies are only marked secure over HTTPS, and application passwords only work over it.'
        : 'Put Pressbase behind a server or proxy with a TLS certificate (Caddy, nginx, or your host’s load balancer), then change the site address to start with https://.',
    );
    r.actions = actionLink('/admin/settings/general', 'Change the site address');
  }
  return r;
}

/** wp_is_application_passwords_supported()'s HTTPS rule. */
function applicationPasswordsTest(): SiteHealthTestResult {
  const r = result(
    'application_passwords',
    SECURITY,
    'Application passwords are only accepted over HTTPS',
    paragraphs(
      'Application passwords travel with every API request, so Pressbase only accepts them over HTTPS, or from this computer during development.',
    ),
  );
  if (process.env.PRESSBASE_ALLOW_HTTP_APP_PASSWORDS === '1') {
    r.status = 'recommended';
    r.label = 'Application passwords are accepted over plain HTTP';
    r.description = paragraphs(
      '<code>PRESSBASE_ALLOW_HTTP_APP_PASSWORDS=1</code> lets API clients send application passwords without encryption. Anyone on the network between them and your site could read and reuse them.',
      'Keep it only on a trusted private network, or remove it and use HTTPS.',
    );
  }
  return r;
}

function setupTokenTest(health: SiteHealth): SiteHealthTestResult {
  const r = result(
    'setup_token',
    SECURITY,
    'The installer is closed',
    paragraphs('Your site is installed, so the installer no longer accepts requests.'),
  );
  if (health.kernel.config.setupToken) {
    r.status = 'recommended';
    r.label = 'The setup code is still set';
    r.description = paragraphs(
      '<code>PRESSBASE_SETUP_TOKEN</code> protected the installer, which closed when your site was installed. The code is no longer needed.',
      'Remove the variable from core’s environment, so the code doesn’t linger in configuration files and process listings.',
    );
  }
  return r;
}

/** get_test_insecure_registration() (WordPress 7.0). */
async function insecureRegistrationTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const { options } = health.kernel;
  const open = await options.get<boolean>('users_can_register', false);
  const role = await options.get<string>('default_role', 'subscriber');
  const r = result(
    'insecure_registration',
    SECURITY,
    'Registration doesn’t give new accounts a privileged role',
    paragraphs(
      'The combination of open registration setting and the default user role may lead to security issues.',
    ),
  );
  if (open && ['editor', 'administrator'].includes(role)) {
    r.status = 'critical';
    r.label = 'Open registration with a privileged default role';
    r.description = paragraphs(
      'Registration is open to anyone, and the default role is set to a privileged role.',
    );
    r.actions = actionLink('/admin/settings/general', 'Change these settings');
  }
  return r;
}

/* ------------------------------------------------------------------- mail */

function mailTest(health: SiteHealth): SiteHealthTestResult {
  const { mail } = health.kernel;
  const r = result(
    'mail',
    PERFORMANCE,
    'Emails are sent through SMTP',
    paragraphs(
      'Password resets, new account emails and comment notifications go through your SMTP server.',
    ),
  );
  if (mail.transport === 'outbox') {
    r.status = isProduction() ? 'critical' : 'recommended';
    r.label = 'Emails are saved to a folder instead of being sent';
    r.description = paragraphs(
      `No SMTP server is set up, so emails such as password resets are written to <code>${esc(mail.outboxDir)}</code> and nobody receives them.`,
      'Set <code>PRESSBASE_SMTP_URL</code> (or <code>PRESSBASE_SMTP_HOST</code> and its companions) and <code>PRESSBASE_MAIL_FROM</code> for core, then restart it.',
    );
  }
  return r;
}

/* -------------------------------------------------------- background work */

async function jobWorkerTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const { kernel } = health;
  const r = result(
    'job_worker',
    PERFORMANCE,
    'Background tasks are running',
    paragraphs(
      'A worker in Pressbase’s core runs scheduled posts, scheduled events and plugins’ background tasks on time.',
    ),
  );
  if (kernel.jobs.workerRunning) return r;
  const handlers = kernel.jobs.handlers();
  const [row] = handlers.length
    ? await kernel.db
        .select({ n: count() })
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.status, 'pending'),
            lt(schema.jobs.runAt, new Date(Date.now() - 5 * 60_000)),
            inArray(schema.jobs.name, handlers),
          ),
        )
    : [{ n: 0 }];
  const overdue = row?.n ?? 0;
  if (overdue > 0) {
    r.status = 'critical';
    r.label = 'Background tasks aren’t running';
    r.description = paragraphs(
      `${overdue} ${overdue === 1 ? 'task is' : 'tasks are'} more than five minutes overdue, and this core process doesn’t run the worker (<code>PRESSBASE_WORKER=off</code>).`,
      'Start one core process without <code>PRESSBASE_WORKER=off</code>. Scheduled posts still go live when someone views your content, but scheduled events and plugin tasks wait.',
    );
  } else {
    r.status = 'recommended';
    r.label = 'This process doesn’t run background tasks';
    r.description = paragraphs(
      'The worker is turned off in this core process (<code>PRESSBASE_WORKER=off</code>). That’s fine when another process sharing the database runs it, and nothing is overdue right now.',
    );
  }
  r.actions = actionLink('/admin/settings/scheduled-tasks', 'View scheduled tasks');
  return r;
}

/**
 * get_test_scheduled_events(): an event more than a minute overdue is late,
 * more than five minutes overdue has been missed. WordPress waits for a page
 * view to run cron; Pressbase's worker checks at least every 15 seconds, so
 * the grace is shorter than wp-cron's.
 */
async function scheduledEventsTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const { kernel } = health;
  const r = result(
    'scheduled_events',
    PERFORMANCE,
    'Scheduled events are running',
    paragraphs(
      'Scheduled events publish scheduled posts on time, clean up old data, and run plugins’ planned tasks.',
    ),
  );
  // Events of deactivated plugins wait on purpose (docs/architecture/jobs.md#plugins).
  const names = kernel.jobs
    .handlers()
    .filter((name) => name === 'cron' || name.startsWith('cron:'));
  if (!names.length) return r;
  const [oldest] = await kernel.db
    .select({ data: schema.jobs.data, runAt: schema.jobs.runAt })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.status, 'pending'),
        inArray(schema.jobs.name, names),
        lt(schema.jobs.runAt, new Date(Date.now() - 60_000)),
      ),
    )
    .orderBy(schema.jobs.runAt)
    .limit(1);
  if (!oldest) return r;
  const hook = esc((oldest.data as { hook?: string }).hook ?? 'unknown');
  const minutes = Math.round((Date.now() - oldest.runAt.getTime()) / 60_000);
  r.status = 'recommended';
  if (minutes >= 5) {
    r.label = 'A scheduled event didn’t run';
    r.description = paragraphs(
      `The scheduled event, <code>${hook}</code>, should have run ${minutes} minutes ago. Your site still works, but scheduled posts and plugins’ planned tasks may not run on time. Check that a worker is running.`,
    );
  } else {
    r.label = 'A scheduled event is late';
    r.description = paragraphs(
      `The scheduled event, <code>${hook}</code>, is late to run. Your site still works, but this may indicate that scheduled posts or plugins’ planned tasks may not run as intended.`,
    );
  }
  r.actions = actionLink('/admin/settings/scheduled-tasks', 'View scheduled tasks');
  return r;
}

async function failedJobsTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const { kernel } = health;
  const since = new Date(Date.now() - 7 * DAY);
  const [row] = await kernel.db
    .select({ n: count() })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.status, 'failed'), gte(schema.jobs.finishedAt, since)));
  const failed = row?.n ?? 0;
  const r = result(
    'failed_jobs',
    PERFORMANCE,
    'No background tasks have failed recently',
    paragraphs('None of the tasks that ran in the past week failed on their last attempt.'),
  );
  if (failed > 0) {
    const [latest] = await kernel.jobs.list({ status: 'failed', limit: 1 });
    const hook = (latest?.data as { hook?: unknown } | null)?.hook;
    const name = typeof hook === 'string' ? hook : (latest?.name ?? '');
    const error = (latest?.lastError ?? '').split('\n')[0] ?? '';
    r.status = 'recommended';
    r.label =
      failed === 1
        ? 'A background task failed recently'
        : `${failed} background tasks failed recently`;
    r.description = paragraphs(
      `Tasks that fail are retried, and these ran out of attempts in the past week. The latest was <code>${esc(name)}</code>${error ? `: ${esc(error)}` : '.'}`,
      'A plugin’s failing task usually means it needs updating, or a service it talks to was down.',
    );
    r.actions = actionLink('/admin/settings/scheduled-tasks', 'See what failed');
  }
  return r;
}

/* ------------------------------------------------------------ public site */

/**
 * get_test_page_cache(), for Pressbase's page cache: is it configured, and
 * does apps/web accept core's purges? Sends a purge for a tag no page has,
 * so nothing is dropped.
 */
async function pageCacheTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const config = health.kernel.config.revalidate;
  const r = result(
    'page_cache',
    PERFORMANCE,
    'Page caching is on',
    paragraphs(
      'The public site keeps rendered pages and serves repeat visits from memory. Core tells it which pages to drop when content changes.',
    ),
  );
  if (!config) {
    r.status = 'recommended';
    r.label = 'Page caching is off';
    r.description = paragraphs(
      'Every visit to the public site renders the page again. Caching makes pages much faster and lets the site handle more visitors.',
      'Set the same <code>PRESSBASE_REVALIDATE_SECRET</code> (16 or more random characters) for core and the public site, and <code>WEB_URL</code> for core, then restart both.',
    );
    return r;
  }
  for (const url of config.urls) {
    const endpoint = `${url.replace(/\/+$/, '')}/_pressbase/revalidate`;
    const response = await health.request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.secret}` },
      body: JSON.stringify({ tags: ['pressbase-site-health'] }),
    });
    if (response instanceof Error) {
      r.status = 'critical';
      r.label = 'Core can’t reach the public site to update its cache';
      r.description = paragraphs(
        `A request to <code>${esc(endpoint)}</code> failed: ${esc(response.message)}`,
        'Visitors may see out-of-date pages for up to a day. Check that <code>WEB_URL</code> is where the public site listens, as seen from core.',
      );
      return r;
    }
    if (response.status === 401) {
      r.status = 'critical';
      r.label = 'The public site refused core’s cache updates';
      r.description = paragraphs(
        `<code>${esc(url)}</code> answered “invalid secret”: <code>PRESSBASE_REVALIDATE_SECRET</code> differs between core and the public site, so changes don’t reach the cache and visitors may see out-of-date pages.`,
        'Set the same value for both and restart them.',
      );
      return r;
    }
    if (response.status === 404) {
      r.status = 'recommended';
      r.label = 'The public site doesn’t cache pages';
      r.description = paragraphs(
        `Core has a cache secret, but <code>${esc(url)}</code> doesn’t: its caching is off. Set the same <code>PRESSBASE_REVALIDATE_SECRET</code> for the public site and restart it.`,
      );
      return r;
    }
    if (!response.ok) {
      r.status = 'recommended';
      r.label = 'The public site’s cache answered unexpectedly';
      r.description = paragraphs(
        `<code>${esc(endpoint)}</code> answered ${response.status}. Check the public site’s log.`,
      );
      return r;
    }
  }
  return r;
}

/**
 * get_test_loopback_requests(): can the site reach itself? Core asks for the
 * REST index at the site address (through the admin's proxy, as visitors
 * reach it) and for robots.txt from the public site (which asks core to
 * render it). A connection failure is critical, an unexpected answer
 * recommended, as WP_Site_Health::can_perform_loopback() rates them.
 */
async function loopbackTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const home = (await health.kernel.options.get<string>('home', '')).replace(/\/+$/, '');
  const r = result(
    'loopback_requests',
    PERFORMANCE,
    'Your site can perform loopback requests',
    paragraphs(
      'The admin and the public site reach core over HTTP. If they can’t, pages and admin screens fail to load for visitors even though core is running.',
    ),
  );
  const checks: {
    what: string;
    url: string;
    ok: (res: HealthResponse, body: string) => boolean;
  }[] = [
    {
      what: 'the site address',
      url: `${home}/wp-json/`,
      ok: (res, body) => res.ok && body.includes('"pressbase"'),
    },
    ...health.webUrls().map((web) => ({
      what: 'the public site',
      url: `${web.replace(/\/+$/, '')}/robots.txt`,
      ok: (res: HealthResponse, body: string) => res.ok && /user-agent/i.test(body),
    })),
  ];
  const problems: string[] = [];
  for (const check of checks) {
    const response = await health.request(check.url);
    if (response instanceof Error) {
      r.status = 'critical';
      problems.push(
        `Core couldn’t reach ${check.what} at <code>${esc(check.url)}</code>: ${esc(response.message)}`,
      );
      continue;
    }
    const body = await response.text().catch(() => '');
    if (!check.ok(response, body)) {
      if (r.status === 'good') r.status = 'recommended';
      problems.push(
        `${check.what[0]?.toUpperCase()}${check.what.slice(1)} at <code>${esc(check.url)}</code> answered ${response.status} without Pressbase’s response.`,
      );
    }
  }
  if (problems.length) {
    r.label = 'Your site could not complete a loopback request';
    r.description = paragraphs(
      ...problems,
      'Check that the site address in General settings is right, and that <code>CORE_URL</code> is set for the admin and the public site.',
    );
    r.actions = actionLink('/admin/settings/general', 'Check the site address');
  }
  return r;
}

/* ------------------------------------------------------------------ media */

/** get_test_file_uploads(), for Pressbase's upload folder. */
async function uploadsTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const storage = mediaStorage(health.kernel);
  const r = result(
    'file_uploads',
    PERFORMANCE,
    'Files can be uploaded',
    paragraphs('Uploaded media is stored in a folder Pressbase can write to.'),
  );
  if (!(storage instanceof LocalStorage)) {
    r.description = paragraphs(
      `Media is stored by a storage adapter (${esc(storage.constructor.name)}).`,
    );
    return r;
  }
  try {
    await mkdir(storage.root, { recursive: true });
    await access(storage.root, constants.W_OK);
    r.description = paragraphs(`Uploaded media is stored in <code>${esc(storage.root)}</code>.`);
  } catch {
    r.status = 'critical';
    r.label = 'Files can’t be uploaded';
    r.description = paragraphs(
      `Pressbase can’t write to <code>${esc(storage.root)}</code>, so uploads fail.`,
      'Make the folder writable by the user core runs as.',
    );
  }
  return r;
}

/** get_test_available_updates_disk_space(), for the data directory. */
async function diskSpaceTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const r = result('available_disk_space', PERFORMANCE, 'There is enough disk space', '');
  const free = await health.freeDiskSpace();
  if (free === null) {
    r.status = 'recommended';
    r.label = 'The free disk space couldn’t be checked';
    r.description = paragraphs(
      'Make sure the disk holding the data directory has room for uploads and the database.',
    );
    return r;
  }
  r.description = paragraphs(
    `${sizeFormat(free)} is free on the disk holding the data directory, for uploads, the outbox and plugins.`,
  );
  if (free < 100 * 1024 ** 2) {
    r.status = 'critical';
    r.label = 'The disk is nearly full';
    r.description = paragraphs(
      `Only ${sizeFormat(free)} is free on the disk holding the data directory. Uploads and plugin installs will fail when it runs out. Free up space or move to a larger disk.`,
    );
  } else if (free < 1024 ** 3) {
    r.status = 'recommended';
    r.label = 'Disk space is running low';
    r.description = paragraphs(
      `${sizeFormat(free)} is free on the disk holding the data directory. Uploads need room; free up space before it runs out.`,
    );
  }
  return r;
}

/** Pressbase: sharp, which resizes images (WordPress's GD and Imagick checks in get_test_php_extensions()). */
async function imageProcessingTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const r = result('image_processing', PERFORMANCE, 'Images can be resized', '');
  const sharp = await health.sharpInfo();
  if (sharp instanceof Error) {
    r.status = 'critical';
    r.label = 'Images can’t be processed';
    r.description = paragraphs(
      `The image library, sharp, failed: ${esc(sharp.message)}`,
      'Uploads still work, but no thumbnails or smaller sizes are made. Reinstall Pressbase’s dependencies on this machine (<code>pnpm install</code>), so sharp gets the build for this system.',
    );
    return r;
  }
  r.description = paragraphs(
    `sharp ${esc(sharp.sharp)} (libvips ${esc(sharp.vips)}) makes thumbnails and smaller image sizes. It can write ${sharp.formats.map(esc).join(', ')}.`,
  );
  return r;
}

/* -------------------------------------------------------- plugins, themes */

async function pluginErrorsTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const { plugins } = health.kernel;
  const [errors, discovered] = await Promise.all([plugins.errors(), plugins.discover()]);
  const runtime: string[] = [];
  for (const plugin of discovered.plugins) {
    if (!plugins.isLoaded(plugin.slug)) continue;
    const status = await plugins.status(plugin);
    if (status.runtimeErrors.length) runtime.push(plugin.manifest.title || plugin.slug);
  }
  const stopped = Object.keys(errors);
  const r = result(
    'plugin_errors',
    PERFORMANCE,
    'Your plugins are running without errors',
    paragraphs('Every active plugin loaded, and none has reported an error since.'),
  );
  const items = [
    ...stopped.map(
      (slug) =>
        `<li><strong>${esc(slug)}</strong> was stopped: ${esc(errors[slug]?.message ?? '')}</li>`,
    ),
    ...runtime.map(
      (title) => `<li><strong>${esc(title)}</strong> reported errors while running</li>`,
    ),
    ...discovered.invalid.map(
      (p) => `<li><strong>${esc(p.slug)}</strong> can’t be loaded: ${esc(p.error)}</li>`,
    ),
  ];
  if (!items.length) return r;
  r.status = stopped.length ? 'critical' : 'recommended';
  r.label = stopped.length ? 'A plugin was stopped by an error' : 'Plugins are reporting errors';
  r.description = `${paragraphs(
    'When a plugin fails to load, Pressbase deactivates it so your site keeps working, and what it adds to your site is missing until it’s fixed.',
  )}<ul>${items.join('')}</ul>`;
  r.actions = actionLink('/admin/plugins', 'Go to Plugins');
  return r;
}

/** get_test_plugin_version()'s inactive plugins part. */
async function inactivePluginsTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const { plugins } = health.kernel;
  const [{ plugins: installed }, active] = await Promise.all([
    plugins.discover(),
    plugins.activeSlugs(),
  ]);
  // Bundled plugins ship with Pressbase and can't be deleted.
  const inactive = installed.filter((p) => p.source === 'site' && !active.includes(p.slug));
  const r = result(
    'inactive_plugins',
    SECURITY,
    'You have no inactive plugins',
    paragraphs(
      'Plugins extend your site’s functionality with things like contact forms, ecommerce and much more. That means they have deep access to your site, so it’s vital to keep them up to date.',
    ),
  );
  if (inactive.length) {
    r.status = 'recommended';
    r.label = 'You should remove inactive plugins';
    r.description = paragraphs(
      `Your site has ${inactive.length} inactive ${inactive.length === 1 ? 'plugin' : 'plugins'}. Inactive plugins are tempting targets for attackers. If you’re not going to use a plugin, you should consider removing it.`,
    );
    r.actions = actionLink('/admin/plugins?plugin_status=inactive', 'Manage inactive plugins');
  }
  return r;
}

/** get_test_theme_version()'s inactive themes part. */
async function inactiveThemesTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const { kernel } = health;
  const siteThemes = path.join(kernel.config.dataDir, 'themes');
  const [themes, active] = await Promise.all([
    kernel.themes.all(),
    kernel.themes.activeStylesheet(),
  ]);
  const activeTheme = themes.find((t) => t.stylesheet === active);
  const keep = new Set([active, activeTheme?.template, DEFAULT_THEME]);
  // Only themes in the data directory can be removed; bundled ones ship with Pressbase.
  const inactive = themes.filter(
    (t) => !keep.has(t.stylesheet) && path.dirname(t.dir) === siteThemes,
  );
  const r = result(
    'inactive_themes',
    SECURITY,
    'You have no inactive themes',
    paragraphs(
      'Themes add your site’s look and feel. Keep the active theme and the default theme as a fallback, and remove the rest.',
    ),
  );
  if (inactive.length) {
    r.status = 'recommended';
    r.label = 'You should remove inactive themes';
    r.description = paragraphs(
      `Your site has ${inactive.length} inactive ${inactive.length === 1 ? 'theme' : 'themes'} (${inactive.map((t) => esc(t.name)).join(', ')}). To enhance your site’s security, you should consider removing any themes you’re not using. You should keep your active theme, and the default theme, Twenty Twenty-Five, as a fallback.`,
      `Delete a theme by removing its folder from <code>${esc(siteThemes)}</code>.`,
    );
    r.actions = actionLink('/admin/appearance', 'Manage your themes');
  }
  return r;
}

/** get_test_search_engine_visibility(). */
async function searchEngineVisibilityTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const r = result(
    'search_engine_visibility',
    PRIVACY,
    'Search engine indexing is enabled.',
    paragraphs('Search engines can crawl and index your site. No action needed.'),
    actionLink('/admin/settings/reading', 'Review your visibility settings'),
  );
  if (!(await health.kernel.options.get<boolean>('blog_public', true))) {
    r.status = 'recommended';
    r.label = 'Search engines are discouraged from indexing this site.';
    r.description = paragraphs(
      'Your site is hidden from search engines. Consider enabling indexing if this is a public site.',
    );
  }
  return r;
}

/** Pressbase: the site's time zone (WordPress's get_test_php_default_timezone() checks PHP's). */
async function timezoneTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const value = await health.kernel.options.get<string | undefined>('timezone_string', undefined);
  const r = result(
    'timezone',
    PERFORMANCE,
    `Your site’s time zone is set (${value ?? 'UTC'})`,
    paragraphs('Post dates, scheduled posts and comment times use the site’s time zone.'),
  );
  let valid = Boolean(value);
  try {
    if (value) new Intl.DateTimeFormat('en', { timeZone: value });
  } catch {
    valid = false;
  }
  if (!valid) {
    r.status = 'recommended';
    r.label = value ? 'Your site’s time zone isn’t valid' : 'Your site’s time zone isn’t set';
    r.description = paragraphs(
      `${value ? `<code>${esc(value)}</code> isn’t a time zone this server knows, so` : 'Without one,'} dates use UTC, and scheduled posts may go out at unexpected times. Choose the city nearest you.`,
    );
    r.actions = actionLink('/admin/settings/general', 'Set the time zone');
  }
  return r;
}

/** get_test_autoloaded_options(). */
async function autoloadedOptionsTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const [row] = resultRows<{ n: number | string; size: number | string }>(
    await health.kernel.db.execute(
      sql`select count(*)::int as n, coalesce(sum(length(${schema.options.value}::text)), 0)::bigint as size from ${schema.options} where ${schema.options.autoload} = true`,
    ),
  );
  const n = Number(row?.n ?? 0);
  const size = Number(row?.size ?? 0);
  const base =
    'Autoloaded options are configuration settings for plugins and themes that are automatically loaded when Pressbase starts and kept in memory. Having too many autoloaded options can slow down your site.';
  const r = result(
    'autoloaded_options',
    PERFORMANCE,
    'Autoloaded options are acceptable',
    paragraphs(
      `${base} Your site has ${n} autoloaded options (size: ${sizeFormat(size)}) in the options table, which is acceptable.`,
    ),
  );
  if (size >= AUTOLOAD_LIMIT) {
    r.status = 'critical';
    r.label = 'Autoloaded options could affect performance';
    r.description = paragraphs(
      `${base} Your site has ${n} autoloaded options (size: ${sizeFormat(size)}) in the options table, which could cause your site to be slow. You can review the options being autoloaded in your database and remove any options that are no longer needed by your site.`,
    );
  }
  return r;
}

/* ---------------------------------------------------------------- version */

/** get_test_wordpress_version(), against Pressbase's GitHub releases. Async and cached. */
async function pressbaseVersionTest(health: SiteHealth): Promise<SiteHealthTestResult> {
  const r = result(
    'pressbase_version',
    SECURITY,
    `Your version of Pressbase (${PRESSBASE_VERSION}) is up to date`,
    paragraphs('New releases bring fixes, including security fixes, and new features.'),
  );
  const check = await health.latestRelease();
  if (check.state === 'off') {
    r.label = `Pressbase ${PRESSBASE_VERSION} is installed`;
    r.description = paragraphs(
      'Checking for new releases is turned off (<code>PRESSBASE_UPDATE_CHECK=off</code>). Watch the project’s releases on GitHub to hear about updates.',
    );
    return r;
  }
  if (check.state === 'error') {
    r.label = `Pressbase ${PRESSBASE_VERSION} is installed`;
    r.description = paragraphs(
      `Pressbase couldn’t check GitHub for a newer release just now (${esc(check.error)}). It will try again later.`,
    );
    return r;
  }
  const current = parseVersion(PRESSBASE_VERSION);
  const latest = parseVersion(check.version);
  if (current && latest && compareVersions(latest, current) > 0) {
    r.status = 'recommended';
    r.label = `Pressbase ${check.version} is available`;
    r.description = paragraphs(
      `You’re running Pressbase ${PRESSBASE_VERSION}. The latest release is ${esc(check.version)}. Read its notes, back up your database and data directory, then update.`,
    );
    r.actions = actionLink(check.url, `See what’s new in ${check.version}`);
  }
  return r;
}

/* ------------------------------------------------------------------ list */

/** WP_Site_Health::get_tests(), before the `site_status_tests` filter. */
export function coreTests(health: SiteHealth): SiteStatusTests {
  const direct = (label: string, test: (h: SiteHealth) => unknown) => ({
    label,
    test: () => test(health) as Promise<SiteHealthTestResult>,
  });
  const route = (id: string) => `/wp-site-health/v1/tests/${id.replace(/_/g, '-')}`;
  const async = (id: string, label: string, test: (h: SiteHealth) => unknown) => ({
    label,
    test: route(id),
    has_rest: true,
    async_direct_test: () => test(health) as Promise<SiteHealthTestResult>,
  });
  return {
    direct: {
      node_version: direct('Node.js version', () => nodeVersionTest()),
      node_env: direct('Node.js environment', () => nodeEnvTest()),
      database_driver: direct('Database', databaseDriverTest),
      sql_server: direct('Database server version', sqlServerTest),
      database_migrations: direct('Database updates', databaseMigrationsTest),
      application_passwords: direct('Application passwords', applicationPasswordsTest),
      setup_token: direct('Setup code', setupTokenTest),
      insecure_registration: direct(
        'Open Registration with privileged default role',
        insecureRegistrationTest,
      ),
      mail: direct('Email', mailTest),
      job_worker: direct('Background tasks', jobWorkerTest),
      scheduled_events: direct('Scheduled events', scheduledEventsTest),
      failed_jobs: direct('Failed background tasks', failedJobsTest),
      file_uploads: direct('File uploads', uploadsTest),
      available_disk_space: direct('Available disk space', diskSpaceTest),
      image_processing: direct('Image processing', imageProcessingTest),
      plugin_errors: direct('Plugin errors', pluginErrorsTest),
      inactive_plugins: direct('Inactive plugins', inactivePluginsTest),
      inactive_themes: direct('Inactive themes', inactiveThemesTest),
      search_engine_visibility: direct('Search Engine Visibility', searchEngineVisibilityTest),
      timezone: direct('Time zone', timezoneTest),
      autoloaded_options: direct('Autoloaded options', autoloadedOptionsTest),
    },
    async: {
      https_status: async('https_status', 'HTTPS status', httpsStatusTest),
      loopback_requests: async('loopback_requests', 'Loopback request', loopbackTest),
      page_cache: async('page_cache', 'Page cache', pageCacheTest),
      pressbase_version: async('pressbase_version', 'Pressbase version', pressbaseVersionTest),
    },
  };
}
