import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { type CurrentUser, userCan } from '../auth/users';
import { parseRestDate, toGmtString, toLocalString } from '../content/dates';
import { type PermalinkContext, permalink, permalinkContext } from '../content/permalinks';
import type { PostType } from '../content/post-types';
import type { Post, PostInput } from '../content/posts';
import { type OrderBy, type QueryArgs, queryPosts, type TaxQueryClause } from '../content/query';
import { renderBlocksAsStatic, stripTags } from '../content/sanitize';
import { type AppEnv, invalidParams, readJson, restError } from '../http';
import type { Kernel } from '../kernel';
import { featuredMediaIds, isValidFeaturedMedia, setFeaturedMedia } from '../media/featured';
import { authorizeRestMeta, parseRestMeta, readRestMeta, writeRestMeta } from './meta-fields';
import {
  authStatus,
  boolParam,
  contextParam,
  intList,
  pageParam,
  perPageParam,
  queryObject,
  rawText,
  serviceError,
  setPaginationHeaders,
  stringList,
} from './rest-util';

/**
 * /wp/v2/posts, /wp/v2/pages — a port of WP_REST_Posts_Controller
 * (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-posts-controller.php).
 * Field names, parameters, status codes and error codes follow WordPress.
 *
 * Filter `rest_prepare_{type}` (response, post, context) can change each item.
 */

type RestContext = 'view' | 'edit' | 'embed';

const EDITABLE_STATUSES = ['publish', 'future', 'draft', 'pending', 'private'] as const;

interface Prepared {
  kernel: Kernel;
  type: PostType;
  user: CurrentUser | null;
  context: RestContext;
  timeZone: string;
  links: PermalinkContext;
  terms: Map<string, Map<number, number[]>>;
  sticky: Set<number>;
  /** Featured image (_thumbnail_id) per post. */
  thumbnails: Map<number, number>;
  /** Registered meta shown in REST (routes/meta-fields.ts), when the type supports custom fields. */
  meta: Map<number, Record<string, unknown>> | undefined;
  password?: string;
}

async function prepareContext(
  kernel: Kernel,
  type: PostType,
  user: CurrentUser | null,
  context: RestContext,
  posts: Post[],
  password?: string,
): Promise<Prepared> {
  const ids = posts.map((p) => p.id);
  const terms = new Map<string, Map<number, number[]>>();
  for (const taxonomy of kernel.taxonomies.forObjectType(type.name)) {
    if (taxonomy.showInRest)
      terms.set(taxonomy.name, await kernel.terms.objectTermIds(ids, taxonomy.name));
  }
  const sticky = new Set(
    type.name === 'post' ? await kernel.options.get<number[]>('sticky_posts', []) : [],
  );
  return {
    kernel,
    type,
    user,
    context,
    timeZone: await kernel.options.get<string>('timezone_string', 'UTC'),
    links: await permalinkContext(kernel),
    terms,
    sticky,
    thumbnails: await featuredMediaIds(kernel, ids),
    meta: type.supports.has('custom-fields')
      ? await readRestMeta(kernel, 'post', type.name, ids)
      : undefined,
    password,
  };
}

/** wp_trim_excerpt(): the first 55 words of the content, tags removed. */
function autoExcerpt(content: string): string {
  const words = stripTags(renderBlocksAsStatic(content)).split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const more = words.length > 55 ? ' [&hellip;]' : '';
  return `<p>${words.slice(0, 55).join(' ')}${more}</p>\n`;
}

async function prepareItem(post: Post, p: Prepared): Promise<Record<string, unknown>> {
  const { kernel, type, context } = p;
  const edit = context === 'edit';
  const canEdit = await currentUserCan(kernel, p.user, 'edit_post', post.id);
  const isProtected = post.password !== '';
  const unlocked = !isProtected || canEdit || p.password === post.password;
  const link = await permalink(kernel, post, p.links);

  const item: Record<string, unknown> = {
    id: post.id,
    date: toLocalString(post.date, p.timeZone),
    date_gmt: toGmtString(post.date),
    guid: edit ? { rendered: post.guid, raw: post.guid } : { rendered: post.guid },
    modified: toLocalString(post.modified, p.timeZone),
    modified_gmt: toGmtString(post.modified),
    slug: post.slug,
    status: post.status,
    type: post.type,
    link,
    title: edit ? { raw: post.title, rendered: post.title } : { rendered: post.title },
    content: {
      ...(edit ? { raw: post.content } : {}),
      // the_content → do_blocks(): dynamic blocks render with this post as context.
      rendered: unlocked
        ? await kernel.blocks.render(post.content, {
            context: kernel.blocks.contextFor(post),
            user: p.user,
            rest: true,
          })
        : '',
      protected: isProtected,
      block_version: /<!-- wp:/.test(post.content) ? 1 : 0,
    },
    excerpt: {
      ...(edit ? { raw: post.excerpt } : {}),
      rendered: unlocked
        ? post.excerpt
          ? `<p>${post.excerpt}</p>\n`
          : autoExcerpt(post.content)
        : '',
      protected: isProtected,
    },
    author: post.authorId ?? 0,
    ...(type.supports.has('thumbnail') ? { featured_media: p.thumbnails.get(post.id) ?? 0 } : {}),
    comment_status: post.commentStatus,
    ping_status: post.pingStatus,
    template: '',
    meta: p.meta?.get(post.id) ?? {},
  };
  if (type.hierarchical) {
    item.parent = post.parentId ?? 0;
  }
  if (type.supports.has('page-attributes')) item.menu_order = post.menuOrder;
  if (type.name === 'post') {
    item.sticky = p.sticky.has(post.id);
    item.format = 'standard';
  }
  for (const taxonomy of kernel.taxonomies.forObjectType(type.name)) {
    const ids = p.terms.get(taxonomy.name)?.get(post.id);
    if (ids) item[taxonomy.restBase] = ids;
  }
  if (edit) {
    item.password = post.password;
    item.permalink_template = link;
    item.generated_slug = post.slug;
  }
  item._links = {
    self: [
      {
        href: `/wp-json/wp/v2/${type.restBase}/${post.id}`,
        // What the user may do with it (WP 6.7+), so core-data skips an OPTIONS request.
        ...(edit ? { targetHints: { allow: await itemMethods(kernel, p.user, post) } } : {}),
      },
    ],
    collection: [{ href: `/wp-json/wp/v2/${type.restBase}` }],
    about: [{ href: `/wp-json/wp/v2/types/${type.name}` }],
    ...(post.authorId
      ? { author: [{ embeddable: true, href: `/wp-json/wp/v2/users/${post.authorId}` }] }
      : {}),
    'version-history': [{ href: `/wp-json/wp/v2/${type.restBase}/${post.id}/revisions` }],
  };

  if (context === 'embed') {
    const { id, date, slug, type: t, link: l, title, author, excerpt, _links } = item;
    return { id, date, slug, type: t, link: l, title, author, excerpt, _links };
  }
  return (await kernel.hooks.applyFilters(
    `rest_prepare_${type.name}`,
    item,
    post,
    context,
  )) as Record<string, unknown>;
}

/**
 * The methods a user may use on one post, as rest_send_allow_header() lists
 * them in `Allow` (core-data's canUser() reads it).
 */
async function itemMethods(
  kernel: Kernel,
  user: CurrentUser | null,
  post: Post,
): Promise<string[]> {
  const methods = ['GET'];
  if (await currentUserCan(kernel, user, 'edit_post', post.id))
    methods.push('POST', 'PUT', 'PATCH');
  if (await currentUserCan(kernel, user, 'delete_post', post.id)) methods.push('DELETE');
  return methods;
}

/** Prepares one post as the controller answers it (for other controllers that embed posts). */
export async function preparePost(
  kernel: Kernel,
  type: PostType,
  user: CurrentUser | null,
  post: Post,
  context: RestContext,
): Promise<Record<string, unknown>> {
  return prepareItem(post, await prepareContext(kernel, type, user, context, [post]));
}

/** WP_REST_Posts_Controller::check_read_permission() */
async function canRead(kernel: Kernel, user: CurrentUser | null, post: Post): Promise<boolean> {
  if (post.status === 'publish') return true;
  return currentUserCan(kernel, user, 'read_post', post.id);
}

const COLLECTION_ARRAYS = [
  'author',
  'author_exclude',
  'include',
  'exclude',
  'slug',
  'status',
  'parent',
  'parent_exclude',
] as const;

function collectionSchema(type: PostType) {
  const orderby: [string, ...string[]] = [
    'author',
    'date',
    'id',
    'include',
    'modified',
    'parent',
    'relevance',
    'slug',
    'include_slugs',
    'title',
  ];
  if (type.supports.has('page-attributes')) orderby.push('menu_order');
  return z.object({
    context: contextParam,
    page: pageParam,
    per_page: perPageParam,
    search: z.string().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
    modified_after: z.string().optional(),
    modified_before: z.string().optional(),
    author: intList,
    author_exclude: intList,
    include: intList,
    exclude: intList,
    offset: z.coerce.number().int().min(0).optional(),
    order: z.enum(['asc', 'desc']).default('desc'),
    orderby: z.enum(orderby).default('date'),
    slug: stringList,
    status: z.array(z.enum([...EDITABLE_STATUSES, 'trash', 'any'])).default(['publish']),
    tax_relation: z.enum(['AND', 'OR']).optional(),
    sticky: boolParam.optional(),
    parent: intList,
    parent_exclude: intList,
    menu_order: z.coerce.number().int().optional(),
    password: z.string().optional(),
  });
}

/** The fields a create or update accepts (also used by `pressbase post create|update`). */
export function postBodySchema() {
  return z.object({
    date: z.string().nullable().optional(),
    date_gmt: z.string().nullable().optional(),
    slug: z.string().max(200).optional(),
    status: z.enum(EDITABLE_STATUSES).optional(),
    password: z.string().max(255).optional(),
    title: rawText.optional(),
    content: rawText.optional(),
    excerpt: rawText.optional(),
    author: z.number().int().min(1).optional(),
    comment_status: z.enum(['open', 'closed']).optional(),
    ping_status: z.enum(['open', 'closed']).optional(),
    sticky: z.boolean().optional(),
    parent: z.number().int().min(0).optional(),
    menu_order: z.number().int().optional(),
    featured_media: z.number().int().min(0).optional(),
  });
}

export function postsRoutes(type: PostType) {
  const app = new Hono<AppEnv>({ strict: false });
  const collectionArgs = collectionSchema(type);
  const body = postBodySchema();
  const taxonomiesFor = (kernel: Kernel) =>
    kernel.taxonomies.forObjectType(type.name).filter((t) => t.showInRest);

  /* ------------------------------------------------------------ list */

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const taxonomies = taxonomiesFor(kernel);
    const arrays = [
      ...COLLECTION_ARRAYS,
      ...taxonomies.flatMap((t) => [t.restBase, `${t.restBase}_exclude`]),
    ];
    const raw = queryObject(c, arrays);
    const parsed = collectionArgs.safeParse(raw);
    if (!parsed.success) return invalidParams(c, parsed.error);
    const q = parsed.data;

    // sanitize_post_statuses(): anything but publish needs edit rights for this type.
    const statuses = q.status;
    if (statuses.some((s) => s !== 'publish') && !userCan(user, type.cap.edit_posts)) {
      return restError(c, authStatus(c), 'rest_forbidden_status', 'Status is forbidden.');
    }
    if (q.context === 'edit' && !userCan(user, type.cap.edit_posts)) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden_context',
        'Sorry, you are not allowed to edit posts in this post type.',
      );
    }

    const timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
    const date = (value: string | undefined, gmt = false) =>
      value === undefined ? undefined : parseRestDate(value, timeZone, gmt);

    const tax_query: TaxQueryClause[] = [];
    for (const taxonomy of taxonomies) {
      const include = (raw[taxonomy.restBase] as string[] | undefined)
        ?.map(Number)
        .filter(Number.isInteger);
      const exclude = (raw[`${taxonomy.restBase}_exclude`] as string[] | undefined)
        ?.map(Number)
        .filter(Number.isInteger);
      if (include?.length) tax_query.push({ taxonomy: taxonomy.name, terms: include });
      if (exclude?.length)
        tax_query.push({ taxonomy: taxonomy.name, terms: exclude, operator: 'NOT IN' });
    }

    const orderbyMap: Record<string, OrderBy> = {
      author: 'author',
      date: 'date',
      id: 'id',
      include: 'post__in',
      modified: 'modified',
      parent: 'parent',
      relevance: 'relevance',
      slug: 'name',
      include_slugs: 'name',
      title: 'title',
      menu_order: 'menu_order',
    };
    const args: QueryArgs = {
      post_type: type.name,
      post_status: statuses,
      posts_per_page: q.per_page,
      paged: q.page,
      offset: q.offset,
      s: q.search,
      author__in: q.author,
      author__not_in: q.author_exclude,
      post__in: q.include,
      post__not_in: q.exclude,
      post_name__in: q.slug,
      post_parent__in: q.parent?.filter((p) => p > 0),
      post_parent__not_in: q.parent_exclude,
      menu_order: q.menu_order,
      date_after: date(q.after),
      date_before: date(q.before),
      modified_after: date(q.modified_after),
      modified_before: date(q.modified_before),
      orderby: orderbyMap[q.orderby],
      order: q.order === 'asc' ? 'ASC' : 'DESC',
      tax_query,
    };
    if (q.parent?.length === 1 && q.parent[0] === 0) args.post_parent = 0;
    if (q.search && q.orderby === 'date' && !raw.orderby) args.orderby = 'relevance';
    if (q.sticky !== undefined && type.name === 'post') {
      const sticky = await kernel.options.get<number[]>('sticky_posts', []);
      if (q.sticky)
        args.post__in = args.post__in ? args.post__in.filter((id) => sticky.includes(id)) : sticky;
      else args.post__not_in = [...(args.post__not_in ?? []), ...sticky];
    }

    const result = await queryPosts(kernel, args);
    if (q.page > result.maxPages && result.found > 0) {
      return restError(
        c,
        400,
        'rest_post_invalid_page_number',
        'The page number requested is larger than the number of pages available.',
      );
    }

    const readable: Post[] = [];
    for (const post of result.posts) if (await canRead(kernel, user, post)) readable.push(post);
    const prepared = await prepareContext(kernel, type, user, q.context, readable, q.password);
    const items = [];
    for (const post of readable) items.push(await prepareItem(post, prepared));

    setPaginationHeaders(c, result.found, result.maxPages, q.page);
    return c.json(items);
  });

  /* --------------------------------------------------------- OPTIONS */

  // rest_send_allow_header(): which methods the current user may use here.
  app.options('/', (c) => {
    const methods = userCan(c.get('user'), type.cap.create_posts) ? ['GET', 'POST'] : ['GET'];
    c.header('Allow', methods.join(', '));
    return c.json({ namespace: 'wp/v2', methods: ['GET', 'POST'] });
  });

  /* ------------------------------------------------------------ read */

  const loadOwn = async (c: Context<AppEnv>) => {
    const id = Number(c.req.param('id'));
    const post = Number.isInteger(id) ? await c.get('kernel').posts.get(id) : undefined;
    return post && post.type === type.name ? post : undefined;
  };
  const invalidId = (c: Context<AppEnv>) =>
    restError(c, 404, 'rest_post_invalid_id', 'Invalid post ID.');

  app.options('/:id{[0-9]+}', async (c) => {
    const post = await loadOwn(c);
    if (!post) return invalidId(c);
    c.header('Allow', (await itemMethods(c.get('kernel'), c.get('user'), post)).join(', '));
    return c.json({ namespace: 'wp/v2', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  });

  app.get('/:id{[0-9]+}', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const parsed = z
      .object({ context: contextParam, password: z.string().optional() })
      .safeParse(c.req.query());
    if (!parsed.success) return invalidParams(c, parsed.error);
    await kernel.posts.publishDue();
    const post = await loadOwn(c);
    if (!post) return invalidId(c);

    if (
      parsed.data.context === 'edit' &&
      !(await currentUserCan(kernel, user, 'edit_post', post.id))
    ) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden_context',
        'Sorry, you are not allowed to edit this post.',
      );
    }
    if (!(await canRead(kernel, user, post))) {
      return restError(
        c,
        authStatus(c),
        'rest_forbidden',
        'Sorry, you are not allowed to do that.',
      );
    }
    const password = parsed.data.password;
    if (password !== undefined && post.password && password !== post.password) {
      return restError(c, 401, 'rest_post_incorrect_password', 'Incorrect post password.');
    }
    const prepared = await prepareContext(
      kernel,
      type,
      user,
      parsed.data.context,
      [post],
      password,
    );
    c.header('Allow', (await itemMethods(kernel, user, post)).join(', '));
    return c.json(await prepareItem(post, prepared));
  });

  /* ------------------------------------------------------- shared write */

  /**
   * Validates the body and applies WordPress's write permission rules.
   * Returns the service input, or a REST error response.
   */
  const toInput = async (c: Context<AppEnv>, existing?: Post): Promise<PostInput | Response> => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const json = await readJson(c);
    const parsed = body.safeParse(json);
    if (!parsed.success) return invalidParams(c, parsed.error);
    const data = parsed.data;
    const raw = (json ?? {}) as Record<string, unknown>;

    if (data.author !== undefined && data.author !== (existing?.authorId ?? user?.id)) {
      if (!userCan(user, type.cap.edit_others_posts)) {
        return restError(
          c,
          authStatus(c),
          'rest_cannot_edit_others',
          'Sorry, you are not allowed to update posts as this user.',
        );
      }
    }
    // handle_status_param(): publishing needs publish rights.
    if (data.status && ['publish', 'future', 'private'].includes(data.status)) {
      const allowed = existing
        ? await currentUserCan(kernel, user, 'publish_post', existing.id)
        : userCan(user, type.cap.publish_posts);
      if (!allowed) {
        return restError(
          c,
          authStatus(c),
          'rest_cannot_publish',
          'Sorry, you are not allowed to publish posts in this post type.',
        );
      }
    }
    if (
      data.sticky !== undefined &&
      !(userCan(user, type.cap.edit_others_posts) && userCan(user, type.cap.publish_posts))
    ) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_assign_sticky',
        'Sorry, you are not allowed to make posts sticky.',
      );
    }

    if (
      data.featured_media !== undefined &&
      type.supports.has('thumbnail') &&
      !(await isValidFeaturedMedia(kernel, data.featured_media))
    ) {
      return restError(c, 400, 'rest_invalid_featured_media', 'Invalid featured media ID.');
    }

    const terms: Record<string, number[]> = {};
    for (const taxonomy of taxonomiesFor(kernel)) {
      const value = raw[taxonomy.restBase];
      if (value === undefined) continue;
      const ids = z.array(z.number().int().min(1)).safeParse(value);
      if (!ids.success) {
        return restError(
          c,
          400,
          'rest_invalid_param',
          `Invalid parameter(s): ${taxonomy.restBase}`,
          {
            params: { [taxonomy.restBase]: `${taxonomy.restBase} must be a list of term IDs.` },
          },
        );
      }
      for (const id of ids.data) {
        if (!(await currentUserCan(kernel, user, 'assign_term', id))) {
          return restError(
            c,
            authStatus(c),
            'rest_cannot_assign_term',
            'Sorry, you are not allowed to assign the provided terms.',
          );
        }
      }
      terms[taxonomy.name] = ids.data;
    }

    const timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
    let date: Date | undefined;
    if (data.date_gmt) date = parseRestDate(data.date_gmt, timeZone, true);
    else if (data.date) date = parseRestDate(data.date, timeZone, false);
    if ((data.date || data.date_gmt) && !date) {
      return restError(c, 400, 'rest_invalid_date', 'Invalid date.');
    }

    return {
      title: data.title,
      content: data.content,
      excerpt: data.excerpt,
      status: data.status,
      slug: data.slug,
      date,
      authorId: data.author ?? (existing ? undefined : (user?.id ?? null)),
      parentId: data.parent === undefined ? undefined : data.parent || null,
      menuOrder: data.menu_order,
      commentStatus: data.comment_status,
      pingStatus: data.ping_status,
      password: data.password,
      terms: Object.keys(terms).length ? terms : undefined,
      filterHtml: !userCan(user, 'unfiltered_html'),
    };
  };

  /** `meta` of a write, for types that support custom fields (WordPress ignores it otherwise). */
  const metaInput = (c: Context<AppEnv>, meta: unknown) =>
    type.supports.has('custom-fields') ? parseRestMeta(c, 'post', type.name, meta) : [];

  const setSticky = async (kernel: Kernel, id: number, sticky: boolean | undefined) => {
    if (sticky === undefined || type.name !== 'post') return;
    const current = await kernel.options.get<number[]>('sticky_posts', []);
    const next = sticky ? [...new Set([...current, id])] : current.filter((s) => s !== id);
    if (next.length !== current.length) await kernel.options.set('sticky_posts', next);
  };

  /* ---------------------------------------------------------- create */

  app.post('/', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    if (!userCan(user, type.cap.create_posts)) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_create',
        'Sorry, you are not allowed to create posts as this user.',
      );
    }
    const input = await toInput(c);
    if (input instanceof Response) return input;
    const { sticky, featured_media, meta } =
      ((await readJson(c)) as
        | { sticky?: boolean; featured_media?: number; meta?: unknown }
        | undefined) ?? {};
    const metaWrites = metaInput(c, meta);
    if (metaWrites instanceof Response) return metaWrites;
    try {
      const post = await kernel.posts.insert(type.name, input);
      // The auth callbacks receive the post's ID, so a new post is checked once it exists.
      const denied = await authorizeRestMeta(c, 'post', post.id, metaWrites);
      if (denied) return denied;
      await writeRestMeta(kernel, 'post', post.id, metaWrites);
      await setSticky(kernel, post.id, sticky);
      await kernel.hooks.doAction(`rest_insert_${type.name}`, post, await readJson(c), true);
      if (type.supports.has('thumbnail')) await setFeaturedMedia(kernel, post.id, featured_media);
      const prepared = await prepareContext(kernel, type, user, 'edit', [post]);
      c.header('Location', `/wp-json/wp/v2/${type.restBase}/${post.id}`);
      return c.json(await prepareItem(post, prepared), 201);
    } catch (error) {
      return serviceError(c, error);
    }
  });

  /* ---------------------------------------------------------- update */

  const update = async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const existing = await loadOwn(c);
    if (!existing) return invalidId(c);
    if (!(await currentUserCan(kernel, user, 'edit_post', existing.id))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_edit',
        'Sorry, you are not allowed to edit this post.',
      );
    }
    const input = await toInput(c, existing);
    if (input instanceof Response) return input;
    const { sticky, featured_media, meta } =
      ((await readJson(c)) as
        | { sticky?: boolean; featured_media?: number; meta?: unknown }
        | undefined) ?? {};
    const metaWrites = metaInput(c, meta);
    if (metaWrites instanceof Response) return metaWrites;
    const denied = await authorizeRestMeta(c, 'post', existing.id, metaWrites);
    if (denied) return denied;
    try {
      // Changing the status of a trashed post restores it first, as the admin's "Restore" does.
      if (existing.status === 'trash' && input.status) await kernel.posts.untrash(existing.id);
      const post = await kernel.posts.update(existing.id, input);
      await writeRestMeta(kernel, 'post', post.id, metaWrites);
      await setSticky(kernel, post.id, sticky);
      await kernel.hooks.doAction(`rest_insert_${type.name}`, post, await readJson(c), false);
      if (type.supports.has('thumbnail')) await setFeaturedMedia(kernel, post.id, featured_media);
      const prepared = await prepareContext(kernel, type, user, 'edit', [post]);
      return c.json(await prepareItem(post, prepared));
    } catch (error) {
      return serviceError(c, error);
    }
  };
  app.post('/:id{[0-9]+}', update);
  app.put('/:id{[0-9]+}', update);
  app.patch('/:id{[0-9]+}', update);

  /* ---------------------------------------------------------- delete */

  app.delete('/:id{[0-9]+}', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const post = await loadOwn(c);
    if (!post) return invalidId(c);
    if (!(await currentUserCan(kernel, user, 'delete_post', post.id))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_delete',
        'Sorry, you are not allowed to delete this post.',
      );
    }
    const force = boolParam.safeParse(c.req.query('force') ?? 'false');
    const prepared = await prepareContext(kernel, type, user, 'edit', [post]);
    try {
      if (force.success && force.data) {
        const previous = await prepareItem(post, prepared);
        await kernel.posts.delete(post.id);
        await setSticky(kernel, post.id, false);
        return c.json({ deleted: true, previous });
      }
      const trashed = await kernel.posts.trash(post.id);
      return c.json(await prepareItem(trashed, prepared));
    } catch (error) {
      return serviceError(c, error);
    }
  });

  /* -------------------------------------------------------- revisions */

  app.get('/:id{[0-9]+}/revisions', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const post = await loadOwn(c);
    if (!post) return restError(c, 404, 'rest_post_invalid_parent', 'Invalid post parent ID.');
    if (!(await currentUserCan(kernel, user, 'edit_post', post.id))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_read',
        'Sorry, you are not allowed to view revisions of this post.',
      );
    }
    const timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
    const revisions = await kernel.posts.revisions(post.id);
    c.header('X-WP-Total', String(revisions.length));
    c.header('X-WP-TotalPages', '1');
    const rendered = await Promise.all(
      revisions.map((r) =>
        kernel.blocks.render(r.content, {
          context: kernel.blocks.contextFor(post),
          user,
          rest: true,
        }),
      ),
    );
    return c.json(
      revisions.map((r, i) => ({
        id: r.id,
        author: r.authorId ?? 0,
        date: toLocalString(r.date, timeZone),
        date_gmt: toGmtString(r.date),
        modified: toLocalString(r.modified, timeZone),
        modified_gmt: toGmtString(r.modified),
        parent: post.id,
        slug: r.slug,
        title: { raw: r.title, rendered: r.title },
        content: { raw: r.content, rendered: rendered[i] ?? '' },
        excerpt: { raw: r.excerpt, rendered: r.excerpt ? `<p>${r.excerpt}</p>\n` : '' },
      })),
    );
  });

  return app;
}
