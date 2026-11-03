import { escAttr, escUrl, stripAllTags } from '@pressbase/blocks';

/**
 * Small, exact edits to a block's saved HTML: the inner HTML of one element,
 * and attributes of one tag. Everything else in the markup is left byte for
 * byte as it was, so classes, inline preset styles and whitespace survive.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  times: '×',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  bull: '•',
};

/** Decodes the HTML entities block markup uses (numeric ones and the common named ones). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/** Rich text to plain text: tags removed, entities decoded, whitespace collapsed. */
export function richTextToPlain(html: string): string {
  return decodeEntities(stripAllTags(html.replace(/<br\s*\/?>/gi, ' '), true)).replace(/\s+/g, ' ');
}

/**
 * Plain text to rich text, as the block editor saves it: `&`, `<` and `>`
 * escaped (quotes stay as typed), line breaks as `<br>`.
 */
export function plainToRichText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
}

export interface ElementMatch {
  /** Offset of the element's inner HTML in the source. */
  start: number;
  end: number;
  inner: string;
}

/**
 * The first `<tag …>…</tag>` in `html`, where `tag` is a regular expression
 * source such as `h[1-6]`. With `openEnded`, a missing closing tag runs to
 * the end (a list item whose nested list is a separate chunk).
 */
export function findElement(html: string, tag: string, openEnded = false): ElementMatch | null {
  const open = new RegExp(`<(${tag})\\b[^>]*>`, 'i').exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const close = new RegExp(`</${open[1]}\\s*>`, 'i');
  const rest = html.slice(start);
  const end = close.exec(rest);
  if (!end) return openEnded ? { start, end: html.length, inner: rest } : null;
  return { start, end: start + end.index, inner: rest.slice(0, end.index) };
}

/** The last `<tag …>…</tag>` in `html` (a quote's citation follows its paragraphs). */
export function findLastElement(html: string, tag: string): ElementMatch | null {
  const re = new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)</${tag}\\s*>`, 'gi');
  let last: ElementMatch | null = null;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const start = m.index + (m[1] as string).length;
    const inner = m[2] as string;
    last = { start, end: start + inner.length, inner };
  }
  return last;
}

export function replaceRange(html: string, match: ElementMatch, inner: string): string {
  return html.slice(0, match.start) + inner + html.slice(match.end);
}

export interface TagMatch {
  start: number;
  end: number;
  tag: string;
}

/** The first opening tag matching `name` (a regular expression source). */
export function findTag(html: string, name: string): TagMatch | null {
  const m = new RegExp(`<(?:${name})\\b[^>]*>`, 'i').exec(html);
  return m ? { start: m.index, end: m.index + m[0].length, tag: m[0] } : null;
}

const attrPattern = (name: string) => new RegExp(`(\\s${name}\\s*=\\s*)("([^"]*)"|'([^']*)')`, 'i');

/** An attribute's value, entities decoded; null when the tag doesn't have it. */
export function getAttr(tag: string, name: string): string | null {
  const m = attrPattern(name).exec(tag);
  if (!m) return null;
  return decodeEntities(m[3] ?? m[4] ?? '');
}

/** Sets (or, with null, removes) an attribute; the value is escaped here. */
export function setAttr(tag: string, name: string, value: string | null): string {
  const pattern = attrPattern(name);
  if (value === null) return tag.replace(new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, 'i'), '');
  const quoted = `"${escAttr(value)}"`;
  if (pattern.test(tag)) return tag.replace(pattern, (_m, before: string) => `${before}${quoted}`);
  return tag.replace(/\s*(\/?)>$/, (_m, slash: string) => ` ${name}=${quoted}${slash ? '/' : ''}>`);
}

/**
 * A URL made safe for an href or src: esc_url() (which refuses javascript:,
 * data: and other schemes), without its HTML encoding, since setAttr()
 * escapes. '' for a URL that can't be made safe.
 */
export function safeUrl(url: string): string {
  return decodeEntities(escUrl(url));
}

/** Removes `wp-image-N` from a class attribute (the image no longer is that attachment). */
export function setImageClass(tag: string, id: number | null): string {
  const current = getAttr(tag, 'class');
  const classes = (current ?? '').split(/\s+/).filter((c) => c && !/^wp-image-\d+$/.test(c));
  if (id !== null) classes.push(`wp-image-${id}`);
  if (current === null && classes.length === 0) return tag;
  return setAttr(tag, 'class', classes.length ? classes.join(' ') : null);
}
