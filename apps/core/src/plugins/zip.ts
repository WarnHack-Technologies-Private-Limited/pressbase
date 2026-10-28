import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * A small, strict ZIP reader for plugin uploads (WordPress's unzip_file()
 * with PclZip / ZipArchive). It reads the central directory, refuses anything
 * that could write outside the target folder or surprise the server, and
 * inflates entries with hard output limits:
 *
 * - names with `..`, absolute paths, drive letters, backslashes or NUL (zip-slip);
 * - symbolic links and other special files (Unix mode in the external attributes);
 * - encrypted entries, ZIP64 archives, compression other than store/deflate;
 * - more than `maxEntries` files, or more than `maxTotalBytes` once inflated
 *   (zip bombs: every entry is inflated with `maxOutputLength` = its declared size);
 * - duplicate names and CRC mismatches.
 *
 * macOS metadata (`__MACOSX/`, `.DS_Store`) is skipped.
 */

export class ZipError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. Never absolute, never contains `..`. */
  name: string;
  data: Uint8Array;
}

export interface ReadZipOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/**
 * Validates one archive path and returns it normalised (no trailing slash),
 * or throws. Exported for tests and for anything else that extracts files.
 */
export function safeEntryPath(name: string): string {
  const bad = () =>
    new ZipError('incompatible_archive_path', `Unsafe path in the archive: "${name}".`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (!name || /[\\\x00-\x1f]/.test(name) || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw bad();
  }
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  const segments = trimmed.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw bad();
  return trimmed;
}

function isJunk(name: string): boolean {
  return name.startsWith('__MACOSX/') || name === '.DS_Store' || name.endsWith('/.DS_Store');
}

export function readZip(input: Uint8Array, options: ReadZipOptions = {}): ZipEntry[] {
  const maxEntries = options.maxEntries ?? 5000;
  const maxTotal = options.maxTotalBytes ?? 256 * 1024 * 1024;
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const notZip = () => new ZipError('incompatible_archive', 'The file is not a valid ZIP archive.');

  // End of central directory: the last 22 bytes, plus up to 64 KB of comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw notZip();
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('incompatible_archive', 'ZIP64 archives are not supported.');
  }
  if (cdOffset + cdSize > eocd) throw notZip();
  if (count > maxEntries) {
    throw new ZipError('incompatible_archive', `The archive has more than ${maxEntries} files.`);
  }

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw notZip();
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;

    if (isJunk(rawName)) continue;
    const name = safeEntryPath(rawName);
    const isDir = rawName.endsWith('/');
    // Unix "version made by": the file type sits in the high 16 bits of the external attributes.
    const mode = madeBy === 3 ? (external >>> 16) & S_IFMT : 0;
    if (mode && mode !== S_IFREG && mode !== S_IFDIR) {
      throw new ZipError(
        'incompatible_archive_symlink',
        `The archive contains a link or special file: "${rawName}".`,
      );
    }
    if (isDir || mode === S_IFDIR) continue;
    if (flags & 0x1) {
      throw new ZipError('incompatible_archive', 'Encrypted archives are not supported.');
    }
    if (method !== 0 && method !== 8) {
      throw new ZipError('incompatible_archive', `Unsupported compression in "${rawName}".`);
    }
    if (seen.has(name)) {
      throw new ZipError('incompatible_archive', `The archive lists "${name}" twice.`);
    }
    seen.add(name);
    total += size;
    if (total > maxTotal) {
      throw new ZipError(
        'incompatible_archive_too_big',
        `The archive is larger than ${Math.round(maxTotal / 1024 / 1024)} MB once unpacked.`,
      );
    }

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) throw notZip();
    const start =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compressed > buf.length) throw notZip();
    const raw = buf.subarray(start, start + compressed);
    let data: Buffer;
    if (method === 0) {
      data = raw;
    } else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
      } catch {
        throw new ZipError('incompatible_archive', `"${rawName}" could not be unpacked.`);
      }
    }
    if (data.length !== size || crc32(data) !== crc) {
      throw new ZipError('incompatible_archive', `"${rawName}" is damaged.`);
    }
    entries.push({ name, data: new Uint8Array(data) });
  }
  return entries;
}

export interface NewZipEntry {
  name: string;
  data?: string | Uint8Array;
  /** Store the entry as a symbolic link (for tests of the reader's checks). */
  symlink?: boolean;
}

/** Writes a ZIP archive (deflate), e.g. for tests and exports. */
export function createZip(files: NewZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(
      typeof file.data === 'string' ? file.data : (file.data ?? new Uint8Array()),
    );
    const isDir = file.name.endsWith('/');
    const deflated = isDir ? data : deflateRawSync(data);
    const method = isDir ? 0 : 8;
    const crc = crc32(data);
    const mode = file.symlink ? 0o120777 : isDir ? 0o040755 : 0o100644;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}
