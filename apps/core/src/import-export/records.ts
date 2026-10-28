/**
 * The records an import source yields: WordPress-shaped data, with the array
 * keys WordPress's own importer uses (WXR_Parser in the WordPress Importer
 * plugin, which reads what wp-admin/includes/export.php writes). A WXR file
 * is one source (wxr-reader.ts); a direct WordPress database migration is
 * another. Every source feeds the same writer (writer.ts), so authors, terms,
 * posts, comments, attachments and menus are imported the same way whatever
 * they came from. See docs/architecture/import-export.md.
 *
 * Values are what WordPress stores: dates as MySQL `Y-m-d H:i:s` strings
 * (local and GMT), IDs as the source site's numbers, and meta values as
 * WordPress's strings, PHP-serialized where WordPress serialized them. The
 * writer turns serialized values into JSON (php-serialize.ts).
 */

/** One meta row (`wp:postmeta`, `wp:commentmeta`, `wp:termmeta`). */
export interface ImportMeta {
  key: string;
  value: string;
}

/** The channel: where the content came from (`wp:base_site_url`, …). */
export interface ImportSite {
  title: string;
  link: string;
  description: string;
  language: string;
  /** `wp:wxr_version`, e.g. "1.2". Empty for sources that aren't WXR. */
  wxr_version: string;
  /** `wp:base_site_url`: the WordPress address (siteurl). */
  base_site_url: string;
  /** `wp:base_blog_url`: the site address (home). */
  base_blog_url: string;
}

/** `wp:author`. Posts name their author by login (`dc:creator`). */
export interface ImportAuthor {
  author_id: number;
  author_login: string;
  author_email: string;
  author_display_name: string;
  author_first_name: string;
  author_last_name: string;
}

/**
 * A term: `wp:category`, `wp:tag` and `wp:term` in one shape (the `wp:term`
 * one). Parents are named by slug, as WXR does, so a source can list terms in
 * any order; the writer links parents that come later.
 */
export interface ImportTerm {
  term_id: number;
  term_taxonomy: string;
  slug: string;
  /** The parent's slug, or empty. */
  term_parent: string;
  term_name: string;
  term_description: string;
  termmeta: ImportMeta[];
}

/** A term attached to a post (`<category domain="…" nicename="…">name</category>`). */
export interface ImportPostTerm {
  /** The taxonomy (WXR's `domain`). */
  domain: string;
  slug: string;
  name: string;
}

/** `wp:comment` */
export interface ImportComment {
  comment_id: number;
  comment_author: string;
  comment_author_email: string;
  comment_author_IP: string;
  comment_author_url: string;
  comment_date: string;
  comment_date_gmt: string;
  comment_content: string;
  /** '1', '0', 'spam', 'trash' (WordPress's comment_approved). */
  comment_approved: string;
  comment_type: string;
  /** The parent comment's ID in the source, 0 for none. */
  comment_parent: number;
  /** The commenter's user ID in the source, 0 for visitors. */
  comment_user_id: number;
  commentmeta: ImportMeta[];
}

/** `item`: a post of any type, with its terms, meta and comments. */
export interface ImportPost {
  post_id: number;
  post_title: string;
  /** The permalink on the source site (`link`). Informational. */
  link: string;
  guid: string;
  /** The author's login (`dc:creator`). */
  post_author: string;
  post_content: string;
  post_excerpt: string;
  post_date: string;
  post_date_gmt: string;
  post_modified: string;
  post_modified_gmt: string;
  comment_status: string;
  ping_status: string;
  /** The slug. */
  post_name: string;
  status: string;
  /** The parent's ID in the source, 0 for none. */
  post_parent: number;
  menu_order: number;
  post_type: string;
  post_password: string;
  is_sticky: boolean;
  /** Attachments: the file's address on the source site. */
  attachment_url: string;
  terms: ImportPostTerm[];
  postmeta: ImportMeta[];
  comments: ImportComment[];
}

/**
 * What a source yields, in this order: the site first, then authors, then
 * terms, then posts. (WXR files are written in that order.) Terms whose parent
 * comes later, posts whose parent or featured image comes later and menu items
 * pointing at later posts are all resolved when the source ends.
 */
export type ImportRecord =
  | { kind: 'site'; site: ImportSite }
  | { kind: 'author'; author: ImportAuthor }
  | { kind: 'term'; term: ImportTerm }
  | { kind: 'post'; post: ImportPost };

/**
 * An import source: anything that can produce WordPress-shaped records. The
 * WXR reader is one; a WordPress MySQL reader can be another. Sources must
 * stream: yield each record as soon as it's read, so memory stays flat for
 * sites of any size.
 */
export interface ImportSource {
  /** Yields the records. `signal` is aborted when the import is cancelled. */
  records(signal?: AbortSignal): AsyncIterable<ImportRecord>;
}

/** MySQL's zero date, which WordPress uses for "no date" (drafts' post_date_gmt). */
export const ZERO_DATE = '0000-00-00 00:00:00';

export function emptyPost(): ImportPost {
  return {
    post_id: 0,
    post_title: '',
    link: '',
    guid: '',
    post_author: '',
    post_content: '',
    post_excerpt: '',
    post_date: '',
    post_date_gmt: '',
    post_modified: '',
    post_modified_gmt: '',
    comment_status: 'closed',
    ping_status: 'closed',
    post_name: '',
    status: 'publish',
    post_parent: 0,
    menu_order: 0,
    post_type: 'post',
    post_password: '',
    is_sticky: false,
    attachment_url: '',
    terms: [],
    postmeta: [],
    comments: [],
  };
}

export function emptyComment(): ImportComment {
  return {
    comment_id: 0,
    comment_author: '',
    comment_author_email: '',
    comment_author_IP: '',
    comment_author_url: '',
    comment_date: '',
    comment_date_gmt: '',
    comment_content: '',
    comment_approved: '1',
    comment_type: 'comment',
    comment_parent: 0,
    comment_user_id: 0,
    commentmeta: [],
  };
}
