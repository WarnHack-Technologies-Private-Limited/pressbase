import {
  type AttributeSchema,
  type BlockType,
  type ParsedBlock,
  parseBlocks,
  sanitizeValueFromSchema,
  serializeBlocks,
  validateValueFromSchema,
} from '@pressbase/blocks';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { type CurrentUser, userCan } from '../auth/users';
import type { BlockServices } from '../blocks/helpers';
import type { BlockPattern } from '../blocks/patterns';
import { PATTERN_SYNC_STATUSES } from '../blocks/service';
import { type AppEnv, readJson, restError } from '../http';
import type { Kernel } from '../kernel';
import { postsRoutes } from './posts';
import { authStatus, contextParam } from './rest-util';

/**
 * The block editor's REST endpoints:
 * - /wp/v2/block-types — WP_REST_Block_Types_Controller
 * - /wp/v2/block-renderer/{name} — WP_REST_Block_Renderer_Controller (ServerSideRender)
 * - /wp/v2/block-patterns/patterns and /categories — WP_REST_Block_Patterns_Controller,
 *   WP_REST_Block_Pattern_Categories_Controller
 * - /wp/v2/blocks — synced patterns, WP_REST_Blocks_Controller
 * (all in wordpress/wp-includes/rest-api/endpoints/).
 */

/**
 * WP_REST_Block_Types_Controller::check_read_permission(): anyone who can edit
 * some post type may read the editor's registries.
 */
function canUseEditor(kernel: Kernel, user: CurrentUser | null): boolean {
  if (userCan(user, 'edit_posts')) return true;
  return kernel.postTypes.all().some((t) => t.showInRest && userCan(user, t.cap.edit_posts));
}

/* --------------------------------------------------------------- block types */

/** WP_REST_Block_Types_Controller::prepare_item_for_response() */
export function prepareBlockType(type: BlockType<BlockServices>): Record<string, unknown> {
  const [namespace] = type.name.split('/');
  const base = '/wp-json/wp/v2/block-types';
  const links: Record<string, unknown> = {
    collection: [{ href: base }],
    self: [{ href: `${base}/${type.name}` }],
    up: [{ href: `${base}/${namespace}` }],
  };
  if (type.isDynamic()) {
    links['https://api.w.org/render-block'] = [
      { href: `/wp-json/wp/v2/block-renderer/${type.name}?context=edit` },
    ];
  }
  return {
    attributes: type.attributes,
    is_dynamic: type.isDynamic(),
    api_version: type.apiVersion,
    name: type.name,
    title: type.title,
    description: type.description,
    icon: type.icon,
    category: type.category,
    keywords: type.keywords,
    parent: type.parent,
    ancestor: type.ancestor,
    allowed_blocks: type.allowedBlocks,
    provides_context: type.providesContext,
    uses_context: type.usesContext,
    selectors: type.selectors,
    supports: type.supports,
    styles: type.styles,
    textdomain: type.textdomain,
    example: type.example,
    editor_script_handles: [],
    script_handles: [],
    view_script_handles: [],
    view_script_module_ids: [],
    editor_style_handles: [],
    style_handles: [],
    view_style_handles: [],
    variations: type.variations,
    block_hooks: [],
    editor_script: null,
    script: null,
    view_script: null,
    editor_style: null,
    style: null,
    _links: links,
  };
}

function blockTypesRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  app.use(async (c, next) => {
    if (!canUseEditor(c.get('kernel'), c.get('user'))) {
      return restError(
        c,
        authStatus(c),
        'rest_block_type_cannot_view',
        'Sorry, you are not allowed to manage block types.',
      );
    }
    await next();
  });

  const list = (c: Context<AppEnv>, namespace?: string) => {
    const types = c
      .get('kernel')
      .blocks.registry.all()
      .filter((t) => !namespace || t.name.split('/')[0] === namespace);
    return c.json(types.map(prepareBlockType));
  };

  app.get('/', (c) => list(c, c.req.query('namespace') || undefined));
  app.get('/:namespace{[a-zA-Z0-9_-]+}', (c) => list(c, c.req.param('namespace')));
  app.get('/:namespace{[a-zA-Z0-9_-]+}/:name{[a-zA-Z0-9_-]+}', (c) => {
    const type = c
      .get('kernel')
      .blocks.registry.get(`${c.req.param('namespace')}/${c.req.param('name')}`);
    if (!type) return restError(c, 404, 'rest_block_type_invalid', 'Invalid block type.');
    return c.json(prepareBlockType(type));
  });
  return app;
}

/* ------------------------------------------------------------ block renderer */

/**
 * Bracketed query parameters as nested objects, the way PHP reads them:
 * `attributes[categories][0][id]=3` → { attributes: { categories: { 0: { id: '3' } } } }.
 */
export function nestedQuery(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    const match = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key);
    if (!match) continue;
    const path = [
      match[1] as string,
      ...[...(match[2] ?? '').matchAll(/\[([^[\]]*)\]/g)].map((m) => m[1] as string),
    ];
    let node: Record<string, unknown> = out;
    for (const [i, rawPart] of path.entries()) {
      // `a[]=x` appends.
      const part = rawPart === '' ? String(Object.keys(node).length) : rawPart;
      if (part === '__proto__' || part === 'constructor' || part === 'prototype') break;
      if (i === path.length - 1) {
        node[part] = value;
      } else {
        const next = node[part];
        if (!next || typeof next !== 'object') node[part] = {};
        node = node[part] as Record<string, unknown>;
      }
    }
  }
  return out;
}

const rendererParams = z.object({
  context: contextParam,
  post_id: z.coerce.number().int().optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
});

function blockRendererRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  const handler = async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const name = `${c.req.param('namespace')}/${c.req.param('name')}`;

    const query = nestedQuery(new URL(c.req.url));
    const body = c.req.method === 'POST' ? ((await readJson(c)) ?? {}) : {};
    const parsed = rendererParams.safeParse({
      ...query,
      ...(body && typeof body === 'object' ? body : {}),
    });
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'attributes');
      return restError(c, 400, 'rest_invalid_param', `Invalid parameter(s): ${field}`, {
        params: { [field]: parsed.error.issues[0]?.message ?? 'Invalid value.' },
      });
    }
    const params = parsed.data;

    // The attributes argument's validate and sanitize callbacks run first, as in WordPress.
    const type = kernel.blocks.registry.get(name);
    let attributes = params.attributes;
    if (type) {
      const attributeSchema: AttributeSchema = {
        type: 'object',
        properties: type.attributes,
        additionalProperties: false,
      };
      attributes = sanitizeValueFromSchema(attributes, attributeSchema) as Record<string, unknown>;
      const error = validateValueFromSchema(attributes, attributeSchema, 'attributes');
      if (error) {
        return restError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): attributes', {
          params: { attributes: error },
        });
      }
    }

    // get_item_permissions_check()
    const postId = params.post_id ?? 0;
    const post = postId > 0 ? await kernel.posts.get(postId) : undefined;
    if (postId > 0) {
      if (!post || !(await currentUserCan(kernel, user, 'edit_post', post.id))) {
        return restError(
          c,
          authStatus(c),
          'block_cannot_read',
          'Sorry, you are not allowed to read blocks of this post.',
        );
      }
    } else if (!userCan(user, 'edit_posts')) {
      return restError(
        c,
        authStatus(c),
        'block_cannot_read',
        'Sorry, you are not allowed to read blocks as this user.',
      );
    }

    if (!type?.isDynamic()) return restError(c, 404, 'block_invalid', 'Invalid block.');

    // A parse_blocks()-shaped block, rendered with render_block() so every filter runs.
    const block: ParsedBlock = {
      blockName: name,
      attrs: attributes,
      innerBlocks: [],
      innerHTML: '',
      innerContent: [],
    };
    const rendered = await kernel.blocks.renderBlock(block, {
      context: post ? kernel.blocks.contextFor(post) : {},
      user,
      rest: true,
    });
    return c.json({ rendered });
  };

  app.get('/:namespace{[a-z0-9-]+}/:name{[a-z0-9-]+}', handler);
  app.post('/:namespace{[a-z0-9-]+}/:name{[a-z0-9-]+}', handler);
  return app;
}

/* ------------------------------------------------------------ block patterns */

/**
 * resolve_pattern_blocks(): replaces core/pattern blocks with the registered
 * pattern's blocks so the editor doesn't have to; unknown patterns stay,
 * recursive ones are dropped.
 */
function resolvePatternBlocks(
  blocks: ParsedBlock[],
  patterns: Map<string, BlockPattern>,
  seen = new Set<string>(),
): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  for (const block of blocks) {
    if (block.blockName === 'core/pattern' && typeof block.attrs.slug === 'string') {
      const slug = block.attrs.slug;
      if (seen.has(slug)) continue;
      const pattern = patterns.get(slug);
      if (!pattern) {
        out.push(block);
        continue;
      }
      seen.add(slug);
      out.push(...resolvePatternBlocks(parseBlocks(pattern.content.trim()), patterns, seen));
      seen.delete(slug);
      continue;
    }
    out.push(
      block.innerBlocks.length
        ? { ...block, innerBlocks: resolvePatternBlocks(block.innerBlocks, patterns, seen) }
        : block,
    );
  }
  return out;
}

const PATTERN_FIELDS: [keyof BlockPattern, string][] = [
  ['name', 'name'],
  ['title', 'title'],
  ['content', 'content'],
  ['description', 'description'],
  ['viewportWidth', 'viewport_width'],
  ['inserter', 'inserter'],
  ['categories', 'categories'],
  ['keywords', 'keywords'],
  ['blockTypes', 'block_types'],
  ['postTypes', 'post_types'],
  ['templateTypes', 'template_types'],
  ['source', 'source'],
];

function blockPatternRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  const guard = (message: string) => async (c: Context<AppEnv>, next: () => Promise<void>) => {
    if (!canUseEditor(c.get('kernel'), c.get('user'))) {
      return restError(c, authStatus(c), 'rest_cannot_view', message);
    }
    await next();
  };

  app.get(
    '/patterns',
    guard('Sorry, you are not allowed to view the registered block patterns.'),
    (c) => {
      const all = c.get('kernel').blocks.patterns();
      const byName = new Map(all.map((p) => [p.name, p]));
      return c.json(
        all.map((pattern) => {
          const resolved = {
            ...pattern,
            content: serializeBlocks(resolvePatternBlocks(parseBlocks(pattern.content), byName)),
          };
          const item: Record<string, unknown> = {};
          for (const [key, restKey] of PATTERN_FIELDS) {
            if (resolved[key] !== undefined) item[restKey] = resolved[key];
          }
          return item;
        }),
      );
    },
  );

  app.get(
    '/categories',
    guard('Sorry, you are not allowed to view the registered block pattern categories.'),
    (c) =>
      c.json(
        c
          .get('kernel')
          .blocks.patternCategories()
          .map(({ name, label, description }) => ({
            name,
            label,
            ...(description !== undefined ? { description } : {}),
          })),
      ),
  );
  return app;
}

/* ----------------------------------------------------------- synced patterns */

/**
 * /wp/v2/blocks: the posts controller for `wp_block`, with
 * WP_REST_Blocks_Controller's differences — reading needs `read_post`
 * (edit_posts), and `meta.wp_pattern_sync_status` is validated here and saved
 * by the rest_insert_wp_block action (see blocks/service.ts).
 */
function syncedPatternRoutes(kernel: Kernel) {
  const type = kernel.postTypes.get('wp_block');
  const app = new Hono<AppEnv>({ strict: false });
  if (!type) return app;

  app.use(async (c, next) => {
    const user = c.get('user');
    if (c.req.method === 'GET' && !userCan(user, type.cap.read)) {
      // check_read_permission() fails for every pattern: lists come back empty.
      if (/\/blocks\/?$/.test(new URL(c.req.url).pathname)) {
        c.header('X-WP-Total', '0');
        c.header('X-WP-TotalPages', '0');
        return c.json([]);
      }
      return restError(
        c,
        authStatus(c),
        'rest_forbidden',
        'Sorry, you are not allowed to do that.',
      );
    }
    if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
      const body = (await readJson(c)) as { meta?: unknown } | undefined;
      const meta = body?.meta;
      if (
        meta !== undefined &&
        (typeof meta !== 'object' || meta === null || Array.isArray(meta))
      ) {
        return restError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): meta', {
          params: { meta: 'meta is not of type object.' },
        });
      }
      const sync = (meta as Record<string, unknown> | undefined)?.wp_pattern_sync_status;
      if (sync !== undefined && !(PATTERN_SYNC_STATUSES as readonly unknown[]).includes(sync)) {
        return restError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): meta', {
          params: {
            'meta.wp_pattern_sync_status':
              'meta[wp_pattern_sync_status] is not one of partial and unsynced.',
          },
        });
      }
    }
    await next();
  });
  app.route('/', postsRoutes(type));
  return app;
}

/** Everything above, for mounting at /wp/v2. */
export function blockRoutes(kernel: Kernel) {
  const app = new Hono<AppEnv>({ strict: false });
  app.route('/block-types', blockTypesRoutes());
  app.route('/block-renderer', blockRendererRoutes());
  app.route('/block-patterns', blockPatternRoutes());
  app.route('/blocks', syncedPatternRoutes(kernel));
  return app;
}
