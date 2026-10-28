import { describe, expect, it, vi } from 'vitest';
import {
  type EditorPost,
  EditorStore,
  editorSnapshot,
  mergeMeta,
  metaChanges,
  normalizeEdits,
  permalinkFor,
} from './editor';

const fields: Omit<EditorPost, 'blocks'> = {
  id: 12,
  type: 'post',
  status: 'draft',
  title: 'Spring planting',
  content: '<!-- wp:paragraph --><p>Seeds first.</p><!-- /wp:paragraph -->',
  slug: 'spring-planting',
  excerpt: '',
  featured_media: 0,
  categories: [1],
  tags: [],
  terms: { categories: [{ id: 1, name: 'Uncategorized' }], tags: [] },
  meta: { _yoast_wpseo_metadesc: '' },
  link: 'https://example.com/spring-planting/',
  permalink: 'https://example.com/spring-planting/',
  isDirty: false,
  isSaving: false,
};

describe('EditorStore', () => {
  it('is empty outside the editor and refuses edits there', () => {
    const store = new EditorStore();
    expect(store.getPost()).toBeNull();
    expect(store.getEditedPostAttribute('title')).toBeUndefined();
    expect(store.editPost({ meta: { a: 1 } })).toBe(false);
  });

  it('publishes snapshots to subscribers and reads attributes by REST name', () => {
    const store = new EditorStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const post = editorSnapshot(fields, () => null);
    store.publish(post);
    store.publish(post); // the same snapshot: no notification
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getPost()).toBe(post);
    expect(store.getEditedPostAttribute('title')).toBe('Spring planting');
    expect(store.getEditedPostAttribute('featured_media')).toBe(0);
  });

  it('passes checked edits to the connected editor, and clears the post on disconnect', () => {
    const store = new EditorStore();
    const handler = vi.fn();
    const disconnect = store.connect(handler);
    store.publish(editorSnapshot(fields, () => null));
    expect(
      store.editPost({ meta: { _yoast_wpseo_metadesc: 'How to start.' }, slug: 'spring' }),
    ).toBe(true);
    expect(handler).toHaveBeenCalledWith({
      meta: { _yoast_wpseo_metadesc: 'How to start.' },
      slug: 'spring',
    });
    disconnect();
    expect(store.getPost()).toBeNull();
    expect(store.editPost({ excerpt: 'x' })).toBe(false);
  });

  it('ignores a stale disconnect after another editor connected', () => {
    const store = new EditorStore();
    const first = store.connect(() => {});
    const second = vi.fn();
    store.connect(second);
    first();
    store.editPost({ excerpt: 'Still here' });
    expect(second).toHaveBeenCalledWith({ excerpt: 'Still here' });
  });
});

describe('normalizeEdits', () => {
  it('accepts meta, slug and excerpt', () => {
    expect(normalizeEdits({ meta: { a: 1 }, slug: 's', excerpt: 'e' })).toEqual({
      meta: { a: 1 },
      slug: 's',
      excerpt: 'e',
    });
  });

  it('names what is wrong', () => {
    expect(() => normalizeEdits(null)).toThrow('takes an object');
    expect(() => normalizeEdits({ title: 'New' })).toThrow('not "title"');
    expect(() => normalizeEdits({ meta: [] })).toThrow('editPost({ meta }) takes an object');
    expect(() => normalizeEdits({ slug: 3 })).toThrow('editPost({ slug }) takes a string');
  });
});

describe('meta helpers', () => {
  it('lists only the keys that changed', () => {
    expect(metaChanges({ a: '', b: [1] }, { a: 'x', b: [1] })).toEqual({ a: 'x' });
    expect(metaChanges(undefined, { a: false })).toEqual({ a: false });
    expect(metaChanges({ a: 1 }, { a: 1 })).toEqual({});
  });

  it('merges edits key by key and keeps the object when nothing changes', () => {
    const meta = { a: 1, b: 2 };
    expect(mergeMeta(meta, { b: 3 })).toEqual({ a: 1, b: 3 });
    expect(mergeMeta(meta, { b: 2 })).toBe(meta);
    expect(mergeMeta(meta, undefined)).toBe(meta);
  });
});

describe('permalinkFor', () => {
  it('swaps the saved slug for the edited one in pretty permalinks', () => {
    expect(permalinkFor('https://example.com/2026/10/old-slug/', 'old-slug', 'new-slug')).toBe(
      'https://example.com/2026/10/new-slug/',
    );
    expect(permalinkFor('https://example.com/old', 'old', 'new')).toBe('https://example.com/new');
  });

  it('fills a %postname% template', () => {
    expect(permalinkFor('https://example.com/%postname%/', '', 'draft-post')).toBe(
      'https://example.com/draft-post/',
    );
  });

  it('leaves plain and unrelated links alone', () => {
    expect(permalinkFor('https://example.com/?p=12', 'a', 'b')).toBe('https://example.com/?p=12');
    expect(permalinkFor('https://example.com/other/', 'a', 'b')).toBe('https://example.com/other/');
    expect(permalinkFor('', 'a', 'b')).toBe('');
  });
});

describe('editorSnapshot', () => {
  it('parses blocks on first read, once', () => {
    const parse = vi.fn(() => [{ name: 'core/paragraph', attributes: {}, innerBlocks: [] }]);
    const post = editorSnapshot(fields, () => parse);
    expect(parse).not.toHaveBeenCalled();
    expect(post.blocks).toHaveLength(1);
    expect(post.blocks).toBe(post.blocks);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(post)).toBe(true);
  });

  it('has no blocks until a parser is there, then parses', () => {
    let parser: ((markup: string) => unknown[]) | null = null;
    const post = editorSnapshot(fields, () => parser);
    expect(post.blocks).toEqual([]);
    parser = () => [{ name: 'core/heading', attributes: {}, innerBlocks: [] }];
    expect(post.blocks[0]?.name).toBe('core/heading');
  });
});
