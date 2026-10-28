import { connect, type DatabaseConnection } from '@pressbase/db';
import { HookBus } from '@pressbase/hooks';
import { BlocksService } from './blocks/service';
import { registerCacheInvalidation } from './cache/invalidation';
import { registerCommentNotifications } from './comments/notify';
import { CommentsService } from './comments/service';
import type { Config } from './config';
import { PostStatusRegistry } from './content/post-statuses';
import { PostTypeRegistry, registerCorePostTypes } from './content/post-types';
import { PostsService } from './content/posts';
import { registerCoreTaxonomies, TaxonomyRegistry } from './content/taxonomies';
import { TermsService } from './content/terms';
import { registerPublicPageHooks, ScriptsApi, StylesApi } from './frontend/head';
import { I18n } from './i18n/l10n';
import { registerCoreEvents } from './jobs/core-events';
import { Cron } from './jobs/cron';
import { JobQueue } from './jobs/queue';
import { Mailer } from './mail/mailer';
import { registerCoreSettings, SettingsRegistry } from './options/settings';
import { Options } from './options/store';
import { CliCommands } from './plugins/cli';
import { PluginManager } from './plugins/manager';
import { SiteHealth } from './site-health/service';
import { registerGlobalStylesHooks, registerGlobalStylesPostType } from './themes/global-styles';
import { ThemesService } from './themes/service';
import { registerSiteIdentityHooks, registerSiteIdentitySettings } from './themes/site-identity';
import { registerThemeSupports } from './themes/supports';
import { DB_VERSION } from './version';

/**
 * Where the site is in its life cycle. The admin app routes on this:
 * needs-database and needs-install go to the installer, ready goes to the dashboard.
 */
export type SiteState = 'needs-database' | 'needs-install' | 'ready';

/**
 * The kernel owns the long-lived pieces of a running site — the replacement
 * for the globals WordPress sets up in wp-settings.php.
 *
 * Boot order: config → registries (settings, post types, taxonomies) →
 * database (+ migrations) → options → active plugins → `init` action.
 */
export class Kernel {
  readonly hooks = new HookBus();
  readonly settings = new SettingsRegistry();
  readonly postTypes = new PostTypeRegistry();
  readonly postStatuses = new PostStatusRegistry();
  readonly taxonomies = new TaxonomyRegistry();
  readonly posts = new PostsService(this);
  readonly terms = new TermsService(this);
  /** Block types, patterns and do_blocks() (see docs/architecture/blocks.md). */
  readonly blocks = new BlocksService(this);
  /** wp_mail(): SMTP, or the development outbox (see docs/architecture/people.md). */
  readonly mail = new Mailer(this);
  /** Comments, moderation and the Discussion settings (see docs/architecture/comments.md). */
  readonly comments = new CommentsService(this);
  /** Installed themes, the active theme and its theme.json (see docs/architecture/themes.md). */
  readonly themes = new ThemesService(this);
  /** Durable background jobs in PostgreSQL (see docs/architecture/jobs.md). */
  readonly jobs = new JobQueue(this);
  /** WP-Cron on top of the job queue: wp_schedule_event() and friends. */
  readonly cron = new Cron(this);
  /** wp_enqueue_script() and friends for public pages (see docs/architecture/scripts-and-styles.md). */
  readonly scripts = new ScriptsApi(this.hooks);
  /** wp_enqueue_style() and friends for public pages. */
  readonly styles = new StylesApi(this.hooks);
  /** Installed plugins, loading and the plugin lifecycle (see docs/architecture/plugins.md). */
  readonly plugins = new PluginManager(this);
  /** Site Health: status tests and debug information (see docs/architecture/site-health.md). */
  readonly siteHealth = new SiteHealth(this);
  /** Commands plugins add to the `pressbase` CLI (v0.6, see docs/development/cli.md). */
  readonly cli = new CliCommands();
  /** Translations, locales and language packs: l10n.php (see docs/architecture/i18n.md). */
  readonly i18n = new I18n(this);
  #connection: DatabaseConnection | undefined;
  #options: Options | undefined;
  #state: SiteState = 'needs-database';

  constructor(readonly config: Config) {
    registerCoreSettings(this.settings);
    registerCorePostTypes(this.postTypes);
    registerCoreTaxonomies(this.taxonomies);
    registerCommentNotifications(this);
    registerThemeSupports(this);
    // Global styles and site identity (v0.4): the wp_global_styles post type,
    // site_logo / site_icon settings. See docs/architecture/themes.md.
    registerGlobalStylesPostType(this.postTypes);
    registerGlobalStylesHooks(this);
    registerSiteIdentitySettings(this.settings);
    registerSiteIdentityHooks(this);
    // Public page caching: content changes announce the cache tags they make stale.
    registerCacheInvalidation(this);
    // Job queue and cron (v0.5): publish_future_post and the daily chores.
    registerCoreEvents(this);
    // Public page hooks: wp_head, wp_footer, wp_enqueue_scripts (v0.5).
    registerPublicPageHooks(this);
  }

  get state(): SiteState {
    return this.#state;
  }

  get connection(): DatabaseConnection {
    if (!this.#connection) throw new Error('The database is not connected yet.');
    return this.#connection;
  }

  get db() {
    return this.connection.db;
  }

  get options(): Options {
    if (!this.#options)
      throw new Error('Options are not available before the database is connected.');
    return this.#options;
  }

  async boot(): Promise<void> {
    if (this.config.databaseUrl) await this.useDatabase(this.config.databaseUrl);
  }

  /** Connects, applies pending migrations and works out whether the site is installed. */
  async useDatabase(url: string): Promise<SiteState> {
    const connection = await connect(url);
    try {
      await connection.migrate();
    } catch (error) {
      await connection.close();
      throw error;
    }
    await this.#connection?.close();
    this.#connection = connection;
    this.#options = new Options(connection.db, this.hooks);
    return this.refreshState();
  }

  async refreshState(): Promise<SiteState> {
    if (!this.#options) {
      this.#state = 'needs-database';
      return this.#state;
    }
    await this.#options.load();
    const installedVersion = await this.#options.get<number | undefined>('pressbase_db_version');
    const wasReady = this.#state === 'ready';
    this.#state = installedVersion === undefined ? 'needs-install' : 'ready';
    if (installedVersion !== undefined && !wasReady) {
      if (installedVersion < DB_VERSION) {
        // Data upgrades will run here (WordPress's wp_upgrade()). None exist yet.
        await this.#options.set('pressbase_db_version', DB_VERSION);
      }
      // Active plugins load before `init`, as wp-settings.php includes them.
      await this.plugins.loadActive();
      await this.hooks.doAction('init');
    }
    return this.#state;
  }

  async shutdown(): Promise<void> {
    await this.jobs.stop();
    this.plugins.unloadAll();
    await this.#connection?.close();
    this.#connection = undefined;
  }
}
