import { describe, expect, it } from 'vitest';
import { fileName, filterFor, formatBytes, previewUrl, type RestMedia, typeLabel } from './media';

const size = (file: string, width: number, height: number) => ({
  file,
  width,
  height,
  mime_type: 'image/jpeg',
  source_url: `https://example.com/wp-content/uploads/2026/10/${file}`,
});

const photo = {
  media_type: 'image',
  mime_type: 'image/jpeg',
  source_url: 'https://example.com/wp-content/uploads/2026/10/caf%C3%A9.jpg',
  media_details: {
    sizes: {
      thumbnail: size('café-150x150.jpg', 150, 150),
      medium: size('café-300x200.jpg', 300, 200),
      large: size('café-1024x683.jpg', 1024, 683),
      full: size('café.jpg', 1200, 800),
    },
  },
} as unknown as RestMedia;

describe('media helpers', () => {
  it('formats sizes in binary units', () => {
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(900)).toBe('900 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('groups MIME types like the type filter', () => {
    expect(filterFor('image/png')).toBe('image');
    expect(filterFor('video/mp4')).toBe('video');
    expect(filterFor('application/pdf')).toBe('document');
    expect(filterFor('text/csv')).toBe('document');
  });

  it('picks the smallest size that fills a tile', () => {
    expect(previewUrl(photo)).toMatch(/café-300x200\.jpg$/);
    expect(previewUrl(photo, 600)).toMatch(/café-1024x683\.jpg$/);
    expect(previewUrl({ ...photo, media_type: 'file' })).toBeUndefined();
  });

  it('names files and types for people', () => {
    expect(fileName(photo)).toBe('café.jpg');
    expect(typeLabel(photo)).toBe('JPEG');
    expect(typeLabel({ ...photo, source_url: 'https://x/a.pdf' })).toBe('PDF');
  });
});
