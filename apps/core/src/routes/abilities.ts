import { sanitizeValueFromSchema } from '@pressbase/blocks';
import { type Context, Hono } from 'hono';
import { prepareJsonSchemaForClient } from '../abilities/json-schema';
import { type Ability, type AbilityCategory, AbilityError } from '../abilities/registry';
import { type AppEnv, readJson, requireCapability, restError } from '../http';
import { nestedQuery } from './blocks';

/**
 * The Abilities API's REST routes, at WordPress's `/wp-abilities/v1`:
 * WP_REST_Abilities_V1_Categories_Controller, WP_REST_Abilities_V1_List_Controller
 * and WP_REST_Abilities_V1_Run_Controller (wp-includes/rest-api/endpoints/).
 *
 * - `GET /categories`, `GET /categories/{slug}`: logged-in users (`read`).
 * - `GET /abilities` (`category`, `namespace`, `page`, `per_page`),
 *   `GET /abilities/{namespace}/{name}`: logged-in users; only abilities with
 *   `showInRest` (or `public`).
 * - `/abilities/{namespace}/{name}/run`: read-only abilities answer GET (input
 *   in `?input=`), destructive idempotent ones DELETE, the rest POST (input in
 *   the JSON body's `input`). The ability's own permission callback decides
 *   who may run it; input is validated before it is asked.
 */

const BASE = '/wp-json/wp-abilities/v1';

function page(c: Context<AppEnv>): { page: number; perPage: number } | string {
  const pageParam = c.req.query('page') ?? '1';
  const perPageParam = c.req.query('per_page') ?? '50';
  const p = Number(pageParam);
  const perPage = Number(perPageParam);
  if (!Number.isInteger(p) || p < 1) return 'page';
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) return 'per_page';
  return { page: p, perPage };
}

function paginate<T>(c: Context<AppEnv>, items: T[], map: (item: T) => unknown) {
  const paging = page(c);
  if (typeof paging === 'string') {
    return restError(c, 400, 'rest_invalid_param', `Invalid parameter(s): ${paging}`, {
      params: { [paging]: `${paging} must be a whole number in range.` },
    });
  }
  const total = items.length;
  const pages = Math.ceil(total / paging.perPage);
  c.header('X-WP-Total', String(total));
  c.header('X-WP-TotalPages', String(pages));
  if (c.req.method === 'HEAD') return c.json([]);
  const offset = (paging.page - 1) * paging.perPage;
  return c.json(items.slice(offset, offset + paging.perPage).map(map));
}

function prepareCategory(category: AbilityCategory) {
  return {
    slug: category.slug,
    label: category.label,
    description: category.description,
    meta: category.meta,
    _links: {
      self: [{ href: `${BASE}/categories/${category.slug}` }],
      collection: [{ href: `${BASE}/categories` }],
      abilities: [{ href: `${BASE}/abilities?category=${category.slug}` }],
    },
  };
}

/** The `meta` REST shows: WordPress's snake_case `show_in_rest`. */
function restMeta(ability: Ability): Record<string, unknown> {
  const { showInRest, ...rest } = ability.meta;
  return { ...rest, show_in_rest: showInRest };
}

function prepareAbility(ability: Ability) {
  return {
    name: ability.name,
    label: ability.label,
    description: ability.description,
    category: ability.category,
    input_schema: prepareJsonSchemaForClient(ability.inputSchema),
    output_schema: prepareJsonSchemaForClient(ability.outputSchema),
    meta: restMeta(ability),
    _links: {
      self: [{ href: `${BASE}/abilities/${ability.name}` }],
      collection: [{ href: `${BASE}/abilities` }],
      'wp:action-run': [{ href: `${BASE}/abilities/${ability.name}/run` }],
    },
  };
}

const notFound = (c: Context<AppEnv>) =>
  restError(c, 404, 'rest_ability_not_found', 'Ability not found.');

/** The REST-visible ability named by the route, or undefined. */
function routeAbility(c: Context<AppEnv>): Ability | undefined {
  const name = `${c.req.param('namespace')}/${c.req.param('ability')}`;
  const ability = c.get('kernel').abilities.get(name);
  return ability?.meta.showInRest ? ability : undefined;
}

/** WP_REST_Abilities_V1_Run_Controller::validate_request_method() */
function expectedMethod(ability: Ability): 'GET' | 'POST' | 'DELETE' {
  const { readonly, destructive, idempotent } = ability.meta.annotations;
  if (readonly) return 'GET';
  if (destructive && idempotent) return 'DELETE';
  return 'POST';
}

/** get_input_from_request(): `?input=` for GET and DELETE, the JSON body's `input` otherwise. */
async function requestInput(c: Context<AppEnv>, ability: Ability): Promise<unknown> {
  if (c.req.method === 'GET' || c.req.method === 'DELETE') {
    let input = nestedQuery(new URL(c.req.url)).input;
    if (typeof input === 'string' && /^\s*[[{]/.test(input)) {
      try {
        input = JSON.parse(input);
      } catch {
        // Left as text: validation reports it.
      }
    }
    // Query strings carry text: coerce to the schema's types (sanitize_input_for_ability()).
    if (input !== undefined && Object.keys(ability.inputSchema).length) {
      input = sanitizeValueFromSchema(input, ability.inputSchema as never);
    }
    return input ?? null;
  }
  const body = await readJson(c);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return (body as { input?: unknown }).input ?? null;
  }
  return null;
}

function abilityError(c: Context<AppEnv>, error: unknown, fallbackStatus = 500) {
  if (error instanceof AbilityError) {
    return restError(c, (error.status ?? fallbackStatus) as 500, error.code, error.message, {
      ...(error.data ?? {}),
    });
  }
  throw error;
}

export function abilitiesRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  app.get('/categories', requireCapability('read'), (c) =>
    paginate(c, c.get('kernel').abilities.categories(), prepareCategory),
  );

  app.get('/categories/:slug{[a-z0-9]+(?:-[a-z0-9]+)*}', requireCapability('read'), (c) => {
    const category = c.get('kernel').abilities.category(c.req.param('slug'));
    if (!category) {
      return restError(c, 404, 'rest_ability_category_not_found', 'Ability category not found.');
    }
    return c.json(prepareCategory(category));
  });

  app.get('/abilities', requireCapability('read'), (c) => {
    const abilities = c.get('kernel').abilities.all({
      category: c.req.query('category') || undefined,
      namespace: c.req.query('namespace') || undefined,
      // Forced, so a caller can't reveal abilities hidden from REST.
      meta: { showInRest: true },
    });
    return paginate(c, abilities, prepareAbility);
  });

  app.get(
    '/abilities/:namespace{[a-z0-9-]+}/:ability{[a-z0-9-]+}',
    requireCapability('read'),
    (c) => {
      const ability = routeAbility(c);
      return ability ? c.json(prepareAbility(ability)) : notFound(c);
    },
  );

  // WordPress registers every method and checks the ability's annotations.
  app.all('/abilities/:namespace{[a-z0-9-]+}/:ability{[a-z0-9-]+}/run', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const ability = routeAbility(c);
    if (!ability) return notFound(c);

    const expected = expectedMethod(ability);
    if (c.req.method !== expected) {
      const message =
        expected === 'GET'
          ? 'Read-only abilities require GET method.'
          : expected === 'DELETE'
            ? 'Abilities that perform destructive actions require DELETE method.'
            : 'Abilities that perform updates require POST method.';
      return restError(c, 405, 'rest_ability_invalid_method', message);
    }

    // check_ability_permissions(): validate first, then ask the ability.
    const context = kernel.abilities.context(user, 'rest');
    let input: unknown;
    try {
      input = await ability.normalizeInput(await requestInput(c, ability));
      await ability.validateInput(input);
    } catch (error) {
      return abilityError(c, error, 400);
    }
    const permitted = await ability.checkPermissions(input, context);
    const denied = user ? 403 : 401;
    if (permitted instanceof AbilityError) {
      return restError(c, denied, permitted.code, permitted.message);
    }
    if (!permitted) {
      return restError(
        c,
        denied,
        'rest_ability_cannot_execute',
        'Sorry, you are not allowed to execute this ability.',
      );
    }

    try {
      const result = await ability.execute(input, context);
      return c.json((result ?? null) as never);
    } catch (error) {
      return abilityError(c, error);
    }
  });

  return app;
}
