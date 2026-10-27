import { describe, expect, it, vi } from 'vitest';
import type { RestMedia } from '@/lib/media';
import {
  ALLOWED_MIME_TYPES,
  categoriesWithMedia,
  createInserterMediaCategories,
  mediaQueryPath,
  toInserterItem,
} from './media-categories';

const photo = {
  id: 7,
  source_url: 'http://localhost:3000/wp-content/uploads/2026/10/photo.jpg',
  alt_text: 'A calm desk',
  caption: { raw: 'Morning light', rendered: '<p>Morning light</p>\n' },
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

const response = (body: unknown, headers: Record<string, string> = {}, ok = true) => ({
  ok,
  json: async () => body,
  headers: { get: (name: string) => headers[name] ?? null },
});

describe('inserter media categories', () => {
  it('maps attachments to the Media tab shape', () => {
    expect(toInserterItem(photo)).toEqual({
      id: 7,
      url: photo.source_url,
      previewUrl: expect.stringContaining('300x200'),
      alt: 'A calm desk',
      caption: 'Morning light',
      title: 'photo',
    });
    const song = {
      ...photo,
      id: 8,
      alt_text: '',
      caption: { rendered: '' },
      title: { rendered: 'Theme &amp; variations' },
      media_type: 'file',
      mime_type: 'audio/mpeg',
      media_details: { sizes: {} },
    } as unknown as RestMedia;
    expect(toInserterItem(song)).toEqual({
      id: 8,
      url: photo.source_url,
      previewUrl: undefined,
      alt: undefined,
      caption: undefined,
      title: 'Theme & variations',
    });
  });

  it('queries /wp/v2/media by media type, search and page', () => {
    expect(mediaQueryPath('image', { per_page: 1 })).toBe(
      '/wp/v2/media?context=edit&media_type=image&per_page=1&orderby=date',
    );
    expect(mediaQueryPath('video', { per_page: 10, page: 2, search: 'sea' })).toBe(
      '/wp/v2/media?context=edit&media_type=video&per_page=10&orderby=relevance&page=2&search=sea',
    );
  });

  it('offers Images, Videos and Audio with pagination totals', async () => {
    const fetcher = vi.fn(async () =>
      response([photo], { 'X-WP-Total': '41', 'X-WP-TotalPages': '3' }),
    );
    const categories = createInserterMediaCategories(fetcher);
    expect(categories.map((c) => [c.name, c.labels.name, c.mediaType])).toEqual([
      ['images', 'Images', 'image'],
      ['videos', 'Videos', 'video'],
      ['audio', 'Audio', 'audio'],
    ]);
    // block-editor drops categories without an allowed MIME type of their kind.
    for (const category of categories) {
      expect(
        Object.values(ALLOWED_MIME_TYPES).some((m) => m.startsWith(`${category.mediaType}/`)),
      ).toBe(true);
    }
    const result = await categories[0]?.fetch({ per_page: 20, search: 'desk' });
    expect(fetcher).toHaveBeenCalledWith({
      path: expect.stringContaining('media_type=image'),
      parse: false,
    });
    expect(result).toMatchObject({ totalItems: 41, totalPages: 3, mediaItems: [{ id: 7 }] });
  });

  it('shows nothing instead of failing when the request fails', async () => {
    const failing = createInserterMediaCategories(async () => response({}, {}, false));
    expect(await failing[0]?.fetch()).toEqual({ mediaItems: [] });
    const throwing = createInserterMediaCategories(async () => {
      throw new Error('offline');
    });
    expect(await throwing[1]?.fetch()).toEqual({ mediaItems: [] });
  });

  it('keeps only the categories that have media', async () => {
    const categories = createInserterMediaCategories(async ({ path }) =>
      response(path.includes('media_type=image') ? [photo] : []),
    );
    expect((await categoriesWithMedia(categories)).map((c) => c.name)).toEqual(['images']);
  });
});
