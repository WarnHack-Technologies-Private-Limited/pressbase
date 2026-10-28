import { schema } from '@pressbase/db';
import { and, asc, eq, gte, inArray, lt, ne, type SQL, sql } from 'drizzle-orm';
import { parseRestDate } from '../content/dates';
import { permalink, permalinkContext } from '../content/permalinks';
import type { Post } from '../content/posts';
import { cdata, rfc822, xmlText } from '../frontend/xml';
import type { Kernel } from '../kernel';
import { fileUrl, META_FILE } from '../media/service';
import { PRESSBASE_VERSION } from '../version';
import { metaToWordPress } from './php-serialize';

/**
 * The exporter: export_wp() (wp-admin/includes/export.php), writing WXR 1.2
 * that WordPress's importer reads. It streams: post IDs are snapshotted
 * first, then posts are read and written 20 at a time, as export_wp() does,
 * so memory stays flat for any site size.
 *
 * Meta values are JSON in Pressbase; arrays and objects are written
 * PHP-serialized, as WordPress stores them (php-serialize.ts).
 */

export const WXR_VERSION = '1.2';

declare module '@pressbase/hooks' {
  interface ActionRegistry {
    /** An export begins, with its arguments (before anything is written). */
    export_wp: [args: ExportOptions];
  }
  interface FilterRegistry {
    /** The download's file name. */
    export_wp_filename: [filename: string, sitename: string, date: string];
    /** The export's arguments, from Tools → Export (wp-admin/export.php). */
    export_args: [args: ExportOptions];
    the_title_export: [title: string];
    the_content_export: [content: string];
    the_excerpt_export: [excerpt: string];
    /** Return true to leave a post meta row out. */
    wxr_export_skip_postmeta: [skip: boolean, key: string, meta: { key: string; value: unknown }];
    wxr_export_skip_commentmeta: [skip: boolean, key: string, meta: { key: string; value: unknown }];
    wxr_export_skip_termmeta: [skip: boolean, key: string, meta: { key: string; value: unknown }];
  }
}

/** export_wp()'s arguments. */
export interface ExportOptions {
  /** 'all' (default) or a post type. An unknown type exports everything, as WordPress does. */
  content?: string;
  /** Author ID (posts, pages and attachments only). */
  author?: number;
  /** Category ID or slug (posts only). */
  category?: number | string;
  /** `YYYY-MM` or `YYYY-MM-DD`: from the start of that day or month (posts, pages, attachments). */
  start_date?: string;
  /** `YYYY-MM` or `YYYY-MM-DD`: up to the end of that month, as export_wp() does (posts, pages, attachments). */
  end_date?: string;
  /** A status (posts and pages only). Default: everything but auto-drafts. */
  status?: string;
}

/** Post types export_wp() includes: every registered type that can be exported (not revisions). */
export function exportablePostTypes(kernel: Kernel): string[] {
  return kernel.postTypes
    .all()
    .map((t) => t.name)
    .filter((name) => name !== 'revision');
}

/** sanitize_key( get_bloginfo( 'name' ) ) . '.WordPress.' . date . '.xml', filtered. */
export async function exportFilename(kernel: Kernel, now = new Date()): Promise<string> {
  const name = (await kernel.options.get<string>('blogname', ''))
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  const sitename = name ? `${name}.` : '';
  const date = now.toISOString().slice(0, 10);
  const filename = `${sitename}WordPress.${date}.xml`;
  return String(await kernel.hooks.applyFilters('export_wp_filename', filename, sitename, date));
}

/** "Y-m-d H:i:s" in a time zone. */
function mysqlDate(date: Date, timeZone: string): string {
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
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

const gmt = (date: Date) => mysqlDate(date, 'UTC');

/** The start of a `YYYY-MM` or `YYYY-MM-DD` date in the site's time zone, optionally a month later. */
function boundary(value: string, timeZone: string, nextMonth: boolean): Date | undefined {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value.trim());
  if (!match) return undefined;
  let year = Number(match[1]);
  let month = Number(match[2]);
  if (nextMonth) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    // export_wp(): strtotime( '+1 month', end_date ) keeps the day.
    const day = match[3] ?? '01';
    return parseRestDate(`${year}-${String(month).padStart(2, '0')}-${day}T00:00:00`, timeZone, false);
  }
  return parseRestDate(`${match[1]}-${match[2]}-${match[3] ?? '01'}T00:00:00`, timeZone, false);
}

interface ExportTerm {
  id: number;
  name: string;
  slug: string;
  description: string;
  taxonomy: string;
  parent: number;
}

/** Puts terms in order with no child before its parent (export_wp()). */
function parentsFirst(terms: ExportTerm[]): ExportTerm[] {
  const out = new Map<number, ExportTerm>();
  const ids = new Set(terms.map((t) => t.id));
  let queue = [...terms];
  while (queue.length) {
    const next: ExportTerm[] = [];
    for (const term of queue) {
      if (!term.parent || out.has(term.parent) || !ids.has(term.parent)) out.set(term.id, term);
      else next.push(term);
    }
    // A loop: write the rest as they are.
    if (next.length === queue.length) {
      for (const term of next) out.set(term.id, term);
      break;
    }
    queue = next;
  }
  return [...out.values()];
}

async function allTerms(kernel: Kernel, taxonomies: string[]): Promise<ExportTerm[]> {
  if (!taxonomies.length) return [];
  const { terms, termTaxonomy } = schema;
  return kernel.db
    .select({
      id: terms.id,
      name: terms.name,
      slug: terms.slug,
      description: termTaxonomy.description,
      taxonomy: termTaxonomy.taxonomy,
      parent:
        sql<number>`coalesce((select p.term_id from term_taxonomy p where p.id = ${termTaxonomy.parentId}), 0)`.mapWith(
          Number,
        ),
    })
    .from(terms)
    .innerJoin(termTaxonomy, eq(termTaxonomy.termId, terms.id))
    .where(inArray(termTaxonomy.taxonomy, taxonomies))
    .orderBy(asc(terms.id));
}

/**
 * Generates the WXR document, chunk by chunk. `exportWxr()` writes it to a
 * stream; the REST route sends it as the download.
 */
export async function* generateWxr(kernel: Kernel, input: ExportOptions = {}): AsyncGenerator<string> {
  const args: ExportOptions = { content: 'all', ...input };
  await kernel.hooks.doAction('export_wp', args);
  const get = <T>(name: string, fallback: T) => kernel.options.get<T>(name, fallback);
  const timeZone = await get('timezone_string', 'UTC');
  const home = (await get('home', '')).replace(/\/+$/, '');
  const siteUrl = ((await get('siteurl', '')) || home).replace(/\/+$/, '');
  const p = schema.posts;

  // Which posts (export_wp()'s $where).
  let content = args.content ?? 'all';
  const exportable = exportablePostTypes(kernel);
  if (content !== 'all' && !exportable.includes(content)) content = 'all';
  const where: SQL[] = [
    content === 'all' ? inArray(p.type, exportable) : eq(p.type, content),
  ];
  if (args.status && (content === 'post' || content === 'page')) where.push(eq(p.status, args.status));
  else where.push(ne(p.status, 'auto-draft'));

  let category: ExportTerm | undefined;
  if (args.category && content === 'post') {
    const [found] = (await allTerms(kernel, ['category'])).filter((t) =>
      typeof args.category === 'number' || /^\d+$/.test(String(args.category))
        ? t.id === Number(args.category)
        : t.slug === args.category,
    );
    category = found;
    if (category) {
      where.push(
        sql`${p.id} in (select r.object_id from term_relationships r join term_taxonomy tt on tt.id = r.term_taxonomy_id where tt.term_id = ${category.id} and tt.taxonomy = 'category')`,
      );
    }
  }
  if (['post', 'page', 'attachment'].includes(content)) {
    if (args.author) where.push(eq(p.authorId, args.author));
    const start = args.start_date ? boundary(args.start_date, timeZone, false) : undefined;
    const end = args.end_date ? boundary(args.end_date, timeZone, true) : undefined;
    if (start) where.push(gte(p.date, start));
    if (end) where.push(lt(p.date, end));
  }

  // A snapshot of the IDs, in case content changes during the export.
  let postIds = (
    await kernel.db.select({ id: p.id }).from(p).where(and(...where)).orderBy(asc(p.id))
  ).map((r) => r.id);

  // Attachments and featured images of the chosen posts, unless all content goes anyway.
  if (content !== 'all' && content !== 'attachment' && postIds.length) {
    const extra = new Set<number>();
    for (let i = 0; i < postIds.length; i += 500) {
      const chunk = postIds.slice(i, i + 500);
      const attachments = await kernel.db
        .select({ id: p.id })
        .from(p)
        .where(and(inArray(p.parentId, chunk), eq(p.type, 'attachment')));
      for (const a of attachments) extra.add(a.id);
      const thumbnails = await kernel.db
        .select({ value: schema.postmeta.value })
        .from(schema.postmeta)
        .where(and(inArray(schema.postmeta.postId, chunk), eq(schema.postmeta.key, '_thumbnail_id')));
      for (const t of thumbnails) {
        const id = Number(t.value);
        if (Number.isInteger(id) && id > 0) extra.add(id);
      }
    }
    postIds = [...new Set([...postIds, ...extra])].sort((a, b) => a - b);
  }

  // The terms to list: the one category, or every term when exporting everything.
  let categories: ExportTerm[] = [];
  let tags: ExportTerm[] = [];
  let customTerms: ExportTerm[] = [];
  if (category) {
    categories = [{ ...category, parent: 0 }];
  } else if (content === 'all') {
    categories = parentsFirst(await allTerms(kernel, ['category']));
    tags = await allTerms(kernel, ['post_tag']);
    const custom = kernel.taxonomies
      .all()
      .filter((t) => !t.builtin)
      .map((t) => t.name);
    customTerms = parentsFirst(await allTerms(kernel, custom));
  }
  const slugOf = (list: ExportTerm[]) => new Map(list.map((t) => [t.id, t.slug]));
  const categorySlugs = slugOf(categories);
  const customSlugs = slugOf(customTerms);

  const blogname = await get('blogname', '');
  const description = await get('blogdescription', '');
  const language = (await get('locale', 'en_US')).replace('_', '-');

  yield `<?xml version="1.0" encoding="UTF-8" ?>
<!-- This is a WordPress eXtended RSS file generated by Pressbase as an export of your site. -->
<!-- It contains information about your site's posts, pages, comments, categories, and other content. -->
<!-- You may use this file to transfer that content from one site to another. -->
<!-- This file is not intended to serve as a complete backup of your site. -->

<!-- To import this information into a WordPress site follow these steps: -->
<!-- 1. Log in to that site as an administrator. -->
<!-- 2. Go to Tools: Import in the WordPress admin panel. -->
<!-- 3. Install the "WordPress" importer from the list. -->
<!-- 4. Activate & Run Importer. -->
<!-- 5. Upload this file using the form provided on that page. -->
<!-- 6. You will first be asked to map the authors in this export file to users -->
<!--    on the site. For each author, you may choose to map to an -->
<!--    existing user on the site or to create a new user. -->
<!-- 7. WordPress will then import each of the posts, pages, comments, categories, etc. -->
<!--    contained in this file into your site. -->

<!-- generator="Pressbase/${PRESSBASE_VERSION}" created="${gmt(new Date()).slice(0, 16)}" -->
<rss version="2.0"
\txmlns:excerpt="http://wordpress.org/export/${WXR_VERSION}/excerpt/"
\txmlns:content="http://purl.org/rss/1.0/modules/content/"
\txmlns:wfw="http://wellformedweb.org/CommentAPI/"
\txmlns:dc="http://purl.org/dc/elements/1.1/"
\txmlns:wp="http://wordpress.org/export/${WXR_VERSION}/"
>

<channel>
\t<title>${xmlText(blogname)}</title>
\t<link>${xmlText(home)}</link>
\t<description>${xmlText(description)}</description>
\t<pubDate>${rfc822(new Date())}</pubDate>
\t<language>${xmlText(language)}</language>
\t<wp:wxr_version>${WXR_VERSION}</wp:wxr_version>
\t<wp:base_site_url>${xmlText(siteUrl)}</wp:base_site_url>
\t<wp:base_blog_url>${xmlText(home)}</wp:base_blog_url>

`;

  // wxr_authors_list(): the authors of the exported posts.
  yield* authorsList(kernel, postIds);

  for (const c of categories) {
    yield `\t<wp:category>
\t\t<wp:term_id>${c.id}</wp:term_id>
\t\t<wp:category_nicename>${cdata(c.slug)}</wp:category_nicename>
\t\t<wp:category_parent>${cdata(c.parent ? (categorySlugs.get(c.parent) ?? '') : '')}</wp:category_parent>
${c.name ? `\t\t<wp:cat_name>${cdata(c.name)}</wp:cat_name>\n` : ''}${c.description ? `\t\t<wp:category_description>${cdata(c.description)}</wp:category_description>\n` : ''}${await termMeta(kernel, c.id)}\t</wp:category>
`;
  }
  for (const t of tags) {
    yield `\t<wp:tag>
\t\t<wp:term_id>${t.id}</wp:term_id>
\t\t<wp:tag_slug>${cdata(t.slug)}</wp:tag_slug>
${t.name ? `\t\t<wp:tag_name>${cdata(t.name)}</wp:tag_name>\n` : ''}${t.description ? `\t\t<wp:tag_description>${cdata(t.description)}</wp:tag_description>\n` : ''}${await termMeta(kernel, t.id)}\t</wp:tag>
`;
  }
  for (const t of customTerms) {
    yield `\t<wp:term>
\t\t<wp:term_id>${t.id}</wp:term_id>
\t\t<wp:term_taxonomy>${cdata(t.taxonomy)}</wp:term_taxonomy>
\t\t<wp:term_slug>${cdata(t.slug)}</wp:term_slug>
\t\t<wp:term_parent>${cdata(t.parent ? (customSlugs.get(t.parent) ?? '') : '')}</wp:term_parent>
${t.name ? `\t\t<wp:term_name>${cdata(t.name)}</wp:term_name>\n` : ''}${t.description ? `\t\t<wp:term_description>${cdata(t.description)}</wp:term_description>\n` : ''}${await termMeta(kernel, t.id)}\t</wp:term>
`;
  }

  // The posts, 20 at a time.
  const ctx = await permalinkContext(kernel);
  const sticky = new Set(await get<number[]>('sticky_posts', []));
  const logins = new Map<number, string>();
  for (let i = 0; i < postIds.length; i += 20) {
    const ids = postIds.slice(i, i + 20);
    const posts = await kernel.db.select().from(p).where(inArray(p.id, ids)).orderBy(asc(p.id));
    const missing = [...new Set(posts.map((post) => post.authorId).filter((id): id is number => !!id))].filter(
      (id) => !logins.has(id),
    );
    if (missing.length) {
      const users = await kernel.db
        .select({ id: schema.users.id, login: schema.users.login })
        .from(schema.users)
        .where(inArray(schema.users.id, missing));
      for (const u of users) logins.set(u.id, u.login);
    }
    const meta = await kernel.db
      .select()
      .from(schema.postmeta)
      .where(inArray(schema.postmeta.postId, ids))
      .orderBy(asc(schema.postmeta.id));
    const postTerms = await kernel.db
      .select({
        objectId: schema.termRelationships.objectId,
        taxonomy: schema.termTaxonomy.taxonomy,
        slug: schema.terms.slug,
        name: schema.terms.name,
      })
      .from(schema.termRelationships)
      .innerJoin(schema.termTaxonomy, eq(schema.termTaxonomy.id, schema.termRelationships.termTaxonomyId))
      .innerJoin(schema.terms, eq(schema.terms.id, schema.termTaxonomy.termId))
      .where(inArray(schema.termRelationships.objectId, ids))
      .orderBy(asc(schema.termRelationships.termOrder), asc(schema.terms.name));

    for (const post of posts) {
      yield await item(kernel, post, {
        ctx,
        timeZone,
        sticky: sticky.has(post.id),
        login: post.authorId ? (logins.get(post.authorId) ?? '') : '',
        meta: meta.filter((m) => m.postId === post.id),
        terms: postTerms.filter((t) => t.objectId === post.id && kernel.taxonomies.get(t.taxonomy)),
      });
    }
  }

  yield '</channel>\n</rss>\n';
}

async function* authorsList(kernel: Kernel, postIds: number[]): AsyncGenerator<string> {
  const ids = new Set<number>();
  for (let i = 0; i < postIds.length; i += 500) {
    const rows = await kernel.db
      .selectDistinct({ authorId: schema.posts.authorId })
      .from(schema.posts)
      .where(inArray(schema.posts.id, postIds.slice(i, i + 500)));
    for (const row of rows) if (row.authorId) ids.add(row.authorId);
  }
  if (!ids.size) return;
  const users = await kernel.db
    .select()
    .from(schema.users)
    .where(inArray(schema.users.id, [...ids]))
    .orderBy(asc(schema.users.id));
  const meta = await kernel.db
    .select()
    .from(schema.usermeta)
    .where(
      and(inArray(schema.usermeta.userId, [...ids]), inArray(schema.usermeta.key, ['first_name', 'last_name'])),
    );
  const field = (userId: number, key: string) =>
    String(meta.find((m) => m.userId === userId && m.key === key)?.value ?? '');
  for (const user of users) {
    yield `\t<wp:author><wp:author_id>${user.id}</wp:author_id><wp:author_login>${cdata(user.login)}</wp:author_login><wp:author_email>${cdata(user.email)}</wp:author_email><wp:author_display_name>${cdata(user.displayName)}</wp:author_display_name><wp:author_first_name>${cdata(field(user.id, 'first_name'))}</wp:author_first_name><wp:author_last_name>${cdata(field(user.id, 'last_name'))}</wp:author_last_name></wp:author>\n`;
  }
  yield '\n';
}

async function termMeta(kernel: Kernel, termId: number): Promise<string> {
  const rows = await kernel.db
    .select()
    .from(schema.termmeta)
    .where(eq(schema.termmeta.termId, termId))
    .orderBy(asc(schema.termmeta.id));
  let out = '';
  for (const row of rows) {
    const meta = { key: row.key, value: row.value };
    if (await kernel.hooks.applyFilters('wxr_export_skip_termmeta', false, row.key, meta)) continue;
    out += `\t\t<wp:termmeta>\n\t\t\t<wp:meta_key>${cdata(row.key)}</wp:meta_key>\n\t\t\t<wp:meta_value>${cdata(metaToWordPress(row.value))}</wp:meta_value>\n\t\t</wp:termmeta>\n`;
  }
  return out;
}

interface ItemContext {
  ctx: Awaited<ReturnType<typeof permalinkContext>>;
  timeZone: string;
  sticky: boolean;
  login: string;
  meta: (typeof schema.postmeta.$inferSelect)[];
  terms: { taxonomy: string; slug: string; name: string }[];
}

async function item(kernel: Kernel, post: Post, x: ItemContext): Promise<string> {
  const hooks = kernel.hooks;
  const title = String(await hooks.applyFilters('the_title_export', post.title));
  const content = String(await hooks.applyFilters('the_content_export', post.content));
  const excerpt = String(await hooks.applyFilters('the_excerpt_export', post.excerpt));
  let attachmentUrl = '';
  if (post.type === 'attachment') {
    const file = x.meta.find((m) => m.key === META_FILE)?.value;
    attachmentUrl = typeof file === 'string' && file ? await fileUrl(kernel, file) : post.guid;
  }
  const lines: string[] = [
    '\t<item>',
    `\t\t<title>${cdata(title)}</title>`,
    `\t\t<link>${xmlText(await permalink(kernel, post, x.ctx))}</link>`,
    `\t\t<pubDate>${rfc822(post.date)}</pubDate>`,
    `\t\t<dc:creator>${cdata(x.login)}</dc:creator>`,
    `\t\t<guid isPermaLink="false">${xmlText(post.guid)}</guid>`,
    '\t\t<description></description>',
    `\t\t<content:encoded>${cdata(content)}</content:encoded>`,
    `\t\t<excerpt:encoded>${cdata(excerpt)}</excerpt:encoded>`,
    `\t\t<wp:post_id>${post.id}</wp:post_id>`,
    `\t\t<wp:post_date>${cdata(mysqlDate(post.date, x.timeZone))}</wp:post_date>`,
    `\t\t<wp:post_date_gmt>${cdata(gmt(post.date))}</wp:post_date_gmt>`,
    `\t\t<wp:post_modified>${cdata(mysqlDate(post.modified, x.timeZone))}</wp:post_modified>`,
    `\t\t<wp:post_modified_gmt>${cdata(gmt(post.modified))}</wp:post_modified_gmt>`,
    `\t\t<wp:comment_status>${cdata(post.commentStatus)}</wp:comment_status>`,
    `\t\t<wp:ping_status>${cdata(post.pingStatus)}</wp:ping_status>`,
    `\t\t<wp:post_name>${cdata(post.slug)}</wp:post_name>`,
    `\t\t<wp:status>${cdata(post.status)}</wp:status>`,
    `\t\t<wp:post_parent>${post.parentId ?? 0}</wp:post_parent>`,
    `\t\t<wp:menu_order>${post.menuOrder}</wp:menu_order>`,
    `\t\t<wp:post_type>${cdata(post.type)}</wp:post_type>`,
    `\t\t<wp:post_password>${cdata(post.password)}</wp:post_password>`,
    `\t\t<wp:is_sticky>${x.sticky ? 1 : 0}</wp:is_sticky>`,
  ];
  if (post.type === 'attachment') lines.push(`\t\t<wp:attachment_url>${cdata(attachmentUrl)}</wp:attachment_url>`);
  // wxr_post_taxonomy()
  for (const term of x.terms) {
    lines.push(
      `\t\t<category domain="${xmlText(term.taxonomy)}" nicename="${xmlText(term.slug)}">${cdata(term.name)}</category>`,
    );
  }
  for (const row of x.meta) {
    const meta = { key: row.key, value: row.value };
    // wxr_filter_postmeta(): _edit_lock is never exported.
    if (row.key === '_edit_lock') continue;
    if (await hooks.applyFilters('wxr_export_skip_postmeta', false, row.key, meta)) continue;
    lines.push(
      `\t\t<wp:postmeta>\n\t\t<wp:meta_key>${cdata(row.key)}</wp:meta_key>\n\t\t<wp:meta_value>${cdata(metaToWordPress(row.value))}</wp:meta_value>\n\t\t</wp:postmeta>`,
    );
  }
  // Comments, spam excepted.
  const comments = await kernel.db
    .select()
    .from(schema.comments)
    .where(and(eq(schema.comments.postId, post.id), ne(schema.comments.approved, 'spam')))
    .orderBy(asc(schema.comments.id));
  const commentMeta = comments.length
    ? await kernel.db
        .select()
        .from(schema.commentmeta)
        .where(inArray(schema.commentmeta.commentId, comments.map((c) => c.id)))
        .orderBy(asc(schema.commentmeta.id))
    : [];
  for (const c of comments) {
    lines.push(
      '\t\t<wp:comment>',
      `\t\t\t<wp:comment_id>${c.id}</wp:comment_id>`,
      `\t\t\t<wp:comment_author>${cdata(c.author)}</wp:comment_author>`,
      `\t\t\t<wp:comment_author_email>${cdata(c.authorEmail)}</wp:comment_author_email>`,
      `\t\t\t<wp:comment_author_url>${xmlText(c.authorUrl)}</wp:comment_author_url>`,
      `\t\t\t<wp:comment_author_IP>${cdata(c.authorIp)}</wp:comment_author_IP>`,
      `\t\t\t<wp:comment_date>${cdata(mysqlDate(c.date, x.timeZone))}</wp:comment_date>`,
      `\t\t\t<wp:comment_date_gmt>${cdata(gmt(c.date))}</wp:comment_date_gmt>`,
      `\t\t\t<wp:comment_content>${cdata(c.content)}</wp:comment_content>`,
      `\t\t\t<wp:comment_approved>${cdata(c.approved)}</wp:comment_approved>`,
      `\t\t\t<wp:comment_type>${cdata(c.type)}</wp:comment_type>`,
      `\t\t\t<wp:comment_parent>${c.parentId ?? 0}</wp:comment_parent>`,
      `\t\t\t<wp:comment_user_id>${c.userId ?? 0}</wp:comment_user_id>`,
    );
    for (const row of commentMeta.filter((m) => m.commentId === c.id)) {
      const meta = { key: row.key, value: row.value };
      if (await hooks.applyFilters('wxr_export_skip_commentmeta', false, row.key, meta)) continue;
      lines.push(
        `\t\t\t<wp:commentmeta>\n\t\t\t<wp:meta_key>${cdata(row.key)}</wp:meta_key>\n\t\t\t<wp:meta_value>${cdata(metaToWordPress(row.value))}</wp:meta_value>\n\t\t\t</wp:commentmeta>`,
      );
    }
    lines.push('\t\t</wp:comment>');
  }
  lines.push('\t</item>', '');
  return lines.join('\n');
}

/** Where exportWxr() writes: a Node stream, a web stream, or a function. */
export type ExportOutput =
  | NodeJS.WritableStream
  | WritableStream<string>
  | ((chunk: string) => unknown);

/**
 * Writes the WXR export to `output` and returns how many chunks were
 * written. The CLI calls this with a file stream.
 */
export async function exportWxr(
  kernel: Kernel,
  options: ExportOptions,
  output: ExportOutput,
): Promise<void> {
  if (typeof output === 'function') {
    for await (const chunk of generateWxr(kernel, options)) await output(chunk);
    return;
  }
  if (output instanceof WritableStream) {
    const writer = output.getWriter();
    try {
      for await (const chunk of generateWxr(kernel, options)) await writer.write(chunk);
      await writer.close();
    } finally {
      writer.releaseLock();
    }
    return;
  }
  const stream = output as NodeJS.WritableStream;
  for await (const chunk of generateWxr(kernel, options)) {
    if (!stream.write(chunk)) await new Promise<void>((resolve) => stream.once('drain', resolve));
  }
}
