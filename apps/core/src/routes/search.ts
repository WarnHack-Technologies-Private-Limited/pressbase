import { schema } from '@pressbase/db';
import { and, asc, count, eq, gt, ilike, inArray, notInArray, or, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { permalink, permalinkContext } from '../content/permalinks';
import { type QueryArgs, queryPosts } from '../content/query';
import { type AppEnv, invalidParams, restError } from '../http';
import type { Kernel } from '../kernel';
import { intList, pageParam, perPageParam, queryObject, setPaginationHeaders } from './rest-util';
import { termLink } from './terms';

/**
 * GET /wp/v2/search — a port of WP_REST_Search_Controller
 * (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-search-controller.php)
 * and its handlers (wordpress/wp-includes/rest-api/search/): one search across
 * posts of every public type, terms of every public taxonomy, or post formats.
 * The block editor's link popover uses it (fetchLinkSuggestions in core-data).
 *
 * Everything returned is public: published posts only, as WordPress's post
 * handler queries `post_status => publish`; terms of public taxonomies.
 *
 * Filters `rest_post_search_query`, `rest_term_search_query` and
 * `rest_post_format_search_query` (args, query) change each handler's query.
 */

type Id = number | string;

interface SearchRequest {
  search?: string;
  subtype: string[];
  page: number;
  per_page: number;
  include: number[];
  exclude: number[];
}

interface Handler {
  type: string;
  subtypes(kernel: Kernel): string[];
  /** WP_REST_Search_Handler::search_items(): IDs of this page and the total. */
  search(kernel: Kernel, request: SearchRequest): Promise<{ ids: Id[]; total: number }>;
  /** The items for those IDs, in the same order. */
  prepare(kernel: Kernel, ids: Id[]): Promise<SearchItem[]>;
}

interface SearchItem {
  id: Id;
  title: string;
  url: string;
  type: string;
  subtype?: string;
  _links: Record<string, { href: string; embeddable?: boolean }[]>;
}

const ANY = 'any';
const escapeLike = (value: string) => value.replace(/[%_\\]/g, '\\$&');

/** The request's subtypes, or every subtype the handler knows for `any`. */
const subtypesFor = (handler: Handler, kernel: Kernel, request: SearchRequest) =>
  request.subtype.includes(ANY) ? handler.subtypes(kernel) : request.subtype;

/** WP_REST_Post_Search_Handler */
const postHandler: Handler = {
  type: 'post',
  // Every public post type in the REST API, except attachments.
  subtypes: (kernel) =>
    kernel.postTypes
      .all()
      .filter((t) => t.public && t.showInRest && t.name !== 'attachment')
      .map((t) => t.name),

  async search(kernel, request) {
    const types = subtypesFor(this, kernel, request);
    if (!types.length) return { ids: [], total: 0 };
    const input: QueryArgs = {
      post_type: types,
      post_status: 'publish',
      paged: request.page,
      posts_per_page: request.per_page,
      s: request.search || undefined,
      post__not_in: request.exclude.length ? request.exclude : undefined,
      post__in: request.include.length ? request.include : undefined,
    };
    const args = (await kernel.hooks.applyFilters(
      'rest_post_search_query',
      input,
      request,
    )) as QueryArgs;
    const result = await queryPosts(kernel, args);
    return { ids: result.posts.map((p) => p.id), total: result.found };
  },

  async prepare(kernel, ids) {
    const numeric = ids.map(Number);
    if (!numeric.length) return [];
    const rows = await kernel.db
      .select()
      .from(schema.posts)
      .where(inArray(schema.posts.id, numeric));
    const byId = new Map(rows.map((p) => [p.id, p]));
    const links = await permalinkContext(kernel);
    const items: SearchItem[] = [];
    for (const id of numeric) {
      const post = byId.get(id);
      if (!post) continue;
      const type = kernel.postTypes.get(post.type);
      items.push({
        id: post.id,
        // get_the_title(), without the "Protected:"/"Private:" prefixes.
        title: type?.supports.has('title') ? post.title : '',
        url: await permalink(kernel, post, links),
        type: 'post',
        subtype: post.type,
        _links: {
          ...(type?.showInRest
            ? { self: [{ embeddable: true, href: `/wp-json/wp/v2/${type.restBase}/${post.id}` }] }
            : {}),
          about: [{ href: `/wp-json/wp/v2/types/${post.type}` }],
        },
      });
    }
    return items;
  },
};

/** WP_REST_Term_Search_Handler */
const termHandler: Handler = {
  type: 'term',
  subtypes: (kernel) =>
    kernel.taxonomies
      .all()
      .filter((t) => t.public && t.showInRest)
      .map((t) => t.name),

  async search(kernel, request) {
    const taxonomies = subtypesFor(this, kernel, request);
    if (!taxonomies.length) return { ids: [], total: 0 };
    const input = {
      taxonomy: taxonomies,
      hide_empty: false,
      offset: (request.page - 1) * request.per_page,
      number: request.per_page,
      search: request.search || undefined,
      exclude: request.exclude.length ? request.exclude : undefined,
      include: request.include.length ? request.include : undefined,
    };
    const args = (await kernel.hooks.applyFilters(
      'rest_term_search_query',
      input,
      request,
    )) as typeof input;

    // WP_Term_Query: name or slug contains the search; ordered by name.
    const { terms, termTaxonomy } = schema;
    const where: (SQL | undefined)[] = [inArray(termTaxonomy.taxonomy, args.taxonomy)];
    if (args.search) {
      const like = `%${escapeLike(args.search)}%`;
      where.push(or(ilike(terms.name, like), ilike(terms.slug, like)));
    }
    if (args.include?.length) where.push(inArray(terms.id, args.include));
    if (args.exclude?.length) where.push(notInArray(terms.id, args.exclude));
    if (args.hide_empty) where.push(gt(termTaxonomy.count, 0));
    const condition = and(...where);
    const [rows, [total]] = await Promise.all([
      kernel.db
        .select({ id: terms.id })
        .from(terms)
        .innerJoin(termTaxonomy, eq(termTaxonomy.termId, terms.id))
        .where(condition)
        .orderBy(asc(terms.name), asc(terms.id))
        .limit(args.number)
        .offset(args.offset),
      kernel.db
        .select({ n: count() })
        .from(terms)
        .innerJoin(termTaxonomy, eq(termTaxonomy.termId, terms.id))
        .where(condition),
    ]);
    return { ids: rows.map((r) => r.id), total: total?.n ?? 0 };
  },

  async prepare(kernel, ids) {
    const numeric = ids.map(Number);
    if (!numeric.length) return [];
    const { terms, termTaxonomy } = schema;
    const rows = await kernel.db
      .select({ id: terms.id, name: terms.name, slug: terms.slug, taxonomy: termTaxonomy.taxonomy })
      .from(terms)
      .innerJoin(termTaxonomy, eq(termTaxonomy.termId, terms.id))
      .where(inArray(terms.id, numeric));
    const byId = new Map(rows.map((t) => [t.id, t]));
    const home = await kernel.options.get<string>('home', '');
    const items: SearchItem[] = [];
    for (const id of numeric) {
      const term = byId.get(id);
      if (!term) continue;
      const taxonomy = kernel.taxonomies.get(term.taxonomy);
      items.push({
        id: term.id,
        title: term.name,
        url: termLink(home, term.taxonomy, term.slug),
        // As WordPress: `type` is the taxonomy, and there is no `subtype`.
        type: term.taxonomy,
        _links: {
          ...(taxonomy?.showInRest
            ? {
                self: [
                  { embeddable: true, href: `/wp-json/wp/v2/${taxonomy.restBase}/${term.id}` },
                ],
              }
            : {}),
          about: [{ href: `/wp-json/wp/v2/taxonomies/${term.taxonomy}` }],
        },
      });
    }
    return items;
  },
};

/**
 * WP_REST_Post_Format_Search_Handler. A format is found only when its archive
 * exists (get_post_format_link()), which needs the post_format taxonomy;
 * Pressbase has no post formats yet, so this always finds nothing.
 */
const postFormatHandler: Handler = {
  type: 'post-format',
  subtypes: () => [],
  async search(kernel, request) {
    await kernel.hooks.applyFilters(
      'rest_post_format_search_query',
      { search: request.search || undefined },
      request,
    );
    return { ids: [], total: 0 };
  },
  async prepare() {
    return [];
  },
};

export const SEARCH_HANDLERS: readonly Handler[] = [postHandler, termHandler, postFormatHandler];

export function searchRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const types = SEARCH_HANDLERS.map((h) => h.type) as [string, ...string[]];
    const subtypes: [string, ...string[]] = [
      ANY,
      ...new Set(SEARCH_HANDLERS.flatMap((h) => h.subtypes(kernel))),
    ];
    const parsed = z
      .object({
        context: z.enum(['view', 'embed']).default('view'),
        page: pageParam,
        per_page: perPageParam,
        search: z.string().optional(),
        type: z.enum(types).default(types[0]),
        subtype: z.array(z.enum(subtypes)).default([ANY]),
        include: intList.default([]),
        exclude: intList.default([]),
      })
      .safeParse(queryObject(c, ['subtype', 'include', 'exclude']));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const q = parsed.data;

    const handler = SEARCH_HANDLERS.find((h) => h.type === q.type);
    if (!handler) return restError(c, 400, 'rest_search_invalid_type', 'Invalid type parameter.');

    // sanitize_subtypes(): `any` wins; otherwise keep the handler's own subtypes.
    const own = handler.subtypes(kernel);
    const subtype = q.subtype.includes(ANY) ? [ANY] : q.subtype.filter((s) => own.includes(s));

    const request: SearchRequest = {
      search: q.search,
      subtype,
      page: q.page,
      per_page: q.per_page,
      include: q.include,
      exclude: q.exclude,
    };
    const { ids, total } = await handler.search(kernel, request);
    const maxPages = Math.ceil(total / q.per_page);
    if (q.page > maxPages && total > 0) {
      return restError(
        c,
        400,
        'rest_search_invalid_page_number',
        'The page number requested is larger than the number of pages available.',
      );
    }

    const items = (await handler.prepare(kernel, ids)).map((item) => ({
      ...item,
      _links: { ...item._links, collection: [{ href: '/wp-json/wp/v2/search' }] },
    }));
    setPaginationHeaders(c, total, maxPages, q.page);
    return c.json(items);
  });

  return app;
}
