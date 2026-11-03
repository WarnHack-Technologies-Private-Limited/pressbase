import { parseBlocks, serializeBlocks } from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { userCan } from '../auth/users';
import { createPostAutosave, getAutosave, listAutosaves } from '../content/autosaves';
import { toLocalString } from '../content/dates';
import type { Post } from '../content/posts';
import { type AppEnv, invalidParams, readJson, restError } from '../http';
import type { Kernel } from '../kernel';
import {
  type BlockTemplate,
  buildBlockTemplateResultFromPost,
  canEditTemplates,
  deleteBlockTemplate,
  getBlockFileTemplate,
  getBlockTemplate,
  getBlockTemplates,
  saveBlockTemplate,
  TEMPLATE_PART_POST_TYPE,
  TEMPLATE_POST_TYPE,
  type TemplateChanges,
  type TemplateType,
} from '../themes/templates';
import { resolvePatternBlocks } from './blocks';
import { authStatus, boolParam, contextParam, serviceError } from './rest-util';

/**
 * /wp/v2/templates and /wp/v2/template-parts — ports of
 * WP_REST_Templates_Controller, WP_REST_Template_Revisions_Controller and
 * WP_REST_Template_Autosaves_Controller
 * (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-template*-controller.php):
 *
 * - GET  /{base}                       every template of the active theme (customised copies first)
 * - POST /{base}                       a new custom template (`slug` required)
 * - GET  /{base}/{theme}//{slug}       one template; `?source=theme` gives the theme's file
 * - POST, PUT, PATCH /{base}/{id}      save: a theme file becomes a customised copy;
 *                                      `source: "theme"` deletes the copy (reset)
 * - DELETE /{base}/{id}                trash a custom template (`force` deletes it):
 *                                      for a customised copy, the theme's file is back
 * - GET  /{base}/{id}/revisions[/{n}], DELETE …/revisions/{n}?force=true
 * - GET, POST /{base}/{id}/autosaves, GET …/autosaves/{n}
 *
 * Reading needs edit_posts (or edit_posts of any REST post type); writing
 * needs edit_theme_options. IDs are `theme//slug`; `theme/slug` is accepted
 * and fixed (_sanitize_template_id()), and so is a URL-encoded id.
 */

declare module '@pressbase/hooks' {
  interface ActionRegistry {
    rest_after_insert_wp_template: [post: Post, body: unknown, creating: boolean];
    rest_after_insert_wp_template_part: [post: Post, body: unknown, creating: boolean];
  }
}

/** `content` and `title` accept a string or `{ raw }`, as in WordPress. */
const rawField = z
  .union([z.string(), z.object({ raw: z.string().optional() }).passthrough()])
  .transform((v) => (typeof v === 'string' ? v : v.raw));

/** get_endpoint_args_for_item_schema(): the writable fields. */
const itemBody = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_%-]+$/, 'Use letters, numbers, "_", "%" and "-" only.')
    .optional(),
  theme: z.string().min(1).optional(),
  type: z.string().optional(),
  content: rawField.optional(),
  title: z.union([z.string(), z.object({ raw: z.string().optional() }).passthrough()]).optional(),
  description: z.string().optional(),
  status: z.enum(['publish', 'future', 'draft', 'pending', 'private']).optional(),
  author: z.coerce.number().int().min(0).optional(),
  area: z.string().optional(),
  is_wp_suggestion: z.boolean().optional(),
  /** update_item() only: `theme` resets a customised copy. */
  source: z.string().optional(),
});
type ItemBody = z.infer<typeof itemBody>;

const listQuery = z.object({
  context: contextParam,
  wp_id: z.coerce.number().int().min(0).optional(),
  area: z.string().optional(),
  post_type: z.string().optional(),
});

const revisionsQuery = z.object({
  context: contextParam,
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

type ContextName = 'view' | 'edit' | 'embed';
type RestErrorResponse = ReturnType<typeof restError>;

/** _sanitize_template_id(): `theme/slug` becomes `theme//slug`. */
export function sanitizeTemplateId(id: string): string {
  const last = id.lastIndexOf('/');
  if (last < 0) return id;
  if (id[last - 1] === '/') return id;
  return `${id.slice(0, last)}/${id.slice(last)}`;
}

/** The path after `/wp/v2/{base}/`: a template id, and a revisions or autosaves suffix. */
function parseItemPath(
  raw: string,
): { id: string; sub?: 'revisions' | 'autosaves'; childId?: number } | undefined {
  let rest = raw;
  try {
    rest = decodeURIComponent(raw);
  } catch {
    // Keep the raw path.
  }
  rest = rest.replace(/\/+$/, '');
  if (!rest) return undefined;
  const sub = /^(.*[^/])\/(revisions|autosaves)(?:\/(\d+))?$/.exec(rest);
  if (sub) {
    return {
      id: sanitizeTemplateId(sub[1] as string),
      sub: sub[2] as 'revisions' | 'autosaves',
      ...(sub[3] ? { childId: Number(sub[3]) } : {}),
    };
  }
  return { id: sanitizeTemplateId(rest) };
}

/** Body fields → saveBlockTemplate() changes. */
function changesFrom(body: ItemBody): TemplateChanges {
  return {
    ...(body.content !== undefined ? { content: body.content } : {}),
    // A string title is taken as it is; `{ raw }` only when not empty, as WordPress does.
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.title === 'object' && body.title.raw ? { title: body.title.raw } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.area !== undefined ? { area: body.area } : {}),
    ...(body.author ? { author: body.author } : {}),
    ...(body.is_wp_suggestion !== undefined ? { isWpSuggestion: body.is_wp_suggestion } : {}),
    ...(body.theme !== undefined ? { theme: body.theme } : {}),
    ...(body.slug !== undefined ? { slug: body.slug } : {}),
  };
}

export function templatesRoutes(kernel: Kernel) {
  const app = new Hono<AppEnv>({ strict: false });

  const home = async () => (await kernel.options.get<string>('home', '')).replace(/\/+$/, '');

  /** get_items_permissions_check() / get_item_permissions_check() */
  const canRead = (c: Context<AppEnv>) => {
    const user = c.get('user');
    if (userCan(user, 'edit_posts')) return true;
    return kernel.postTypes
      .all()
      .some((type) => type.showInRest && userCan(user, type.cap.edit_posts));
  };
  const cannotManage = (c: Context<AppEnv>) =>
    restError(
      c,
      authStatus(c),
      'rest_cannot_manage_templates',
      'Sorry, you are not allowed to access the templates on this site.',
    );
  const notFound = (c: Context<AppEnv>) =>
    restError(c, 404, 'rest_template_not_found', 'No templates exist with that id.');
  const noRoute = (c: Context<AppEnv>) =>
    restError(c, 404, 'rest_no_route', 'No route was found matching the URL and request method.');

  /** get_wp_templates_original_source_field() */
  const originalSource = (t: BlockTemplate): 'theme' | 'plugin' | 'site' | 'user' => {
    if (
      t.hasThemeFile &&
      (t.origin === 'theme' || (!t.origin && ['theme', 'custom'].includes(t.source)))
    )
      return 'theme';
    if (t.origin === 'plugin') return 'plugin';
    if (!t.hasThemeFile && t.source === 'custom' && !t.author) return 'site';
    return 'user';
  };

  /** get_wp_templates_author_text_field() */
  const authorText = async (t: BlockTemplate): Promise<string> => {
    switch (originalSource(t)) {
      case 'theme': {
        const theme = await kernel.themes.get(t.theme);
        return theme?.name || t.theme;
      }
      case 'plugin':
        return t.theme;
      case 'site':
        return kernel.options.get<string>('blogname', '');
      default: {
        const [user] = t.author
          ? await kernel.db
              .select({ name: schema.users.displayName })
              .from(schema.users)
              .where(eq(schema.users.id, t.author))
          : [];
        return user ? user.name : kernel.i18n.__('Unknown author');
      }
    }
  };

  /** prepare_item_for_response() */
  const prepare = async (
    c: Context<AppEnv>,
    template: BlockTemplate,
    base: string,
    context: ContextName,
    extra: { parent?: number; links?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown>> => {
    // resolve_pattern_blocks(): core/pattern blocks become their content, so
    // the editor edits real blocks. Skipped when there are none (same result).
    let content = template.content;
    if (content.includes('<!-- wp:pattern ')) {
      const patterns = new Map(kernel.blocks.patterns().map((p) => [p.name, p]));
      content = serializeBlocks(resolvePatternBlocks(parseBlocks(content), patterns));
    }
    const timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
    const title = template.wpId
      ? String(await kernel.hooks.applyFilters('the_title', template.title, template.wpId))
      : template.title;
    const data: Record<string, unknown> = {
      id: template.id,
      theme: template.theme,
      content: {
        raw: content,
        ...(context === 'edit' ? { block_version: /<!-- wp:/.test(content) ? 1 : 0 } : {}),
      },
      slug: template.slug,
      source: template.source,
      origin: template.origin,
      type: template.type,
      description: template.description,
      title: { raw: template.title, rendered: title },
      status: template.status,
      wp_id: template.wpId ?? 0,
      has_theme_file: template.hasThemeFile,
      ...(template.type === TEMPLATE_POST_TYPE ? { is_custom: template.isCustom } : {}),
      author: template.author ?? 0,
      ...(template.type === TEMPLATE_PART_POST_TYPE ? { area: template.area } : {}),
      ...(context !== 'embed'
        ? {
            modified: template.modified ? toLocalString(template.modified, timeZone) : null,
            date: template.date ? toLocalString(template.date, timeZone) : null,
          }
        : {}),
      author_text: await authorText(template),
      original_source: originalSource(template),
      ...(extra.parent !== undefined ? { parent: extra.parent } : {}),
    };
    data._links = extra.links ?? (await itemLinks(c, template, base, context));
    return data;
  };

  /** prepare_links() + get_available_actions() */
  const itemLinks = async (
    c: Context<AppEnv>,
    template: BlockTemplate,
    base: string,
    context: ContextName,
  ) => {
    const root = `${await home()}/wp-json/wp/v2`;
    const self = `${root}/${base}/${template.id}`;
    const user = c.get('user');
    const canEdit = canEditTemplates(user);
    const links: Record<string, unknown> = {
      self: [
        {
          href: self,
          // What the user may do (WP 6.7+), so core-data skips an OPTIONS request.
          ...(context === 'edit'
            ? {
                targetHints: {
                  allow: canEdit ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : ['GET'],
                },
              }
            : {}),
        },
      ],
      collection: [{ href: `${root}/${base}` }],
      about: [{ href: `${root}/types/${template.type}` }],
    };
    if (template.wpId) {
      const revisions = await kernel.posts.revisions(template.wpId);
      links['version-history'] = [{ href: `${self}/revisions`, count: revisions.length }];
      const latest = revisions[0];
      if (latest) {
        links['predecessor-version'] = [{ href: `${self}/revisions/${latest.id}`, id: latest.id }];
      }
    }
    if (canEdit) links['wp:action-publish'] = [{ href: self }];
    if (userCan(user, 'unfiltered_html')) links['wp:action-unfiltered-html'] = [{ href: self }];
    return links;
  };

  /** A revision or autosave: the parent's template fields, plus `parent`. */
  const prepareChild = async (
    c: Context<AppEnv>,
    row: Post,
    base: string,
    sub: 'revisions' | 'autosaves',
    context: ContextName,
  ) => {
    const template = await buildBlockTemplateResultFromPost(kernel, row);
    if (!template) return undefined;
    const root = `${await home()}/wp-json/wp/v2/${base}/${template.id}`;
    return prepare(c, template, base, context, {
      parent: row.parentId ?? 0,
      links: { self: [{ href: `${root}/${sub}/${row.id}` }], parent: [{ href: root }] },
    });
  };

  /** The JSON body (empty when there is none), or the error to answer with. */
  const json = async (
    c: Context<AppEnv>,
  ): Promise<{ body: Record<string, unknown> } | { error: RestErrorResponse }> => {
    const body = await readJson(c);
    if (body === undefined) return { body: {} };
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return {
        error: restError(c, 400, 'rest_invalid_json', 'The request body must be a JSON object.'),
      };
    }
    return { body: body as Record<string, unknown> };
  };

  for (const type of [TEMPLATE_POST_TYPE, TEMPLATE_PART_POST_TYPE] as TemplateType[]) {
    const base = kernel.postTypes.get(type)?.restBase ?? type;
    const collection = `/wp/v2/${base}`;

    /* ---------------------------------------------------------- list */

    app.get(collection, async (c) => {
      if (!canRead(c)) return cannotManage(c);
      const parsed = listQuery.safeParse(c.req.query());
      if (!parsed.success) return invalidParams(c, parsed.error);
      const { context, wp_id, area, post_type } = parsed.data;
      const templates = await getBlockTemplates(
        kernel,
        {
          ...(wp_id !== undefined ? { wp_id } : {}),
          ...(area !== undefined ? { area } : {}),
          ...(post_type !== undefined ? { post_type } : {}),
        },
        type,
      );
      const out = [];
      for (const template of templates) out.push(await prepare(c, template, base, context));
      return c.json(out);
    });

    /* -------------------------------------------------------- create */

    app.post(collection, async (c) => {
      if (!canEditTemplates(c.get('user'))) return cannotManage(c);
      const read = await json(c);
      if ('error' in read) return read.error;
      const body = read.body;
      const parsed = itemBody.safeParse(body);
      if (!parsed.success) return invalidParams(c, parsed.error);
      if (!parsed.data.slug) {
        return restError(c, 400, 'rest_missing_callback_param', 'Missing parameter(s): slug', {
          params: ['slug'],
        });
      }
      const user = c.get('user');
      try {
        const { template } = await saveBlockTemplate(kernel, type, null, changesFrom(parsed.data), {
          userId: user?.id,
          filterHtml: !userCan(user, 'unfiltered_html'),
        });
        const post = template.wpId ? await kernel.posts.get(template.wpId) : undefined;
        if (post) await kernel.hooks.doAction(`rest_after_insert_${type}`, post, body, true);
        const data = await prepare(c, template, base, 'edit');
        c.header('Location', `${await home()}/wp-json/wp/v2/${base}/${template.id}`);
        return c.json(data, 201);
      } catch (error) {
        return serviceError(c, error);
      }
    });

    /* ----------------------------------------- one template and below */

    app.all(`${collection}/*`, async (c) => {
      const prefix = `${collection}/`;
      const path = c.req.path;
      const parsedPath = parseItemPath(path.slice(path.indexOf(prefix) + prefix.length));
      if (!parsedPath) return noRoute(c);
      const { id, sub, childId } = parsedPath;
      const method = c.req.method;
      if (!sub) {
        if (method === 'GET') return getItem(c, id);
        if (['POST', 'PUT', 'PATCH'].includes(method)) return updateItem(c, id);
        if (method === 'DELETE') return deleteItem(c, id);
        return noRoute(c);
      }
      if (sub === 'revisions') {
        if (method === 'GET' && childId === undefined) return listRevisions(c, id);
        if (method === 'GET') return getRevision(c, id, childId as number);
        if (method === 'DELETE' && childId !== undefined) return deleteRevision(c, id, childId);
        return noRoute(c);
      }
      if (method === 'GET' && childId === undefined) return listAutosavesOf(c, id);
      if (method === 'GET') return getAutosaveOf(c, id);
      if (method === 'POST' && childId === undefined) return createAutosave(c, id);
      return noRoute(c);
    });

    /** get_item() */
    const getItem = async (c: Context<AppEnv>, id: string) => {
      if (!canRead(c)) return cannotManage(c);
      const parsed = z
        .object({ context: contextParam, source: z.string().optional() })
        .safeParse(c.req.query());
      if (!parsed.success) return invalidParams(c, parsed.error);
      const { context, source } = parsed.data;
      const template =
        source === 'theme' || source === 'plugin'
          ? await getBlockFileTemplate(kernel, id, type)
          : await getBlockTemplate(kernel, id, type);
      if (!template) return notFound(c);
      return c.json(await prepare(c, template, base, context));
    };

    /** update_item() */
    const updateItem = async (c: Context<AppEnv>, id: string) => {
      const user = c.get('user');
      if (!canEditTemplates(user)) return cannotManage(c);
      const read = await json(c);
      if ('error' in read) return read.error;
      const body = read.body;
      const parsed = itemBody.safeParse(body);
      if (!parsed.success) return invalidParams(c, parsed.error);
      const template = await getBlockTemplate(kernel, id, type);
      if (!template) return notFound(c);
      try {
        // `source: theme`: back to the theme's file, the customised copy deleted.
        if (parsed.data.source === 'theme') {
          if (template.source === 'custom' && template.wpId) {
            await kernel.posts.delete(template.wpId);
          }
          const reset = await getBlockTemplate(kernel, id, type);
          if (!reset) return notFound(c);
          return c.json(await prepare(c, reset, base, 'edit'));
        }
        const { template: saved, created } = await saveBlockTemplate(
          kernel,
          type,
          id,
          changesFrom({ ...parsed.data, slug: undefined, theme: undefined }),
          { userId: user?.id, filterHtml: !userCan(user, 'unfiltered_html') },
        );
        const post = saved.wpId ? await kernel.posts.get(saved.wpId) : undefined;
        if (post) await kernel.hooks.doAction(`rest_after_insert_${type}`, post, body, created);
        return c.json(await prepare(c, saved, base, 'edit'));
      } catch (error) {
        return serviceError(c, error);
      }
    };

    /** delete_item(): a customised copy goes, and the theme's file shows again. */
    const deleteItem = async (c: Context<AppEnv>, id: string) => {
      if (!canEditTemplates(c.get('user'))) return cannotManage(c);
      const read = await json(c);
      if ('error' in read) return read.error;
      const body = read.body;
      const force = boolParam.safeParse(c.req.query('force') ?? body.force ?? false);
      if (!force.success) return invalidParams(c, force.error);
      try {
        const { template, deleted } = await deleteBlockTemplate(kernel, type, id, force.data);
        const data = await prepare(c, template, base, 'edit');
        return c.json(deleted ? { deleted: true, previous: data } : data);
      } catch (error) {
        return serviceError(c, error);
      }
    };

    /**
     * WP_REST_Template_Revisions_Controller::get_parent(): the template's post,
     * with the revisions controller's permission check (edit_post).
     */
    const loadParent = async (
      c: Context<AppEnv>,
      id: string,
      denied: string,
    ): Promise<{ post: Post } | { error: RestErrorResponse }> => {
      const template = await getBlockTemplate(kernel, id, type);
      if (!template) {
        return {
          error: restError(c, 404, 'rest_post_invalid_parent', 'Invalid template parent ID.'),
        };
      }
      const post = template.wpId ? await kernel.posts.get(template.wpId) : undefined;
      if (!post) {
        return {
          error: restError(
            c,
            400,
            'rest_invalid_template',
            "Templates based on theme files can't have revisions.",
          ),
        };
      }
      if (!(await currentUserCan(kernel, c.get('user'), 'edit_post', post.id))) {
        return { error: restError(c, authStatus(c), 'rest_cannot_read', denied) };
      }
      return { post };
    };
    const revisionsDenied = 'Sorry, you are not allowed to view revisions of this post.';
    const autosavesDenied = 'Sorry, you are not allowed to view autosaves of this post.';

    /** WP_REST_Revisions_Controller::get_items() */
    const listRevisions = async (c: Context<AppEnv>, id: string) => {
      const loaded = await loadParent(c, id, revisionsDenied);
      if ('error' in loaded) return loaded.error;
      const parent = loaded.post;
      const query = revisionsQuery.safeParse(c.req.query());
      if (!query.success) return invalidParams(c, query.error);
      const { page, per_page: perPage, offset, context } = query.data;
      const all = await kernel.posts.revisions(parent.id);
      const total = all.length;
      const size = perPage ?? total;
      const start = offset ?? (page - 1) * size;
      const totalPages = size > 0 ? Math.ceil(total / size) : total > 0 ? 1 : 0;
      if (total > 0 && offset !== undefined && offset >= total) {
        return restError(
          c,
          400,
          'rest_revision_invalid_offset_number',
          'The offset number requested is larger than or equal to the number of available revisions.',
        );
      }
      if (total > 0 && offset === undefined && page > totalPages) {
        return restError(
          c,
          400,
          'rest_revision_invalid_page_number',
          'The page number requested is larger than the number of pages available.',
        );
      }
      c.header('X-WP-Total', String(total));
      c.header('X-WP-TotalPages', String(totalPages));
      const out = [];
      for (const row of all.slice(start, start + (size || total))) {
        const item = await prepareChild(c, row, base, 'revisions', context);
        if (item) out.push(item);
      }
      return c.json(out);
    };

    /** get_revision(): a revision of this parent. */
    const loadRevision = async (
      c: Context<AppEnv>,
      parent: Post,
      revisionId: number,
    ): Promise<{ revision: Post } | { error: RestErrorResponse }> => {
      const revision = await kernel.posts.get(revisionId);
      if (revision?.type !== 'revision') {
        return { error: restError(c, 404, 'rest_post_invalid_id', 'Invalid revision ID.') };
      }
      if (revision.parentId !== parent.id) {
        return {
          error: restError(
            c,
            404,
            'rest_revision_parent_id_mismatch',
            `The revision does not belong to the specified parent with id of "${parent.id}"`,
          ),
        };
      }
      return { revision };
    };

    /** WP_REST_Revisions_Controller::get_item() */
    const getRevision = async (c: Context<AppEnv>, id: string, revisionId: number) => {
      const loaded = await loadParent(c, id, revisionsDenied);
      if ('error' in loaded) return loaded.error;
      const parent = loaded.post;
      const query = z.object({ context: contextParam }).safeParse(c.req.query());
      if (!query.success) return invalidParams(c, query.error);
      const found = await loadRevision(c, parent, revisionId);
      if ('error' in found) return found.error;
      const revision = found.revision;
      const item = await prepareChild(c, revision, base, 'revisions', query.data.context);
      return item ? c.json(item) : notFound(c);
    };

    /** WP_REST_Template_Revisions_Controller::delete_item(): `force` is required. */
    const deleteRevision = async (c: Context<AppEnv>, id: string, revisionId: number) => {
      const loaded = await loadParent(c, id, revisionsDenied);
      if ('error' in loaded) return loaded.error;
      const parent = loaded.post;
      const user = c.get('user');
      if (
        !(await currentUserCan(kernel, user, 'delete_post', parent.id)) ||
        !canEditTemplates(user)
      ) {
        return restError(
          c,
          authStatus(c),
          'rest_cannot_delete',
          'Sorry, you are not allowed to delete this revision.',
        );
      }
      const found = await loadRevision(c, parent, revisionId);
      if ('error' in found) return found.error;
      const revision = found.revision;
      const force = boolParam.safeParse(c.req.query('force') ?? false);
      if (!force.success) return invalidParams(c, force.error);
      if (!force.data) {
        return restError(
          c,
          501,
          'rest_trash_not_supported',
          "Revisions do not support trashing. Set 'force' to true to delete.",
        );
      }
      const previous = await prepareChild(c, revision, base, 'revisions', 'edit');
      await kernel.posts.delete(revision.id);
      return c.json({ deleted: true, previous });
    };

    /** WP_REST_Autosaves_Controller::get_items() */
    const listAutosavesOf = async (c: Context<AppEnv>, id: string) => {
      const loaded = await loadParent(c, id, autosavesDenied);
      if ('error' in loaded) return loaded.error;
      const parent = loaded.post;
      const query = z.object({ context: contextParam }).safeParse(c.req.query());
      if (!query.success) return invalidParams(c, query.error);
      const out = [];
      for (const row of await listAutosaves(kernel, parent.id)) {
        const item = await prepareChild(c, row, base, 'autosaves', query.data.context);
        if (item) out.push(item);
      }
      return c.json(out);
    };

    /** WP_REST_Template_Autosaves_Controller::get_item(): the newest autosave. */
    const getAutosaveOf = async (c: Context<AppEnv>, id: string) => {
      const loaded = await loadParent(c, id, revisionsDenied);
      if ('error' in loaded) return loaded.error;
      const parent = loaded.post;
      const query = z.object({ context: contextParam }).safeParse(c.req.query());
      if (!query.success) return invalidParams(c, query.error);
      const autosave = await getAutosave(kernel, parent.id);
      if (!autosave) {
        return restError(
          c,
          404,
          'rest_post_no_autosave',
          'There is no autosave revision for this template.',
        );
      }
      const item = await prepareChild(c, autosave, base, 'autosaves', query.data.context);
      return item ? c.json(item) : notFound(c);
    };

    /**
     * WP_REST_Autosaves_Controller::create_item(): the author's own draft is
     * updated directly; a published template keeps the user's autosave revision.
     */
    const createAutosave = async (c: Context<AppEnv>, id: string) => {
      const user = c.get('user');
      if (!user || !canEditTemplates(user)) return cannotManage(c);
      const loaded = await loadParent(c, id, autosavesDenied);
      if ('error' in loaded) return loaded.error;
      const parent = loaded.post;
      const read = await json(c);
      if ('error' in read) return read.error;
      const body = read.body;
      const parsed = itemBody.safeParse(body);
      if (!parsed.success) return invalidParams(c, parsed.error);
      const changes = changesFrom(parsed.data);
      const fields = {
        ...(changes.title !== undefined ? { title: changes.title } : {}),
        ...(changes.content !== undefined ? { content: changes.content } : {}),
        ...(changes.description !== undefined ? { excerpt: changes.description } : {}),
      };
      const filterHtml = !userCan(user, 'unfiltered_html');
      try {
        const isDraft = parent.status === 'draft' || parent.status === 'auto-draft';
        const row =
          isDraft && parent.authorId === user.id
            ? await kernel.posts.update(parent.id, { ...fields, filterHtml, saveRevision: false })
            : await createPostAutosave(kernel, parent, user.id, { ...fields, filterHtml });
        const item = await prepareChild(c, row, base, 'autosaves', 'edit');
        return item ? c.json(item) : notFound(c);
      } catch (error) {
        return serviceError(c, error);
      }
    };
  }

  return app;
}
