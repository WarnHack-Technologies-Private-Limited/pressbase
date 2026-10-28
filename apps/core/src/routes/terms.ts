import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { userCan } from '../auth/users';
import { type SiteInfo, siteInfo, termLink } from '../blocks/helpers';
import type { Taxonomy } from '../content/taxonomies';
import type { Term } from '../content/terms';
import { type AppEnv, invalidParams, readJson, restError } from '../http';
import { authorizeRestMeta, parseRestMeta, readRestMeta, writeRestMeta } from './meta-fields';
import {
  authStatus,
  boolParam,
  contextParam,
  intList,
  pageParam,
  perPageParam,
  queryObject,
  serviceError,
  setPaginationHeaders,
  stringList,
} from './rest-util';

/**
 * /wp/v2/categories, /wp/v2/tags — a port of WP_REST_Terms_Controller
 * (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-terms-controller.php).
 */

function prepare(
  term: Term,
  taxonomy: Taxonomy,
  site: SiteInfo,
  context: string,
  meta?: Map<number, Record<string, unknown>>,
) {
  const item: Record<string, unknown> = {
    id: term.id,
    count: term.count,
    description: term.description,
    link: termLink(site, term),
    name: term.name,
    slug: term.slug,
    taxonomy: taxonomy.name,
  };
  if (taxonomy.hierarchical) item.parent = term.parent;
  // Registered meta (routes/meta-fields.ts); WordPress prints an empty list as [].
  item.meta = meta?.get(term.id) ?? [];
  item._links = {
    self: [{ href: `/wp-json/wp/v2/${taxonomy.restBase}/${term.id}` }],
    collection: [{ href: `/wp-json/wp/v2/${taxonomy.restBase}` }],
    about: [{ href: `/wp-json/wp/v2/taxonomies/${taxonomy.name}` }],
  };
  if (context === 'embed') {
    const { id, link, name, slug, taxonomy: t, _links } = item;
    return { id, link, name, slug, taxonomy: t, _links };
  }
  return item;
}

const listArgs = z.object({
  context: contextParam,
  page: pageParam,
  per_page: perPageParam,
  search: z.string().optional(),
  exclude: intList,
  include: intList,
  order: z.enum(['asc', 'desc']).default('asc'),
  orderby: z
    .enum(['id', 'include', 'name', 'slug', 'include_slugs', 'term_group', 'description', 'count'])
    .default('name'),
  hide_empty: boolParam.default(false),
  parent: z.coerce.number().int().min(0).optional(),
  post: z.coerce.number().int().min(0).optional(),
  slug: stringList,
});

const writeBody = z.object({
  name: z.string().trim().min(1, 'A name is required for this term.').max(200).optional(),
  slug: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  parent: z.number().int().min(0).optional(),
});

export function termsRoutes(taxonomy: Taxonomy) {
  const app = new Hono<AppEnv>({ strict: false });
  const home = (c: Context<AppEnv>) => siteInfo(c.get('kernel'));
  const termMeta = (c: Context<AppEnv>, ids: number[]) =>
    readRestMeta(c.get('kernel'), 'term', taxonomy.name, ids);

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const parsed = listArgs.safeParse(queryObject(c, ['exclude', 'include', 'slug']));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const q = parsed.data;
    if (q.context === 'edit' && !userCan(c.get('user'), taxonomy.cap.edit_terms)) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden_context',
        'Sorry, you are not allowed to edit terms in this taxonomy.',
      );
    }
    const { terms, total } = await kernel.terms.list(taxonomy.name, {
      search: q.search,
      include: q.include,
      exclude: q.exclude,
      slug: q.slug,
      parent: taxonomy.hierarchical ? q.parent : undefined,
      post: q.post,
      hideEmpty: q.hide_empty,
      orderby: q.orderby === 'include_slugs' ? 'slug' : q.orderby,
      order: q.order,
      page: q.page,
      perPage: q.per_page,
    });
    const totalPages = Math.ceil(total / q.per_page);
    if (q.page > totalPages && total > 0) {
      return restError(
        c,
        400,
        'rest_term_invalid_page_number',
        'The page number requested is larger than the number of pages available.',
      );
    }
    setPaginationHeaders(c, total, totalPages, q.page);
    const base = await home(c);
    const meta = await termMeta(
      c,
      terms.map((t) => t.id),
    );
    return c.json(terms.map((t) => prepare(t, taxonomy, base, q.context, meta)));
  });

  app.get('/:id{[0-9]+}', async (c) => {
    const term = await c.get('kernel').terms.get(taxonomy.name, Number(c.req.param('id')));
    if (!term) return restError(c, 404, 'rest_term_invalid', 'Term does not exist.');
    const meta = await termMeta(c, [term.id]);
    return c.json(prepare(term, taxonomy, await home(c), c.req.query('context') ?? 'view', meta));
  });

  app.post('/', async (c) => {
    const kernel = c.get('kernel');
    // Hierarchical taxonomies need edit_terms; flat ones (tags) only assign_terms,
    // so writers can add new tags while editing — as in WordPress.
    const cap = taxonomy.hierarchical ? taxonomy.cap.edit_terms : taxonomy.cap.assign_terms;
    if (!userCan(c.get('user'), cap)) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_create',
        'Sorry, you are not allowed to create terms in this taxonomy.',
      );
    }
    const json = await readJson(c);
    const parsed = writeBody.safeParse(json);
    if (!parsed.success) return invalidParams(c, parsed.error);
    const metaWrites = parseRestMeta(c, 'term', taxonomy.name, (json as { meta?: unknown })?.meta);
    if (metaWrites instanceof Response) return metaWrites;
    if (!parsed.data.name) {
      return restError(c, 400, 'rest_missing_callback_param', 'Missing parameter(s): name', {
        params: { name: 'A name is required for this term.' },
      });
    }
    try {
      const term = await kernel.terms.insert(taxonomy.name, {
        ...parsed.data,
        name: parsed.data.name,
      });
      const denied = await authorizeRestMeta(c, 'term', term.id, metaWrites);
      if (denied) return denied;
      await writeRestMeta(kernel, 'term', term.id, metaWrites);
      c.header('Location', `/wp-json/wp/v2/${taxonomy.restBase}/${term.id}`);
      const meta = await termMeta(c, [term.id]);
      return c.json(prepare(term, taxonomy, await home(c), 'edit', meta), 201);
    } catch (error) {
      return serviceError(c, error);
    }
  });

  const update = async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    const id = Number(c.req.param('id'));
    if (!(await kernel.terms.get(taxonomy.name, id)))
      return restError(c, 404, 'rest_term_invalid', 'Term does not exist.');
    if (!(await currentUserCan(kernel, c.get('user'), 'edit_term', id))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_update',
        'Sorry, you are not allowed to edit this term.',
      );
    }
    const json = await readJson(c);
    const parsed = writeBody.safeParse(json);
    if (!parsed.success) return invalidParams(c, parsed.error);
    const metaWrites = parseRestMeta(c, 'term', taxonomy.name, (json as { meta?: unknown })?.meta);
    if (metaWrites instanceof Response) return metaWrites;
    const denied = await authorizeRestMeta(c, 'term', id, metaWrites);
    if (denied) return denied;
    try {
      const term = await kernel.terms.update(taxonomy.name, id, parsed.data);
      await writeRestMeta(kernel, 'term', id, metaWrites);
      const meta = await termMeta(c, [term.id]);
      return c.json(prepare(term, taxonomy, await home(c), 'edit', meta));
    } catch (error) {
      return serviceError(c, error);
    }
  };
  app.post('/:id{[0-9]+}', update);
  app.put('/:id{[0-9]+}', update);
  app.patch('/:id{[0-9]+}', update);

  app.delete('/:id{[0-9]+}', async (c) => {
    const kernel = c.get('kernel');
    const id = Number(c.req.param('id'));
    if (!(await kernel.terms.get(taxonomy.name, id)))
      return restError(c, 404, 'rest_term_invalid', 'Term does not exist.');
    if (!(await currentUserCan(kernel, c.get('user'), 'delete_term', id))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_delete',
        'Sorry, you are not allowed to delete this term.',
      );
    }
    const force = boolParam.safeParse(c.req.query('force') ?? 'false');
    if (!force.success || !force.data) {
      return restError(
        c,
        501,
        'rest_trash_not_supported',
        "Terms do not support trashing. Set 'force=true' to delete.",
      );
    }
    try {
      const term = await kernel.terms.delete(taxonomy.name, id);
      return c.json({ deleted: true, previous: prepare(term, taxonomy, await home(c), 'edit') });
    } catch (error) {
      return serviceError(c, error);
    }
  });

  return app;
}
