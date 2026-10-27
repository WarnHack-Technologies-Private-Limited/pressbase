import { schema } from '@pressbase/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Kernel } from '../kernel';
import { RESIZABLE_IMAGE_TYPES } from './mime';
import { deleteMeta, META_THUMBNAIL, setMeta } from './service';

/**
 * Featured images — get_post_thumbnail_id(), set_post_thumbnail() and
 * delete_post_thumbnail() (wordpress/wp-includes/post-thumbnail-template.php,
 * post.php). Stored as the post's `_thumbnail_id` meta.
 */

/** `_thumbnail_id` for each post that has one. */
export async function featuredMediaIds(
  kernel: Kernel,
  ids: number[],
): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await kernel.db
    .select({ postId: schema.postmeta.postId, value: schema.postmeta.value })
    .from(schema.postmeta)
    .where(and(inArray(schema.postmeta.postId, ids), eq(schema.postmeta.key, META_THUMBNAIL)));
  const out = new Map<number, number>();
  for (const row of rows) {
    const id = Number(row.value);
    if (Number.isInteger(id) && id > 0) out.set(row.postId, id);
  }
  return out;
}

/** set_post_thumbnail() accepts only image attachments. 0 clears the featured image. */
export async function isValidFeaturedMedia(kernel: Kernel, id: number): Promise<boolean> {
  if (id === 0) return true;
  const attachment = await kernel.posts.get(id);
  return attachment?.type === 'attachment' && RESIZABLE_IMAGE_TYPES.has(attachment.mimeType);
}

/** Sets or (with 0) removes a post's featured image. Validate first with isValidFeaturedMedia. */
export async function setFeaturedMedia(
  kernel: Kernel,
  postId: number,
  mediaId: number | undefined,
): Promise<void> {
  if (mediaId === undefined) return;
  if (mediaId) await setMeta(kernel, postId, META_THUMBNAIL, mediaId);
  else await deleteMeta(kernel, postId, META_THUMBNAIL);
}
