import { escUrl } from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { z } from 'zod';
import type { Kernel } from '../kernel';
import type { AttachmentMetadata, SubSizeMeta } from '../media/images';
import {
  fileUrl,
  getMetaMap,
  META_FILE,
  META_METADATA,
  mediaStorage,
  setMeta,
} from '../media/service';
import type { SettingsRegistry } from '../options/settings';

/**
 * Site identity: the site logo and the site icon (favicon).
 *
 * - `site_logo` and `site_icon` are attachment IDs in options of those names,
 *   exposed at /wp/v2/settings as WordPress registers them
 *   (register_block_core_site_logo_setting(), register_initial_settings()).
 * - The site icon gets square crops at WP_Site_Icon's sizes (512, 270, 192,
 *   180, 32), stored next to the image as `site_icon-{size}` sub-sizes, made
 *   when the option changes (or on first use) — WP_Site_Icon::additional_sizes()
 *   with sharp, cropping the centre of non-square images.
 * - wp_site_icon() prints the icon links in the public page head, filterable
 *   with `site_icon_meta_tags`; get_site_icon_url() picks a size.
 * - Deleting the attachment clears the option (WP_Site_Icon::delete_attachment_data()).
 *
 * Changes arrive as `updated_option` (name, old, new), like any option.
 */

/** WP_Site_Icon::$min_size and $site_icon_sizes. */
export const SITE_ICON_SIZES = [512, 270, 192, 180, 32] as const;

const attachmentId = z.number({ message: 'Choose an image from the media library.' }).int().min(0);

/** register_setting( 'general', 'site_logo' | 'site_icon' ) */
export function registerSiteIdentitySettings(registry: SettingsRegistry): void {
  registry.register('site_logo', { option: 'site_logo', schema: attachmentId, default: 0 });
  registry.register('site_icon', { option: 'site_icon', schema: attachmentId, default: 0 });
}

const sizeName = (size: number) => `site_icon-${size}`;

async function readAll(stream: ReadableStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An image attachment's file key and metadata, or undefined. */
async function imageAttachment(kernel: Kernel, id: number) {
  if (!id) return undefined;
  const [post] = await kernel.db
    .select({ type: schema.posts.type, mime: schema.posts.mimeType })
    .from(schema.posts)
    .where(eq(schema.posts.id, id));
  if (post?.type !== 'attachment' || !post.mime.startsWith('image/')) return undefined;
  const meta = (await getMetaMap(kernel, [id], [META_FILE, META_METADATA])).get(id);
  const file = meta?.[META_FILE];
  if (typeof file !== 'string' || !file) return undefined;
  return { file, metadata: (meta?.[META_METADATA] ?? {}) as AttachmentMetadata };
}

/**
 * Creates the site icon sizes of an image that doesn't have them yet: PNG
 * squares, `photo-32x32.png` and so on, recorded in its metadata so they are
 * deleted with it. Returns false when the attachment isn't a usable image.
 */
export async function ensureSiteIconSizes(kernel: Kernel, id: number): Promise<boolean> {
  const image = await imageAttachment(kernel, id);
  if (!image) return false;
  const { file, metadata } = image;
  const missing = SITE_ICON_SIZES.filter((size) => !metadata.sizes?.[sizeName(size)]);
  if (!missing.length) return true;
  const storage = mediaStorage(kernel);
  const stream = await storage.read(file);
  if (!stream) return false;
  const data = await readAll(stream);
  const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  const base = file.slice(folder.length).replace(/\.[^.]+$/, '');
  const sizes: Record<string, SubSizeMeta> = { ...metadata.sizes };
  try {
    for (const size of missing) {
      const output = await sharp(data, { failOn: 'error' })
        .autoOrient()
        .resize(size, size, { fit: 'cover', position: 'centre' })
        .png()
        .toBuffer();
      const name = `${base}-${size}x${size}.png`;
      await storage.put(`${folder}${name}`, output, { contentType: 'image/png' });
      sizes[sizeName(size)] = {
        file: name,
        width: size,
        height: size,
        'mime-type': 'image/png',
        filesize: output.byteLength,
      };
    }
  } catch (error) {
    console.warn(`Could not make site icon sizes for attachment ${id}:`, error);
    return false;
  }
  await setMeta(kernel, id, META_METADATA, { ...metadata, sizes });
  return true;
}

/** get_site_icon_url( $size ): the closest size at least as big, or the full image. */
export async function siteIconUrl(kernel: Kernel, size = 512): Promise<string> {
  const id = Number(await kernel.options.get<number>('site_icon', 0)) || 0;
  if (!id) return '';
  await ensureSiteIconSizes(kernel, id);
  const image = await imageAttachment(kernel, id);
  if (!image) return '';
  const folder = image.file.includes('/')
    ? image.file.slice(0, image.file.lastIndexOf('/') + 1)
    : '';
  const fit = [...SITE_ICON_SIZES]
    .sort((a, b) => a - b)
    .find((candidate) => candidate >= size && image.metadata.sizes?.[sizeName(candidate)]);
  const sub = fit ? image.metadata.sizes?.[sizeName(fit)] : undefined;
  return fileUrl(kernel, sub ? `${folder}${sub.file}` : image.file);
}

/** wp_site_icon(): the icon links for the page head ('' without a site icon). */
export async function siteIconTags(kernel: Kernel): Promise<string> {
  const id = Number(await kernel.options.get<number>('site_icon', 0)) || 0;
  if (!id) return '';
  const [icon32, icon192, icon180, icon270] = await Promise.all(
    [32, 192, 180, 270].map((size) => siteIconUrl(kernel, size)),
  );
  const tags: string[] = [];
  if (icon32) tags.push(`<link rel="icon" href="${escUrl(icon32)}" sizes="32x32" />`);
  if (icon192) tags.push(`<link rel="icon" href="${escUrl(icon192)}" sizes="192x192" />`);
  if (icon180) tags.push(`<link rel="apple-touch-icon" href="${escUrl(icon180)}" />`);
  if (icon270) tags.push(`<meta name="msapplication-TileImage" content="${escUrl(icon270)}" />`);
  const filtered = (await kernel.hooks.applyFilters('site_icon_meta_tags', tags)) as string[];
  return filtered.filter((tag) => typeof tag === 'string' && tag).join('\n');
}

/** The REST index's identity fields (WP_REST_Server::get_index(), add_site_logo_to_index()…). */
export async function siteIdentityIndex(kernel: Kernel) {
  return {
    site_logo: Number(await kernel.options.get<number>('site_logo', 0)) || 0,
    site_icon: Number(await kernel.options.get<number>('site_icon', 0)) || 0,
    site_icon_url: await siteIconUrl(kernel),
  };
}

/** Makes icon sizes when the option changes; forgets a deleted logo or icon. */
export function registerSiteIdentityHooks(kernel: Kernel): void {
  kernel.hooks.addAction('updated_option', async (...args: unknown[]) => {
    const [name, , value] = args;
    if (name === 'site_icon' && Number(value) > 0) await ensureSiteIconSizes(kernel, Number(value));
  });
  kernel.hooks.addAction('delete_attachment', async (...args: unknown[]) => {
    const id = Number(args[0]);
    for (const option of ['site_icon', 'site_logo']) {
      if (Number(await kernel.options.get<number>(option, 0)) === id) {
        await kernel.options.set(option, 0);
      }
    }
  });
}
