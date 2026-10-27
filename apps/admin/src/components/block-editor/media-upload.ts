import { uploadMedia } from '@wordpress/media-utils';

/**
 * The editor's `mediaUpload` setting: what image, gallery, video, audio,
 * file and cover blocks call for uploads and drag-and-drop. It posts to
 * /wp/v2/media through api-fetch, as WordPress's editor does
 * (packages/editor/src/utils/media-upload).
 */

export const MEDIA_UNAVAILABLE =
  'Uploading needs the media library, which isn’t available yet. Use “Insert from URL” instead.';

type UploadArgs = Omit<Parameters<typeof uploadMedia>[0], 'onError'> & {
  onError?: (message: string) => void;
};

export function createMediaUpload({ available, postId }: { available: boolean; postId?: number }) {
  return function mediaUpload({ onError, additionalData, ...args }: UploadArgs) {
    if (!available) {
      onError?.(MEDIA_UNAVAILABLE);
      return;
    }
    uploadMedia({
      ...args,
      additionalData: { ...(postId ? { post: postId } : {}), ...additionalData },
      onError: (error) => onError?.(error.message),
    });
  };
}
