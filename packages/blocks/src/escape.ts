/**
 * Output escaping — esc_html(), esc_attr(), esc_url() and wp_strip_all_tags()
 * (wordpress/wp-includes/formatting.php). Use them on every piece of data a
 * block's render callback prints.
 */

/** An entity that is already encoded and must not be encoded twice (wp_kses_normalize_entities). */
const ENTITY = /&(?:[A-Za-z][A-Za-z0-9]{1,31}|#0*[0-9]{1,7}|#[xX]0*[0-9A-Fa-f]{1,6});/y;

const SPECIAL = /[&<>"']/;

/**
 * _wp_specialchars( $text, ENT_QUOTES, false, false ): encodes `& < > " '`
 * without double-encoding existing entities, so `&amp;` stays `&amp;`.
 */
function specialChars(text: string): string {
  if (!SPECIAL.test(text)) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    switch (ch) {
      case '&': {
        ENTITY.lastIndex = i;
        const entity = ENTITY.exec(text);
        if (entity) {
          out += entity[0];
          i += entity[0].length - 1;
        } else out += '&amp;';
        break;
      }
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&#039;';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

const toText = (value: unknown): string =>
  value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value);

/** esc_html(): text for an HTML element's content. */
export function escHtml(text: unknown): string {
  return specialChars(toText(text));
}

/** esc_attr(): text for an HTML attribute value (always quote the attribute). */
export function escAttr(text: unknown): string {
  return specialChars(toText(text));
}

/** wp_allowed_protocols() */
export const ALLOWED_PROTOCOLS = [
  'http',
  'https',
  'ftp',
  'ftps',
  'mailto',
  'news',
  'irc',
  'irc6',
  'ircs',
  'gopher',
  'nntp',
  'feed',
  'telnet',
  'mms',
  'rtsp',
  'sms',
  'svn',
  'tel',
  'fax',
  'xmpp',
  'webcal',
  'urn',
] as const;

/**
 * esc_url() in its default "display" context: removes characters that can't
 * appear in a URL, rejects schemes outside `protocols` (javascript:, data:…),
 * adds `http://` to bare domains and encodes `&` and `'` for HTML.
 * Returns '' for a URL that can't be made safe.
 */
export function escUrl(url: unknown, protocols: readonly string[] = ALLOWED_PROTOCOLS): string {
  let out = toText(url);
  if (out === '') return out;

  out = out.trimStart().replace(/ /g, '%20');
  // PHP allows bytes 0x80–0xff (UTF-8); every non-ASCII code unit is allowed here.
  out = out.replace(/[^a-z0-9\-~+_.?#=!&;,/:%@$|*'()[\]\u0080-\uffff]/gi, '');
  if (out === '') return out;

  if (!out.toLowerCase().startsWith('mailto:')) {
    // _deep_replace(): strip encoded line breaks until none are left.
    let previous: string;
    do {
      previous = out;
      out = out.replace(/%0[da]/gi, '');
    } while (out !== previous);
  }

  out = out.replace(/;\/\//g, '://');
  if (
    !out.includes(':') &&
    !['/', '#', '?'].includes(out[0] as string) &&
    !/^[a-z0-9-]+?\.php/i.test(out)
  ) {
    out = `${protocols[0] === 'https' ? 'https' : 'http'}://${out}`;
  }

  // Display context: normalise entities, then encode ampersands and single quotes.
  out = specialAmpersands(out).replace(/&amp;/g, '&#038;').replace(/'/g, '&#039;');

  if (out.includes('[') || out.includes(']')) {
    // Brackets are only valid in the host (IPv6); encode them elsewhere.
    const front = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*/i.exec(out)?.[0] ?? '';
    out = front + out.slice(front.length).replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  }

  if (out[0] === '/') return out;
  // wp_kses_bad_protocol(): a scheme must be one of the allowed protocols.
  const scheme = /^([^:/?#]+):/.exec(out)?.[1];
  if (scheme !== undefined && !protocols.includes(scheme.toLowerCase())) return '';
  return out;
}

/** wp_kses_normalize_entities() for URLs: a bare `&` becomes `&amp;`. */
function specialAmpersands(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '&') {
      out += text[i];
      continue;
    }
    ENTITY.lastIndex = i;
    const entity = ENTITY.exec(text);
    if (entity) {
      out += entity[0];
      i += entity[0].length - 1;
    } else out += '&amp;';
  }
  return out;
}

/** wp_strip_all_tags(): removes tags, and the contents of script and style elements. */
export function stripAllTags(text: unknown, removeBreaks = false): string {
  let out = toText(text)
    .replace(/<(script|style)[^>]*?>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>?/g, '');
  if (removeBreaks) out = out.replace(/[\r\n\t ]+/g, ' ');
  return out.trim();
}
