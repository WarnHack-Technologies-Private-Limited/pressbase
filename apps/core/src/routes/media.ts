import { createHash } from 'node:crypto';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { type CurrentUser, userCan } from '../auth/users';
import { toGmtString, toLocalString } from '../content/dates';
import type { Post } from '../content/posts';
import { type OrderBy, type QueryArgs, queryPosts } from '../content/query';
import { renderBlocksAsStatic } from '../content/sanitize';
import { type AppEnv, invalidParams, readJson, restError } from '../http';
import type { Kernel } from '../kernel';
import { type AttachmentMetadata, registeredImageSizes, resizeDimensions } from '../media/images';
import { mediaTypes, RESIZABLE_IMAGE_TYPES } from '../media/mime';
import {
  allowedMimeTypes,
  deleteAttachment,
  fileUrl,
  getMetaMap,
  META_ALT,
  META_FILE,
  META_METADATA,
  MediaError,
  maxUploadBytes,
  updateAttachment,
  uploadAttachment,
} from '../media/service';
import {
  authStatus,
  boolParam,
  contextParam,
  intList,
  pageParam,
  perPageParam,
  queryObject,
  rawText,
  setPaginationHeaders,
  stringList,
} from './rest-util';

/**
 * /wp/v2/media — a port of WP_REST_Attachments_Controller
 * (wordpress/wp-includes/rest-api/endpoints/class-wp-rest-attachments-controller.php).
 *
 * Uploads arrive as multipart/form-data (field `file`) or as a raw body with
 * Content-Disposition and Content-Type headers, as in WordPress. Attachments
 * have no Trash: DELETE needs `?force=true`.
 *
 * Filter `rest_prepare_attachment` (response, post, context) can change each item.
 */

type RestContext = 'view' | 'edit' | 'embed';

interface Prepared {
  kernel: Kernel;
  user: CurrentUser | null;
  context: RestContext;
  timeZone: string;
  home: string;
  meta: Map<number, Record<string, unknown>>;
  sizes: Awaited<ReturnType<typeof registeredImageSizes>>;
}

async function prepareContext(
  kernel: Kernel,
  user: CurrentUser | null,
  context: RestContext,
  posts: Post[],
): Promise<Prepared> {
  return {
    kernel,
    user,
    context,
    timeZone: await kernel.options.get<string>('timezone_string', 'UTC'),
    home: (await kernel.options.get<string>('home', '')).replace(/\/+$/, ''),
    meta: await getMetaMap(
      kernel,
      posts.map((p) => p.id),
      [META_FILE, META_METADATA, META_ALT],
    ),
    sizes: await registeredImageSizes(kernel),
  };
}

/** wpautop(), reduced to paragraphs and line breaks, for descriptions. */
function autop(text: string): string {
  const html = renderBlocksAsStatic(text).trim();
  if (!html) return '';
  if (/^<(p|div|figure|ul|ol|h[1-6]|blockquote|table)\b/i.test(html)) return `${html}\n`;
  return `${html
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.trim().replace(/\n/g, '<br />\n')}</p>`)
    .join('\n')}\n`;
}

const folderOf = (key: string) => (key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '');

async function prepareItem(post: Post, p: Prepared): Promise<Record<string, unknown>> {
  const { kernel, context } = p;
  const edit = context === 'edit';
  const meta = p.meta.get(post.id) ?? {};
  const attachedFile = typeof meta[META_FILE] === 'string' ? (meta[META_FILE] as string) : '';
  const metadata = (meta[META_METADATA] ?? {}) as AttachmentMetadata;
  const isImage = RESIZABLE_IMAGE_TYPES.has(post.mimeType);
  const sourceUrl = attachedFile ? await fileUrl(kernel, attachedFile) : post.guid;
  const folder = folderOf(attachedFile);

  // media_details: the stored metadata, with mime_type and source_url per size and a `full` entry.
  const details: Record<string, unknown> = { ...metadata };
  const sizes: Record<string, unknown> = {};
  for (const [name, size] of Object.entries(metadata.sizes ?? {})) {
    const { 'mime-type': mime, ...rest } = size;
    sizes[name] = {
      ...rest,
      mime_type: mime,
      source_url: await fileUrl(kernel, `${folder}${size.file}`),
    };
  }
  if (isImage && metadata.width && metadata.height) {
    sizes.full = {
      file: attachedFile.slice(folder.length),
      width: metadata.width,
      height: metadata.height,
      mime_type: post.mimeType,
      source_url: sourceUrl,
    };
  }
  details.sizes = sizes;

  // wp_get_missing_image_subsizes(): sizes the image is big enough for but doesn't have.
  const missing: string[] = [];
  if (isImage && metadata.width && metadata.height) {
    // Sub-sizes are made from the original, but every registered size fits within the
    // big image threshold, so the "full" dimensions decide the same set.
    const fullW = metadata.width;
    const fullH = metadata.height;
    for (const [name, size] of Object.entries(p.sizes)) {
      if (metadata.sizes?.[name]) continue;
      if (resizeDimensions(fullW, fullH, size.width, size.height, size.crop)) missing.push(name);
    }
  }

  const item: Record<string, unknown> = {
    id: post.id,
    date: toLocalString(post.date, p.timeZone),
    date_gmt: toGmtString(post.date),
    guid: edit ? { rendered: post.guid, raw: post.guid } : { rendered: post.guid },
    modified: toLocalString(post.modified, p.timeZone),
    modified_gmt: toGmtString(post.modified),
    slug: post.slug,
    status: post.status,
    type: 'attachment',
    link: `${p.home}/?attachment_id=${post.id}`,
    title: edit ? { raw: post.title, rendered: post.title } : { rendered: post.title },
    author: post.authorId ?? 0,
    comment_status: post.commentStatus,
    ping_status: post.pingStatus,
    template: '',
    meta: {},
    description: {
      ...(edit ? { raw: post.content } : {}),
      rendered: autop(post.content),
    },
    caption: {
      ...(edit ? { raw: post.excerpt } : {}),
      rendered: post.excerpt ? `<p>${post.excerpt}</p>\n` : '',
    },
    alt_text: typeof meta[META_ALT] === 'string' ? meta[META_ALT] : '',
    media_type: isImage ? 'image' : 'file',
    mime_type: post.mimeType,
    media_details: details,
    post: post.parentId ?? null,
    source_url: sourceUrl,
  };
  if (edit) {
    item.missing_image_sizes = missing;
    item.permalink_template = item.link;
    item.generated_slug = post.slug;
  }
  item._links = {
    self: [{ href: `/wp-json/wp/v2/media/${post.id}` }],
    collection: [{ href: '/wp-json/wp/v2/media' }],
    about: [{ href: '/wp-json/wp/v2/types/attachment' }],
    ...(post.authorId
      ? { author: [{ embeddable: true, href: `/wp-json/wp/v2/users/${post.authorId}` }] }
      : {}),
  };

  if (context === 'embed') {
    const {
      id,
      date,
      slug,
      type,
      link,
      title,
      author,
      caption,
      alt_text,
      media_type,
      mime_type,
      media_details,
      source_url,
      _links,
    } = item;
    return {
      id,
      date,
      slug,
      type,
      link,
      title,
      author,
      caption,
      alt_text,
      media_type,
      mime_type,
      media_details,
      source_url,
      _links,
    };
  }
  return (await kernel.hooks.applyFilters(
    'rest_prepare_attachment',
    item,
    post,
    context,
  )) as Record<string, unknown>;
}

/**
 * WP_REST_Posts_Controller::check_read_permission() for attachments: an
 * `inherit` attachment is as readable as the post it's attached to, and
 * public when it isn't attached.
 */
async function canRead(kernel: Kernel, user: CurrentUser | null, post: Post): Promise<boolean> {
  if (post.status === 'inherit') {
    if (!post.parentId) return true;
    const parent = await kernel.posts.get(post.parentId);
    if (!parent) return true;
    if (parent.status === 'publish') return true;
    return currentUserCan(kernel, user, 'read_post', parent.id);
  }
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
  'media_type',
  'mime_type',
] as const;

const collectionArgs = z.object({
  context: contextParam,
  page: pageParam,
  per_page: perPageParam,
  search: z.string().optional(),
  author: intList,
  author_exclude: intList,
  include: intList,
  exclude: intList,
  offset: z.coerce.number().int().min(0).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  orderby: z
    .enum(['author', 'date', 'id', 'include', 'modified', 'parent', 'relevance', 'slug', 'title'])
    .default('date'),
  slug: stringList,
  status: z.array(z.enum(['inherit', 'private', 'trash'])).default(['inherit']),
  parent: intList,
  parent_exclude: intList,
  media_type: z.array(z.enum(['image', 'video', 'text', 'application', 'audio'])).optional(),
  mime_type: stringList,
});

const updateBody = z.object({
  title: rawText.optional(),
  caption: rawText.optional(),
  description: rawText.optional(),
  alt_text: z.string().max(1000).optional(),
  post: z.number().int().min(0).nullable().optional(),
  author: z.number().int().min(1).optional(),
  slug: z.string().max(200).optional(),
  comment_status: z.enum(['open', 'closed']).optional(),
  ping_status: z.enum(['open', 'closed']).optional(),
});

/** Optional fields that may accompany an upload (form fields or query parameters). */
const uploadFields = z.object({
  title: z.string().max(1000).optional(),
  caption: z.string().max(10_000).optional(),
  description: z.string().max(100_000).optional(),
  alt_text: z.string().max(1000).optional(),
  post: z.coerce.number().int().min(0).optional(),
});

/**
 * get_filename_from_disposition(): the filename from a Content-Disposition
 * header, supporting RFC 5987's `filename*=UTF-8''…` as well.
 */
export function filenameFromDisposition(header: string): string | undefined {
  const params = header.split(';').slice(1);
  let plain: string | undefined;
  let extended: string | undefined;
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    let value = param.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (key === 'filename' && value) plain = value;
    if (key === 'filename*' && value) {
      const match = /^([\w-]+)'[^']*'(.*)$/.exec(value);
      try {
        extended = match ? decodeURIComponent(match[2] ?? '') : undefined;
      } catch {
        extended = undefined;
      }
    }
  }
  return extended || plain || undefined;
}

const mediaError = (c: Context, error: unknown) => {
  if (error instanceof MediaError) return restError(c, error.status, error.code, error.message);
  throw error;
};

export function mediaRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  /* ------------------------------------------------------------ list */

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const type = kernel.postTypes.get('attachment');
    if (!type) return restError(c, 404, 'rest_no_route', 'No route was found.');
    const raw = queryObject(c, COLLECTION_ARRAYS);
    const parsed = collectionArgs.safeParse(raw);
    if (!parsed.success) return invalidParams(c, parsed.error);
    const q = parsed.data;

    if (q.status.some((s) => s !== 'inherit') && !userCan(user, type.cap.edit_posts)) {
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

    // prepare_items_query(): media types and MIME types become post_mime_type.
    const groups = mediaTypes(await allowedMimeTypes(kernel, user));
    const mimes = new Set<string>();
    for (const group of q.media_type ?? []) for (const m of groups[group] ?? []) mimes.add(m);
    for (const mime of q.mime_type ?? []) {
      if (groups[mime.split('/')[0] ?? '']?.includes(mime)) mimes.add(mime);
    }
    const filtering = Boolean(q.media_type?.length || q.mime_type?.length);

    const orderbyMap: Record<string, OrderBy> = {
      author: 'author',
      date: 'date',
      id: 'id',
      include: 'post__in',
      modified: 'modified',
      parent: 'parent',
      relevance: 'relevance',
      slug: 'name',
      title: 'title',
    };
    const args: QueryArgs = {
      post_type: 'attachment',
      post_status: q.status,
      posts_per_page: q.per_page,
      paged: q.page,
      offset: q.offset,
      s: q.search,
      author__in: q.author,
      author__not_in: q.author_exclude,
      post__in: q.include,
      post__not_in: q.exclude,
      post_name__in: q.slug,
      post_parent__in: q.parent?.filter((id) => id > 0),
      post_parent__not_in: q.parent_exclude,
      orderby: orderbyMap[q.orderby],
      order: q.order === 'asc' ? 'ASC' : 'DESC',
    };
    // Filtering on types nothing matches returns nothing, not everything.
    if (filtering) args.post_mime_type = mimes.size ? [...mimes] : ['none/none'];
    if (q.parent?.length === 1 && q.parent[0] === 0) args.post_parent = 0;
    if (q.search && q.orderby === 'date' && !raw.orderby) args.orderby = 'relevance';

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
    const prepared = await prepareContext(kernel, user, q.context, readable);
    const items = [];
    for (const post of readable) items.push(await prepareItem(post, prepared));
    setPaginationHeaders(c, result.found, result.maxPages, q.page);
    return c.json(items);
  });

  /* ------------------------------------------------------------ read */

  const loadOwn = async (c: Context<AppEnv>) => {
    const id = Number(c.req.param('id'));
    const post = Number.isInteger(id) ? await c.get('kernel').posts.get(id) : undefined;
    return post && post.type === 'attachment' ? post : undefined;
  };
  const invalidId = (c: Context<AppEnv>) =>
    restError(c, 404, 'rest_post_invalid_id', 'Invalid post ID.');

  app.get('/:id{[0-9]+}', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const parsed = z.object({ context: contextParam }).safeParse(c.req.query());
    if (!parsed.success) return invalidParams(c, parsed.error);
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
    const prepared = await prepareContext(kernel, user, parsed.data.context, [post]);
    return c.json(await prepareItem(post, prepared));
  });

  /* ---------------------------------------------------------- create */

  /** create_item_permissions_check(), before the body is read. */
  const canUpload: MiddlewareHandler<AppEnv> = async (c, next) => {
    const user = c.get('user');
    if (!userCan(user, 'upload_files')) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_create',
        'Sorry, you are not allowed to upload media on this site.',
      );
    }
    await next();
  };

  /** Refuses bodies over the upload limit, plus room for multipart framing and fields. */
  const limitBody: MiddlewareHandler<AppEnv> = (c, next) => {
    const max = maxUploadBytes(c.get('kernel'));
    return bodyLimit({
      maxSize: max + 1024 * 1024,
      onError: (ctx) =>
        restError(
          ctx,
          413,
          'rest_upload_file_too_big',
          `This file is too big. Files must be smaller than ${Math.round(max / 1024 / 1024)} MB.`,
        ),
    })(c, next);
  };

  app.post('/', canUpload, limitBody, async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const contentType = c.req.header('content-type') ?? '';

    let data: Uint8Array;
    let filename: string;
    let fields: Record<string, unknown>;
    if (contentType.toLowerCase().startsWith('multipart/form-data')) {
      // upload_from_file()
      let body: Record<string, string | File | (string | File)[]>;
      try {
        body = await c.req.parseBody({ all: false });
      } catch {
        return restError(c, 400, 'rest_upload_no_data', 'No data supplied.');
      }
      const file = body.file;
      if (!(file instanceof File)) {
        return restError(c, 400, 'rest_upload_no_data', 'No data supplied.');
      }
      data = new Uint8Array(await file.arrayBuffer());
      filename = file.name;
      fields = Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string'));
    } else {
      // upload_from_data(): the body is the file; details come in headers and the query string.
      data = new Uint8Array(await c.req.arrayBuffer());
      if (!data.byteLength) return restError(c, 400, 'rest_upload_no_data', 'No data supplied.');
      if (!contentType) {
        return restError(c, 400, 'rest_upload_no_content_type', 'No Content-Type supplied.');
      }
      const disposition = c.req.header('content-disposition');
      if (!disposition) {
        return restError(
          c,
          400,
          'rest_upload_no_content_disposition',
          'No Content-Disposition supplied.',
        );
      }
      const name = filenameFromDisposition(disposition);
      if (!name) {
        return restError(
          c,
          400,
          'rest_upload_invalid_disposition',
          'Invalid Content-Disposition supplied. Content-Disposition needs to be formatted as `attachment; filename="image.png"` or similar.',
        );
      }
      filename = name;
      fields = c.req.query();
    }

    const md5 = c.req.header('content-md5');
    if (md5 && createHash('md5').update(data).digest('hex') !== md5.trim()) {
      return restError(c, 412, 'rest_upload_hash_mismatch', 'Content hash did not match expected.');
    }

    const parsed = uploadFields.safeParse(fields);
    if (!parsed.success) return invalidParams(c, parsed.error);
    const input = parsed.data;
    if (input.post && !(await currentUserCan(kernel, user, 'edit_post', input.post))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_edit',
        'Sorry, you are not allowed to upload media to this post.',
      );
    }

    try {
      const post = await uploadAttachment(kernel, {
        data,
        filename,
        user,
        title: input.title,
        caption: input.caption,
        description: input.description,
        altText: input.alt_text,
        parentId: input.post || null,
      });
      const prepared = await prepareContext(kernel, user, 'edit', [post]);
      c.header('Location', `/wp-json/wp/v2/media/${post.id}`);
      return c.json(await prepareItem(post, prepared), 201);
    } catch (error) {
      return mediaError(c, error);
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
    const parsed = updateBody.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    const data = parsed.data;

    if (data.author !== undefined && data.author !== existing.authorId) {
      if (!userCan(user, 'edit_others_posts')) {
        return restError(
          c,
          authStatus(c),
          'rest_cannot_edit_others',
          'Sorry, you are not allowed to update posts as this user.',
        );
      }
    }
    if (data.post && !(await currentUserCan(kernel, user, 'edit_post', data.post))) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_edit',
        'Sorry, you are not allowed to upload media to this post.',
      );
    }
    try {
      const post = await updateAttachment(kernel, existing, {
        title: data.title,
        caption: data.caption,
        description: data.description,
        altText: data.alt_text,
        parentId: data.post === undefined ? undefined : data.post || null,
        authorId: data.author,
        slug: data.slug,
        commentStatus: data.comment_status,
        pingStatus: data.ping_status,
        filterHtml: !userCan(user, 'unfiltered_html'),
      });
      const prepared = await prepareContext(kernel, user, 'edit', [post]);
      return c.json(await prepareItem(post, prepared));
    } catch (error) {
      return mediaError(c, error);
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
    // Attachments have no Trash (MEDIA_TRASH is off by default in WordPress).
    if (!force.success || !force.data) {
      return restError(
        c,
        501,
        'rest_trash_not_supported',
        "The post does not support trashing. Set 'force=true' to delete.",
      );
    }
    const prepared = await prepareContext(kernel, user, 'edit', [post]);
    const previous = await prepareItem(post, prepared);
    await deleteAttachment(kernel, post);
    return c.json({ deleted: true, previous });
  });

  return app;
}
