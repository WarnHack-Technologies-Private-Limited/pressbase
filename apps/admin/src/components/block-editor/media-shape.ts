import type { RestMedia } from '@/lib/media';
import type { MediaKind } from '../media/media-picker';

/** Pure helpers for the media-library bridge (kept out of the .tsx so they can be unit-tested). */

/** A REST attachment in the shape blocks expect from WordPress's media modal. */
export function toEditorMedia(media: RestMedia) {
  const sizes = Object.fromEntries(
    Object.entries(media.media_details?.sizes ?? {}).flatMap(([name, size]) =>
      size ? [[name, { url: size.source_url, width: size.width, height: size.height }]] : [],
    ),
  );
  const [type = 'file', subtype = ''] = media.mime_type.split('/');
  return {
    id: media.id,
    url: media.source_url,
    link: media.link,
    alt: media.alt_text,
    caption: media.caption?.raw ?? '',
    title: media.title?.raw ?? media.title?.rendered ?? '',
    mime: media.mime_type,
    type,
    subtype,
    width: media.media_details?.width,
    height: media.media_details?.height,
    sizes,
    media_details: media.media_details,
  };
}

/** Block allowedTypes (["image"], ["video"], MIME types…) → picker filters; undefined means everything. */
export function kindsFor(allowed?: string[]): MediaKind[] | undefined {
  if (!allowed?.length) return undefined;
  const kinds = new Set<MediaKind>();
  for (const type of allowed) {
    const top = type.split('/')[0];
    if (top === 'image' || top === 'audio' || top === 'video') kinds.add(top);
    else return undefined;
  }
  return [...kinds];
}
