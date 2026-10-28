import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import { authorPostsUrl, siteInfo, termLink } from '../blocks/helpers';
import { addCacheTags, CacheTag } from '../cache/tags';
import type { Term } from '../content/terms';
import type { Kernel } from '../kernel';
import type { AttachmentMetadata } from '../media/images';
import { fileUrl, META_ALT, META_FILE, META_METADATA } from '../media/service';

/**
 * Small read helpers for `api.content` that WordPress plugins get from
 * template tags: get_term_link(), get_userdata() with get_author_posts_url(),
 * and wp_get_attachment_image_src() with the image's alt text.
 */

/** A post author as plugins see it: no email, login or password. */
export interface ContentAuthor {
  id: number;
  name: string;
  nicename: string;
  description: string;
  /** get_author_posts_url() */
  url: string;
}

/** wp_get_attachment_image_src() plus `alt` (`_wp_attachment_image_alt`). */
export interface AttachmentImage {
  id: number;
  url: string;
  width: number;
  height: number;
  alt: string;
  mimeType: string;
}

/** get_term_link() */
export async function contentTermLink(
  kernel: Kernel,
  term: Pick<Term, 'id' | 'slug' | 'taxonomy'>,
): Promise<string> {
  return termLink(await siteInfo(kernel), term);
}

/** get_userdata()'s public fields and get_author_posts_url(), or undefined. */
export async function contentAuthor(
  kernel: Kernel,
  id: number,
): Promise<ContentAuthor | undefined> {
  const { users } = schema;
  const [row] = await kernel.db
    .select({
      id: users.id,
      name: users.displayName,
      nicename: users.nicename,
      login: users.login,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!row) return undefined;
  addCacheTags(CacheTag.author(row.id));
  const description = await kernel.meta.get('user', row.id, 'description', true);
  return {
    id: row.id,
    name: row.name || row.login,
    nicename: row.nicename,
    description: typeof description === 'string' ? description : '',
    url: authorPostsUrl(await siteInfo(kernel), row),
  };
}

/**
 * wp_get_attachment_image_src( $id, $size ): the image's URL and size
 * (`full`, or a registered sub-size that exists, falling back to full), or
 * false when `id` isn't an image attachment.
 */
export async function contentAttachmentImage(
  kernel: Kernel,
  id: number,
  size = 'full',
): Promise<AttachmentImage | false> {
  const post = await kernel.posts.get(id);
  if (post?.type !== 'attachment' || !post.mimeType.startsWith('image/')) return false;
  const file = await kernel.meta.get('post', id, META_FILE, true);
  if (typeof file !== 'string' || !file) return false;
  const metadata = ((await kernel.meta.get('post', id, META_METADATA, true)) ??
    {}) as AttachmentMetadata;
  const alt = await kernel.meta.get('post', id, META_ALT, true);
  const sub = size === 'full' ? undefined : metadata.sizes?.[size];
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  return {
    id,
    url: await fileUrl(kernel, sub?.file ? `${dir}${sub.file}` : file),
    width: Number(sub?.width ?? metadata.width ?? 0),
    height: Number(sub?.height ?? metadata.height ?? 0),
    alt: typeof alt === 'string' ? alt : '',
    mimeType: post.mimeType,
  };
}
