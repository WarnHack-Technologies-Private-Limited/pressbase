import path from 'node:path';
import { schema } from '@pressbase/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { CurrentUser } from '../auth/users';
import { userCan } from '../auth/users';
import type { Post } from '../content/posts';
import {
  sanitizePostContent,
  sanitizePostTitle,
  sanitizeSlug,
  stripTags,
} from '../content/sanitize';
import type { Kernel } from '../kernel';
import { sanitizeFileName, uniqueFileName } from './filenames';
import {
  type AttachmentMetadata,
  createImageSubsizes,
  type ImageSize,
  imageSize,
  registeredImageSizes,
  resizeDimensions,
} from './images';
import { ALLOWED_MIME_TYPES, checkFileType, RESIZABLE_IMAGE_TYPES } from './mime';
import { LocalStorage, type MediaStorage } from './storage';

/**
 * The media library's server side — WordPress's wp_handle_upload(),
 * wp_insert_attachment(), wp_generate_attachment_metadata() and
 * wp_delete_attachment() (wp-admin/includes/file.php, image.php,
 * wp-includes/post.php).
 *
 * Attachments are `posts` rows with type `attachment` and status `inherit`.
 * Post meta, with WordPress's keys:
 * - `_wp_attached_file`: the file's storage key, e.g. `2026/10/photo.jpg`;
 * - `_wp_attachment_metadata`: dimensions, sub-sizes and image meta;
 * - `_wp_attachment_image_alt`: the alternative text.
 *
 * Hooks: actions add_attachment, edit_attachment, delete_attachment (id, post);
 * filters upload_mimes, sanitize_file_name, wp_generate_attachment_metadata,
 * big_image_size_threshold, intermediate_image_sizes_advanced.
 */

export const META_FILE = '_wp_attached_file';
export const META_METADATA = '_wp_attachment_metadata';
export const META_ALT = '_wp_attachment_image_alt';
export const META_THUMBNAIL = '_thumbnail_id';

export class MediaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 412 | 413 | 500 = 400,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------- storage */

const storages = new WeakMap<Kernel, MediaStorage>();

/** The kernel's media storage: local disk under `<dataDir>/uploads` unless replaced. */
export function mediaStorage(kernel: Kernel): MediaStorage {
  let storage = storages.get(kernel);
  if (!storage) {
    storage = new LocalStorage(path.join(kernel.config.dataDir, 'uploads'));
    storages.set(kernel, storage);
  }
  return storage;
}

/** Replaces the storage, e.g. with an S3-compatible adapter. Call before serving requests. */
export function setMediaStorage(kernel: Kernel, storage: MediaStorage): void {
  storages.set(kernel, storage);
}

/** PRESSBASE_MAX_UPLOAD_MB, default 64 — the largest file accepted, in bytes. */
export function maxUploadBytes(kernel: Kernel): number {
  const mb = kernel.config.maxUploadMb ?? 64;
  return Math.max(1, mb) * 1024 * 1024;
}

/** get_allowed_mime_types(), filtered by `upload_mimes` (mimes, user). */
export async function allowedMimeTypes(
  kernel: Kernel,
  user: CurrentUser | null,
): Promise<Record<string, string>> {
  return (await kernel.hooks.applyFilters(
    'upload_mimes',
    { ...ALLOWED_MIME_TYPES },
    user,
  )) as Record<string, string>;
}

async function siteUrl(kernel: Kernel): Promise<string> {
  const url = await kernel.options.get<string>('siteurl', '');
  return (url || (await kernel.options.get<string>('home', ''))).replace(/\/+$/, '');
}

/** wp_get_attachment_url() for a storage key. */
export async function fileUrl(kernel: Kernel, key: string): Promise<string> {
  return mediaStorage(kernel).url(key, await siteUrl(kernel));
}

/* ---------------------------------------------------------------- meta */

export async function getMetaMap(
  kernel: Kernel,
  ids: number[],
  keys: string[],
): Promise<Map<number, Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>();
  if (!ids.length) return out;
  const rows = await kernel.db
    .select()
    .from(schema.postmeta)
    .where(and(inArray(schema.postmeta.postId, ids), inArray(schema.postmeta.key, keys)));
  for (const row of rows) {
    const entry = out.get(row.postId) ?? {};
    entry[row.key] = row.value;
    out.set(row.postId, entry);
  }
  return out;
}

export async function setMeta(
  kernel: Kernel,
  id: number,
  key: string,
  value: unknown,
): Promise<void> {
  await kernel.db
    .delete(schema.postmeta)
    .where(and(eq(schema.postmeta.postId, id), eq(schema.postmeta.key, key)));
  await kernel.db.insert(schema.postmeta).values({ postId: id, key, value });
}

export async function deleteMeta(kernel: Kernel, id: number, key: string): Promise<void> {
  await kernel.db
    .delete(schema.postmeta)
    .where(and(eq(schema.postmeta.postId, id), eq(schema.postmeta.key, key)));
}

/* -------------------------------------------------------------- upload */

export interface UploadInput {
  data: Uint8Array;
  /** The name the file had on the uploader's computer. */
  filename: string;
  user: CurrentUser | null;
  title?: string;
  caption?: string;
  description?: string;
  altText?: string;
  parentId?: number | null;
  /**
   * The attachment's date, which also picks its year/month folder (the
   * importer keeps a file's original date and folder, as wp_upload_bits() is
   * given the post's date). Default: now, or the parent post's month.
   */
  date?: Date;
  /**
   * A `YYYY/MM` folder to use instead of the date's: a migration keeps each
   * file in the folder it had on the old site (its `_wp_attached_file`).
   */
  folder?: string;
}

/** Year and month folders follow the site's time zone, as current_time() does. */
async function uploadFolder(kernel: Kernel, date: Date, wanted?: string): Promise<string> {
  if (!(await kernel.options.get<boolean>('uploads_use_yearmonth_folders', true))) return '';
  if (wanted && /^\d{4}\/(0[1-9]|1[0-2])$/.test(wanted)) return wanted;
  const timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}/${get('month')}`;
}

/** Choosing a unique name and writing the file happen one upload at a time. */
const locks = new WeakMap<Kernel, Promise<unknown>>();
async function exclusive<T>(kernel: Kernel, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(kernel) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  locks.set(kernel, next);
  return next;
}

/** wp_unique_post_slug() for attachments: unique across every post type. */
async function uniqueAttachmentSlug(kernel: Kernel, base: string, selfId: number): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const [clash] = await kernel.db
      .select({ id: schema.posts.id })
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.slug, candidate),
          sql`${schema.posts.id} <> ${selfId}`,
          sql`${schema.posts.type} <> 'revision'`,
        ),
      )
      .limit(1);
    if (!clash) return candidate;
  }
}

/**
 * Validates, stores and registers one upload. Images get their sub-sizes
 * before this returns, so the response can include every size.
 */
export async function uploadAttachment(kernel: Kernel, input: UploadInput): Promise<Post> {
  const { data, user } = input;
  if (!data.byteLength) {
    throw new MediaError(
      'rest_upload_no_data',
      'The file is empty. Choose a file with something in it.',
    );
  }
  const limit = maxUploadBytes(kernel);
  if (data.byteLength > limit) {
    throw new MediaError(
      'rest_upload_file_too_big',
      `This file is too big. Files must be smaller than ${Math.round(limit / 1024 / 1024)} MB.`,
      413,
    );
  }

  const allowed = await allowedMimeTypes(kernel, user);
  let filename = String(
    await kernel.hooks.applyFilters(
      'sanitize_file_name',
      sanitizeFileName(path.basename(input.filename.replace(/\\/g, '/')), allowed),
      input.filename,
    ),
  );
  const checked = checkFileType(filename, data, allowed);
  if (!checked) {
    throw new MediaError(
      'rest_upload_invalid_type',
      'Sorry, you are not allowed to upload this file type.',
    );
  }
  if (checked.properFilename) filename = checked.properFilename;
  if (filename.startsWith('.') || !filename.includes('.')) filename = `file.${checked.ext}`;

  const isImage = RESIZABLE_IMAGE_TYPES.has(checked.type);
  if (isImage && !(await imageSize(data))) {
    throw new MediaError(
      'rest_upload_invalid_image',
      'This image can’t be read. It may be damaged; try saving it again and uploading the copy.',
    );
  }

  // media_handle_upload(): files attached to a post go in that post's month (pages excepted).
  let parent: Post | undefined;
  if (input.parentId) {
    parent = await kernel.posts.get(input.parentId);
    if (!parent || ['revision', 'attachment'].includes(parent.type)) {
      throw new MediaError('rest_invalid_param', 'Invalid parent type.');
    }
  }
  const folderDate = input.date ?? (parent && parent.type !== 'page' ? parent.date : new Date());
  const folder = await uploadFolder(kernel, folderDate, input.folder);
  const storage = mediaStorage(kernel);

  const key = await exclusive(kernel, async () => {
    const name = await uniqueFileName(storage, folder, filename);
    const chosen = folder ? `${folder}/${name}` : name;
    await storage.put(chosen, data, { contentType: checked.type });
    return chosen;
  });

  const filterHtml = !userCan(user, 'unfiltered_html');
  const originalBase = path
    .basename(input.filename.replace(/\\/g, '/'))
    .replace(/\.[^.]+$/, '')
    .trim();
  const rawTitle =
    input.title?.trim() || stripTags(originalBase) || filename.replace(/\.[^.]+$/, '');
  const title = filterHtml ? sanitizePostTitle(rawTitle) : rawTitle;
  const caption = input.caption ?? '';
  const description = input.description ?? '';
  const now = input.date ?? new Date();

  let created: Post | undefined;
  try {
    [created] = await kernel.db
      .insert(schema.posts)
      .values({
        type: 'attachment',
        status: 'inherit',
        date: now,
        modified: now,
        title,
        content: filterHtml ? sanitizePostContent(description) : description,
        excerpt: filterHtml ? sanitizePostTitle(caption) : caption,
        authorId: user?.id ?? null,
        parentId: parent?.id ?? null,
        mimeType: checked.type,
        guid: await fileUrl(kernel, key),
        commentStatus: 'closed',
        pingStatus: 'closed',
      })
      .returning();
  } catch (error) {
    await storage.delete(key);
    throw error;
  }
  if (!created) {
    await storage.delete(key);
    throw new MediaError('db_insert_error', 'Could not save the upload.', 500);
  }
  const id = created.id;
  const slug = await uniqueAttachmentSlug(kernel, sanitizeSlug(title) || String(id), id);
  await kernel.db.update(schema.posts).set({ slug }).where(eq(schema.posts.id, id));
  await setMeta(kernel, id, META_FILE, key);
  const alt = stripTags(input.altText ?? '').trim();
  if (alt) await setMeta(kernel, id, META_ALT, alt);
  await kernel.hooks.doAction('add_attachment', id);

  // wp_generate_attachment_metadata()
  let metadata: AttachmentMetadata = { filesize: data.byteLength };
  if (isImage) {
    try {
      const result = await createImageSubsizes(kernel, storage, key, data, checked.type, id);
      metadata = result.metadata;
      if (result.attachedFile !== key) await setMeta(kernel, id, META_FILE, result.attachedFile);
    } catch (error) {
      // The upload stays usable at full size; missing_image_sizes reports the gap.
      console.error(`Could not create image sizes for attachment ${id}:`, error);
      const size = await imageSize(data);
      metadata = { ...size, file: key, filesize: data.byteLength, sizes: {} };
    }
  }
  metadata = (await kernel.hooks.applyFilters(
    'wp_generate_attachment_metadata',
    metadata,
    id,
    'create',
  )) as AttachmentMetadata;
  await setMeta(kernel, id, META_METADATA, metadata);

  return (await kernel.posts.get(id)) as Post;
}

/* -------------------------------------------------------------- update */

export interface AttachmentUpdate {
  title?: string;
  caption?: string;
  description?: string;
  altText?: string;
  parentId?: number | null;
  authorId?: number;
  slug?: string;
  commentStatus?: 'open' | 'closed';
  pingStatus?: 'open' | 'closed';
  filterHtml: boolean;
}

/** wp_update_post() for attachments; fires edit_attachment. */
export async function updateAttachment(
  kernel: Kernel,
  attachment: Post,
  input: AttachmentUpdate,
): Promise<Post> {
  const set: Partial<typeof schema.posts.$inferInsert> = { modified: new Date() };
  const clean = (value: string, html = false) =>
    input.filterHtml ? (html ? sanitizePostContent(value) : sanitizePostTitle(value)) : value;
  if (input.title !== undefined) set.title = clean(input.title);
  if (input.caption !== undefined) set.excerpt = clean(input.caption);
  if (input.description !== undefined) set.content = clean(input.description, true);
  if (input.authorId !== undefined) set.authorId = input.authorId;
  if (input.commentStatus !== undefined) set.commentStatus = input.commentStatus;
  if (input.pingStatus !== undefined) set.pingStatus = input.pingStatus;
  if (input.parentId !== undefined) {
    if (input.parentId) {
      const parent = await kernel.posts.get(input.parentId);
      if (!parent || ['revision', 'attachment'].includes(parent.type)) {
        throw new MediaError('rest_invalid_param', 'Invalid parent type.');
      }
    }
    set.parentId = input.parentId || null;
  }
  if (input.slug !== undefined) {
    const base = sanitizeSlug(input.slug) || sanitizeSlug(set.title ?? attachment.title);
    set.slug = await uniqueAttachmentSlug(kernel, base || String(attachment.id), attachment.id);
  }
  await kernel.db.update(schema.posts).set(set).where(eq(schema.posts.id, attachment.id));
  if (input.altText !== undefined) {
    // sanitize_text_field()
    const alt = stripTags(input.altText).replace(/\s+/g, ' ').trim();
    if (alt) await setMeta(kernel, attachment.id, META_ALT, alt);
    else await deleteMeta(kernel, attachment.id, META_ALT);
  }
  await kernel.hooks.doAction('edit_attachment', attachment.id);
  return (await kernel.posts.get(attachment.id)) as Post;
}

/* ---------------------------------------------------------- regenerate */

export interface RegenerateOptions {
  /** Only attachments missing a registered size (or its file) are regenerated. */
  onlyMissing?: boolean;
  /** Keep the files of sizes the new set no longer uses. */
  skipDelete?: boolean;
}

export interface RegenerateResult {
  /** False when `onlyMissing` found nothing to do. */
  regenerated: boolean;
  /** The sub-sizes the attachment has afterwards. */
  sizes: string[];
  /** Files removed because no size uses them any more. */
  deleted: string[];
}

async function readAll(stream: ReadableStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Remakes an image attachment's sub-sizes from its original upload, after
 * the sizes in Settings → Media (or a theme's) changed: what
 * `wp media regenerate` does with wp_create_image_subsizes(). The original is
 * kept; sub-size files no size uses any more are deleted unless `skipDelete`
 * (or another attachment shares them). Throws MediaError.
 */
export async function regenerateImageSizes(
  kernel: Kernel,
  attachment: Post,
  options: RegenerateOptions = {},
): Promise<RegenerateResult> {
  if (attachment.type !== 'attachment' || !RESIZABLE_IMAGE_TYPES.has(attachment.mimeType)) {
    throw new MediaError(
      'pressbase_not_an_image',
      `Attachment ${attachment.id} isn’t an image Pressbase can resize.`,
    );
  }
  const id = attachment.id;
  const meta = (await getMetaMap(kernel, [id], [META_FILE, META_METADATA])).get(id);
  const attachedFile = typeof meta?.[META_FILE] === 'string' ? (meta[META_FILE] as string) : '';
  if (!attachedFile) {
    throw new MediaError('pressbase_missing_file', `Attachment ${id} has no file.`, 404);
  }
  const metadata = (meta?.[META_METADATA] ?? {}) as AttachmentMetadata;
  const folder = attachedFile.includes('/')
    ? attachedFile.slice(0, attachedFile.lastIndexOf('/') + 1)
    : '';
  const originalKey = metadata.original_image
    ? `${folder}${metadata.original_image}`
    : attachedFile;
  const storage = mediaStorage(kernel);
  const stream = await storage.read(originalKey);
  if (!stream) {
    throw new MediaError(
      'pressbase_missing_file',
      `The original file of attachment ${id} is missing (${originalKey}).`,
      404,
    );
  }
  const data = await readAll(stream);

  if (options.onlyMissing) {
    const size = await imageSize(data);
    const sizes = (await kernel.hooks.applyFilters(
      'intermediate_image_sizes_advanced',
      await registeredImageSizes(kernel),
      metadata,
      id,
    )) as Record<string, ImageSize>;
    let missing = false;
    for (const [name, s] of Object.entries(sizes)) {
      if (!size || !resizeDimensions(size.width, size.height, s.width, s.height, s.crop)) continue;
      const have = metadata.sizes?.[name];
      if (!have || !(await storage.stat(`${folder}${have.file}`))) {
        missing = true;
        break;
      }
    }
    if (!missing) {
      return { regenerated: false, sizes: Object.keys(metadata.sizes ?? {}), deleted: [] };
    }
  }

  const before = attachmentFiles(attachedFile, metadata);
  const result = await createImageSubsizes(
    kernel,
    storage,
    originalKey,
    data,
    attachment.mimeType,
    id,
  );
  const next = (await kernel.hooks.applyFilters(
    'wp_generate_attachment_metadata',
    result.metadata,
    id,
    'update',
  )) as AttachmentMetadata;
  if (result.attachedFile !== attachedFile)
    await setMeta(kernel, id, META_FILE, result.attachedFile);
  await setMeta(kernel, id, META_METADATA, next);

  const deleted: string[] = [];
  if (!options.skipDelete) {
    const keep = new Set([...attachmentFiles(result.attachedFile, next), originalKey]);
    const stale = before.filter((f) => !keep.has(f));
    if (stale.length) {
      // Another attachment may use one of these files (imports do this).
      const shared = await kernel.db
        .select({ value: schema.postmeta.value })
        .from(schema.postmeta)
        .where(
          and(
            eq(schema.postmeta.key, META_FILE),
            inArray(sql<string>`(${schema.postmeta.value} #>> '{}')`, stale),
          ),
        );
      const used = new Set(shared.map((row) => String(row.value)));
      for (const file of stale.filter((f) => !used.has(f))) {
        await storage.delete(file);
        deleted.push(file);
      }
    }
  }
  return { regenerated: true, sizes: Object.keys(next.sizes ?? {}), deleted };
}

/* -------------------------------------------------------------- delete */

/** Every storage key that belongs to an attachment: the file, its original and its sizes. */
export function attachmentFiles(attachedFile: string, metadata: AttachmentMetadata): string[] {
  const folder = attachedFile.includes('/')
    ? attachedFile.slice(0, attachedFile.lastIndexOf('/') + 1)
    : '';
  const files = new Set([attachedFile]);
  if (metadata.original_image) files.add(`${folder}${metadata.original_image}`);
  for (const size of Object.values(metadata.sizes ?? {})) {
    if (size?.file) files.add(`${folder}${size.file}`);
  }
  return [...files];
}

/**
 * wp_delete_attachment(..., true): removes the row, its meta, its files, and
 * any post's featured image pointing at it.
 */
export async function deleteAttachment(kernel: Kernel, attachment: Post): Promise<void> {
  const meta = (await getMetaMap(kernel, [attachment.id], [META_FILE, META_METADATA])).get(
    attachment.id,
  );
  await kernel.hooks.doAction('delete_attachment', attachment.id, attachment);
  await kernel.db
    .delete(schema.postmeta)
    .where(
      and(
        eq(schema.postmeta.key, META_THUMBNAIL),
        sql`(${schema.postmeta.value} #>> '{}') = ${String(attachment.id)}`,
      ),
    );
  await kernel.terms.clearObject(attachment.id);
  await kernel.db.delete(schema.posts).where(eq(schema.posts.id, attachment.id));

  const attachedFile = typeof meta?.[META_FILE] === 'string' ? (meta[META_FILE] as string) : '';
  if (attachedFile) {
    const storage = mediaStorage(kernel);
    const metadata = (meta?.[META_METADATA] ?? {}) as AttachmentMetadata;
    // Another attachment may share a file (imports do this); keep shared files.
    const files = attachmentFiles(attachedFile, metadata);
    const shared = await kernel.db
      .select({ value: schema.postmeta.value })
      .from(schema.postmeta)
      .where(
        and(
          eq(schema.postmeta.key, META_FILE),
          inArray(sql<string>`(${schema.postmeta.value} #>> '{}')`, files),
        ),
      );
    const keep = new Set(shared.map((row) => String(row.value)));
    await Promise.all(files.filter((f) => !keep.has(f)).map((f) => storage.delete(f)));
  }
  await kernel.hooks.doAction('deleted_post', attachment.id, attachment);
}
