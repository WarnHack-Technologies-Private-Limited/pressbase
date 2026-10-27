/**
 * Allowed upload types and content sniffing — a stricter take on WordPress's
 * get_allowed_mime_types(), wp_check_filetype() and wp_check_filetype_and_ext()
 * (wordpress/wp-includes/functions.php).
 *
 * WordPress trusts the extension for most files and only sniffs images. Pressbase
 * checks every upload's leading bytes against its extension, and never allows
 * SVG, HTML, scripts or executables (they can run code in a visitor's browser
 * or on a server).
 */

/** Extension list (WordPress's `jpg|jpeg|jpe` keys) → MIME type. */
export const ALLOWED_MIME_TYPES: Record<string, string> = {
  // Images.
  'jpg|jpeg|jpe': 'image/jpeg',
  gif: 'image/gif',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  // Documents.
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  csv: 'text/csv',
  // Audio.
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  'ogg|oga': 'audio/ogg',
  wav: 'audio/wav',
  // Video.
  'mp4|m4v': 'video/mp4',
  'mov|qt': 'video/quicktime',
  webm: 'video/webm',
};

/** Types the browser can display as images and Pressbase can resize. */
export const RESIZABLE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/** WordPress's media types (the MIME type's first part), for the `media_type` filter. */
export function mediaTypes(allowed: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const mime of Object.values(allowed)) {
    const group = mime.split('/')[0] ?? '';
    out[group] = [...new Set([...(out[group] ?? []), mime])];
  }
  return out;
}

/** wp_check_filetype(): the MIME type for a file name's extension, from the allowed list. */
export function mimeForExtension(
  ext: string,
  allowed: Record<string, string> = ALLOWED_MIME_TYPES,
): string | undefined {
  const lower = ext.toLowerCase();
  for (const [exts, mime] of Object.entries(allowed)) {
    if (exts.split('|').includes(lower)) return mime;
  }
  return undefined;
}

/** The preferred extension for a MIME type (wp_get_default_extension_for_mime_type()). */
export function extensionForMime(
  mime: string,
  allowed: Record<string, string> = ALLOWED_MIME_TYPES,
): string | undefined {
  for (const [exts, type] of Object.entries(allowed)) {
    if (type === mime) return exts.split('|')[0];
  }
  return undefined;
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** What the leading bytes say a file is. Coarse families for containers. */
export type Sniffed =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif'
  | 'application/pdf'
  | 'zip'
  | 'ole'
  | 'rtf'
  | 'audio/mpeg'
  | 'audio/ogg'
  | 'audio/wav'
  | 'isobmff'
  | 'video/quicktime'
  | 'video/webm'
  | 'text'
  | 'unknown';

/** Identifies a file by its magic bytes, like wp_get_image_mime() but for every allowed type. */
export function sniff(bytes: Uint8Array): Sniffed {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(bytes, 4, 8) === 'ftyp') {
    // ISO base media: AVIF images, and MP4 / M4A / MOV audio and video.
    const brands: string[] = [];
    const boxSize = Math.min(
      bytes.length,
      ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0),
    );
    brands.push(ascii(bytes, 8, 12));
    for (let i = 16; i + 4 <= boxSize; i += 4) brands.push(ascii(bytes, i, i + 4));
    if (brands.some((b) => b === 'avif' || b === 'avis')) return 'image/avif';
    if (brands[0] === 'qt  ') return 'video/quicktime';
    return 'isobmff';
  }
  if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(ascii(bytes, 4, 8))) {
    return 'video/quicktime';
  }
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole';
  if (ascii(bytes, 0, 5) === '{\\rtf') return 'rtf';
  if (ascii(bytes, 0, 4) === 'OggS') return 'audio/ogg';
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(bytes, 0, 3) === 'ID3') return 'audio/mpeg';
  // An MPEG audio frame header: 11 set sync bits, then a valid layer.
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && ((bytes[1] ?? 0) & 0x06) !== 0) {
    return 'audio/mpeg';
  }
  if (looksLikeText(bytes)) return 'text';
  return 'unknown';
}

/**
 * Plain text: no NUL or other binary control bytes, and nothing a browser
 * would treat as markup if a misconfigured server dropped `nosniff`.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192);
  for (const b of head) {
    if (b === 0 || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c)) {
      return false;
    }
  }
  const start = new TextDecoder('utf-8', { fatal: false })
    .decode(head.subarray(0, 512))
    .replace(/^﻿/, '')
    .trimStart()
    .toLowerCase();
  return !/^<(!doctype|html|head|body|script|svg|\?xml|iframe)/.test(start);
}

/** Which sniffed family each allowed MIME type must come from. */
const EXPECTED: Record<string, Sniffed[]> = {
  'image/jpeg': ['image/jpeg'],
  'image/png': ['image/png'],
  'image/gif': ['image/gif'],
  'image/webp': ['image/webp'],
  'image/avif': ['image/avif'],
  'application/pdf': ['application/pdf'],
  'application/msword': ['ole'],
  'application/vnd.ms-excel': ['ole'],
  'application/vnd.ms-powerpoint': ['ole'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['zip'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['zip'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['zip'],
  'application/vnd.oasis.opendocument.text': ['zip'],
  'application/vnd.oasis.opendocument.spreadsheet': ['zip'],
  'application/vnd.oasis.opendocument.presentation': ['zip'],
  'application/rtf': ['rtf'],
  'text/plain': ['text'],
  'text/csv': ['text'],
  'audio/mpeg': ['audio/mpeg'],
  'audio/mp4': ['isobmff'],
  'audio/ogg': ['audio/ogg'],
  'audio/wav': ['audio/wav'],
  'video/mp4': ['isobmff', 'video/quicktime'],
  'video/quicktime': ['video/quicktime', 'isobmff'],
  'video/webm': ['video/webm'],
};

export interface CheckedType {
  ext: string;
  type: string;
  /** Set when the extension was corrected to match the content (images only, as in WordPress). */
  properFilename?: string;
}

/**
 * wp_check_filetype_and_ext(): the file's real type, or undefined when it is
 * not allowed. The extension must be on the allowed list *and* the content
 * must match it. An image saved with the wrong image extension (a PNG named
 * .jpg) gets its extension corrected, as WordPress does.
 */
export function checkFileType(
  filename: string,
  bytes: Uint8Array,
  allowed: Record<string, string> = ALLOWED_MIME_TYPES,
): CheckedType | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const ext = filename.slice(dot + 1).toLowerCase();
  const type = mimeForExtension(ext, allowed);
  if (!type) return undefined;
  const sniffed = sniff(bytes);

  if (type.startsWith('image/') || sniffed.startsWith('image/')) {
    if (!sniffed.startsWith('image/')) return undefined;
    if (sniffed === type) return { ext, type };
    // A real image with the wrong image extension: correct it.
    const realExt = extensionForMime(sniffed, allowed);
    if (!realExt || !type.startsWith('image/')) return undefined;
    return {
      ext: realExt,
      type: sniffed,
      properFilename: `${filename.slice(0, dot)}.${realExt}`,
    };
  }
  return EXPECTED[type]?.includes(sniffed) ? { ext, type } : undefined;
}
