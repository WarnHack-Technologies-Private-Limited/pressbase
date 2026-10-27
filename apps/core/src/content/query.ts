import { schema } from '@pressbase/db';
import {
  and,
  asc,
  type Column,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Kernel } from '../kernel';
import type { Post } from './posts';

/**
 * ContentQuery — Pressbase's WP_Query (wordpress/wp-includes/class-wp-query.php).
 * Arguments keep WordPress's names so existing knowledge transfers.
 *
 * The `content_query_args` filter (like pre_get_posts) can change the
 * arguments before the query runs.
 */

export interface TaxQueryClause {
  taxonomy: string;
  /** Term IDs or slugs, depending on `field`. */
  terms: (number | string)[];
  field?: 'term_id' | 'slug';
  operator?: 'IN' | 'NOT IN' | 'AND';
  /** Also match child terms (hierarchical taxonomies). Default true, as in WordPress. */
  include_children?: boolean;
}

export interface MetaQueryClause {
  key: string;
  value?: string | number | boolean | (string | number)[];
  compare?:
    | '='
    | '!='
    | '>'
    | '>='
    | '<'
    | '<='
    | 'LIKE'
    | 'NOT LIKE'
    | 'IN'
    | 'NOT IN'
    | 'EXISTS'
    | 'NOT EXISTS';
}

export type OrderBy =
  | 'date'
  | 'modified'
  | 'title'
  | 'name'
  | 'id'
  | 'author'
  | 'parent'
  | 'menu_order'
  | 'comment_count'
  | 'post__in'
  | 'relevance';

export interface QueryArgs {
  post_type?: string | string[];
  post_status?: string | string[];
  p?: number;
  post__in?: number[];
  post__not_in?: number[];
  name?: string;
  post_name__in?: string[];
  author?: number;
  author__in?: number[];
  author__not_in?: number[];
  /** 0 means top level only. */
  post_parent?: number;
  post_parent__in?: number[];
  post_parent__not_in?: number[];
  s?: string;
  /** Full MIME types (`image/png`) or media types (`image`), as in WordPress. */
  post_mime_type?: string | string[];
  tax_query?: TaxQueryClause[];
  meta_query?: MetaQueryClause[];
  date_after?: Date;
  date_before?: Date;
  modified_after?: Date;
  modified_before?: Date;
  menu_order?: number;
  orderby?: OrderBy;
  order?: 'ASC' | 'DESC';
  posts_per_page?: number;
  paged?: number;
  offset?: number;
  /** Skip counting total rows (faster when pagination is not needed). */
  no_found_rows?: boolean;
}

export interface QueryResult {
  posts: Post[];
  found: number;
  maxPages: number;
}

const list = <T>(value: T | T[] | undefined): T[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

const escapeLike = (value: string) => value.replace(/[%_\\]/g, '\\$&');

function taxClause(clause: TaxQueryClause, hierarchical: boolean): SQL {
  const { posts } = schema;
  const field = clause.field ?? 'term_id';
  const values = clause.terms.map((t) => (field === 'term_id' ? Number(t) : String(t)));
  const termMatch =
    field === 'term_id'
      ? sql`t.id in (${sql.join(
          values.map((v) => sql`${v}`),
          sql`, `,
        )})`
      : sql`t.slug in (${sql.join(
          values.map((v) => sql`${v}`),
          sql`, `,
        )})`;

  // The term_taxonomy rows to match, optionally with all their descendants.
  const matched =
    hierarchical && clause.include_children !== false
      ? sql`with recursive tree as (
          select tt.id from term_taxonomy tt join terms t on t.id = tt.term_id
          where tt.taxonomy = ${clause.taxonomy} and ${termMatch}
          union select child.id from term_taxonomy child join tree on child.parent_id = tree.id
        ) select id from tree`
      : sql`select tt.id from term_taxonomy tt join terms t on t.id = tt.term_id
          where tt.taxonomy = ${clause.taxonomy} and ${termMatch}`;

  const has = (ttIds: SQL) =>
    sql`exists (select 1 from term_relationships tr where tr.object_id = ${posts.id} and tr.term_taxonomy_id in (${ttIds}))`;

  switch (clause.operator ?? 'IN') {
    case 'NOT IN':
      return sql`not ${has(matched)}`;
    case 'AND':
      // Every listed term must be attached (children are not considered, as in WordPress).
      return and(
        ...values.map((v) =>
          has(
            sql`select tt.id from term_taxonomy tt join terms t on t.id = tt.term_id
              where tt.taxonomy = ${clause.taxonomy} and ${field === 'term_id' ? sql`t.id = ${v}` : sql`t.slug = ${v}`}`,
          ),
        ),
      ) as SQL;
    default:
      return has(matched);
  }
}

function metaClause(clause: MetaQueryClause): SQL {
  const { posts } = schema;
  const compare = clause.compare ?? (Array.isArray(clause.value) ? 'IN' : '=');
  const row = sql`select 1 from postmeta pm where pm.post_id = ${posts.id} and pm.key = ${clause.key}`;
  if (compare === 'EXISTS') return sql`exists (${row})`;
  if (compare === 'NOT EXISTS') return sql`not exists (${row})`;

  // Meta values are JSONB; compare their text form, numerically when the value is a number.
  const values = list(clause.value) ?? [];
  const numeric = values.length > 0 && values.every((v) => typeof v === 'number');
  const text = sql`(pm.value #>> '{}')`;
  const lhs = numeric ? sql`(${text})::numeric` : text;
  const one = values[0];
  let test: SQL;
  switch (compare) {
    case 'IN':
    case 'NOT IN':
      test = sql`${lhs} ${sql.raw(compare === 'IN' ? 'in' : 'not in')} (${sql.join(
        values.map((v) => sql`${numeric ? v : String(v)}`),
        sql`, `,
      )})`;
      break;
    case 'LIKE':
      test = sql`${text} ilike ${`%${escapeLike(String(one))}%`}`;
      break;
    case 'NOT LIKE':
      test = sql`${text} not ilike ${`%${escapeLike(String(one))}%`}`;
      break;
    default:
      test = sql`${lhs} ${sql.raw(compare)} ${numeric ? one : String(one)}`;
  }
  return sql`exists (${row} and ${test})`;
}

export async function queryPosts(kernel: Kernel, input: QueryArgs): Promise<QueryResult> {
  const args = (await kernel.hooks.applyFilters('content_query_args', input)) as QueryArgs;
  await kernel.posts.publishDue();

  const { posts } = schema;
  const where: (SQL | undefined)[] = [];

  const types = list(args.post_type) ?? ['post'];
  if (!types.includes('any')) where.push(inArray(posts.type, types));
  const statuses = list(args.post_status) ?? ['publish'];
  if (!statuses.includes('any')) where.push(inArray(posts.status, statuses));
  else where.push(notInArray(posts.status, ['trash', 'auto-draft', 'inherit']));

  if (args.p !== undefined) where.push(eq(posts.id, args.p));
  if (args.post__in)
    where.push(args.post__in.length ? inArray(posts.id, args.post__in) : sql`false`);
  if (args.post__not_in?.length) where.push(notInArray(posts.id, args.post__not_in));
  if (args.name !== undefined) where.push(eq(posts.slug, args.name));
  if (args.post_name__in?.length) where.push(inArray(posts.slug, args.post_name__in));
  if (args.author !== undefined) where.push(eq(posts.authorId, args.author));
  if (args.author__in?.length) where.push(inArray(posts.authorId, args.author__in));
  if (args.author__not_in?.length) {
    where.push(or(isNull(posts.authorId), notInArray(posts.authorId, args.author__not_in)));
  }
  if (args.post_parent !== undefined) {
    where.push(
      args.post_parent === 0 ? isNull(posts.parentId) : eq(posts.parentId, args.post_parent),
    );
  }
  if (args.post_parent__in?.length) where.push(inArray(posts.parentId, args.post_parent__in));
  if (args.post_parent__not_in?.length) {
    where.push(or(isNull(posts.parentId), notInArray(posts.parentId, args.post_parent__not_in)));
  }
  if (args.menu_order !== undefined) where.push(eq(posts.menuOrder, args.menu_order));
  if (args.date_after) where.push(sql`${posts.date} > ${args.date_after}`);
  if (args.date_before) where.push(sql`${posts.date} < ${args.date_before}`);
  if (args.modified_after) where.push(sql`${posts.modified} > ${args.modified_after}`);
  if (args.modified_before) where.push(sql`${posts.modified} < ${args.modified_before}`);

  // wp_post_mime_type_where(): `image` matches every image/* type.
  const mimeTypes = list(args.post_mime_type)?.filter(Boolean);
  if (mimeTypes?.length) {
    where.push(
      or(
        ...mimeTypes.map((m) =>
          m.includes('/') ? eq(posts.mimeType, m) : ilike(posts.mimeType, `${escapeLike(m)}/%`),
        ),
      ),
    );
  }

  // Search: every word must appear in the title, excerpt or content (WordPress's parse_search).
  const words = (args.s ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 10);
  for (const word of words) {
    const like = `%${escapeLike(word)}%`;
    where.push(
      or(ilike(posts.title, like), ilike(posts.excerpt, like), ilike(posts.content, like)),
    );
  }

  for (const clause of args.tax_query ?? []) {
    if (!clause.terms.length) continue;
    const hierarchical = kernel.taxonomies.get(clause.taxonomy)?.hierarchical ?? false;
    where.push(taxClause(clause, hierarchical));
  }
  for (const clause of args.meta_query ?? []) where.push(metaClause(clause));

  const condition = and(...where);
  const direction = args.order === 'ASC' ? asc : desc;
  const orderby = args.orderby ?? (words.length ? 'relevance' : 'date');
  const orderColumns: Record<Exclude<OrderBy, 'post__in' | 'relevance'>, Column> = {
    date: posts.date,
    modified: posts.modified,
    title: posts.title,
    name: posts.slug,
    id: posts.id,
    author: posts.authorId,
    parent: posts.parentId,
    menu_order: posts.menuOrder,
    comment_count: posts.commentCount,
  };
  let orderBy: SQL[];
  if (orderby === 'post__in' && args.post__in?.length) {
    orderBy = [
      sql`array_position(${sql.raw(`ARRAY[${args.post__in.map(Number).join(',')}]::bigint[]`)}, ${posts.id})`,
    ];
  } else if (orderby === 'relevance' && words.length) {
    // Whole phrase in the title first, then all words in the title, then by date.
    const phrase = `%${escapeLike(words.join(' '))}%`;
    orderBy = [
      sql`(${posts.title} ilike ${phrase}) desc`,
      sql`(${and(...words.map((w) => ilike(posts.title, `%${escapeLike(w)}%`)))}) desc`,
      desc(posts.date),
    ];
  } else {
    const column = orderColumns[orderby as keyof typeof orderColumns] ?? posts.date;
    orderBy = [direction(column)];
  }
  orderBy.push(direction(posts.id));

  const perPage = args.posts_per_page ?? (await kernel.options.get<number>('posts_per_page', 10));
  const unlimited = perPage === -1;
  const offset = args.offset ?? ((args.paged ?? 1) - 1) * (unlimited ? 0 : perPage);

  const rowsQuery = kernel.db
    .select()
    .from(posts)
    .where(condition)
    .orderBy(...orderBy);
  const rows = await (unlimited
    ? rowsQuery.offset(offset)
    : rowsQuery.limit(perPage).offset(offset));

  let found = rows.length;
  if (!args.no_found_rows && !unlimited) {
    const [total] = await kernel.db.select({ n: count() }).from(posts).where(condition);
    found = total?.n ?? 0;
  }
  return {
    posts: rows,
    found,
    maxPages: unlimited ? 1 : Math.ceil(found / Math.max(perPage, 1)),
  };
}
