/**
 * Small, dependency-free helpers for reading post content (WordPress block markup / HTML).
 *
 * Pure string scanning: no DOM and no Node APIs, so the same code runs in the editor and on the
 * server. It is deliberately forgiving rather than a full HTML parser: it handles attribute order,
 * single/double/unquoted attribute values and `>` inside quoted values.
 */

export interface Heading {
  level: number;
  text: string;
}

export interface Image {
  src: string;
  /** `null` when the alt attribute is missing entirely; `''` when it is present but empty. */
  alt: string | null;
}

export interface Link {
  href: string;
  text: string;
}

/** Everything inside a tag after its name, with quoted values allowed to contain `>`. */
const ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*)`;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
};

/** Decodes the common named entities and all numeric ones, in a single pass. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      if (code === 0xa0) return ' ';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Parses a tag's attribute string into a lower-cased name → decoded value map. */
export function parseAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  // A trailing "/" closes a self-closing tag; it is not part of an unquoted value.
  for (const m of source.replace(/\/\s*$/, '').matchAll(re)) {
    const name = (m[1] ?? '').toLowerCase();
    if (!name || attrs.has(name)) continue;
    attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Removes block comments, scripts, styles and tags; decodes entities; collapses whitespace. */
export function stripTags(html: string): string {
  const withoutTags = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(new RegExp(`<\\/?([a-zA-Z][a-zA-Z0-9-]*)${ATTRS}>`, 'g'), (_m, name: string) =>
      BLOCK_TAGS.has(name.toLowerCase()) ? ' ' : '',
    );
  return collapse(decodeEntities(withoutTags));
}

/** All `<h1>`–`<h6>` headings in document order. */
export function headings(html: string): Heading[] {
  const re = new RegExp(`<h([1-6])\\b${ATTRS}>([\\s\\S]*?)<\\/h\\1\\s*>`, 'gi');
  const out: Heading[] = [];
  for (const m of html.matchAll(re)) {
    out.push({ level: Number(m[1]), text: stripTags(m[3] ?? '') });
  }
  return out;
}

/** All `<img>` elements in document order. */
export function images(html: string): Image[] {
  const re = new RegExp(`<img\\b${ATTRS}>`, 'gi');
  const out: Image[] = [];
  for (const m of html.replace(/<!--[\s\S]*?-->/g, ' ').matchAll(re)) {
    const attrs = parseAttributes(m[1] ?? '');
    out.push({
      src: attrs.get('src') ?? '',
      alt: attrs.has('alt') ? (attrs.get('alt') ?? '') : null,
    });
  }
  return out;
}

/** All `<a href>` links in document order (anchors without href are skipped). */
export function links(html: string): Link[] {
  const re = new RegExp(`<a\\b${ATTRS}>([\\s\\S]*?)<\\/a\\s*>`, 'gi');
  const out: Link[] = [];
  for (const m of html.replace(/<!--[\s\S]*?-->/g, ' ').matchAll(re)) {
    const attrs = parseAttributes(m[1] ?? '');
    const href = attrs.get('href');
    if (href === undefined) continue;
    out.push({ href: href.trim(), text: stripTags(m[2] ?? '') });
  }
  return out;
}

/** Text of the first `<p>` that has any text; falls back to the first ~300 characters of text. */
export function firstParagraph(html: string): string {
  const re = new RegExp(`<p\\b${ATTRS}>([\\s\\S]*?)<\\/p\\s*>`, 'gi');
  for (const m of html.replace(/<!--[\s\S]*?-->/g, ' ').matchAll(re)) {
    const text = stripTags(m[2] ?? '');
    if (text) return text;
  }
  const all = stripTags(html);
  if (all.length <= 300) return all;
  const cut = all.slice(0, 300);
  const space = cut.lastIndexOf(' ');
  return space > 200 ? cut.slice(0, space) : cut;
}

/** Lower-cases, strips accents (NFD + combining marks) and normalises apostrophes. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'");
}

/** Splits text into words (letters/digits, with inner apostrophes kept: "don't"). */
export function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

/** Slug-style normalisation: folded, apostrophes dropped, other non-alphanumerics → single '-'. */
export function slugify(text: string): string {
  return fold(text)
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}
