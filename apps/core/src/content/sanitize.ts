import sanitizeHtml from 'sanitize-html';

/**
 * Content sanitising — the parts of WordPress's kses.php and formatting.php
 * that run when a user without `unfiltered_html` saves a post.
 *
 * Block delimiters (<!-- wp:paragraph {"align":"center"} -->) carry the block
 * structure, so they are kept: content is split on them, the HTML between them
 * is sanitised, and each delimiter is validated and re-serialised.
 */

const INLINE_TAGS = [
  'a',
  'abbr',
  'b',
  'br',
  'cite',
  'code',
  'del',
  'em',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
];

const POST_TAGS = [
  ...INLINE_TAGS,
  'address',
  'blockquote',
  'caption',
  'col',
  'colgroup',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
  'audio',
  'video',
  'source',
  'track',
];

const POST_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: POST_TAGS,
  allowedAttributes: {
    '*': ['class', 'id', 'lang', 'dir', 'title', 'aria-label', 'aria-hidden', 'role', 'data-*'],
    a: ['href', 'rel', 'target', 'hreflang', 'download'],
    img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
    td: ['colspan', 'rowspan', 'headers'],
    th: ['colspan', 'rowspan', 'headers', 'scope'],
    ol: ['start', 'reversed', 'type'],
    time: ['datetime'],
    blockquote: ['cite'],
    q: ['cite'],
    details: ['open'],
    audio: ['src', 'controls', 'loop', 'muted', 'preload'],
    video: [
      'src',
      'controls',
      'loop',
      'muted',
      'preload',
      'poster',
      'width',
      'height',
      'playsinline',
    ],
    source: ['src', 'type', 'srcset', 'media'],
    track: ['src', 'kind', 'srclang', 'label', 'default'],
  },
  // WordPress's wp_allowed_protocols(), minus the rarely used ones.
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'ftp', 'sms'],
  allowedSchemesAppliedToAttributes: ['href', 'src', 'cite', 'poster'],
  allowProtocolRelative: true,
};

const TITLE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['b', 'strong', 'em', 'i', 'code', 'abbr', 's', 'del', 'sub', 'sup', 'br'],
  allowedAttributes: { abbr: ['title'] },
};

/** <!-- wp:name {json} --> | <!-- /wp:name --> | <!-- wp:name {json} /--> */
const BLOCK_DELIMITER =
  /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)\s+(\{(?:(?!-->)[\s\S])*?\}\s+)?(\/)?-->/g;

function serialiseDelimiter(match: RegExpExecArray): string {
  const [, closer, namespace = '', name, rawAttrs, selfClosing] = match;
  if (closer) return `<!-- /wp:${namespace}${name} -->`;
  let attrs = '';
  if (rawAttrs) {
    try {
      const parsed: unknown = JSON.parse(rawAttrs);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Re-encode so the comment can never be closed early from inside the JSON.
        attrs = `${JSON.stringify(parsed).replace(/--/g, '\\u002d\\u002d')} `;
      }
    } catch {
      // Invalid attributes are dropped; the block keeps its defaults.
    }
  }
  return `<!-- wp:${namespace}${name} ${attrs}${selfClosing ? '/' : ''}-->`;
}

/** kses for post content: sanitise HTML, keep valid block delimiters. */
export function sanitizePostContent(content: string): string {
  let out = '';
  let last = 0;
  BLOCK_DELIMITER.lastIndex = 0;
  for (let match = BLOCK_DELIMITER.exec(content); match; match = BLOCK_DELIMITER.exec(content)) {
    out += sanitizeHtml(content.slice(last, match.index), POST_OPTIONS);
    out += serialiseDelimiter(match);
    last = match.index + match[0].length;
  }
  return out + sanitizeHtml(content.slice(last), POST_OPTIONS);
}

/** kses for titles: a handful of inline tags only. */
export function sanitizePostTitle(title: string): string {
  return sanitizeHtml(title, TITLE_OPTIONS);
}

/** Removes every tag, e.g. for term names and plain-text excerpts. */
export function stripTags(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).trim();
}

/** sanitize_title(): lowercase, accents removed, anything else becomes a dash. */
export function sanitizeSlug(value: string, maxLength = 200): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength)
    .replace(/-$/, '');
}

/**
 * What the REST API returns as `content.rendered` until block rendering
 * arrives in v0.3: the saved HTML of static blocks, delimiters removed.
 */
export function renderBlocksAsStatic(content: string): string {
  return content
    .replace(BLOCK_DELIMITER, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
