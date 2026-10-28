import { describe, expect, it } from 'vitest';
import {
  backupKey,
  clearBackup,
  differs,
  newerAutosave,
  type RestAutosave,
  readBackup,
  usefulBackup,
  writeBackup,
} from './autosave';

const post = {
  id: 10,
  modified_gmt: '2026-10-27T10:00:00',
  title: 'Hello',
  content: '<p>Saved</p>',
  excerpt: '',
};

const autosave = (overrides: Partial<RestAutosave> = {}): RestAutosave => ({
  id: 99,
  author: 1,
  parent: 10,
  modified: '2026-10-27T15:31:00',
  modified_gmt: '2026-10-27T10:01:00',
  title: { raw: 'Hello' },
  content: { raw: '<p>Autosaved</p>' },
  excerpt: { raw: '' },
  ...overrides,
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe('newerAutosave', () => {
  it("offers the user's autosave when it is newer and different", () => {
    expect(newerAutosave(post, [autosave()], 1)?.id).toBe(99);
  });

  it('ignores older, identical or other people’s autosaves', () => {
    expect(newerAutosave(post, [autosave({ modified_gmt: '2026-10-27T09:59:00' })], 1)).toBeNull();
    expect(newerAutosave(post, [autosave({ content: { raw: ' <p>Saved</p>\n' } })], 1)).toBeNull();
    expect(newerAutosave(post, [autosave({ author: 2 })], 1)).toBeNull();
    // A draft autosave updates the post itself; that's not something to restore.
    expect(newerAutosave(post, [autosave({ id: 10 })], 1)).toBeNull();
  });
});

describe('local backups', () => {
  it('round-trips through storage and survives bad data', () => {
    const storage = memoryStorage();
    const key = backupKey('post', 10);
    expect(key).toBe('pressbase:editor-backup:post:10');
    expect(backupKey('page')).toBe('pressbase:editor-backup:page:new');

    const backup = { title: 'T', content: 'C', excerpt: '', savedAt: 1 };
    writeBackup(storage, key, backup);
    expect(readBackup(storage, key)).toEqual(backup);
    clearBackup(storage, key);
    expect(readBackup(storage, key)).toBeNull();

    storage.setItem(key, '{not json');
    expect(readBackup(storage, key)).toBeNull();
    storage.setItem(key, JSON.stringify({ title: 1 }));
    expect(readBackup(storage, key)).toBeNull();
    expect(readBackup(undefined, key)).toBeNull();
  });

  it('only offers copies written after the last save that say something new', () => {
    const after = Date.parse('2026-10-27T10:05:00Z');
    const saved = { title: 'Hello', content: '<p>Saved</p>', excerpt: '' };
    const copy = { ...saved, content: '<p>More</p>', savedAt: after };
    expect(usefulBackup(copy, saved, post.modified_gmt)).toEqual(copy);
    expect(
      usefulBackup({ ...copy, savedAt: after - 3_600_000 }, saved, post.modified_gmt),
    ).toBeNull();
    expect(usefulBackup({ ...saved, savedAt: after }, saved, post.modified_gmt)).toBeNull();
    expect(
      usefulBackup({ title: ' ', content: '', excerpt: '', savedAt: after }, saved),
    ).toBeNull();
  });

  it('keeps plugins’ unsaved meta edits, and offers a copy that only has those', () => {
    const storage = memoryStorage();
    const key = backupKey('post', 11);
    const saved = { title: 'Hello', content: '<p>Saved</p>', excerpt: '' };
    const copy = { ...saved, savedAt: Date.now(), meta: { _yoast_wpseo_focuskw: 'tomatoes' } };
    writeBackup(storage, key, copy);
    expect(readBackup(storage, key)).toEqual(copy);
    expect(usefulBackup(copy, saved)).toEqual(copy);
    expect(usefulBackup({ ...copy, meta: {} }, saved)).toBeNull();
    storage.setItem(key, JSON.stringify({ ...copy, meta: ['bad'] }));
    expect(readBackup(storage, key)).toBeNull();
  });

  it('compares like WordPress, ignoring whitespace runs', () => {
    const a = { title: 'A  title', content: 'x\r\n\r\ny', excerpt: '' };
    expect(differs(a, { title: 'A title', content: 'x\ny', excerpt: ' ' })).toBe(false);
    expect(differs(a, { ...a, excerpt: 'new' })).toBe(true);
  });
});
