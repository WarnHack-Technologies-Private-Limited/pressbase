import type { Context } from 'hono';
import { z } from 'zod';
import { PostError } from '../content/posts';
import { TermError } from '../content/terms';
import { restError } from '../http';

/**
 * Helpers shared by the WordPress-compatible collection controllers
 * (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-controller.php).
 */

/**
 * Query string → plain object. Array parameters accept every WordPress form:
 * `tags=1,2`, `tags[]=1&tags[]=2` and `tags=1&tags=2`.
 */
export function queryObject(
  c: Context,
  arrayKeys: readonly string[],
): Record<string, string | string[]> {
  const url = new URL(c.req.url);
  const out: Record<string, string | string[]> = {};
  for (const [rawKey, value] of url.searchParams) {
    const key = rawKey.endsWith('[]') ? rawKey.slice(0, -2) : rawKey;
    if (arrayKeys.includes(key)) {
      const existing = (out[key] as string[] | undefined) ?? [];
      out[key] = [
        ...existing,
        ...value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      ];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const intList = z.array(z.coerce.number().int().min(0)).optional();
export const stringList = z.array(z.string()).optional();
export const boolParam = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const contextParam = z.enum(['view', 'edit', 'embed']).default('view');
export const pageParam = z.coerce.number().int().min(1).default(1);
export const perPageParam = z.coerce.number().int().min(1).max(100).default(10);

/** X-WP-Total, X-WP-TotalPages and Link headers, as WordPress sends them. */
export function setPaginationHeaders(
  c: Context,
  total: number,
  totalPages: number,
  page: number,
): void {
  c.header('X-WP-Total', String(total));
  c.header('X-WP-TotalPages', String(totalPages));
  const url = new URL(c.req.url);
  const links: string[] = [];
  if (page > 1) {
    url.searchParams.set('page', String(Math.min(page - 1, Math.max(totalPages, 1))));
    links.push(`<${url.pathname}${url.search}>; rel="prev"`);
  }
  if (page < totalPages) {
    url.searchParams.set('page', String(page + 1));
    links.push(`<${url.pathname}${url.search}>; rel="next"`);
  }
  if (links.length) c.header('Link', links.join(', '));
}

/** Turns service errors into REST errors; rethrows anything unexpected. */
export function serviceError(c: Context, error: unknown) {
  if (error instanceof PostError || error instanceof TermError) {
    const extra = error instanceof TermError ? error.data : {};
    return restError(c, error.status, error.code, error.message, extra);
  }
  throw error;
}

/** WordPress accepts `title: "…"` or `title: { raw: "…" }`. */
export const rawText = z
  .union([z.string(), z.object({ raw: z.string() })])
  .transform((v) => (typeof v === 'string' ? v : v.raw));

/** 401 for logged-out visitors, 403 for logged-in users — WordPress's rest_authorization_required_code(). */
export function authStatus(c: Context): 401 | 403 {
  return c.get('user') ? 403 : 401;
}
