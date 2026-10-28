import { describe, expect, it } from 'vitest';
import { COLOR_SCHEME_STORAGE_KEY, colorSchemeScript, parseColorScheme } from './color-scheme';

/** Runs the inline script against a fake <html> and localStorage. */
function run(script: string, stored: string | null, { storageThrows = false } = {}) {
  const attributes = new Map<string, string>([['data-theme', 'stale']]);
  const storage = new Map<string, string>();
  if (stored !== null) storage.set(COLOR_SCHEME_STORAGE_KEY, stored);
  const document = {
    documentElement: {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    },
  };
  const localStorage = {
    getItem: (key: string) => {
      if (storageThrows) throw new Error('SecurityError');
      return storage.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (storageThrows) throw new Error('SecurityError');
      storage.set(key, value);
    },
  };
  new Function('document', 'localStorage', script)(document, localStorage);
  return { theme: attributes.get('data-theme'), stored: storage.get(COLOR_SCHEME_STORAGE_KEY) };
}

describe('color scheme', () => {
  it('accepts only light and dark as overrides', () => {
    expect(parseColorScheme('dark')).toBe('dark');
    expect(parseColorScheme('light')).toBe('light');
    expect(parseColorScheme('system')).toBe('system');
    expect(parseColorScheme('purple')).toBe('system');
    expect(parseColorScheme(undefined)).toBe('system');
  });

  it('applies the remembered scheme before paint', () => {
    expect(run(colorSchemeScript(), 'dark').theme).toBe('dark');
    expect(run(colorSchemeScript(), 'light').theme).toBe('light');
    expect(run(colorSchemeScript(), 'system').theme).toBeUndefined();
    expect(run(colorSchemeScript(), null).theme).toBeUndefined();
    expect(run(colorSchemeScript(), '"><script>').theme).toBeUndefined();
  });

  it('prefers the account’s scheme and refreshes the local copy', () => {
    expect(run(colorSchemeScript('dark'), 'light')).toEqual({ theme: 'dark', stored: 'dark' });
    expect(run(colorSchemeScript('system'), 'dark')).toEqual({
      theme: undefined,
      stored: 'system',
    });
  });

  it('still works when storage is blocked', () => {
    expect(run(colorSchemeScript(), 'dark', { storageThrows: true }).theme).toBeUndefined();
    expect(run(colorSchemeScript('dark'), null, { storageThrows: true }).theme).toBe('dark');
  });
});
