import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { resolveSession, SESSION_COOKIE } from './auth/sessions';
import { type CurrentUser, loadUser, userCan } from './auth/users';
import type { Kernel } from './kernel';

export interface AppEnv {
  Variables: {
    kernel: Kernel;
    user: CurrentUser | null;
  };
}

/**
 * Errors use WordPress's REST error shape so existing clients can read them:
 * { code, message, data: { status, ...extra } }
 */
export function restError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return c.json({ code, message, data: { status, ...extra } }, status);
}

/** First address in X-Forwarded-For (set by the admin app's proxy), else empty. */
export function clientIp(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
}

export function isSecureRequest(c: Context): boolean {
  return c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF protection for cookie-authenticated requests. Browsers cannot attach a
 * custom header to a cross-site request without a CORS preflight, which core
 * never approves, so requiring X-Pressbase-Request on unsafe methods blocks
 * cross-site form posts. Requests with an Authorization header (API clients)
 * carry no ambient credentials and are exempt.
 */
export const requireRequestHeader: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (
    UNSAFE_METHODS.has(c.req.method) &&
    !c.req.header('authorization') &&
    !c.req.header('x-pressbase-request') &&
    !isAnonymousComment(c)
  ) {
    return restError(
      c,
      403,
      'pressbase_missing_request_header',
      'This request is missing the X-Pressbase-Request header.',
    );
  }
  await next();
};

/**
 * The one exception to the header rule: a visitor *without a session cookie*
 * posting a new comment to /wp/v2/comments. With no cookie there are no
 * ambient credentials to abuse, so a cross-site request can do nothing the
 * visitor couldn't do directly; it's how a public comment form can post
 * without the admin's JavaScript. With a cookie, the header is required as
 * usual. See docs/architecture/security.md.
 */
function isAnonymousComment(c: Context): boolean {
  return (
    c.req.method === 'POST' &&
    /\/wp-json\/wp\/v2\/comments\/?$/.test(c.req.path) &&
    getCookie(c, SESSION_COOKIE) === undefined
  );
}

/** Rejects requests until the site is installed. */
export const requireInstalled: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('kernel').state !== 'ready') {
    return restError(c, 503, 'pressbase_not_installed', 'Pressbase is not installed yet.');
  }
  await next();
};

/** Loads the logged-in user from the session cookie, if there is one. */
export const loadSessionUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const kernel = c.get('kernel');
  const token = getCookie(c, SESSION_COOKIE);
  let user: CurrentUser | null = null;
  if (token && kernel.state === 'ready') {
    const userId = await resolveSession(kernel, token);
    if (userId !== null) user = await loadUser(kernel, userId);
  }
  c.set('user', user);
  await next();
};

/** 401 when logged out, 403 when logged in without the capability — as WordPress does. */
export function requireCapability(capability: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!userCan(user, capability)) {
      return restError(
        c,
        user ? 403 : 401,
        'rest_forbidden',
        c.get('kernel').i18n.__('Sorry, you are not allowed to do that.', 'pressbase'),
      );
    }
    await next();
  };
}

/** Reads a JSON body, returning undefined instead of throwing when it is malformed. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * Answers with WordPress's rest_invalid_param error, keyed by field path, so
 * forms can show each message next to its field.
 */
export function invalidParams(c: Context, error: z.ZodError) {
  const params: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'body';
    params[key] ??= issue.message;
  }
  return restError(
    c,
    400,
    'rest_invalid_param',
    `Invalid parameter(s): ${Object.keys(params).join(', ')}`,
    {
      params,
    },
  );
}
