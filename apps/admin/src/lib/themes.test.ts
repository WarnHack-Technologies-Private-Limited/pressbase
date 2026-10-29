import { describe, expect, it } from 'vitest';
import {
  canDeleteTheme,
  fileSize,
  isZipFile,
  type RestTheme,
  sortThemes,
  themeName,
  themeUploadMessage,
} from './themes';

const theme = (stylesheet: string, name: string, status: RestTheme['status']): RestTheme => ({
  stylesheet,
  template: stylesheet,
  name: { raw: name, rendered: name },
  description: { raw: '', rendered: '' },
  version: '1.0',
  author: { raw: '', rendered: '' },
  author_uri: { raw: '', rendered: '' },
  theme_uri: { raw: '', rendered: '' },
  screenshot: '',
  status,
  tags: { raw: [], rendered: '' },
  requires_wp: '',
  requires_php: '',
  textdomain: stylesheet,
  is_block_theme: true,
  pressbase_source: 'site',
  pressbase_deletable: status === 'inactive',
});

describe('sortThemes', () => {
  it('lists the active theme first, then by name', () => {
    const sorted = sortThemes([
      theme('zeta', 'Zeta', 'inactive'),
      theme('alpha', 'Alpha', 'inactive'),
      theme('tt5', 'Twenty Twenty-Five', 'active'),
    ]);
    expect(sorted.map((t) => t.stylesheet)).toEqual(['tt5', 'alpha', 'zeta']);
  });
});

describe('themeName', () => {
  it('falls back to the folder name', () => {
    expect(themeName(theme('my-theme', '  ', 'inactive'))).toBe('my-theme');
  });
});

describe('canDeleteTheme', () => {
  it('follows pressbase_deletable, never for the active theme', () => {
    expect(canDeleteTheme(theme('a', 'A', 'inactive'))).toBe(true);
    expect(canDeleteTheme({ ...theme('a', 'A', 'inactive'), pressbase_deletable: false })).toBe(
      false,
    );
    expect(canDeleteTheme({ ...theme('a', 'A', 'active'), pressbase_deletable: true })).toBe(false);
  });
});

describe('theme uploads', () => {
  it('accepts .zip files only', () => {
    expect(isZipFile({ name: 'sunny.zip', type: '' })).toBe(true);
    expect(isZipFile({ name: 'SUNNY.ZIP', type: '' })).toBe(true);
    expect(isZipFile({ name: 'download', type: 'application/x-zip-compressed' })).toBe(true);
    expect(isZipFile({ name: 'sunny.tar.gz', type: 'application/gzip' })).toBe(false);
  });

  it('formats sizes', () => {
    expect(fileSize(200)).toBe('1 KB');
    expect(fileSize(512 * 1024)).toBe('512 KB');
    expect(fileSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('turns server errors into next steps', () => {
    expect(themeUploadMessage(400, 'incompatible_archive_theme_no_style')).toMatch(/no style\.css/);
    expect(themeUploadMessage(400, 'pressbase_theme_not_block_theme')).toMatch(
      /only runs block themes/,
    );
    expect(themeUploadMessage(400, 'pressbase_theme_not_block_theme', 'Classic is classic.')).toBe(
      'Classic is classic.',
    );
    expect(themeUploadMessage(400, 'incompatible_archive_path', 'Unsafe path.')).toBe(
      'This .zip was refused for safety. Unsafe path.',
    );
    expect(themeUploadMessage(403, 'rest_cannot_install_theme')).toMatch(/Ask an administrator/);
    expect(themeUploadMessage(413, 'whatever')).toMatch(/too big/);
    expect(themeUploadMessage(500)).toMatch(/couldn’t be installed/);
  });
});
