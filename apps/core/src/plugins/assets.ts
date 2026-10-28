import path from 'node:path';
import { Hono } from 'hono';
import type { Strategy, Version } from '../frontend/dependencies';
import type { ScriptOptions } from '../frontend/head';
import { currentPage } from '../frontend/page';
import type { AppEnv } from '../http';
import type { Kernel } from '../kernel';
import { notFoundResponse, safeSegments, serveStaticFile } from '../themes/static-files';

/**
 * A plugin's static files and `api.scripts` / `api.styles`
 * (docs/architecture/plugins.md#scripts-styles-and-static-files).
 *
 * Files in a plugin's `public/` folder are served at
 * `/wp-content/plugins/{slug}/{file}` (plugins_url() in WordPress), only while
 * the plugin is active, with the same rules as theme assets: every segment
 * checked, no dot files, an allow-list of types, no symlinks out of the
 * folder. Script and stylesheet sources that are relative paths resolve to
 * that URL and get the plugin's version as `?ver=`, so a new version is a new
 * URL and the files can be cached for a year.
 */

export const PLUGINS_URL_PATH = '/wp-content/plugins';
/** The folder of a plugin served as static files. */
export const PUBLIC_DIR = 'public';

export type { ScriptOptions, Strategy, Version };

export interface PluginScripts {
  /**
   * wp_register_script(). `src` is a file in the plugin's `public/` folder
   * (`'tips.js'`), an absolute URL, or false for an alias. `ver` defaults to the
   * plugin's version. Returns false when the handle is taken.
   */
  register(
    handle: string,
    src: string | false,
    deps?: string[],
    ver?: Version,
    options?: ScriptOptions | boolean,
  ): boolean;
  /** wp_enqueue_script(): registers first when `src` is given. */
  enqueue(
    handle: string,
    src?: string | false,
    deps?: string[],
    ver?: Version,
    options?: ScriptOptions | boolean,
  ): void;
  dequeue(handle: string): void;
  deregister(handle: string): void;
  is(handle: string, status?: 'registered' | 'enqueued' | 'to_do' | 'done'): boolean;
  /** wp_add_inline_script() */
  addInline(handle: string, code: string, position?: 'before' | 'after'): boolean;
  /** wp_localize_script() */
  localize(handle: string, objectName: string, data: Record<string, unknown>): boolean;
}

export interface PluginStyles {
  /** wp_register_style(). `src` as for scripts; `ver` defaults to the plugin's version. */
  register(
    handle: string,
    src: string | false,
    deps?: string[],
    ver?: Version,
    media?: string,
  ): boolean;
  /** wp_enqueue_style() */
  enqueue(
    handle: string,
    src?: string | false,
    deps?: string[],
    ver?: Version,
    media?: string,
  ): void;
  dequeue(handle: string): void;
  deregister(handle: string): void;
  is(handle: string, status?: 'registered' | 'enqueued' | 'to_do' | 'done'): boolean;
  /** wp_add_inline_style() */
  addInline(handle: string, css: string): boolean;
}

export interface PluginAssets {
  /**
   * plugins_url(): the public URL of a file in the plugin's `public/` folder,
   * `/wp-content/plugins/{slug}/{file}` (root-relative). Served only while the plugin is active.
   */
  url(file: string): string;
}

export interface AssetsHost {
  kernel: Kernel;
  slug: string;
  version: string;
  track(dispose: () => void): void;
}

const ABSOLUTE = /^(?:https?:)?\/\//i;

/** plugins_url() for `file`; throws for a path that leaves the folder. */
export function pluginAssetUrl(slug: string, file: string): string {
  const clean = String(file)
    .replace(/^\.\//, '')
    .replace(/^public\//, '');
  const segments = clean.split('/');
  if (
    !clean ||
    clean.includes('\\') ||
    segments.some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))
  ) {
    throw new Error(`Use a file inside the plugin's public/ folder, like "style.css": "${file}".`);
  }
  return `${PLUGINS_URL_PATH}/${slug}/${segments.map(encodeURIComponent).join('/')}`;
}

export function createAssets(host: AssetsHost): {
  scripts: PluginScripts;
  styles: PluginStyles;
  assets: PluginAssets;
} {
  const { kernel, slug, version } = host;
  const source = (src: string | false | undefined) => {
    if (src === false || src === undefined) return src;
    if (ABSOLUTE.test(src) || src.startsWith('/')) return src;
    return pluginAssetUrl(slug, src);
  };
  const ver = (value: Version) => (value === undefined ? version : value);
  // Outside a page render the registration is site-wide: take it back on deactivation.
  // Inside one it belongs to that page only and disappears with it.
  const siteWide = () => currentPage() === undefined;

  const scripts: PluginScripts = Object.freeze<PluginScripts>({
    register: (handle, src, deps = [], v, options = {}) => {
      const added = kernel.scripts.register(handle, source(src) ?? false, deps, ver(v), options);
      if (added && siteWide()) host.track(() => kernel.scripts.deregister(handle));
      return added;
    },
    enqueue: (handle, src, deps = [], v, options = {}) => {
      const name = handle.split('?')[0] ?? handle;
      if (src || options === true || (typeof options === 'object' && options.inFooter)) {
        scripts.register(name, src ?? false, deps, v, options);
      }
      kernel.scripts.enqueue(handle);
      if (siteWide()) host.track(() => kernel.scripts.dequeue(name));
    },
    dequeue: (handle) => kernel.scripts.dequeue(handle),
    deregister: (handle) => kernel.scripts.deregister(handle),
    is: (handle, status) => kernel.scripts.is(handle, status),
    addInline: (handle, code, position) => kernel.scripts.addInline(handle, code, position),
    localize: (handle, objectName, data) => kernel.scripts.localize(handle, objectName, data),
  });

  const styles: PluginStyles = Object.freeze<PluginStyles>({
    register: (handle, src, deps = [], v, media = 'all') => {
      const added = kernel.styles.register(handle, source(src) ?? false, deps, ver(v), media);
      if (added && siteWide()) host.track(() => kernel.styles.deregister(handle));
      return added;
    },
    enqueue: (handle, src, deps = [], v, media = 'all') => {
      const name = handle.split('?')[0] ?? handle;
      if (src) styles.register(name, src, deps, v, media);
      kernel.styles.enqueue(handle);
      if (siteWide()) host.track(() => kernel.styles.dequeue(name));
    },
    dequeue: (handle) => kernel.styles.dequeue(handle),
    deregister: (handle) => kernel.styles.deregister(handle),
    is: (handle, status) => kernel.styles.is(handle, status),
    addInline: (handle, css) => kernel.styles.addInline(handle, css),
  });

  const assets: PluginAssets = Object.freeze({ url: (file: string) => pluginAssetUrl(slug, file) });
  return { scripts, styles, assets };
}

/**
 * GET /wp-content/plugins/{slug}/{file}: a file from an active plugin's
 * `public/` folder. Anything else (an inactive or unknown plugin, a dot file, a
 * path that leaves the folder, a type outside the allow-list) is a 404.
 * Requests with `?ver=` equal to the plugin's version are cached for a year.
 */
export function pluginAssetRoutes(kernel: Kernel) {
  const app = new Hono<AppEnv>({ strict: true });
  app.get(`${PLUGINS_URL_PATH}/*`, async (c) => {
    if (kernel.state !== 'ready') return notFoundResponse();
    const segments = safeSegments(new URL(c.req.url).pathname, `${PLUGINS_URL_PATH}/`);
    if (!segments || segments.length < 2) return notFoundResponse();
    const [slug = '', ...file] = segments;
    const runtime = kernel.plugins.runtime(slug);
    if (!runtime) return notFoundResponse();
    const version = runtime.plugin.manifest.version;
    return serveStaticFile(c, path.join(runtime.plugin.dir, PUBLIC_DIR), file, {
      maxAge: c.req.query('ver') === version ? 31_536_000 : 3_600,
    });
  });
  return app;
}
