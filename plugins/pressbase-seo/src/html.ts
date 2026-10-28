/** Escaping for what Pressbase SEO prints (esc_attr, esc_html, esc_url and JSON-LD). */

export function escHtml(value: string): string {
  return value
    .replace(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escAttr(value: string): string {
  return escHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** http(s) URLs and site paths only; anything else becomes ''. */
export function escUrl(value: string): string {
  const url = value.trim();
  if (!/^(?:https?:\/\/|\/)/i.test(url)) return '';
  return escAttr(url.replace(/[\s<>"]/g, (c) => encodeURIComponent(c)));
}

/** JSON for a <script type="application/ld+json">, safe against `</script>`. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** Plain text from HTML or block markup, with the common entities decoded. */
export function plainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function decodeEntities(text: string): string {
  const named: Record<string, string> = {
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
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return named[code.toLowerCase()] ?? match;
  });
}

/** At most `max` characters, cut at a word, with an ellipsis when cut. */
export function trimText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut.slice(0, max)).replace(/[\s,.;:]+$/, '')}…`;
}
