import apiFetch from '@wordpress/api-fetch';
import { plainTitle } from '../../lib/content';
import { previewUrl, type RestMedia } from '../../lib/media';

/**
 * The inserter's Media tab (`inserterMediaCategories`): Images, Videos and
 * Audio from the media library, as @wordpress/editor's media-categories.js
 * provides them in WordPress. Dragging or clicking an item inserts an Image,
 * Video or Audio block (block-editor's getBlockAndPreviewFromMedia()).
 * Only offered when /wp/v2/media exists.
 */

/**
 * The editor's `allowedMimeTypes` setting (WordPress's get_allowed_mime_types()):
 * the Media tab only shows categories with an allowed type, and upload
 * buttons use it for their file filters. Mirrors ALLOWED_MIME_TYPES in
 * apps/core/src/media/mime.ts; core still checks every upload.
 */
export const ALLOWED_MIME_TYPES: Readonly<Record<string, string>> = {
  'jpg|jpeg|jpe': 'image/jpeg',
  gif: 'image/gif',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  csv: 'text/csv',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  'ogg|oga': 'audio/ogg',
  wav: 'audio/wav',
  'mp4|m4v': 'video/mp4',
  'mov|qt': 'video/quicktime',
  webm: 'video/webm',
};

export type InserterMediaType = 'image' | 'video' | 'audio';

/** What the Media tab asks for (block-editor's InserterMediaRequest). */
export interface InserterMediaRequest {
  per_page?: number;
  page?: number;
  search?: string;
}

/** One item, as the Media tab expects it (block-editor's InserterMediaItem). */
export interface InserterMediaItem {
  id: number;
  url: string;
  previewUrl?: string;
  alt?: string;
  caption?: string;
  title: string;
}

export interface InserterMediaResponse {
  mediaItems: InserterMediaItem[];
  totalItems?: number;
  totalPages?: number;
}

export interface InserterMediaCategory {
  name: string;
  labels: { name: string; search_items: string };
  mediaType: InserterMediaType;
  fetch: (query?: InserterMediaRequest) => Promise<InserterMediaResponse>;
}

/** A REST attachment → a Media tab item. Previews use the medium size, as WordPress does. */
export function toInserterItem(media: RestMedia): InserterMediaItem {
  return {
    id: media.id,
    url: media.source_url,
    previewUrl:
      media.media_details?.sizes?.medium?.source_url ??
      (media.media_details ? previewUrl(media) : undefined),
    alt: media.alt_text || undefined,
    caption: media.caption?.raw || plainTitle(media.caption?.rendered ?? '') || undefined,
    title: media.title?.raw ?? plainTitle(media.title?.rendered ?? ''),
  };
}

/** The /wp/v2/media path for a category and the tab's query. */
export function mediaQueryPath(mediaType: InserterMediaType, query: InserterMediaRequest = {}) {
  const q = new URLSearchParams({
    context: 'edit',
    media_type: mediaType,
    per_page: String(query.per_page ?? 20),
    orderby: query.search ? 'relevance' : 'date',
  });
  if (query.page && query.page > 1) q.set('page', String(query.page));
  if (query.search) q.set('search', query.search);
  return `/wp/v2/media?${q}`;
}

/** The parts of a fetch Response the categories read. */
interface FetchedResponse {
  ok: boolean;
  json(): Promise<unknown>;
  headers: { get(name: string): string | null };
}

type RawFetch = (options: { path: string; parse: false }) => Promise<FetchedResponse>;

const CATEGORIES: { name: string; label: string; search: string; mediaType: InserterMediaType }[] =
  [
    { name: 'images', label: 'Images', search: 'Search images', mediaType: 'image' },
    { name: 'videos', label: 'Videos', search: 'Search videos', mediaType: 'video' },
    { name: 'audio', label: 'Audio', search: 'Search audio', mediaType: 'audio' },
  ];

export function createInserterMediaCategories(
  fetcher: RawFetch = (options) => apiFetch(options) as Promise<FetchedResponse>,
): InserterMediaCategory[] {
  return CATEGORIES.map(({ name, label, search, mediaType }) => ({
    name,
    labels: { name: label, search_items: search },
    mediaType,
    async fetch(query = {}) {
      let response: FetchedResponse;
      let items: RestMedia[];
      try {
        response = await fetcher({ path: mediaQueryPath(mediaType, query), parse: false });
        if (!response.ok) return { mediaItems: [] };
        items = (await response.json()) as RestMedia[];
      } catch {
        // The tab shows "No results found." rather than breaking.
        return { mediaItems: [] };
      }
      const total = response.headers.get('X-WP-Total');
      const pages = response.headers.get('X-WP-TotalPages');
      return {
        mediaItems: Array.isArray(items) ? items.map(toInserterItem) : [],
        totalItems: total === null ? undefined : Number(total),
        totalPages: pages === null ? undefined : Number(pages),
      };
    },
  }));
}

/**
 * The categories with at least one item. Categories added through
 * registerInserterMediaCategory() are never checked by the Media tab, so an
 * empty Videos tab would show; this does the check WordPress's own does.
 */
export async function categoriesWithMedia(
  categories: readonly InserterMediaCategory[],
): Promise<InserterMediaCategory[]> {
  const found = await Promise.all(
    categories.map(async (category) => {
      try {
        return (await category.fetch({ per_page: 1 })).mediaItems.length > 0;
      } catch {
        return false;
      }
    }),
  );
  return categories.filter((_, index) => found[index]);
}
