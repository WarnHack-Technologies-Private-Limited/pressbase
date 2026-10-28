import { createReadStream } from 'node:fs';
import { Parser } from 'htmlparser2';
import {
  emptyComment,
  emptyPost,
  type ImportAuthor,
  type ImportComment,
  type ImportMeta,
  type ImportPost,
  type ImportRecord,
  type ImportSite,
  type ImportSource,
  type ImportTerm,
} from './records';

/**
 * Reads a WXR file (what wp-admin/includes/export.php writes) as a stream of
 * records, never holding more than one item in memory, so files of hundreds
 * of megabytes import with flat memory use. The counterpart of the WordPress
 * Importer plugin's WXR_Parser_XML.
 *
 * The XML parser is htmlparser2 in XML mode: a small, fast, maintained
 * streaming parser (already in the dependency tree through sanitize-html).
 * It's forgiving, like WordPress's fallback parsers: a stray `&` or an
 * unclosed tag in one post doesn't stop the import. CDATA sections come
 * through raw, entities in text are decoded.
 */

export class WxrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Where WXR comes from: a file on disk, XML text, or a stream of chunks. */
export type WxrInput =
  | { path: string }
  | { xml: string }
  | AsyncIterable<Uint8Array | string>
  | ReadableStream<Uint8Array>;

/** Chunks of text from any input, decoding UTF-8 across chunk boundaries. */
async function* textChunks(input: WxrInput): AsyncGenerator<string> {
  let source: AsyncIterable<Uint8Array | string>;
  if (Symbol.asyncIterator in input) {
    // Node streams, web ReadableStreams (async iterable in Node) and generators.
    source = input as AsyncIterable<Uint8Array | string>;
  } else if ('xml' in input) {
    // Hand large strings over in slices, so the parser streams them too.
    for (let i = 0; i < input.xml.length; i += 65536) yield input.xml.slice(i, i + 65536);
    return;
  } else if ('path' in input) {
    source = createReadStream(input.path, { highWaterMark: 64 * 1024 });
  } else {
    throw new TypeError('Unsupported WXR input.');
  }
  const decoder = new TextDecoder('utf-8');
  for await (const chunk of source) {
    yield typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  const rest = decoder.decode();
  if (rest) yield rest;
}

const SITE_FIELDS: Record<string, keyof ImportSite> = {
  title: 'title',
  link: 'link',
  description: 'description',
  language: 'language',
  'wp:wxr_version': 'wxr_version',
  'wp:base_site_url': 'base_site_url',
  'wp:base_blog_url': 'base_blog_url',
};

const AUTHOR_FIELDS: Record<string, keyof ImportAuthor> = {
  'wp:author_id': 'author_id',
  'wp:author_login': 'author_login',
  'wp:author_email': 'author_email',
  'wp:author_display_name': 'author_display_name',
  'wp:author_first_name': 'author_first_name',
  'wp:author_last_name': 'author_last_name',
};

/** wp:category, wp:tag and wp:term fields, mapped onto the wp:term shape. */
const TERM_FIELDS: Record<string, keyof ImportTerm> = {
  'wp:term_id': 'term_id',
  'wp:category_nicename': 'slug',
  'wp:category_parent': 'term_parent',
  'wp:cat_name': 'term_name',
  'wp:category_description': 'term_description',
  'wp:tag_slug': 'slug',
  'wp:tag_name': 'term_name',
  'wp:tag_description': 'term_description',
  'wp:term_taxonomy': 'term_taxonomy',
  'wp:term_slug': 'slug',
  'wp:term_parent': 'term_parent',
  'wp:term_name': 'term_name',
  'wp:term_description': 'term_description',
};

const POST_FIELDS: Record<string, keyof ImportPost> = {
  title: 'post_title',
  link: 'link',
  guid: 'guid',
  'dc:creator': 'post_author',
  'content:encoded': 'post_content',
  'excerpt:encoded': 'post_excerpt',
  'wp:post_id': 'post_id',
  'wp:post_date': 'post_date',
  'wp:post_date_gmt': 'post_date_gmt',
  'wp:post_modified': 'post_modified',
  'wp:post_modified_gmt': 'post_modified_gmt',
  'wp:comment_status': 'comment_status',
  'wp:ping_status': 'ping_status',
  'wp:post_name': 'post_name',
  'wp:status': 'status',
  'wp:post_parent': 'post_parent',
  'wp:menu_order': 'menu_order',
  'wp:post_type': 'post_type',
  'wp:post_password': 'post_password',
  'wp:is_sticky': 'is_sticky',
  'wp:attachment_url': 'attachment_url',
};

const COMMENT_FIELDS: Record<string, keyof ImportComment> = {
  'wp:comment_id': 'comment_id',
  'wp:comment_author': 'comment_author',
  'wp:comment_author_email': 'comment_author_email',
  'wp:comment_author_IP': 'comment_author_IP',
  'wp:comment_author_url': 'comment_author_url',
  'wp:comment_date': 'comment_date',
  'wp:comment_date_gmt': 'comment_date_gmt',
  'wp:comment_content': 'comment_content',
  'wp:comment_approved': 'comment_approved',
  'wp:comment_type': 'comment_type',
  'wp:comment_parent': 'comment_parent',
  'wp:comment_user_id': 'comment_user_id',
};

/** Free text kept exactly as written; every other field is trimmed. */
const VERBATIM = new Set([
  'title',
  'content:encoded',
  'excerpt:encoded',
  'wp:comment_content',
  'wp:category_description',
  'wp:tag_description',
  'wp:term_description',
  'wp:meta_value',
  'description',
]);

const NUMERIC = new Set([
  'author_id',
  'term_id',
  'post_id',
  'post_parent',
  'menu_order',
  'comment_id',
  'comment_parent',
  'comment_user_id',
]);

function assign(target: object, key: string, raw: string): void {
  const record = target as Record<string, unknown>;
  if (NUMERIC.has(key)) record[key] = Number.parseInt(raw, 10) || 0;
  else if (key === 'is_sticky') record[key] = raw === '1';
  else record[key] = raw;
}

/** A WXR file as an import source. */
export class WxrReader implements ImportSource {
  constructor(private readonly input: WxrInput) {}

  async *records(signal?: AbortSignal): AsyncGenerator<ImportRecord> {
    const queue: ImportRecord[] = [];
    const stack: string[] = [];
    let text = '';
    const site: ImportSite = {
      title: '',
      link: '',
      description: '',
      language: '',
      wxr_version: '',
      base_site_url: '',
      base_blog_url: '',
    };
    let sawChannel = false;
    let siteSent = false;
    let author: ImportAuthor | undefined;
    let term: ImportTerm | undefined;
    let post: ImportPost | undefined;
    let comment: ImportComment | undefined;
    let meta: ImportMeta | undefined;
    let postTerm: { domain: string; slug: string } | undefined;

    const sendSite = () => {
      if (siteSent) return;
      siteSent = true;
      // WP_Import::parse(): "This does not appear to be a WXR file, missing/invalid WXR version number".
      if (!/^\d+\.\d+$/.test(site.wxr_version)) {
        throw new WxrError(
          'wxr_invalid',
          'This doesn’t look like a WordPress export file: it has no WXR version number.',
        );
      }
      queue.push({ kind: 'site', site: { ...site } });
    };

    const parser = new Parser(
      {
        onopentag(name, attributes) {
          const parent = stack[stack.length - 1];
          stack.push(name);
          text = '';
          if (name === 'channel') sawChannel = true;
          if (parent === 'channel') {
            if (name === 'wp:author') {
              sendSite();
              author = {
                author_id: 0,
                author_login: '',
                author_email: '',
                author_display_name: '',
                author_first_name: '',
                author_last_name: '',
              };
            } else if (name === 'wp:category' || name === 'wp:tag' || name === 'wp:term') {
              sendSite();
              term = {
                term_id: 0,
                term_taxonomy:
                  name === 'wp:category' ? 'category' : name === 'wp:tag' ? 'post_tag' : '',
                slug: '',
                term_parent: '',
                term_name: '',
                term_description: '',
                termmeta: [],
              };
            } else if (name === 'item') {
              sendSite();
              post = emptyPost();
            }
          } else if (post && name === 'wp:comment' && parent === 'item') {
            comment = emptyComment();
          } else if (name === 'wp:postmeta' || name === 'wp:commentmeta' || name === 'wp:termmeta') {
            meta = { key: '', value: '' };
          } else if (post && name === 'category' && parent === 'item') {
            postTerm = { domain: attributes.domain ?? '', slug: attributes.nicename ?? '' };
          }
        },
        ontext(chunk) {
          text += chunk;
        },
        onclosetag(name) {
          stack.pop();
          const parent = stack[stack.length - 1];
          const value = VERBATIM.has(name) ? text : text.trim();
          text = '';

          if (meta && (name === 'wp:meta_key' || name === 'wp:meta_value')) {
            if (name === 'wp:meta_key') meta.key = value;
            else meta.value = value;
            return;
          }
          if (meta && (name === 'wp:postmeta' || name === 'wp:commentmeta' || name === 'wp:termmeta')) {
            if (name === 'wp:commentmeta') comment?.commentmeta.push(meta);
            else if (name === 'wp:termmeta') term?.termmeta.push(meta);
            else post?.postmeta.push(meta);
            meta = undefined;
            return;
          }
          if (comment) {
            if (name === 'wp:comment') {
              post?.comments.push(comment);
              comment = undefined;
            } else if (parent === 'wp:comment' && COMMENT_FIELDS[name]) {
              assign(comment, COMMENT_FIELDS[name], value);
            }
            return;
          }
          if (post) {
            if (name === 'item') {
              queue.push({ kind: 'post', post });
              post = undefined;
            } else if (name === 'category' && postTerm && parent === 'item') {
              post.terms.push({ domain: postTerm.domain, slug: postTerm.slug, name: value });
              postTerm = undefined;
            } else if (parent === 'item' && POST_FIELDS[name]) {
              assign(post, POST_FIELDS[name], value);
            }
            return;
          }
          if (author) {
            if (name === 'wp:author') {
              queue.push({ kind: 'author', author });
              author = undefined;
            } else if (AUTHOR_FIELDS[name]) {
              assign(author, AUTHOR_FIELDS[name], value);
            }
            return;
          }
          if (term) {
            if (name === 'wp:category' || name === 'wp:tag' || name === 'wp:term') {
              queue.push({ kind: 'term', term });
              term = undefined;
            } else if (TERM_FIELDS[name]) {
              assign(term, TERM_FIELDS[name], value);
            }
            return;
          }
          if (parent === 'channel' && SITE_FIELDS[name]) {
            site[SITE_FIELDS[name]] = value;
          } else if (name === 'channel') {
            sendSite();
          }
        },
      },
      { xmlMode: true, decodeEntities: true },
    );

    let failure: unknown;
    const write = (chunk: string) => {
      try {
        parser.write(chunk);
      } catch (error) {
        failure = error;
      }
    };

    for await (const chunk of textChunks(this.input)) {
      signal?.throwIfAborted();
      write(chunk);
      if (failure) throw failure;
      // Hand records over between chunks; the parser waits meanwhile.
      for (let i = 0; i < queue.length; i++) yield queue[i] as ImportRecord;
      queue.length = 0;
    }
    try {
      parser.end();
    } catch (error) {
      failure = error;
    }
    if (failure) throw failure;
    for (const record of queue) yield record;
    if (!sawChannel) {
      throw new WxrError(
        'wxr_invalid',
        'This doesn’t look like a WordPress export file. Choose the .xml file from Tools → Export.',
      );
    }
    if (!siteSent) {
      sendSite();
      for (const record of queue.splice(0)) yield record;
    }
  }
}

/** A summary of a WXR file, read without importing it: what step 1 of the importer shows. */
export interface WxrSummary {
  site: ImportSite;
  authors: ImportAuthor[];
  /** Items per post type. */
  posts: Record<string, number>;
  /** Terms per taxonomy. */
  terms: Record<string, number>;
  comments: number;
  /** All items (every post type), for progress. */
  items: number;
}

/**
 * Reads the whole file once (streaming) and counts what's in it. Authors are
 * listed in full: the admin maps each one to a user before importing.
 * A post's author that has no `wp:author` entry (WXR 1.0) is added, as
 * WP_Import::get_authors_from_import() does.
 */
export async function scanWxr(input: WxrInput, signal?: AbortSignal): Promise<WxrSummary> {
  const summary: WxrSummary = {
    site: {
      title: '',
      link: '',
      description: '',
      language: '',
      wxr_version: '',
      base_site_url: '',
      base_blog_url: '',
    },
    authors: [],
    posts: {},
    terms: {},
    comments: 0,
    items: 0,
  };
  const logins = new Set<string>();
  for await (const record of new WxrReader(input).records(signal)) {
    if (record.kind === 'site') summary.site = record.site;
    else if (record.kind === 'author') {
      if (!logins.has(record.author.author_login)) {
        logins.add(record.author.author_login);
        summary.authors.push(record.author);
      }
    } else if (record.kind === 'term') {
      const tax = record.term.term_taxonomy;
      summary.terms[tax] = (summary.terms[tax] ?? 0) + 1;
    } else {
      const { post } = record;
      summary.items += 1;
      summary.posts[post.post_type] = (summary.posts[post.post_type] ?? 0) + 1;
      summary.comments += post.comments.length;
      if (post.post_author && !logins.has(post.post_author)) {
        logins.add(post.post_author);
        summary.authors.push({
          author_id: 0,
          author_login: post.post_author,
          author_email: '',
          author_display_name: post.post_author,
          author_first_name: '',
          author_last_name: '',
        });
      }
    }
  }
  return summary;
}
