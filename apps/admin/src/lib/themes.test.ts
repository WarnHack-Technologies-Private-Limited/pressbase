import { describe, expect, it } from 'vitest';
import { type RestTheme, sortThemes, themeName } from './themes';

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
