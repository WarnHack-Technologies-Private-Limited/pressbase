import { ALLOWED_MIME_TYPES, mimeForExtension } from './mime';
import type { MediaStorage } from './storage';

/**
 * File names — ports of sanitize_file_name() (wordpress/wp-includes/formatting.php)
 * and wp_unique_filename() (wordpress/wp-includes/functions.php).
 */

const SPECIAL_CHARS = [
  '?',
  '[',
  ']',
  '/',
  '\\',
  '=',
  '<',
  '>',
  ':',
  ';',
  ',',
  "'",
  '"',
  '&',
  '$',
  '#',
  '*',
  '(',
  ')',
  '|',
  '~',
  '`',
  '!',
  '{',
  '}',
  '%',
  '+',
  '’',
  '«',
  '»',
  '”',
  '“',
  '\0',
];

/** remove_accents(), reduced to Unicode decomposition: "Café" → "Cafe". */
function removeAccents(value: string): string {
  return value.normalize('NFD').replace(/\p{Mn}/gu, '');
}

/**
 * sanitize_file_name(): removes characters that are special in paths, URLs or
 * shells, turns whitespace into dashes and neutralises intermediate
 * extensions, so `shell.php.jpg` becomes `shell.php_.jpg`. Pressbase also drops
 * control characters and lowercases the extension.
 */
export function sanitizeFileName(
  raw: string,
  allowed: Record<string, string> = ALLOWED_MIME_TYPES,
): string {
  let name = removeAccents(raw);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we remove.
  name = name.replace(/[\x00-\x1f\x7f]/g, '');
  name = name.replace(/\p{Zs}/gu, ' ');
  for (const char of SPECIAL_CHARS) name = name.split(char).join('');
  name = name.replace(/%20|\+/g, '-');
  name = name.replace(/\.{2,}/g, '.');
  name = name.replace(/[\r\n\t -]+/g, '-');
  name = name.replace(/^[.\-_]+|[.\-_]+$/g, '');

  if (!name.includes('.') && mimeForExtension(name, allowed)) name = `unnamed-file.${name}`;

  const parts = name.split('.');
  if (parts.length > 1) {
    const ext = (parts.pop() ?? '').toLowerCase();
    let base = parts.shift() ?? '';
    for (const part of parts) {
      base += `.${part}`;
      // Postfix intermediate extensions that aren't allowed, so no server runs them.
      if (/^[a-zA-Z]{2,5}\d?$/.test(part) && !mimeForExtension(part, allowed)) base += '_';
    }
    name = `${base}.${ext}`;
  }
  // Keep names comfortably within file system limits (255 bytes).
  if (Buffer.byteLength(name) > 200) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    let base = dot > 0 ? name.slice(0, dot) : name;
    while (Buffer.byteLength(base + ext) > 200) base = base.slice(0, -1);
    name = base + ext;
  }
  return name;
}

const SUB_SIZE_SUFFIX = /-(?:\d+x\d+|scaled|rotated)$/;

/**
 * wp_unique_filename(): `photo.jpg`, then `photo-1.jpg`, `photo-2.jpg`… A name is
 * taken if the file exists or if it would collide with an existing image's
 * sub-sizes (`photo-300x200.jpg`, `photo-scaled.jpg`). Names that already look
 * like a sub-size always get a number, as in WordPress.
 */
export async function uniqueFileName(
  storage: MediaStorage,
  folder: string,
  filename: string,
): Promise<string> {
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot).toLowerCase() : '';
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const existing = await storage.list(folder);
  const lower = new Set(existing.map((f) => f.toLowerCase()));

  const taken = (candidate: string) => {
    if (lower.has(`${candidate}${ext}`.toLowerCase())) return true;
    // _wp_check_existing_file_names(): sub-sizes of an image with this name.
    const pattern = new RegExp(
      `^${escapeRegExp(candidate)}-(?:\\d+x\\d+|scaled|rotated)${escapeRegExp(ext)}$`,
      'i',
    );
    return existing.some((f) => pattern.test(f));
  };

  let number = SUB_SIZE_SUFFIX.test(base) ? 1 : 0;
  for (;;) {
    const candidate = number ? `${base}-${number}` : base;
    if (!taken(candidate)) return `${candidate}${ext}`;
    number++;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
