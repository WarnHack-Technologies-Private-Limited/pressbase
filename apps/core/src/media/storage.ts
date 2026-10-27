import { createReadStream } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

/**
 * Where uploaded files live. WordPress writes to wp-content/uploads directly;
 * Pressbase goes through this interface so a site can swap the local disk for
 * an S3-compatible bucket without touching the media code.
 *
 * Keys are relative, forward-slash paths such as `2026/10/photo.jpg` — the
 * value WordPress stores in `_wp_attached_file`. Implementations must treat
 * keys as untrusted and refuse anything that could escape their root.
 */
export interface MediaStorage {
  /** Writes (or overwrites) a file. */
  put(key: string, data: Uint8Array, options: { contentType: string }): Promise<void>;
  /** Removes a file. Missing files are not an error. */
  delete(key: string): Promise<void>;
  /** Size and modification time, or undefined when the file doesn't exist. */
  stat(key: string): Promise<StoredFile | undefined>;
  /**
   * A stream of the file's bytes, optionally limited to an inclusive byte
   * range (for HTTP Range requests). Undefined when the file doesn't exist.
   */
  read(key: string, range?: { start: number; end: number }): Promise<ReadableStream | undefined>;
  /** Names of the files directly inside a folder (`2026/10`), for unique file names. */
  list(folder: string): Promise<string[]>;
  /** The public URL of a file. `siteUrl` is the site's address, without a trailing slash. */
  url(key: string, siteUrl: string): string;
}

export interface StoredFile {
  size: number;
  modified: Date;
}

/** URL path under which local uploads are served (outside /wp-json, as in WordPress). */
export const UPLOADS_PATH = '/wp-content/uploads';

/**
 * Splits a key into safe segments, or returns undefined. Rejects empty and
 * dot segments, backslashes, NUL bytes and hidden files, so a key can never
 * name anything outside the storage root.
 */
export function safeKeySegments(key: string): string[] | undefined {
  if (!key || key.length > 1024) return undefined;
  const segments = key.split('/');
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.startsWith('.') ||
      /[\\\0]/.test(segment) ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
      /[\x00-\x1f\x7f]/.test(segment)
    ) {
      return undefined;
    }
  }
  return segments;
}

/** Files on the server's disk, under `<dataDir>/uploads`. */
export class LocalStorage implements MediaStorage {
  constructor(readonly root: string) {}

  /** Absolute path for a key, guaranteed to sit inside the root. */
  #resolve(key: string): string | undefined {
    const segments = safeKeySegments(key);
    if (!segments) return undefined;
    const root = path.resolve(this.root);
    const full = path.resolve(root, ...segments);
    if (!full.startsWith(root + path.sep)) return undefined;
    return full;
  }

  /** Like #resolve, but also follows symlinks and checks the real path stays inside the root. */
  async #existing(key: string): Promise<string | undefined> {
    const full = this.#resolve(key);
    if (!full) return undefined;
    try {
      const [real, realRoot] = await Promise.all([realpath(full), realpath(this.root)]);
      return real.startsWith(realRoot + path.sep) ? real : undefined;
    } catch {
      return undefined;
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const full = this.#resolve(key);
    if (!full) throw new Error(`Invalid storage key: ${key}`);
    await mkdir(path.dirname(full), { recursive: true });
    // Write to a temporary name first so readers never see a half-written file.
    const temp = `${full}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, data, { mode: 0o644 });
    await rename(temp, full);
  }

  async delete(key: string): Promise<void> {
    const full = this.#resolve(key);
    if (!full) return;
    await rm(full, { force: true });
  }

  async stat(key: string): Promise<StoredFile | undefined> {
    const full = await this.#existing(key);
    if (!full) return undefined;
    const info = await stat(full).catch(() => undefined);
    if (!info?.isFile()) return undefined;
    return { size: info.size, modified: info.mtime };
  }

  async read(
    key: string,
    range?: { start: number; end: number },
  ): Promise<ReadableStream | undefined> {
    const full = await this.#existing(key);
    if (!full) return undefined;
    const stream = createReadStream(full, range ? { start: range.start, end: range.end } : {});
    return Readable.toWeb(stream) as ReadableStream;
  }

  async list(folder: string): Promise<string[]> {
    const full = folder ? this.#resolve(folder) : path.resolve(this.root);
    if (!full) return [];
    try {
      const entries = await readdir(full, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  url(key: string, siteUrl: string): string {
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `${siteUrl}${UPLOADS_PATH}/${encoded}`;
  }
}
