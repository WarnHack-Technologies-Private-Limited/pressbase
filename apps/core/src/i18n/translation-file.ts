import { pluralFunction } from './plural-forms';

/**
 * Translation files: `.mo`, `.po` and the JSON (Jed) files WordPress ships
 * for scripts. A port of WP_Translation_File and WP_Translation_File_MO
 * (wordpress/wp-includes/l10n/class-wp-translation-file*.php), of PO's
 * reader and writer (wp-includes/pomo/po.php), and of the format
 * load_script_translations() reads (wp-includes/l10n.php).
 *
 * WordPress's `.l10n.php` files are PHP arrays and are never read: Pressbase
 * doesn't run PHP. Language packs also carry the `.mo` and `.po` they were
 * built from.
 *
 * Entries are keyed the way gettext keys them: `context\u0004singular`, or
 * the singular alone. A value is the list of translations, one per plural form.
 */

/** Separates a message's context from its text in a key, as in gettext. */
export const CONTEXT_GLUE = '\u0004';

export type TranslationEntries = Map<string, string[]>;

export class TranslationFileError extends Error {}

export interface TranslationFile {
  /** Where it was read from ('' when built in memory). */
  file: string;
  /** Header names in lower case, e.g. `plural-forms`, `language`. */
  headers: Record<string, string>;
  entries: TranslationEntries;
  /** The index of the plural form for a number (the Plural-Forms header). */
  pluralForm(n: number): number;
  /** JSON files: the script they translate (`comment.reference`), e.g. wp-includes/js/dist/editor.js. */
  source?: string;
}

export function entryKey(singular: string, context = ''): string {
  return context ? `${context}${CONTEXT_GLUE}${singular}` : singular;
}

function makeFile(
  file: string,
  headers: Record<string, string>,
  entries: TranslationEntries,
): TranslationFile {
  const plural = pluralFunction(headers['plural-forms']);
  return { file, headers, entries, pluralForm: plural };
}

/** Header lines (`Name: value`) into a lower-cased record. */
export function parseHeaderBlock(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (!line || colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

const MO_MAGIC = 0x950412de;

/** WP_Translation_File_MO::parse_file(). Throws TranslationFileError on a broken file. */
export function parseMo(data: Uint8Array, file = ''): TranslationFile {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buffer.length < 24) throw new TranslationFileError('Invalid data');
  let littleEndian: boolean;
  if (buffer.readUInt32LE(0) === MO_MAGIC) littleEndian = true;
  else if (buffer.readUInt32BE(0) === MO_MAGIC) littleEndian = false;
  else throw new TranslationFileError('Magic marker does not exist');
  const u32 = (offset: number) => {
    if (offset + 4 > buffer.length) throw new TranslationFileError('Invalid data');
    return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  };
  const revision = u32(4);
  const total = u32(8);
  const originalsAddr = u32(12);
  const translationsAddr = u32(16);
  if (revision > 0) throw new TranslationFileError('Unsupported revision');
  if (originalsAddr > buffer.length || translationsAddr > buffer.length) {
    throw new TranslationFileError('Invalid data');
  }
  const read = (table: number, i: number) => {
    const length = u32(table + i * 8);
    const position = u32(table + i * 8 + 4);
    if (position + length > buffer.length) throw new TranslationFileError('Invalid data');
    return buffer.toString('utf8', position, position + length);
  };
  let headers: Record<string, string> = {};
  const entries: TranslationEntries = new Map();
  for (let i = 0; i < total; i++) {
    const original = read(originalsAddr, i);
    // A GlotPress bug leaves trailing NULs on translations.
    const translation = read(translationsAddr, i).replace(/\0+$/, '');
    if (original === '') {
      headers = parseHeaderBlock(translation);
      continue;
    }
    if (translation === '') continue;
    // "singular\0plural": the key is the singular, with its context.
    const key = original.split('\0')[0] as string;
    entries.set(key, translation.split('\0'));
  }
  return makeFile(file, headers, entries);
}

/** PO::unpoify(): one quoted string's contents, unescaped. */
function unpoify(quoted: string): string {
  let s = quoted.trim();
  if (s.startsWith('"')) s = s.slice(1);
  if (s.endsWith('"')) s = s.slice(0, -1);
  const escapes: Record<string, string> = { t: '\t', n: '\n', r: '\r', '\\': '\\' };
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === '\\' && i + 1 < s.length) {
      const next = s[++i] as string;
      out += escapes[next] ?? next;
    } else {
      out += ch;
    }
  }
  return out.replace(/\r\n?/g, '\n');
}

export interface PoEntry {
  context: string;
  singular: string;
  plural?: string;
  translations: string[];
  /** `#.` comments: notes for translators from the source (`translators:` comments). */
  extractedComments?: string;
  /** `#:` references: file:line. */
  references?: string[];
  /** `#,` flags, e.g. fuzzy, php-format. */
  flags?: string[];
  /** `#` comments written by translators. */
  translatorComments?: string;
}

export interface ParsedPo {
  headers: Record<string, string>;
  entries: PoEntry[];
}

/**
 * PO::import_from_file() / PO::read_entry(). Throws TranslationFileError
 * with the line number on a syntax error.
 */
export function parsePoEntries(text: string): ParsedPo {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const parsed: ParsedPo = { headers: {}, entries: [] };
  type State = '' | 'comment' | 'msgctxt' | 'msgid' | 'msgid_plural' | 'msgstr' | 'msgstr_plural';
  let state: State = '';
  let entry: PoEntry = { context: '', singular: '', translations: [] };
  let index = 0;
  let hasSingular = false;
  const fail = (line: number) => {
    throw new TranslationFileError(`Invalid PO syntax on line ${line + 1}`);
  };
  const finish = () => {
    if (state !== 'msgstr' && state !== 'msgstr_plural') {
      if (state !== '' && state !== 'comment') fail(lines.length - 1);
      return;
    }
    if (entry.singular === '' && !entry.context && hasSingular) {
      parsed.headers = parseHeaderBlock(entry.translations[0] ?? '');
    } else {
      parsed.entries.push(entry);
    }
  };
  const isFinal = () => state === 'msgstr' || state === 'msgstr_plural';
  const start = () => {
    finish();
    entry = { context: '', singular: '', translations: [] };
    hasSingular = false;
    state = '';
  };
  for (let n = 0; n < lines.length; n++) {
    const line = (lines[n] as string).trim();
    if (line === '') continue;
    // A keyword line: msgctxt, msgid, msgid_plural, msgstr or msgstr[n], then a string.
    const keyword = /^(msgctxt|msgid_plural|msgid|msgstr\[(\d+)\]|msgstr)\s+(".*")$/.exec(line);
    const word = keyword?.[2] !== undefined ? 'msgstr[]' : keyword?.[1];
    const quoted = keyword?.[3] ?? '';
    if (line.startsWith('#')) {
      if (isFinal()) start();
      if (state && state !== 'comment') fail(n);
      state = 'comment';
      const kind = line.slice(0, 2);
      const comment = line.slice(2).trim();
      if (kind === '#:') entry.references = [...(entry.references ?? []), ...comment.split(/\s+/)];
      else if (kind === '#.')
        entry.extractedComments = [entry.extractedComments, comment].filter(Boolean).join('\n');
      else if (kind === '#,') entry.flags = [...(entry.flags ?? []), ...comment.split(/,\s*/)];
      else if (kind !== '#~' && kind !== '#|')
        entry.translatorComments = [entry.translatorComments, line.slice(1).trim()]
          .filter(Boolean)
          .join('\n');
    } else if (word === 'msgctxt') {
      if (isFinal()) start();
      if (state && state !== 'comment') fail(n);
      state = 'msgctxt';
      entry.context += unpoify(quoted);
    } else if (word === 'msgid') {
      if (isFinal()) start();
      if (state && state !== 'msgctxt' && state !== 'comment') fail(n);
      state = 'msgid';
      hasSingular = true;
      entry.singular += unpoify(quoted);
    } else if (word === 'msgid_plural') {
      if (state !== 'msgid') fail(n);
      state = 'msgid_plural';
      entry.plural = (entry.plural ?? '') + unpoify(quoted);
    } else if (word === 'msgstr') {
      if (state !== 'msgid') fail(n);
      state = 'msgstr';
      entry.translations = [unpoify(quoted)];
    } else if (word === 'msgstr[]') {
      if (state !== 'msgid_plural' && state !== 'msgstr_plural') fail(n);
      state = 'msgstr_plural';
      index = Number(keyword?.[2]);
      entry.translations[index] = unpoify(quoted);
    } else if (/^".*"$/.test(line)) {
      const value = unpoify(line);
      switch (state) {
        case 'msgid':
          entry.singular += value;
          break;
        case 'msgctxt':
          entry.context += value;
          break;
        case 'msgid_plural':
          entry.plural = (entry.plural ?? '') + value;
          break;
        case 'msgstr':
          entry.translations[0] = (entry.translations[0] ?? '') + value;
          break;
        case 'msgstr_plural':
          entry.translations[index] = (entry.translations[index] ?? '') + value;
          break;
        default:
          fail(n);
      }
    } else {
      fail(n);
    }
  }
  finish();
  return parsed;
}

/**
 * A `.po` file as translations. Untranslated and fuzzy entries are left out,
 * as msgfmt leaves them out of the `.mo` it compiles.
 */
export function parsePo(text: string, file = ''): TranslationFile {
  const { headers, entries } = parsePoEntries(text);
  const map: TranslationEntries = new Map();
  for (const entry of entries) {
    if (entry.flags?.includes('fuzzy')) continue;
    const translations = [...entry.translations].map((t) => t ?? '');
    if (!translations.some((t) => t !== '')) continue;
    map.set(entryKey(entry.singular, entry.context), translations);
  }
  return makeFile(file, headers, map);
}

/** The shape of a Jed 1.x locale data object, as WordPress's JSON files and `@wordpress/i18n` use it. */
export type JedLocaleData = Record<string, string[] | Record<string, string>>;

export interface JedFile {
  domain?: string;
  locale_data?: Record<string, JedLocaleData>;
  comment?: { reference?: string };
  source?: string;
}

/**
 * A JSON translation file (wp i18n make-json, or a language pack's
 * `{locale}-{md5}.json`). The messages are under `locale_data.messages`
 * (or the file's domain). Old files start each value with `null`.
 */
export function parseJed(text: string, file = ''): TranslationFile {
  let json: JedFile;
  try {
    json = JSON.parse(text) as JedFile;
  } catch {
    throw new TranslationFileError('Invalid JSON');
  }
  const data = json.locale_data?.[json.domain ?? 'messages'] ?? json.locale_data?.messages;
  if (!data || typeof data !== 'object') throw new TranslationFileError('No locale_data');
  const headers: Record<string, string> = {};
  const entries: TranslationEntries = new Map();
  for (const [key, value] of Object.entries(data)) {
    if (key === '') {
      for (const [name, header] of Object.entries(value as Record<string, string>)) {
        headers[name.toLowerCase().replace(/_/g, '-')] = String(header);
      }
      continue;
    }
    if (!Array.isArray(value)) continue;
    const translations = (value[0] === null ? value.slice(1) : value).map((v) => String(v ?? ''));
    if (translations.some((t) => t !== '')) entries.set(key, translations);
  }
  return {
    ...makeFile(file, headers, entries),
    source: json.comment?.reference ?? json.source ?? '',
  };
}

/** Reads a translation file by its extension: .mo, .po or .json. */
export function parseTranslationFile(data: Uint8Array, file: string): TranslationFile {
  if (file.endsWith('.mo')) return parseMo(data, file);
  const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (file.endsWith('.po')) return parsePo(text, file);
  if (file.endsWith('.json')) return parseJed(text, file);
  throw new TranslationFileError(`Unsupported translation file "${file}"`);
}

/**
 * WP_Translation_File_MO::export(): a `.mo` file. Pressbase reads `.po` files
 * directly, so this is for tests and tools.
 */
export function compileMo(
  headers: Record<string, string>,
  entries: { context?: string; singular: string; plural?: string; translations: string[] }[],
): Uint8Array {
  const headerText = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\n`)
    .join('');
  const pairs: [string, string][] = [['', headerText]];
  for (const e of entries) {
    const original = entryKey(e.plural ? `${e.singular}\0${e.plural}` : e.singular, e.context);
    pairs.push([original, e.translations.join('\0')]);
  }
  // msgfmt sorts the originals, so lookups could binary-search.
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const encoded = pairs.map(([o, t]) => [Buffer.from(o, 'utf8'), Buffer.from(t, 'utf8')]);
  const count = encoded.length;
  const originalsAddr = 28;
  const translationsAddr = originalsAddr + count * 8;
  let offset = translationsAddr + count * 8;
  const header = Buffer.alloc(28);
  header.writeUInt32LE(MO_MAGIC, 0);
  header.writeUInt32LE(0, 4);
  header.writeUInt32LE(count, 8);
  header.writeUInt32LE(originalsAddr, 12);
  header.writeUInt32LE(translationsAddr, 16);
  header.writeUInt32LE(0, 20);
  header.writeUInt32LE(offset, 24);
  const originalTable = Buffer.alloc(count * 8);
  const translationTable = Buffer.alloc(count * 8);
  const bodies: Buffer[] = [];
  for (const [column, table] of [
    [0, originalTable],
    [1, translationTable],
  ] as const) {
    encoded.forEach((pair, i) => {
      const bytes = pair[column] as Buffer;
      table.writeUInt32LE(bytes.length, i * 8);
      table.writeUInt32LE(offset, i * 8 + 4);
      bodies.push(bytes, Buffer.from([0]));
      offset += bytes.length + 1;
    });
  }
  return new Uint8Array(Buffer.concat([header, originalTable, translationTable, ...bodies]));
}

/** PO::poify(): a string as one or more quoted PO lines. */
export function poify(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t');
  const parts = escaped.split('\n');
  let po = `"${parts.join('\\n"\n"')}"`;
  const newlines = value.split('\n').length - 1;
  if (newlines > 1 || (newlines === 1 && !value.endsWith('\n'))) po = `""\n${po}`;
  return po.replace(/\n""/g, '');
}

/** PO::export(): a `.po` (or `.pot`) file. */
export function exportPo(
  headers: Record<string, string>,
  entries: PoEntry[],
  commentBeforeHeaders = '',
): string {
  const out: string[] = [];
  const headerText = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\n`)
    .join('');
  const before = commentBeforeHeaders
    ? `${commentBeforeHeaders
        .trimEnd()
        .split('\n')
        .map((l) => `# ${l}`.trimEnd())
        .join('\n')}\n`
    : '';
  out.push(`${before}msgid ""\nmsgstr ${poify(headerText)}`);
  for (const entry of entries) {
    const lines: string[] = [];
    if (entry.translatorComments) {
      lines.push(...entry.translatorComments.split('\n').map((c) => `# ${c}`));
    }
    if (entry.extractedComments) {
      lines.push(...entry.extractedComments.split('\n').map((c) => `#. ${c}`));
    }
    if (entry.references?.length) lines.push(`#: ${entry.references.join(' ')}`);
    if (entry.flags?.length) lines.push(`#, ${entry.flags.join(', ')}`);
    if (entry.context) lines.push(`msgctxt ${poify(entry.context)}`);
    lines.push(`msgid ${poify(entry.singular)}`);
    if (entry.plural === undefined) {
      lines.push(`msgstr ${poify(entry.translations[0] ?? '')}`);
    } else {
      lines.push(`msgid_plural ${poify(entry.plural)}`);
      const translations = entry.translations.length ? entry.translations : ['', ''];
      translations.forEach((t, i) => {
        lines.push(`msgstr[${i}] ${poify(t)}`);
      });
    }
    out.push(lines.join('\n'));
  }
  return `${out.join('\n\n')}\n`;
}
