import { type Context, Hono } from 'hono';
import type { AppEnv } from '../http';
import { mimeForExtension } from '../media/mime';
import { mediaStorage } from '../media/service';
import { safeKeySegments, UPLOADS_PATH } from '../media/storage';

/**
 * GET /wp-content/uploads/* — serves uploaded files from the media storage,
 * where WordPress relies on the web server. Paths are checked strictly: any
 * encoded slash, dot segment, hidden file or unknown type is a 404.
 *
 * Responses carry the type for the file's extension (never sniffed), nosniff,
 * a sandboxing CSP, long-lived caching with ETag / Last-Modified validators,
 * and byte ranges so audio and video can seek.
 */

const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });

/** The storage key for a request path, or undefined when the path isn't safe. */
export function keyFromPath(pathname: string): string | undefined {
  const prefix = `${UPLOADS_PATH}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const segments: string[] = [];
  for (const raw of pathname.slice(prefix.length).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    // An encoded slash or backslash would smuggle a separator past the split.
    if (segment.includes('/') || segment.includes('\\')) return undefined;
    segments.push(segment);
  }
  const key = segments.join('/');
  return safeKeySegments(key) ? key : undefined;
}

/** Parses a single `bytes=a-b` range. Multiple ranges aren't supported (full response instead). */
function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | 'invalid' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, from = '', to = ''] = match;
  if (!from && !to) return undefined;
  let start: number;
  let end: number;
  if (!from) {
    // Suffix range: the last N bytes.
    const length = Number(to);
    if (length === 0) return 'invalid';
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(from);
    end = to ? Math.min(Number(to), size - 1) : size - 1;
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

export function uploadsRoutes() {
  const app = new Hono<AppEnv>({ strict: true });

  const serve = async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    if (kernel.state !== 'ready') return notFound();
    const key = keyFromPath(new URL(c.req.url).pathname);
    if (!key) return notFound();
    const ext = key.slice(key.lastIndexOf('.') + 1);
    const type = key.includes('.') ? mimeForExtension(ext) : undefined;
    if (!type) return notFound();

    const storage = mediaStorage(kernel);
    const info = await storage.stat(key);
    if (!info) return notFound();

    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.modified.getTime() / 1000).toString(16)}"`;
    const lastModified = info.modified.toUTCString();
    const headers: Record<string, string> = {
      'content-type': type.startsWith('text/') ? `${type}; charset=utf-8` : type,
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=31536000',
      etag,
      'last-modified': lastModified,
      'accept-ranges': 'bytes',
      // Uploaded files never run scripts, even if a browser were tricked into rendering one.
      // PDFs are exempt: Chrome's built-in viewer doesn't load in a sandbox.
      ...(type === 'application/pdf'
        ? {}
        : {
            'content-security-policy':
              "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
          }),
    };

    const ifNoneMatch = c.req.header('if-none-match');
    const ifModifiedSince = c.req.header('if-modified-since');
    const notModified = ifNoneMatch
      ? ifNoneMatch.split(',').some((tag) => tag.trim() === etag || tag.trim() === '*')
      : ifModifiedSince
        ? Math.floor(info.modified.getTime() / 1000) <=
          Math.floor(Date.parse(ifModifiedSince) / 1000)
        : false;
    if (notModified) return new Response(null, { status: 304, headers });

    let range: { start: number; end: number } | 'invalid' | undefined;
    const rangeHeader = c.req.header('range');
    const ifRange = c.req.header('if-range');
    if (rangeHeader && (!ifRange || ifRange === etag || ifRange === lastModified)) {
      range = parseRange(rangeHeader, info.size);
    }
    if (range === 'invalid') {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'content-range': `bytes */${info.size}` },
      });
    }

    const head = c.req.method === 'HEAD';
    if (range) {
      const body = head ? null : await storage.read(key, range);
      return new Response(body, {
        status: 206,
        headers: {
          ...headers,
          'content-range': `bytes ${range.start}-${range.end}/${info.size}`,
          'content-length': String(range.end - range.start + 1),
        },
      });
    }
    const body = head ? null : await storage.read(key);
    if (!head && !body) return notFound();
    return new Response(body, {
      status: 200,
      headers: { ...headers, 'content-length': String(info.size) },
    });
  };

  // Hono answers HEAD with the GET handler and drops the body.
  app.get('/*', serve);
  return app;
}
