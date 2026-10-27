/**
 * Client-side shapes and helpers for the media library (/wp/v2/media).
 */

export interface RestMediaSize {
  file: string;
  width: number;
  height: number;
  mime_type: string;
  filesize?: number;
  source_url: string;
}

export interface RestMedia {
  id: number;
  date: string;
  date_gmt: string;
  modified: string;
  slug: string;
  status: string;
  type: 'attachment';
  link: string;
  title: { raw?: string; rendered: string };
  author: number;
  caption: { raw?: string; rendered: string };
  description: { raw?: string; rendered: string };
  alt_text: string;
  media_type: 'image' | 'file';
  mime_type: string;
  media_details: {
    width?: number;
    height?: number;
    file?: string;
    filesize?: number;
    original_image?: string;
    sizes: Partial<Record<string, RestMediaSize>>;
  };
  post: number | null;
  source_url: string;
  missing_image_sizes?: string[];
}

/** The library's type filter: each maps to WordPress media types (the MIME type's first part). */
export type MediaFilter = 'all' | 'image' | 'document' | 'audio' | 'video';

export const MEDIA_FILTERS: { id: MediaFilter; label: string; mediaTypes: string[] }[] = [
  { id: 'all', label: 'All', mediaTypes: [] },
  { id: 'image', label: 'Images', mediaTypes: ['image'] },
  { id: 'document', label: 'Documents', mediaTypes: ['application', 'text'] },
  { id: 'audio', label: 'Audio', mediaTypes: ['audio'] },
  { id: 'video', label: 'Video', mediaTypes: ['video'] },
];

/** What the file input offers for each filter, as `accept` values. */
export const ACCEPT: Record<MediaFilter, string> = {
  all: 'image/jpeg,image/png,image/gif,image/webp,image/avif,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.txt,.csv,audio/mpeg,audio/mp4,audio/ogg,audio/wav,.m4a,video/mp4,video/quicktime,video/webm',
  image: 'image/jpeg,image/png,image/gif,image/webp,image/avif',
  document: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.txt,.csv',
  audio: 'audio/mpeg,audio/mp4,audio/ogg,audio/wav,.mp3,.m4a,.ogg,.wav',
  video: 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm',
};

/** Which filter a MIME type belongs to. */
export function filterFor(mime: string): Exclude<MediaFilter, 'all'> {
  const group = mime.split('/')[0];
  if (group === 'image' || group === 'audio' || group === 'video') return group;
  return 'document';
}

/** "1.4 MB", "820 KB", "12 bytes" — binary units, as WordPress's size_format(). */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toLocaleString('en-US', { maximumFractionDigits: digits })} ${units[unit]}`;
}

/** The file's name, from its URL. */
export function fileName(media: Pick<RestMedia, 'source_url' | 'media_details'>): string {
  const fromUrl = decodeURIComponent(media.source_url.split('/').pop() ?? '');
  return fromUrl || media.media_details.file?.split('/').pop() || '';
}

/** Short type label for a file, e.g. "PDF", "JPEG", "MP4". */
export function typeLabel(media: Pick<RestMedia, 'mime_type' | 'source_url'>): string {
  const ext = media.source_url.split('.').pop()?.toLowerCase() ?? '';
  if (ext && ext.length <= 5) return ext === 'jpg' ? 'JPEG' : ext.toUpperCase();
  return media.mime_type.split('/')[1]?.toUpperCase() ?? media.mime_type;
}

/** The smallest stored size that's at least `min` pixels wide, for thumbnails. */
export function previewUrl(media: RestMedia, min = 300): string | undefined {
  if (media.media_type !== 'image') return undefined;
  const sizes = Object.values(media.media_details.sizes).filter((s): s is RestMediaSize =>
    Boolean(s),
  );
  const fitting = sizes
    .filter((s) => s.width >= min || s.height >= min)
    .sort((a, b) => a.width * a.height - b.width * b.height);
  return fitting[0]?.source_url ?? media.media_details.sizes.full?.source_url ?? media.source_url;
}

export interface UploadOptions {
  /** Extra fields: title, alt_text, caption, description, post. */
  fields?: Record<string, string>;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Uploads one file to /wp/v2/media as multipart/form-data. Uses XHR (not
 * fetch) because only XHR reports upload progress.
 */
export function uploadMedia(file: File, options: UploadOptions = {}): Promise<RestMedia> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/wp-json/wp/v2/media');
    xhr.withCredentials = true;
    // Required on writes; see requireRequestHeader in apps/core/src/http.ts.
    xhr.setRequestHeader('x-pressbase-request', '1');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      const data = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as RestMedia);
      else
        reject(
          new UploadError(
            xhr.status,
            data?.code ?? 'pressbase_unknown_error',
            uploadMessage(xhr.status, data?.code, data?.message),
          ),
        );
    };
    xhr.onerror = () =>
      reject(
        new UploadError(
          0,
          'pressbase_network_error',
          'The upload was interrupted. Check your connection and try again.',
        ),
      );
    xhr.onabort = () => reject(new UploadError(0, 'pressbase_upload_cancelled', 'Cancelled.'));
    options.signal?.addEventListener('abort', () => xhr.abort());

    const form = new FormData();
    form.append('file', file, file.name);
    for (const [key, value] of Object.entries(options.fields ?? {})) form.append(key, value);
    xhr.send(form);
  });
}

/** Turns server errors into a sentence that says what to do next. */
function uploadMessage(status: number, code?: string, message?: string): string {
  switch (code) {
    case 'rest_upload_invalid_type':
      return 'This file type isn’t allowed. Upload an image, PDF, document, audio or video file.';
    case 'rest_upload_file_too_big':
      return message ?? 'This file is too big.';
    case 'rest_cannot_create':
      return 'Your role can’t upload files. Ask an administrator for access.';
    default:
      if (status === 413) return 'This file is too big for the server. Try a smaller file.';
      return message ?? 'The upload failed. Please try again.';
  }
}
