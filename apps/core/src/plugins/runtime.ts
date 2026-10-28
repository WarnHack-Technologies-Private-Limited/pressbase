import type { Database } from '@pressbase/db';
import type {
  ActionCallback,
  ActionRegistry,
  FilterCallback,
  FilterRegistry,
} from '@pressbase/hooks';
import { sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { type CurrentUser, userCan } from '../auth/users';
import type { PostType, PostTypeArgs } from '../content/post-types';
import type { PostsService } from '../content/posts';
import { type QueryArgs, type QueryResult, queryPosts } from '../content/query';
import type { Taxonomy, TaxonomyArgs } from '../content/taxonomies';
import type { TermsService } from '../content/terms';
import { type AppEnv, restError } from '../http';
import type { Kernel } from '../kernel';
import { PRESSBASE_VERSION } from '../version';
import {
  PluginAdmin,
  type PluginPageArgs,
  type PluginSectionArgs,
  type PluginSettingArgs,
} from './admin';
import { createAssets, type PluginAssets, type PluginScripts, type PluginStyles } from './assets';
import { type Background, createBackground, type PluginCron, type PluginJobs } from './background';
import type { PluginCliCommandArgs, PluginCliHandler } from './cli';
import type { InstalledPlugin } from './discovery';
import { createSubApp } from './dispatch';
import { createPluginI18n, type PluginI18n } from './i18n';
import type { PluginPermission } from './manifest';

/**
 * The object a plugin's `register(api)` receives, and everything a plugin
 * registers through it. Each registration is tracked so deactivating the
 * plugin takes it all back: hooks, post types, taxonomies and REST routes.
 *
 * This interface is the seam for the plugin SDK (`packages/sdk`, later): keep
 * it narrow, and add to it rather than handing plugins the kernel.
 */

/** Hook callbacks are matched by reference, whatever their arguments. */
// biome-ignore lint/suspicious/noExplicitAny: callbacks of any shape.
type AnyCallback = (...args: any[]) => unknown;

export interface PluginLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** What a REST handler or permission callback receives: Hono's context. */
export type PluginRequestContext = Context<AppEnv>;

export interface PluginRouteArgs {
  /** HTTP methods, default GET. */
  methods?: string | string[];
  /** Returns a Response, or any JSON-serialisable value (sent with status 200). */
  handler: (c: PluginRequestContext) => unknown;
  /**
   * Required, as WordPress requires `permission_callback` since 5.5. Return
   * true to allow. Use `() => true` for a public route.
   */
  permission: (c: PluginRequestContext) => boolean | Promise<boolean>;
}

export interface PluginApi {
  readonly plugin: {
    name: string;
    title: string;
    version: string;
    dir: string;
    /** Permissions the administrator granted on activation. */
    permissions: readonly PluginPermission[];
  };
  readonly pressbase: { version: string };
  readonly hooks: {
    /** Hook names core declares autocomplete; any other name works too. */
    addFilter<K extends keyof FilterRegistry | (string & {})>(
      name: K,
      callback: FilterCallback<K>,
      priority?: number,
    ): () => void;
    addAction<K extends keyof ActionRegistry | (string & {})>(
      name: K,
      callback: ActionCallback<K>,
      priority?: number,
    ): () => void;
    removeFilter(name: string, callback: AnyCallback, priority?: number): boolean;
    removeAction(name: string, callback: AnyCallback, priority?: number): boolean;
    applyFilters(name: string, value: unknown, ...args: unknown[]): Promise<unknown>;
    doAction(name: string, ...args: unknown[]): Promise<void>;
    hasFilter(name: string): boolean;
    hasAction(name: string): boolean;
    didAction(name: string): number;
  };
  readonly postTypes: {
    register(name: string, args: PostTypeArgs): PostType;
    get(name: string): PostType | undefined;
  };
  readonly taxonomies: {
    register(name: string, objectTypes: string[], args: TaxonomyArgs): Taxonomy;
    get(name: string): Taxonomy | undefined;
  };
  /**
   * The plugin's own options, stored as `{prefix}{name}` where the prefix is
   * the plugin's slug with underscores (daily-tips → `daily_tips_greeting`).
   */
  readonly options: {
    prefix: string;
    get<T = unknown>(name: string, fallback?: T): Promise<T>;
    set(name: string, value: unknown): Promise<void>;
    delete(name: string): Promise<void>;
  };
  /** Any site option (get_option / update_option). Only with the `options` permission. */
  readonly siteOptions?: {
    get<T = unknown>(name: string, fallback?: T): Promise<T>;
    set(name: string, value: unknown): Promise<void>;
    delete(name: string): Promise<void>;
  };
  /** Raw database access. Only with the `database` permission. */
  readonly db?: {
    /** Drizzle on Pressbase's connection. */
    db: Database;
    /** Drizzle's sql`` template tag. */
    sql: typeof sql;
    /** Runs a script of SQL statements (simple query protocol). */
    exec(script: string): Promise<void>;
  };
  readonly content: {
    posts: PostsService;
    terms: TermsService;
    query(args: QueryArgs): Promise<QueryResult>;
  };
  readonly rest: {
    /**
     * register_rest_route(): `namespace` is the plugin's slug, or starts with
     * it (`daily-tips/v1`); `route` uses Hono's path syntax (`/items/:id{[0-9]+}`).
     * Served at /wp-json/{namespace}{route}.
     */
    registerRoute(namespace: string, route: string, args: PluginRouteArgs): void;
    /** The logged-in user of a request, or null. */
    currentUser(c: PluginRequestContext): CurrentUser | null;
    /** current_user_can() for a request. */
    userCan(c: PluginRequestContext, capability: string): boolean;
  };
  readonly logger: PluginLogger;
  /**
   * WP-Cron for the plugin: hook names get the plugin's prefix (`rotate` →
   * `daily_tips_rotate`). A deactivated plugin's events wait until it is active again.
   */
  readonly cron: PluginCron;
  /** The job queue, with job names namespaced by the plugin's slug (`sync` → `daily-tips/sync`). */
  readonly jobs: PluginJobs;
  /** wp_enqueue_script() & co. for public pages; relative sources are files in `public/`. */
  readonly scripts: PluginScripts;
  /** wp_enqueue_style() & co. for public pages; relative sources are files in `public/`. */
  readonly styles: PluginStyles;
  /** URLs of the plugin's static files (its `public/` folder). */
  readonly assets: PluginAssets;
  /**
   * The Settings API: register_setting() with its field, and
   * add_settings_section(). The admin draws the plugin's settings page from
   * them; no admin JavaScript needed. See plugins/admin.ts.
   */
  readonly settings: {
    register(name: string, args?: PluginSettingArgs): void;
    addSection(id: string, args?: PluginSectionArgs): void;
    /** The stored value, or the registered default. */
    get<T = unknown>(name: string): Promise<T>;
    /** Validates and sanitises like a save from the admin; throws with the field's message. */
    set(name: string, value: unknown): Promise<void>;
  };
  /** Admin menu pages: add_menu_page(), add_options_page(), add_management_page(). */
  readonly admin: {
    addPage(args: PluginPageArgs): void;
  };
  /**
   * Commands for the `pressbase` CLI: WP_CLI::add_command(). The name is the
   * plugin's slug, then optional subcommand words (`daily-tips rotate`).
   * Returns a function that removes the command. See plugins/cli.ts.
   */
  readonly cli: {
    addCommand(name: string, handler: PluginCliHandler, args?: PluginCliCommandArgs): () => void;
  };
  /**
   * Translations in the plugin's text domain (its slug), loaded from its
   * `languages/` folder: `api.i18n.__('Daily tip')`. See plugins/i18n.ts.
   */
  readonly i18n: PluginI18n;
}

/** What a plugin's main module exports. */
export interface PluginModule {
  default?: (api: PluginApi) => unknown;
  register?: (api: PluginApi) => unknown;
  activate?: (api: PluginApi) => unknown;
  deactivate?: (api: PluginApi) => unknown;
  uninstall?: (api: PluginApi) => unknown;
}

interface RouteDef {
  namespace: string;
  route: string;
  methods: string[];
  args: PluginRouteArgs;
}

/** /wp/v2 routes core serves itself, which a plugin's post type or taxonomy can't take. */
const CORE_REST_BASES = new Set([
  'users',
  'settings',
  'types',
  'taxonomies',
  'statuses',
  'media',
  'search',
  'comments',
  'plugins',
  'themes',
  'block-types',
  'block-renderer',
  'block-patterns',
  'blocks',
  'global-styles',
  'navigation',
  'menus',
  'menu-items',
  'templates',
  'template-parts',
]);

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const NAMESPACE = /^[a-z0-9-]+(?:\/[a-z0-9._-]+)*$/;
const OPTION_NAME = /^[a-z0-9_]+$/;

/** Plugin slug → option prefix: daily-tips → daily_tips_. */
export function optionPrefix(slug: string): string {
  return `${slug.replace(/-/g, '_')}_`;
}

export interface RuntimeHost {
  /** A hook callback, route or permission check of the plugin threw. */
  reportError(slug: string, during: string, error: unknown): void;
  /** Ownership of registered names, for dynamic routing. */
  claim(kind: 'postType' | 'taxonomy', name: string, slug: string): void;
  release(kind: 'postType' | 'taxonomy', name: string): void;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export class PluginRuntime {
  readonly api: PluginApi;
  readonly logger: PluginLogger;
  #disposers: (() => void)[] = [];
  #routes: RouteDef[] = [];
  #app: Hono<AppEnv> | undefined;
  /** Wrapped hook callbacks by original callback, so removeFilter() can find them. */
  #wrapped = new Map<AnyCallback, { name: string; wrapped: AnyCallback; off: () => void }[]>();
  #disposed = false;
  #background: Background | undefined;

  constructor(
    readonly kernel: Kernel,
    readonly plugin: InstalledPlugin,
    readonly permissions: readonly PluginPermission[],
    readonly module: PluginModule,
    private readonly host: RuntimeHost,
  ) {
    const slug = plugin.slug;
    const tag = `[plugin:${slug}]`;
    this.logger = {
      debug: (...args) => console.debug(tag, ...args),
      info: (...args) => console.info(tag, ...args),
      warn: (...args) => console.warn(tag, ...args),
      error: (...args) => console.error(tag, ...args),
    };
    this.adminRegistrations = new PluginAdmin(kernel, plugin, permissions, (dispose) =>
      this.#track(dispose),
    );
    this.api = this.#createApi();
  }

  /** The plugin's settings, sections and admin pages (plugins/admin.ts). */
  readonly adminRegistrations: PluginAdmin;

  get slug(): string {
    return this.plugin.slug;
  }

  /** The REST namespaces the plugin registered routes in. */
  namespaces(): string[] {
    return [...new Set(this.#routes.map((r) => r.namespace))];
  }

  /** Hono app serving the plugin's routes, rebuilt after new registrations. */
  restApp(): Hono<AppEnv> {
    if (!this.#app) this.#app = this.#buildApp();
    return this.#app;
  }

  /**
   * Starts the plugin's background work (its cron runner), once `register`
   * has added its callbacks, so no event runs before its action exists.
   */
  startBackground(): void {
    this.#background?.start();
  }

  /** Takes back everything the plugin registered, newest first. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        this.logger.error('Cleanup failed:', error);
      }
    }
    this.#disposers = [];
    this.#routes = [];
    this.#wrapped.clear();
    this.#app = undefined;
  }

  #track(dispose: () => void) {
    if (this.#disposed) throw new Error(`${this.plugin.manifest.title} is no longer active.`);
    this.#disposers.push(dispose);
  }

  /**
   * Hook callbacks are isolated: an exception is logged and recorded against
   * the plugin, and the hook carries on (a filter keeps its incoming value),
   * so one broken plugin can't break every request.
   */
  #wrap(name: string, callback: (...args: unknown[]) => unknown, filter: boolean) {
    const fail = (error: unknown, args: unknown[]) => {
      this.host.reportError(this.slug, `hook ${name}`, error);
      return filter ? args[0] : undefined;
    };
    return (...args: unknown[]) => {
      try {
        const result = callback(...args);
        if (isThenable(result)) {
          return Promise.resolve(result).catch((error: unknown) => fail(error, args));
        }
        return result;
      } catch (error) {
        return fail(error, args);
      }
    };
  }
  #addHook(name: string, callback: AnyCallback, priority: number | undefined, filter: boolean) {
    if (typeof callback !== 'function')
      throw new TypeError(`The callback for "${name}" is not a function.`);
    const wrapped = this.#wrap(name, callback, filter);
    const off = this.kernel.hooks.addFilter(name, wrapped as never, priority);
    const entry = { name, wrapped, off };
    const list = this.#wrapped.get(callback) ?? [];
    list.push(entry);
    this.#wrapped.set(callback, list);
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      off();
      const current = this.#wrapped.get(callback)?.filter((e) => e !== entry) ?? [];
      if (current.length) this.#wrapped.set(callback, current);
      else this.#wrapped.delete(callback);
    };
    this.#track(remove);
    return remove;
  }
  #removeHook(name: string, callback: AnyCallback, priority?: number): boolean {
    let found = false;
    for (const entry of [...(this.#wrapped.get(callback) ?? [])]) {
      if (entry.name !== name) continue;
      if (this.kernel.hooks.removeFilter(name, entry.wrapped, priority)) {
        found = true;
        entry.off();
      }
    }
    return found;
  }

  #createApi(): PluginApi {
    const { kernel, plugin } = this;
    const manifest = plugin.manifest;
    const slug = plugin.slug;
    const prefix = optionPrefix(slug);
    const optionName = (name: string) => {
      if (!OPTION_NAME.test(name)) {
        throw new Error(`Option names use lowercase letters, numbers and underscores: "${name}".`);
      }
      return name.startsWith(prefix) ? name : `${prefix}${name}`;
    };
    const has = (permission: PluginPermission) => this.permissions.includes(permission);
    const track = (dispose: () => void) => this.#track(dispose);
    const background = createBackground({
      kernel,
      slug,
      prefix,
      track,
      addAction: (name, callback, priority) => this.#addHook(name, callback, priority, false),
      reportError: (during, error) => this.host.reportError(slug, during, error),
    });
    this.#background = background;
    const { scripts, styles, assets } = createAssets({
      kernel,
      slug,
      version: manifest.version,
      track,
    });

    const api: PluginApi = {
      plugin: Object.freeze({
        name: slug,
        title: manifest.title,
        version: manifest.version,
        dir: plugin.dir,
        permissions: Object.freeze([...this.permissions]),
      }),
      pressbase: Object.freeze({ version: PRESSBASE_VERSION }),
      hooks: {
        addFilter: (name, callback, priority) => this.#addHook(name, callback, priority, true),
        addAction: (name, callback, priority) => this.#addHook(name, callback, priority, false),
        removeFilter: (name, callback, priority) => this.#removeHook(name, callback, priority),
        removeAction: (name, callback, priority) => this.#removeHook(name, callback, priority),
        applyFilters: (name, value, ...args) =>
          kernel.hooks.applyFilters(name, value, ...(args as [])),
        doAction: (name, ...args) => kernel.hooks.doAction(name, ...args),
        hasFilter: (name) => kernel.hooks.hasFilter(name),
        hasAction: (name) => kernel.hooks.hasAction(name),
        didAction: (name) => kernel.hooks.didAction(name),
      },
      postTypes: {
        register: (name, args) => {
          if (kernel.postTypes.get(name)) {
            throw new Error(`The post type "${name}" is already registered.`);
          }
          const restBase = args.restBase ?? name;
          if (
            args.showInRest &&
            (CORE_REST_BASES.has(restBase) ||
              kernel.postTypes.byRestBase(restBase) ||
              kernel.taxonomies.byRestBase(restBase))
          ) {
            throw new Error(`The REST base "${restBase}" is already in use.`);
          }
          const type = kernel.postTypes.register(name, args);
          this.host.claim('postType', name, slug);
          this.#track(() => {
            kernel.postTypes.unregister(name);
            this.host.release('postType', name);
          });
          return type;
        },
        get: (name) => kernel.postTypes.get(name),
      },
      taxonomies: {
        register: (name, objectTypes, args) => {
          if (kernel.taxonomies.get(name)) {
            throw new Error(`The taxonomy "${name}" is already registered.`);
          }
          const restBase = args.restBase ?? name;
          if (
            args.showInRest &&
            (CORE_REST_BASES.has(restBase) ||
              kernel.postTypes.byRestBase(restBase) ||
              kernel.taxonomies.byRestBase(restBase))
          ) {
            throw new Error(`The REST base "${restBase}" is already in use.`);
          }
          const taxonomy = kernel.taxonomies.register(name, objectTypes, args);
          this.host.claim('taxonomy', name, slug);
          this.#track(() => {
            kernel.taxonomies.unregister(name);
            this.host.release('taxonomy', name);
          });
          return taxonomy;
        },
        get: (name) => kernel.taxonomies.get(name),
      },
      options: Object.freeze({
        prefix,
        get: <T>(name: string, fallback?: T) => kernel.options.get<T>(optionName(name), fallback),
        set: (name: string, value: unknown) => kernel.options.set(optionName(name), value),
        delete: (name: string) => kernel.options.delete(optionName(name)),
      }),
      siteOptions: has('options')
        ? Object.freeze({
            get: <T>(name: string, fallback?: T) => kernel.options.get<T>(name, fallback),
            set: (name: string, value: unknown) => kernel.options.set(name, value),
            delete: (name: string) => kernel.options.delete(name),
          })
        : undefined,
      db: has('database')
        ? Object.freeze({
            db: kernel.db,
            sql,
            exec: (script: string) => kernel.connection.exec(script),
          })
        : undefined,
      content: Object.freeze({
        posts: kernel.posts,
        terms: kernel.terms,
        query: (args: QueryArgs) => queryPosts(kernel, args),
      }),
      rest: Object.freeze({
        registerRoute: (namespace: string, route: string, args: PluginRouteArgs) =>
          this.#registerRoute(namespace, route, args),
        currentUser: (c: PluginRequestContext) => c.get('user') ?? null,
        userCan: (c: PluginRequestContext, capability: string) =>
          userCan(c.get('user') ?? null, capability),
      }),
      logger: this.logger,
      cron: background.cron,
      jobs: background.jobs,
      scripts,
      styles,
      assets,
      settings: Object.freeze({
        register: (name: string, args?: PluginSettingArgs) => {
          this.adminRegistrations.registerSetting(name, args);
        },
        addSection: (id: string, args?: PluginSectionArgs) =>
          this.adminRegistrations.addSection(id, args),
        get: <T>(name: string) => this.adminRegistrations.get<T>(name),
        set: async (name: string, value: unknown) => {
          await this.adminRegistrations.set(name, value);
        },
      }),
      admin: Object.freeze({
        addPage: (args: PluginPageArgs) => this.adminRegistrations.addPage(args),
      }),
      cli: Object.freeze({
        addCommand: (name: string, handler: PluginCliHandler, args: PluginCliCommandArgs = {}) => {
          const off = kernel.cli.add({
            name,
            handler,
            plugin: slug,
            shortdesc: args.shortdesc,
            synopsis: args.synopsis,
            longdesc: args.longdesc,
          });
          let removed = false;
          const remove = () => {
            if (removed) return;
            removed = true;
            off();
          };
          this.#track(remove);
          return remove;
        },
      }),
      i18n: createPluginI18n({ kernel, slug, dir: plugin.dir, track }),
    };
    return Object.freeze(api);
  }

  #registerRoute(namespace: string, route: string, args: PluginRouteArgs) {
    const slug = this.slug;
    if (!NAMESPACE.test(namespace) || !(namespace === slug || namespace.startsWith(`${slug}/`))) {
      throw new Error(
        `REST namespaces must start with the plugin's name: "${slug}/v1", not "${namespace}".`,
      );
    }
    if (!route.startsWith('/') || route.includes('..')) {
      throw new Error(`Routes start with "/": "${route}".`);
    }
    if (typeof args?.handler !== 'function') {
      throw new Error(`The route ${namespace}${route} has no handler.`);
    }
    if (typeof args.permission !== 'function') {
      throw new Error(
        `The route ${namespace}${route} has no permission callback. Use \`permission: () => true\` for a public route.`,
      );
    }
    const methods = (Array.isArray(args.methods) ? args.methods : [args.methods ?? 'GET']).map(
      (m) => m.toUpperCase(),
    );
    for (const method of methods) {
      if (!METHODS.has(method)) throw new Error(`Unsupported HTTP method "${method}".`);
    }
    const def: RouteDef = { namespace, route, methods, args };
    this.#routes.push(def);
    this.#app = undefined;
    this.#track(() => {
      this.#routes = this.#routes.filter((r) => r !== def);
      this.#app = undefined;
    });
  }

  #buildApp(): Hono<AppEnv> {
    const title = this.plugin.manifest.title;
    const app = createSubApp((error, c) => {
      this.host.reportError(this.slug, `REST ${c.req.method} ${c.req.path}`, error);
      return restError(
        c,
        500,
        'pressbase_plugin_error',
        `The ${title} plugin couldn’t handle this request.`,
      );
    });
    for (const def of this.#routes) {
      const path = `/wp-json/${def.namespace}${def.route === '/' ? '' : def.route}`;
      app.on(def.methods, path, async (c) => {
        const allowed = await def.args.permission(c);
        if (allowed !== true) {
          return restError(
            c,
            c.get('user') ? 403 : 401,
            'rest_forbidden',
            'Sorry, you are not allowed to do that.',
          );
        }
        const result = await def.args.handler(c);
        return result instanceof Response ? result : c.json((result ?? null) as never);
      });
    }
    return app;
  }
}
