import sharp, { type Sharp } from 'sharp';
import type { Kernel } from '../kernel';
import type { MediaStorage } from './storage';

/**
 * Image processing — ports of wp_get_registered_image_subsizes(),
 * image_resize_dimensions() and wp_constrain_dimensions() (wordpress/wp-includes/media.php)
 * and wp_create_image_subsizes() (wordpress/wp-admin/includes/image.php),
 * with sharp in place of GD/Imagick.
 */

export interface ImageSize {
  width: number;
  height: number;
  crop: boolean;
}

export interface SubSizeMeta {
  file: string;
  width: number;
  height: number;
  /** WordPress stores the hyphenated key; the REST API renames it to mime_type. */
  'mime-type': string;
  filesize: number;
}

/** The `_wp_attachment_metadata` shape for images (wp_generate_attachment_metadata()). */
export interface AttachmentMetadata {
  width?: number;
  height?: number;
  file?: string;
  filesize?: number;
  sizes?: Record<string, SubSizeMeta>;
  image_meta?: ImageMeta;
  original_image?: string;
}

/** wp_read_image_metadata()'s keys. Pressbase fills the orientation; the rest stay empty. */
export interface ImageMeta {
  aperture: number;
  credit: string;
  camera: string;
  caption: string;
  created_timestamp: number;
  copyright: string;
  focal_length: number;
  iso: number;
  shutter_speed: number;
  title: string;
  orientation: number;
  keywords: string[];
  alt: string;
}

/** The big image threshold (filter `big_image_size_threshold`; false or 0 disables it). */
export const BIG_IMAGE_THRESHOLD = 2560;

/**
 * wp_get_registered_image_subsizes(): the default sizes from Settings → Media,
 * plus WordPress's 1536x1536 and 2048x2048 sizes used for srcset.
 * Filter `intermediate_image_sizes_advanced` can add or remove sizes.
 */
export async function registeredImageSizes(kernel: Kernel): Promise<Record<string, ImageSize>> {
  const opt = (name: string, fallback: number) =>
    kernel.options.get<number>(name, fallback).then((v) => Math.max(0, Number(v) || 0));
  return {
    thumbnail: {
      width: await opt('thumbnail_size_w', 150),
      height: await opt('thumbnail_size_h', 150),
      crop: Boolean(await kernel.options.get<boolean>('thumbnail_crop', true)),
    },
    medium: {
      width: await opt('medium_size_w', 300),
      height: await opt('medium_size_h', 300),
      crop: false,
    },
    medium_large: {
      width: await opt('medium_large_size_w', 768),
      height: await opt('medium_large_size_h', 0),
      crop: false,
    },
    large: {
      width: await opt('large_size_w', 1024),
      height: await opt('large_size_h', 1024),
      crop: false,
    },
    '1536x1536': { width: 1536, height: 1536, crop: false },
    '2048x2048': { width: 2048, height: 2048, crop: false },
  };
}

/** wp_constrain_dimensions(): fits a box without changing the aspect ratio. */
export function constrainDimensions(
  width: number,
  height: number,
  maxWidth = 0,
  maxHeight = 0,
): [number, number] {
  if (!maxWidth && !maxHeight) return [width, height];
  let widthRatio = 1;
  let heightRatio = 1;
  let didWidth = false;
  let didHeight = false;
  if (maxWidth > 0 && width > 0 && width > maxWidth) {
    widthRatio = maxWidth / width;
    didWidth = true;
  }
  if (maxHeight > 0 && height > 0 && height > maxHeight) {
    heightRatio = maxHeight / height;
    didHeight = true;
  }
  const smaller = Math.min(widthRatio, heightRatio);
  const larger = Math.max(widthRatio, heightRatio);
  const ratio =
    Math.round(width * larger) > maxWidth || Math.round(height * larger) > maxHeight
      ? smaller
      : larger;
  let w = Math.max(1, Math.round(width * ratio));
  let h = Math.max(1, Math.round(height * ratio));
  // Round up results that are one pixel short of the box, as WordPress does.
  if (didWidth && w === maxWidth - 1) w = maxWidth;
  if (didHeight && h === maxHeight - 1) h = maxHeight;
  return [w, h];
}

export interface ResizePlan {
  /** Source rectangle to crop from (the whole image when not cropping). */
  left: number;
  top: number;
  cropWidth: number;
  cropHeight: number;
  /** Output size. */
  width: number;
  height: number;
}

/**
 * image_resize_dimensions(): the crop and output size for a sub-size, or
 * undefined when the image is already smaller (images are never upscaled) or
 * the result would be the same size as the original.
 */
export function resizeDimensions(
  origW: number,
  origH: number,
  destW: number,
  destH: number,
  crop: boolean,
): ResizePlan | undefined {
  if (origW <= 0 || origH <= 0) return undefined;
  if (destW <= 0 && destH <= 0) return undefined;

  // Stop if the destination size is larger than the original image.
  if (!destH) {
    if (origW < destW) return undefined;
  } else if (!destW) {
    if (origH < destH) return undefined;
  } else if (origW < destW && origH < destH) {
    return undefined;
  }

  let newW: number;
  let newH: number;
  let cropW: number;
  let cropH: number;
  let left = 0;
  let top = 0;
  if (crop) {
    const aspect = origW / origH;
    newW = Math.min(destW, origW);
    newH = Math.min(destH, origH);
    if (!newW) newW = Math.round(newH * aspect);
    if (!newH) newH = Math.round(newW / aspect);
    const sizeRatio = Math.max(newW / origW, newH / origH);
    cropW = Math.round(newW / sizeRatio);
    cropH = Math.round(newH / sizeRatio);
    left = Math.floor((origW - cropW) / 2);
    top = Math.floor((origH - cropH) / 2);
  } else {
    cropW = origW;
    cropH = origH;
    [newW, newH] = constrainDimensions(origW, origH, destW, destH);
  }

  // wp_fuzzy_number_match(): within a pixel of the original means "same size".
  if (Math.abs(newW - origW) <= 1 && Math.abs(newH - origH) <= 1) return undefined;
  return {
    left,
    top,
    cropWidth: Math.min(cropW, origW),
    cropHeight: Math.min(cropH, origH),
    width: newW,
    height: newH,
  };
}

function emptyImageMeta(orientation: number): ImageMeta {
  return {
    aperture: 0,
    credit: '',
    camera: '',
    caption: '',
    created_timestamp: 0,
    copyright: '',
    focal_length: 0,
    iso: 0,
    shutter_speed: 0,
    title: '',
    orientation,
    keywords: [],
    alt: '',
  };
}

/** Encodes in the source format, the way WordPress keeps the original format. */
function encode(image: Sharp, mime: string): Sharp {
  switch (mime) {
    case 'image/jpeg':
      return image.jpeg({ quality: 82, mozjpeg: true });
    case 'image/png':
      return image.png({ compressionLevel: 9 });
    case 'image/webp':
      return image.webp({ quality: 86 });
    case 'image/avif':
      return image.avif({ quality: 60 });
    case 'image/gif':
      return image.gif();
    default:
      return image;
  }
}

/** `photo.jpg` + `300x200` → `photo-300x200.jpg` (WP_Image_Editor::generate_filename()). */
export function suffixedName(file: string, suffix: string): string {
  const dot = file.lastIndexOf('.');
  return dot > 0 ? `${file.slice(0, dot)}-${suffix}${file.slice(dot)}` : `${file}-${suffix}`;
}

/**
 * wp_create_image_subsizes(): reads the image, writes the scaled or rotated
 * "full" image when needed, then each registered sub-size. Returns the
 * attachment metadata and the key now used as `_wp_attached_file`.
 *
 * Sub-sizes are made from the original upload (for the best quality), turned
 * upright from its EXIF orientation, with all metadata stripped.
 */
export async function createImageSubsizes(
  kernel: Kernel,
  storage: MediaStorage,
  key: string,
  data: Uint8Array,
  mime: string,
  attachmentId: number,
): Promise<{ metadata: AttachmentMetadata; attachedFile: string }> {
  const source = sharp(data, { failOn: 'error', limitInputPixels: 268_402_689 });
  const info = await source.metadata();
  const orientation = info.orientation ?? 0;
  // Width and height as displayed, after the EXIF orientation is applied.
  const rotatedSides = orientation >= 5 && orientation <= 8;
  const rawW = info.width ?? 0;
  const rawH = info.height ?? 0;
  const width = rotatedSides ? rawH : rawW;
  const height = rotatedSides ? rawW : rawH;

  const folder = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
  const fileName = key.slice(folder.length);

  let attachedFile = key;
  const metadata: AttachmentMetadata = {
    width,
    height,
    file: key,
    filesize: data.byteLength,
    sizes: {},
    image_meta: emptyImageMeta(orientation),
  };

  const threshold = Number(
    await kernel.hooks.applyFilters(
      'big_image_size_threshold',
      BIG_IMAGE_THRESHOLD,
      [width, height],
      key,
      attachmentId,
    ),
  );
  const scaleDown = threshold > 0 && (width > threshold || height > threshold);
  const needsRotation = orientation > 1;

  // Decode once, upright, as raw pixels: every output is encoded exactly once from these.
  const upright = await sharp(data, { failOn: 'error' })
    .autoOrient()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const fromUpright = () =>
    sharp(upright.data, {
      raw: {
        width: upright.info.width,
        height: upright.info.height,
        channels: upright.info.channels,
      },
    });

  if (scaleDown || needsRotation) {
    let image = fromUpright();
    let outW = width;
    let outH = height;
    if (scaleDown) {
      [outW, outH] = constrainDimensions(width, height, threshold, threshold);
      image = image.resize(outW, outH, { fit: 'fill' });
    }
    const output = await encode(image, mime).toBuffer({ resolveWithObject: true });
    const name = suffixedName(fileName, scaleDown ? 'scaled' : 'rotated');
    attachedFile = `${folder}${name}`;
    await storage.put(attachedFile, output.data, { contentType: mime });
    // _wp_image_meta_replace_original()
    metadata.width = output.info.width;
    metadata.height = output.info.height;
    metadata.file = attachedFile;
    metadata.filesize = output.data.byteLength;
    metadata.original_image = fileName;
    if (metadata.image_meta && needsRotation) metadata.image_meta.orientation = 1;
  }

  const sizes = (await kernel.hooks.applyFilters(
    'intermediate_image_sizes_advanced',
    await registeredImageSizes(kernel),
    metadata,
    attachmentId,
  )) as Record<string, ImageSize>;

  // Created in WordPress's priority order, so the most useful sizes exist first.
  const order = ['medium', 'large', 'thumbnail', 'medium_large'];
  const names = [
    ...order.filter((n) => n in sizes),
    ...Object.keys(sizes).filter((n) => !order.includes(n)),
  ];
  for (const name of names) {
    const size = sizes[name];
    if (!size) continue;
    const plan = resizeDimensions(width, height, size.width, size.height, size.crop);
    if (!plan) continue;
    let image = fromUpright();
    if (plan.cropWidth !== width || plan.cropHeight !== height) {
      image = image.extract({
        left: plan.left,
        top: plan.top,
        width: plan.cropWidth,
        height: plan.cropHeight,
      });
    }
    image = image.resize(plan.width, plan.height, { fit: 'fill' });
    const output = await encode(image, mime).toBuffer();
    const file = suffixedName(fileName, `${plan.width}x${plan.height}`);
    // Sizes with identical dimensions share one file, as in WordPress.
    if (!Object.values(metadata.sizes ?? {}).some((s) => s.file === file)) {
      await storage.put(`${folder}${file}`, output, { contentType: mime });
    }
    (metadata.sizes as Record<string, SubSizeMeta>)[name] = {
      file,
      width: plan.width,
      height: plan.height,
      'mime-type': mime,
      filesize: output.byteLength,
    };
  }

  return { metadata, attachedFile };
}

/** Width and height of an image, for validation. Undefined when it can't be decoded. */
export async function imageSize(
  data: Uint8Array,
): Promise<{ width: number; height: number } | undefined> {
  try {
    const info = await sharp(data).metadata();
    return info.width && info.height ? { width: info.width, height: info.height } : undefined;
  } catch {
    return undefined;
  }
}
