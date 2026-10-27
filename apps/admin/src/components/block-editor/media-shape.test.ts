import { describe, expect, it } from 'vitest';
import type { RestMedia } from '@/lib/media';
import { kindsFor, toEditorMedia } from './media-shape';

const media = {
  id: 7,
  link: 'http://localhost:3000/?attachment_id=7',
  source_url: 'http://localhost:3000/wp-content/uploads/2026/10/photo.jpg',
  alt_text: 'A calm desk',
  caption: { raw: 'Morning light', rendered: '<p>Morning light</p>' },
  title: { raw: 'photo', rendered: 'photo' },
  mime_type: 'image/jpeg',
  media_type: 'image',
  media_details: {
    width: 1200,
    height: 800,
    sizes: {
      medium: {
        file: 'photo-300x200.jpg',
        width: 300,
        height: 200,
        mime_type: 'image/jpeg',
        source_url: 'http://localhost:3000/wp-content/uploads/2026/10/photo-300x200.jpg',
      },
    },
  },
} as unknown as RestMedia;

describe('media library bridge', () => {
  it('gives blocks the media-modal shape they expect', () => {
    expect(toEditorMedia(media)).toMatchObject({
      id: 7,
      url: media.source_url,
      alt: 'A calm desk',
      caption: 'Morning light',
      type: 'image',
      subtype: 'jpeg',
      width: 1200,
      sizes: { medium: { url: expect.stringContaining('300x200'), width: 300, height: 200 } },
    });
  });

  it('maps block allowedTypes onto picker filters', () => {
    expect(kindsFor(['image'])).toEqual(['image']);
    expect(kindsFor(['image', 'video'])).toEqual(['image', 'video']);
    expect(kindsFor(['application/pdf'])).toBeUndefined();
    expect(kindsFor(undefined)).toBeUndefined();
  });
});
