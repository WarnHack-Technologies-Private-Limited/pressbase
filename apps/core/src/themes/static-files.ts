import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { safeKeySegments } from '../media/storage';

/**
 * Serves files from a folder on disk with the same safety rules as uploads
 * (routes/uploads.ts): every path segment decoded and checked, an allow-list
 * of extensions, a real-path check against symlinks, nosniff, and caching
 * validators. Used for theme assets (/wp-content/themes/…) and WordPress's
 * front-end CSS (/wp-includes/…).
 */

/** Extensions a theme may serve. No PHP, HTML, JSON or Markdown: those are the theme's source. */
export const STATIC_TYPES: Record<string, string> = {
  css: 'text/css',
  js: 'text/javascript',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export const notFoundResponse = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });

/** Decodes a URL path below a prefix into safe segments, or undefined. */
export function safeSegments(pathname: string, prefix: string): string[] | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const segments: string[] = [];
  for (const raw of pathname.slice(prefix.length).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (segment.includes('/') || segment.includes('\\')) return undefined;
    segments.push(segment);
  }
  return safeKeySegments(segments.join('/'));
}

/** Streams `root/segments…` if it is an allowed, existing file inside `root`. */
export async function serveStaticFile(
  c: Context,
  root: string,
  segments: string[],
  options: { maxAge?: number } = {},
): Promise<Response> {
  const name = segments[segments.length - 1] ?? '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const type = STATIC_TYPES[ext];
  if (!type) return notFoundResponse();

  const base = path.resolve(root);
  const full = path.resolve(base, ...segments);
  if (!full.startsWith(base + path.sep)) return notFoundResponse();
  let real: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    real = await realpath(full);
    const realBase = await realpath(base);
    if (!real.startsWith(realBase + path.sep)) return notFoundResponse();
    info = await stat(real);
  } catch {
    return notFoundResponse();
  }
  if (!info.isFile()) return notFoundResponse();

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs / 1000).toString(16)}"`;
  const lastModified = info.mtime.toUTCString();
  const headers: Record<string, string> = {
    'content-type': type.startsWith('text/') ? `${type}; charset=utf-8` : type,
    'x-content-type-options': 'nosniff',
    'cache-control': `public, max-age=${options.maxAge ?? 86_400}`,
    etag,
    'last-modified': lastModified,
    'access-control-allow-origin': '*',
  };
  // An SVG opened directly must not run scripts.
  if (ext === 'svg') {
    headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  }
  const ifNoneMatch = c.req.header('if-none-match');
  const ifModifiedSince = c.req.header('if-modified-since');
  const notModified = ifNoneMatch
    ? ifNoneMatch.split(',').some((tag) => tag.trim() === etag || tag.trim() === '*')
    : ifModifiedSince
      ? Math.floor(info.mtimeMs / 1000) <= Math.floor(Date.parse(ifModifiedSince) / 1000)
      : false;
  if (notModified) return new Response(null, { status: 304, headers });
  const body =
    c.req.method === 'HEAD'
      ? null
      : (Readable.toWeb(createReadStream(real)) as unknown as ReadableStream);
  return new Response(body, {
    status: 200,
    headers: { ...headers, 'content-length': String(info.size) },
  });
}
