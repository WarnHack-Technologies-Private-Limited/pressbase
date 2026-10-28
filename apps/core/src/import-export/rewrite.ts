import { serializeBlockAttributes } from '@pressbase/blocks';

/**
 * Rewrites imported content to point at this site: WP_Import's
 * backfill_attachment_urls() (old media URLs → the new files) and the
 * attachment IDs in block markup, plus links to the old site's address.
 *
 * - **Media URLs.** Each downloaded file's old URL maps to its new URL. For
 *   images, the old name without its extension maps too, so sub-sizes follow
 *   (`photo-300x200.jpg`), as WP_Import's url_remap does; Pressbase only
 *   matches a size suffix (`-300x200`, `-scaled`, `-rotated`) there, so
 *   `photo2.jpg` isn't caught by `photo`.
 * - **Block IDs.** Image, cover, file, audio and video blocks (`id`),
 *   media & text (`mediaId`), galleries (`ids`), synced patterns and
 *   navigation blocks (`ref`), navigation links (`id`, by kind), and the
 *   `wp-image-{id}` class.
 * - **Internal links.** `?p=`, `?page_id=` and `?attachment_id=` links get
 *   the new ID; any other link to the old site's address gets this site's
 *   address. Permalinks then resolve when the permalink structure matches.
 *
 * URLs are found with one small pattern (anything starting with an old
 * address) and looked up in maps, so the cost doesn't grow with the number of
 * files.
 */

export interface RewriteMaps {
  /** Old post and attachment IDs → new. */
  posts: Map<number, number>;
  /** Old term IDs → new. */
  terms: Map<number, number>;
  /** Exact old file URLs → new. */
  urls: Map<string, string>;
  /** Old image URLs without the extension → new, for sub-sizes. */
  sizePrefixes: Map<string, string>;
  /** The old site's addresses (home and siteurl), without a trailing slash. */
  oldBases: string[];
  /** This site's address, without a trailing slash. */
  newBase: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Both schemes of each address, longest first, without trailing slashes. */
export function baseVariants(bases: string[]): string[] {
  const out = new Set<string>();
  for (const base of bases) {
    const clean = base.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(clean)) continue;
    out.add(clean);
    out.add(clean.replace(/^https?:/i, (scheme) => (scheme.toLowerCase() === 'http:' ? 'https:' : 'http:')));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const SIZE_SUFFIX = /^(.*?)((?:-\d+x\d+|-scaled|-rotated|-e\d{10,})*)(\.[a-z0-9]{2,5})$/i;

/** Builds the rewriter for one import. Returns content unchanged when there's nothing to map. */
export function createRewriter(maps: RewriteMaps): (content: string) => string {
  const newBase = maps.newBase.replace(/\/+$/, '');
  const swapBases = baseVariants(maps.oldBases).filter((b) => b !== newBase);
  const scanOrigins = new Set(swapBases);
  for (const url of [...maps.urls.keys(), ...maps.sizePrefixes.keys()]) {
    try {
      scanOrigins.add(new URL(url).origin);
    } catch {
      // Not absolute: nothing to scan for.
    }
  }
  const origins = [...scanOrigins].sort((a, b) => b.length - a.length);
  const urlPattern = origins.length
    ? new RegExp(
        `(?:${origins.map(escapeRegExp).join('|')})(?=[/?#"'\\s<)\\]]|$)[^\\s"'<>()\\\\\\]]*`,
        'gi',
      )
    : undefined;

  const mapUrl = (raw: string): string => {
    // A link at the end of a sentence: keep the punctuation out of the lookup.
    const trailing = /[.,;:!]+$/.exec(raw)?.[0] ?? '';
    const url = trailing ? raw.slice(0, -trailing.length) : raw;
    const exact = maps.urls.get(url);
    if (exact) return exact + trailing;
    const cut = url.search(/[?#]/);
    const pathPart = cut < 0 ? url : url.slice(0, cut);
    const rest = cut < 0 ? '' : url.slice(cut);
    const exactPath = maps.urls.get(pathPart);
    if (exactPath) return exactPath + rest + trailing;
    const size = SIZE_SUFFIX.exec(pathPart);
    if (size) {
      const prefix = maps.sizePrefixes.get(size[1] as string);
      if (prefix) return `${prefix}${size[2]}${size[3]}${rest}${trailing}`;
    }
    const base = swapBases.find((b) => url.toLowerCase().startsWith(b.toLowerCase()));
    if (!base) return raw;
    const tail = url.slice(base.length);
    const idLink = /^\/?\?(p|page_id|attachment_id)=(\d+)(?=$|[&#])(.*)$/.exec(tail);
    if (idLink) {
      const mapped = maps.posts.get(Number(idLink[2]));
      if (!mapped) return raw;
      return `${newBase}/?${idLink[1]}=${mapped}${idLink[3]}${trailing}`;
    }
    const catLink = /^\/?\?cat=(\d+)(?=$|[&#])(.*)$/.exec(tail);
    if (catLink) {
      const mapped = maps.terms.get(Number(catLink[1]));
      if (!mapped) return raw;
      return `${newBase}/?cat=${mapped}${catLink[2]}${trailing}`;
    }
    return `${newBase}${tail}${trailing}`;
  };

  const postId = (value: unknown) =>
    typeof value === 'number' ? (maps.posts.get(value) ?? value) : value;

  const remapAttributes = (name: string, attrs: Record<string, unknown>): boolean => {
    const before = JSON.stringify(attrs);
    switch (name) {
      case 'image':
      case 'cover':
      case 'file':
      case 'audio':
      case 'video':
        if ('id' in attrs) attrs.id = postId(attrs.id);
        break;
      case 'media-text':
        if ('mediaId' in attrs) attrs.mediaId = postId(attrs.mediaId);
        break;
      case 'gallery':
        if (Array.isArray(attrs.ids)) attrs.ids = attrs.ids.map(postId);
        break;
      case 'block':
      case 'navigation':
        if ('ref' in attrs) attrs.ref = postId(attrs.ref);
        break;
      case 'navigation-link':
      case 'navigation-submenu':
        if (typeof attrs.id === 'number') {
          if (attrs.kind === 'post-type') attrs.id = postId(attrs.id);
          else if (attrs.kind === 'taxonomy') attrs.id = maps.terms.get(attrs.id) ?? attrs.id;
        }
        // Its `url` is rewritten with every other URL, below.
        break;
      default:
        return false;
    }
    return JSON.stringify(attrs) !== before;
  };

  return (content: string): string => {
    if (!content) return content;
    let out = content;
    if (maps.posts.size || maps.terms.size) {
      out = out.replace(
        /<!--\s+wp:((?:[a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*))\s+(\{(?:[^}]|\}(?!\s+\/?-->))*\})\s+(\/)?-->/g,
        (whole, fullName: string, name: string, json: string, selfClosing?: string) => {
          if (fullName.includes('/') && !fullName.startsWith('core/')) return whole;
          let attrs: unknown;
          try {
            attrs = JSON.parse(json);
          } catch {
            return whole;
          }
          if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return whole;
          if (!remapAttributes(name, attrs as Record<string, unknown>)) return whole;
          return `<!-- wp:${fullName} ${serializeBlockAttributes(attrs as Record<string, unknown>)} ${selfClosing ? '/' : ''}-->`;
        },
      );
      out = out.replace(/\bwp-image-(\d+)\b/g, (whole, id: string) => {
        const mapped = maps.posts.get(Number(id));
        return mapped ? `wp-image-${mapped}` : whole;
      });
    }
    if (urlPattern) out = out.replace(urlPattern, mapUrl);
    return out;
  };
}
