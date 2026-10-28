/**
 * The public site's only job: ask core to render a URL with the active theme,
 * and turn core's answer into an HTTP response. Core owns routing, the
 * template hierarchy, theme.json and caching decisions (see
 * docs/adr/0007-public-rendering.md); this app holds no business logic.
 */

/** What GET /wp-json/pressbase/v1/render returns. */
export interface RenderResult {
  status: number;
  headers: Record<string, string>;
  /** The body: HTML, or XML / text for feeds, sitemaps and robots.txt. */
  html: string;
  /** Cache tags: what the response depends on (see page-cache.ts). */
  tags?: string[];
}

/** Headers from core that may reach the visitor. Anything else is dropped. */
export const PASSTHROUGH_HEADERS = [
  'content-type',
  'cache-control',
  'location',
  'etag',
  'last-modified',
  'link',
  'x-robots-tag',
  'vary',
] as const;

/** Request headers forwarded to core: the session cookie (previews) and the ETag validator. */
export const FORWARDED_REQUEST_HEADERS = ['cookie', 'if-none-match'] as const;

/** The core render endpoint for a public URL, keeping its path and query string. */
export function renderEndpoint(coreUrl: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  const target = `${url.pathname}${url.search}`;
  return `${coreUrl.replace(/\/+$/, '')}/wp-json/pressbase/v1/render?url=${encodeURIComponent(target)}`;
}

/** Copies the allowed headers (case-insensitively) and adds nosniff. */
export function pickHeaders(source: Record<string, string> | undefined): Headers {
  const headers = new Headers();
  const lower = new Map(Object.entries(source ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of PASSTHROUGH_HEADERS) {
    const value = lower.get(name);
    if (typeof value === 'string' && value !== '' && !/[\r\n]/.test(value)) {
      headers.set(name, value);
    }
  }
  if (!headers.has('content-type')) headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

/** Statuses that never carry a body. */
const BODYLESS = new Set([204, 304]);

export function isRenderResult(value: unknown): value is RenderResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.status === 'number' &&
    Number.isInteger(v.status) &&
    v.status >= 200 &&
    v.status <= 599 &&
    typeof v.html === 'string'
  );
}

/** Turns core's render result into the visitor's response. */
export function toResponse(result: RenderResult, method = 'GET'): Response {
  const headers = pickHeaders(result.headers);
  const body = method === 'HEAD' || BODYLESS.has(result.status) ? null : result.html;
  return new Response(body, { status: result.status, headers });
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[ch] ?? ch,
  );
}

/** A minimal page for when core can't render the site. */
export function errorPage(status: number, title: string, message: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#1e1e1e}h1{font-size:1.5rem}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Interprets core's reply. A 200 carries a RenderResult; a 503 with
 * `pressbase_not_installed` sends the visitor to the installer, which lives in
 * the admin app. Anything else means core can't render pages yet.
 */
export async function responseFromCore(
  res: Response,
  { method, adminUrl }: { method: string; adminUrl: string },
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    payload = undefined;
  }
  if (res.ok && isRenderResult(payload)) return toResponse(payload, method);

  const code = (payload as { code?: unknown } | undefined)?.code;
  if (res.status === 503 && code === 'pressbase_not_installed') {
    // The installer belongs to the admin app. When this app is reached through
    // the admin's fallback proxy, ADMIN_URL is that same origin.
    return new Response(null, {
      status: 302,
      headers: { location: `${adminUrl.replace(/\/+$/, '')}/install`, 'cache-control': 'no-store' },
    });
  }
  return errorPage(
    502,
    'The site can’t be shown right now',
    'Pressbase’s core server answered, but couldn’t render this page. Check the core server’s logs, then reload.',
  );
}
