import { createHash } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { sanitizePostContent } from '../content/sanitize';

/**
 * Comment text: what WordPress's kses ($allowedtags), wp_rel_ugc(),
 * comment_text's wpautop() and get_avatar_url() do for comments.
 */

/**
 * WordPress's $allowedtags (wp-includes/kses.php): the small set of inline
 * tags visitors may use in comments.
 */
const COMMENT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a',
    'abbr',
    'acronym',
    'b',
    'blockquote',
    'cite',
    'code',
    'del',
    'em',
    'i',
    'q',
    's',
    'strike',
    'strong',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'rel'],
    abbr: ['title'],
    acronym: ['title'],
    blockquote: ['cite'],
    del: ['datetime'],
    q: ['cite'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'ftp'],
  allowedSchemesAppliedToAttributes: ['href', 'cite'],
  allowProtocolRelative: false,
};

/** wp_filter_kses() for comment content. */
export function ksesComment(content: string): string {
  return sanitizeHtml(content, COMMENT_OPTIONS);
}

/**
 * wp_rel_ugc(): every link in a comment gets rel="nofollow ugc", so search
 * engines don't reward spam and readers know the link is user-generated.
 */
export function relUgc(content: string): string {
  return content.replace(/<a\s([^>]*)>/gi, (_match, attrs: string) => {
    const rel = /\srel=(["'])(.*?)\1/i.exec(` ${attrs}`);
    const values = new Set((rel?.[2] ?? '').split(/\s+/).filter(Boolean));
    values.add('nofollow');
    values.add('ugc');
    const rest = attrs.replace(/\s*rel=(["']).*?\1/i, '').trim();
    return `<a ${rest} rel="${[...values].join(' ')}">`;
  });
}

/** Strips every tag (wp_strip_all_tags), for names and plain-text excerpts. */
export function plainText(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).trim();
}

/** Paragraphs that already start with a block element aren't wrapped again. */
const BLOCK_START = /^<(p|div|blockquote|ul|ol|pre|h[1-6]|figure|table|section)[\s>]/i;

/**
 * wpautop(), reduced to what comments need: blank lines make paragraphs and
 * single line breaks become <br />.
 */
export function autop(text: string): string {
  const normalised = text.replace(/\r\n?/g, '\n').trim();
  if (!normalised) return '';
  return `${normalised
    .split(/\n\s*\n/)
    .map((para) =>
      BLOCK_START.test(para.trim())
        ? para.trim()
        : `<p>${para.trim().replace(/\n/g, '<br />\n')}</p>`,
    )
    .join('\n')}\n`;
}

/**
 * get_comment_text() through the `comment_text` defaults. Content is passed
 * through the post allow-list again on output, so HTML stored by a user with
 * unfiltered_html can't run script on the public site or in the admin
 * (WordPress prints it as-is; this is a deliberate hardening, as for titles).
 */
export function commentText(content: string): string {
  return autop(relUgc(sanitizePostContent(content)));
}

/** get_comment_excerpt(): the first 20 words of the text, tags removed. */
export function commentExcerpt(content: string, words = 20): string {
  const list = plainText(content).split(/\s+/).filter(Boolean);
  if (list.length <= words) return list.join(' ');
  return `${list.slice(0, words).join(' ')}&hellip;`;
}

/**
 * get_avatar_url() for Gravatar: SHA-256 of the trimmed, lowercased email
 * (WordPress 6.8+), with the site's default image and rating.
 */
export function avatarUrl(
  email: string,
  size: number,
  options: { default: string; rating: string },
): string {
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  const d =
    options.default === 'mystery'
      ? 'mm'
      : options.default === 'gravatar_default'
        ? ''
        : options.default;
  const query = new URLSearchParams({ s: String(size) });
  if (d) query.set('d', d);
  query.set('r', options.rating.toLowerCase());
  return `https://secure.gravatar.com/avatar/${hash}?${query}`;
}

/** rest_get_avatar_urls(): the 24, 48 and 96 pixel sizes. */
export function avatarUrls(
  email: string,
  options: { default: string; rating: string },
): Record<string, string> {
  return Object.fromEntries([24, 48, 96].map((s) => [String(s), avatarUrl(email, s, options)]));
}
