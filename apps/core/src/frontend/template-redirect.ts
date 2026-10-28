import type { CurrentUser } from '../auth/users';
import type { MainQuery } from './query';

/**
 * Early request hooks of the public site (ADR 0017):
 *
 * - `template_redirect` (action): fires once per public render, before
 *   robots.txt, sitemaps, feeds, plugin files and theme pages, as in
 *   wordpress/wp-includes/template-loader.php. WordPress callbacks call
 *   wp_redirect() and exit; here a callback calls `request.redirect()` (or
 *   `request.notFound()`), and the first answer wins.
 * - `pre_handle_404` (filter, `false, main, url`): return anything but false
 *   to stop a URL that matched nothing from being a 404 (WP::handle_404() in
 *   class-wp.php). The page then renders with status 200.
 * - `pressbase_404` (action, `request`): a 404 is being served, with its
 *   path and referrer. WordPress has no such action (plugins check is_404()
 *   in `template_redirect`); this one also covers sitemaps and feeds that
 *   don't exist. While anything listens, 404 answers are sent `no-store`,
 *   as WordPress's nocache_headers() does, so the page cache doesn't hide
 *   repeat hits from it.
 *
 * Both actions run inside the render that the page cache stores and shares
 * between anonymous visitors (ADR 0008): decide from the URL and the site's
 * data, never from the visitor. When that data changes (a redirect is
 * added), purge the path: `api.cache.purgePaths(['/old/'])`.
 */

/** What `template_redirect` callbacks receive. */
export interface TemplateRedirectRequest {
  /** The requested path, e.g. `/old-page/` (percent-encoded as requested). */
  readonly path: string;
  readonly query: URLSearchParams;
  /** The Referer header, or ''. */
  readonly referrer: string;
  /** The logged-in visitor, or null (always null for renders the cache stores). */
  readonly user: CurrentUser | null;
  /**
   * The main query of the URL as a page (WordPress's `$wp_query`), resolved
   * on first use and shared with the render. Don't call it when the path
   * alone decides: resolving it costs a query.
   */
  main(): Promise<MainQuery>;
  /**
   * wp_redirect(): answer with a redirect instead. `location` is an absolute
   * http(s) URL or a path starting with `/`. Returns false when another
   * callback already answered or the location is unusable.
   */
  redirect(location: string, status?: 301 | 302 | 303 | 307 | 308): boolean;
  /**
   * Answer with the theme's not-found page: 404, or 410 for content that's
   * gone for good. A 404 fires `pressbase_404`; a 410 doesn't.
   */
  notFound(status?: 404 | 410): boolean;
  /** The answer a callback chose, if any. */
  readonly answer: TemplateRedirectAnswer | undefined;
}

export type TemplateRedirectAnswer =
  | { kind: 'redirect'; location: string; status: number }
  | { kind: 'not-found'; status: 404 | 410 };

/** What `pressbase_404` callbacks receive. */
export interface NotFoundRequest {
  /** The requested path, e.g. `/missing-page/`. */
  path: string;
  /** The query string without `?`, or ''. */
  query: string;
  /** The Referer header, or ''. */
  referrer: string;
  /** The logged-in visitor, or null. */
  user: CurrentUser | null;
  /** The main query (`is404` is true). */
  main: MainQuery;
}

declare module '@pressbase/hooks' {
  interface ActionRegistry {
    template_redirect: [request: TemplateRedirectRequest];
    pressbase_404: [request: NotFoundRequest];
  }
  interface FilterRegistry {
    pre_handle_404: [preempt: boolean, main: MainQuery, url: URL];
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * wp_sanitize_redirect(): the characters a Location may hold, with no line
 * breaks. Returns undefined for anything that isn't http(s) or a local path.
 */
export function sanitizeRedirect(location: string): string | undefined {
  if (typeof location !== 'string') return undefined;
  const clean = location
    .replace(/[\r\n\t]|%0[ad]/gi, '')
    .replace(/[^a-z0-9\-~+_.?#=!&;,/:%@$|*'()[\]\x80-￿]/gi, (ch) => encodeURIComponent(ch));
  if (!clean) return undefined;
  if (clean.startsWith('/') && !clean.startsWith('//')) return clean;
  try {
    const url = new URL(clean);
    return url.protocol === 'http:' || url.protocol === 'https:' ? clean : undefined;
  } catch {
    return undefined;
  }
}

export class TemplateRedirect implements TemplateRedirectRequest {
  readonly path: string;
  readonly query: URLSearchParams;
  #answer: TemplateRedirectAnswer | undefined;
  #main: Promise<MainQuery> | undefined;

  constructor(
    url: URL,
    readonly referrer: string,
    readonly user: CurrentUser | null,
    private readonly resolveMain: () => Promise<MainQuery>,
  ) {
    this.path = url.pathname;
    this.query = new URLSearchParams(url.search);
  }

  main(): Promise<MainQuery> {
    this.#main ??= this.resolveMain();
    return this.#main;
  }

  /** The main query, if a callback already asked for it. */
  get resolvedMain(): Promise<MainQuery> | undefined {
    return this.#main;
  }

  get answer(): TemplateRedirectAnswer | undefined {
    return this.#answer;
  }

  redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 302): boolean {
    if (this.#answer || !REDIRECT_STATUSES.has(status)) return false;
    const clean = sanitizeRedirect(location);
    if (!clean) return false;
    this.#answer = { kind: 'redirect', location: clean, status };
    return true;
  }

  notFound(status: 404 | 410 = 404): boolean {
    if (this.#answer || (status !== 404 && status !== 410)) return false;
    this.#answer = { kind: 'not-found', status };
    return true;
  }
}
