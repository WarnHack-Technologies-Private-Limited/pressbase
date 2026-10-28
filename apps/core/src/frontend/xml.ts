import { escHtml } from '@pressbase/blocks';

/**
 * XML output helpers for feeds and sitemaps: esc_xml(), ent2ncr() and CDATA
 * sections (wordpress/wp-includes/formatting.php). HTML's named entities
 * (`&hellip;`, `&nbsp;`) are not defined in XML, so they become numeric
 * references; characters XML 1.0 forbids are dropped, so hostile content
 * can't make a feed unparseable.
 */

/** Characters outside XML 1.0's Char production (controls, lone surrogates, U+FFFE/F). */
const INVALID_XML =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters being removed.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripInvalidXml(text: string): string {
  return text.replace(INVALID_XML, '');
}

/** HTML 4 entity names (Latin-1 from 160, then symbols) and their code points: ent2ncr()'s table. */
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';
const SYMBOLS: Record<string, number> = {
  OElig: 338,
  oelig: 339,
  Scaron: 352,
  scaron: 353,
  Yuml: 376,
  fnof: 402,
  circ: 710,
  tilde: 732,
  ensp: 8194,
  emsp: 8195,
  thinsp: 8201,
  zwnj: 8204,
  zwj: 8205,
  lrm: 8206,
  rlm: 8207,
  ndash: 8211,
  mdash: 8212,
  lsquo: 8216,
  rsquo: 8217,
  sbquo: 8218,
  ldquo: 8220,
  rdquo: 8221,
  bdquo: 8222,
  dagger: 8224,
  Dagger: 8225,
  bull: 8226,
  hellip: 8230,
  permil: 8240,
  prime: 8242,
  Prime: 8243,
  lsaquo: 8249,
  rsaquo: 8250,
  oline: 8254,
  frasl: 8260,
  euro: 8364,
  trade: 8482,
  larr: 8592,
  uarr: 8593,
  rarr: 8594,
  darr: 8595,
  harr: 8596,
  minus: 8722,
  infin: 8734,
  ne: 8800,
  le: 8804,
  ge: 8805,
  hearts: 9829,
};
const NAMED = new Map<string, number>(Object.entries(SYMBOLS));
LATIN1.split(' ').forEach((name, i) => {
  NAMED.set(name, 160 + i);
});
const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

/** ent2ncr(): named HTML entities → numeric references; unknown names are escaped. */
export function ent2ncr(text: string): string {
  return text.replace(/&([A-Za-z][A-Za-z0-9]*);/g, (match, name: string) => {
    if (XML_ENTITIES.has(name)) return match;
    const code = NAMED.get(name);
    return code ? `&#${code};` : `&amp;${name};`;
  });
}

/** esc_xml(): text for an XML element or attribute. */
export function xmlText(text: unknown): string {
  return ent2ncr(escHtml(stripInvalidXml(text === null || text === undefined ? '' : String(text))));
}

/** A CDATA section; `]]>` inside the data is split across two sections. */
export function cdata(text: string): string {
  return `<![CDATA[${stripInvalidXml(text).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

/** RFC 822 date for RSS (`D, d M Y H:i:s +0000`). */
export function rfc822(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000');
}

/** ISO 8601 UTC date for Atom (`Y-m-d\TH:i:s\Z`). */
export function atomDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** DATE_W3C in the site's time zone, as wp_date( DATE_W3C, … ) prints sitemap dates. */
export function w3cDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const local = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  );
  const offset = Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${sign}${hh}:${mm}`;
}
