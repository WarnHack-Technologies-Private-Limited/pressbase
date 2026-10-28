import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import path from 'node:path';

/**
 * Downloads an attachment for the importer: WordPress's wp_safe_remote_get()
 * (wp_http_validate_url(), wp-includes/http.php), with the importer's
 * size limit (WP_Import::fetch_remote_file()).
 *
 * - Only http and https, on ports 80, 443 and 8080 (`http_allowed_safe_ports`).
 * - Private, loopback, link-local, unique-local, carrier-grade NAT, multicast
 *   and unspecified addresses are refused. The check runs on the address the
 *   socket actually connects to, in the DNS lookup, so a name that resolves
 *   to a public address once and a private one later (DNS rebinding) can't
 *   slip through, and every redirect is checked again.
 * - At most `maxRedirects` redirects, `maxBytes` bytes (checked against
 *   Content-Length first, then while reading) and `timeoutMs` in total.
 *
 * `allowPrivate` (PRESSBASE_IMPORT_ALLOW_PRIVATE_HOSTS) lifts the address
 * and port checks, for importing from a site on your own network. The
 * `http_request_host_is_external` filter can allow single hosts, as in WordPress.
 */

export class RemoteFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface FetchOptions {
  maxBytes: number;
  allowPrivate?: boolean;
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Ports allowed when private hosts aren't (http_allowed_safe_ports). */
  safePorts?: number[];
  /** http_request_host_is_external: may a host that resolves privately be fetched? */
  hostIsExternal?: (host: string, url: string) => boolean | Promise<boolean>;
}

export interface RemoteFile {
  data: Uint8Array;
  /** The file name from the final URL (or Content-Disposition). */
  filename: string;
  contentType: string;
  url: string;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network, unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata services live here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['64:ff9b::', 96], // NAT64, which can reach IPv4 private ranges
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for addresses an import must not reach unless private hosts are allowed. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

const DEFAULT_SAFE_PORTS = [80, 443, 8080];

function guardedLookup(allowPrivate: boolean, allowedHost: () => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const list = addresses as LookupAddress[];
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad && !allowPrivate && !allowedHost()) {
        return callback(
          new RemoteFileError(
            'import_private_host',
            `${hostname} points to a private network address (${bad.address}), so it wasn’t downloaded.`,
          ),
          '',
          0,
        );
      }
      if (options.all) return callback(null, list as never);
      const first = list[0];
      if (!first) return callback(new Error(`No address for ${hostname}.`), '', 0);
      callback(null, first.address, first.family);
    });
  };
}

function filenameFrom(url: URL, disposition: string | undefined): string {
  const match = disposition && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (match?.[1]) {
    try {
      return path.basename(decodeURIComponent(match[1]));
    } catch {
      return path.basename(match[1]);
    }
  }
  try {
    return path.basename(decodeURIComponent(url.pathname)) || 'file';
  } catch {
    return path.basename(url.pathname) || 'file';
  }
}

/** Fetches a file within the limits above. Throws RemoteFileError with a plain reason. */
export async function fetchRemoteFile(rawUrl: string, options: FetchOptions): Promise<RemoteFile> {
  const maxRedirects = options.maxRedirects ?? 5;
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const allowPrivate = Boolean(options.allowPrivate);
  const safePorts = options.safePorts ?? DEFAULT_SAFE_PORTS;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RemoteFileError('import_invalid_url', `“${rawUrl}” isn’t a web address.`);
  }

  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new RemoteFileError(
        'import_invalid_url',
        `Only http and https addresses can be downloaded, not ${url.protocol}.`,
      );
    }
    if (url.username || url.password) {
      throw new RemoteFileError(
        'import_invalid_url',
        'Addresses with a user name or password aren’t downloaded.',
      );
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const external =
      !allowPrivate && options.hostIsExternal
        ? await options.hostIsExternal(host, url.href)
        : false;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!allowPrivate && !external && !safePorts.includes(port)) {
      throw new RemoteFileError(
        'import_unsafe_port',
        `Port ${port} isn’t one files are downloaded from (${safePorts.join(', ')}).`,
      );
    }
    // A literal IP never reaches the lookup, so check it here.
    if (isIP(host) && isPrivateAddress(host) && !allowPrivate && !external) {
      throw new RemoteFileError(
        'import_private_host',
        `${host} is a private network address, so it wasn’t downloaded.`,
      );
    }

    const response = await request(url, {
      lookup: guardedLookup(allowPrivate, () => external),
      deadline,
      signal: options.signal,
    });
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      if (hop >= maxRedirects) {
        throw new RemoteFileError(
          'import_too_many_redirects',
          'The file’s address redirected too many times.',
        );
      }
      url = new URL(response.headers.location, url);
      continue;
    }
    if (status !== 200) {
      response.resume();
      throw new RemoteFileError(
        'import_file_error',
        `The server answered ${status}${response.statusMessage ? ` ${response.statusMessage}` : ''}.`,
      );
    }
    const length = Number(response.headers['content-length'] ?? 0);
    if (length > options.maxBytes) {
      response.destroy();
      throw tooBig(options.maxBytes);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > options.maxBytes) {
        response.destroy();
        throw tooBig(options.maxBytes);
      }
      chunks.push(chunk);
    }
    if (length && total !== length) {
      throw new RemoteFileError(
        'import_file_error',
        'The download stopped before the whole file arrived.',
      );
    }
    if (!total) throw new RemoteFileError('import_file_error', 'The downloaded file is empty.');
    return {
      data: new Uint8Array(Buffer.concat(chunks, total)),
      filename: filenameFrom(url, response.headers['content-disposition']),
      contentType: String(response.headers['content-type'] ?? ''),
      url: url.href,
    };
  }
}

function tooBig(max: number): RemoteFileError {
  return new RemoteFileError(
    'import_file_too_big',
    `The file is larger than the ${Math.round(max / 1024 / 1024)} MB limit.`,
  );
}

function request(
  url: URL,
  options: { lookup: LookupFunction; deadline: number; signal?: AbortSignal },
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) {
      reject(new RemoteFileError('import_timeout', 'The download took too long.'));
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      lookup: options.lookup,
      signal: options.signal,
      headers: { 'user-agent': 'Pressbase importer', accept: '*/*' },
    });
    // One timer covers the whole download, body included.
    const timer = setTimeout(() => {
      req.destroy(new RemoteFileError('import_timeout', 'The download took too long.'));
    }, remaining);
    timer.unref?.();
    req.on('response', (response) => {
      response.on('close', () => clearTimeout(timer));
      response.on('error', () => clearTimeout(timer));
      resolve(response);
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
