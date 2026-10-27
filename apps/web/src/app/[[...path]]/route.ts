import {
  errorPage,
  FORWARDED_REQUEST_HEADERS,
  renderEndpoint,
  responseFromCore,
} from '@/lib/render';

/**
 * Every public URL (except /wp-json, /wp-content and /wp-includes, which
 * next.config.ts proxies to core) is rendered by core's theme engine.
 *
 * Always dynamic: core decides how long a page may be cached and says so in
 * Cache-Control and ETag. Rendering here with ISR and revalidating by tag when
 * content changes is a later step.
 */
export const dynamic = 'force-dynamic';

const CORE_URL = process.env.CORE_URL ?? 'http://localhost:4000';
const ADMIN_URL = process.env.ADMIN_URL ?? 'http://localhost:3000';

async function handle(request: Request): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  let res: Response;
  try {
    res = await fetch(renderEndpoint(CORE_URL, request.url), {
      headers,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return errorPage(
      502,
      'The site can’t be reached right now',
      `Pressbase’s core server isn’t answering at ${CORE_URL}. Start it (pnpm dev), then reload this page.`,
    );
  }
  return responseFromCore(res, { method: request.method, adminUrl: ADMIN_URL });
}

export const GET = handle;
export const HEAD = handle;
