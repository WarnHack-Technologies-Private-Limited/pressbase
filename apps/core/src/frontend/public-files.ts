import type { CurrentUser } from '../auth/users';
import { parseFeedRequest } from './feeds';
import { parseSitemapRequest } from './sitemaps';

/**
 * Files plugins serve at fixed paths of the public site: `/llms.txt`, an
 * IndexNow key at `/{key}.txt`, `/.well-known/…`. WordPress plugins do this
 * with a rewrite rule and a `template_redirect` callback that prints and
 * exits; here a plugin declares the path (`api.public.addFile()`), and the
 * public renderer (frontend/render.ts) answers it after core's own files
 * (robots.txt, sitemaps, feeds) and before theme pages.
 *
 * Core's paths can't be taken: robots.txt, the sitemaps, feeds, anything
 * under `/wp-` and the admin's and apps' own paths are refused when the file
 * is added, so core always wins. Answers are part of the page cache
 * (ADR 0008) like any render: tags recorded while the handler runs (the
 * content services record them), plus `site` and the path's own tag.
 */

export interface PublicFileRequest {
  /** The path, e.g. `/llms.txt`. */
  path: string;
  query: URLSearchParams;
  /** The logged-in visitor, or null (always null for cacheable renders). */
  user: CurrentUser | null;
}

export interface PublicFileBody {
  body: string;
  /** Default 200. */
  status?: number;
  /** Default: from the file's extension (`.txt` → `text/plain; charset=utf-8`). */
  contentType?: string;
  /** Extra headers (`x-robots-tag`, `link`…); only the ones apps/web passes on reach visitors. */
  headers?: Record<string, string>;
}

/** A string is the body; null or undefined answers 404 (nothing to serve right now). */
export type PublicFileResult = string | PublicFileBody | null | undefined;

export type PublicFileHandler = (
  request: PublicFileRequest,
) => PublicFileResult | Promise<PublicFileResult>;

export interface PublicFileOptions {
  /** Default content type of the answers. */
  contentType?: string;
  /**
   * `false` marks every answer `private, no-store`, so the page cache never
   * keeps it. Leave it on when the content only changes with things that
   * purge (posts, terms, options): the cache keeps it until then.
   */
  cache?: boolean;
}

export interface PublicFile {
  path: string;
  handler: PublicFileHandler;
  owner: string;
  contentType: string;
  cache: boolean;
}

const PATH = /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/;

/** Paths of core, the admin and the apps (the admin proxies everything else to apps/web). */
const RESERVED = [
  '/robots.txt',
  '/favicon.ico',
  '/xmlrpc.php',
  '/admin',
  '/login',
  '/install',
  '/lost-password',
  '/reset-password',
  '/editor-assets',
  '/_next',
  '/_pressbase',
];

const TYPES: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=UTF-8',
  json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
};

/** The content type a file's extension suggests (plain text when unknown). */
export function contentTypeFor(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'text/plain; charset=utf-8';
}

/** Why a path can't be a plugin file, or undefined when it can. */
export function publicFilePathProblem(path: string): string | undefined {
  if (typeof path !== 'string' || !PATH.test(path) || path.length > 200) {
    return `"${path}" isn't a file path: start with "/", use letters, numbers, ".", "_", "~" and "-", and end with a file name.`;
  }
  const segments = path.split('/').slice(1);
  if (segments.some((s) => /^\.+$/.test(s))) return `"${path}" has a "." or ".." segment.`;
  const lower = path.toLowerCase();
  if (
    lower.startsWith('/wp-') ||
    RESERVED.some((r) => lower === r || lower.startsWith(`${r}/`) || lower.startsWith(`${r}.`))
  ) {
    return `"${path}" belongs to Pressbase.`;
  }
  const url = new URL(path, 'http://pressbase.invalid');
  for (const pretty of [true, false]) {
    if (parseSitemapRequest(url, pretty) || parseFeedRequest(url, pretty)) {
      return `"${path}" is a sitemap or feed address, which Pressbase serves.`;
    }
  }
  return undefined;
}

/** `kernel.publicFiles`: the registry of plugin files. */
export class PublicFiles {
  #files = new Map<string, PublicFile>();

  /** Adds a file; throws when the path is invalid, core's, or another plugin's. Returns its remover. */
  add(
    path: string,
    handler: PublicFileHandler,
    owner: string,
    options: PublicFileOptions = {},
  ): () => void {
    const problem = publicFilePathProblem(path);
    if (problem) throw new Error(problem);
    if (typeof handler !== 'function') throw new Error(`The file ${path} has no handler.`);
    const taken = this.#files.get(path);
    if (taken) throw new Error(`The path ${path} is already served by ${taken.owner}.`);
    const file: PublicFile = {
      path,
      handler,
      owner,
      contentType: options.contentType ?? contentTypeFor(path),
      cache: options.cache !== false,
    };
    this.#files.set(path, file);
    return () => {
      if (this.#files.get(path) === file) this.#files.delete(path);
    };
  }

  get(path: string): PublicFile | undefined {
    return this.#files.get(path);
  }

  all(): PublicFile[] {
    return [...this.#files.values()];
  }
}
