import { describe, expect, it } from 'vitest';
import { exampleBase, examplePermalink, presetFor, toggleTag } from './permalinks';

describe('permalink helpers', () => {
  it('recognises the common settings', () => {
    expect(presetFor('')).toBe('plain');
    expect(presetFor('/%year%/%monthnum%/%day%/%postname%/')).toBe('day');
    expect(presetFor('/archives/%post_id%')).toBe('numeric');
    expect(presetFor('/%postname%/')).toBe('postname');
    expect(presetFor('/%category%/%postname%/')).toBe('custom');
  });

  it('adds and removes tags like the tag buttons', () => {
    expect(toggleTag('', '%postname%')).toBe('/%postname%/');
    expect(toggleTag('/%year%', '%postname%')).toBe('/%year%/%postname%/');
    expect(toggleTag('/%year%/%postname%/', '%year%')).toBe('/%postname%/');
    expect(toggleTag('/%postname%/', '%postname%')).toBe('');
  });

  it('shows example addresses', () => {
    const date = new Date(2026, 9, 28, 9, 5, 7);
    expect(
      examplePermalink('https://site.test/', '/%year%/%monthnum%/%day%/%postname%/', date),
    ).toBe('https://site.test/2026/10/28/sample-post/');
    expect(examplePermalink('https://site.test', '', date)).toBe('https://site.test/?p=123');
    expect(examplePermalink('https://site.test', '/archives/%post_id%', date)).toBe(
      'https://site.test/archives/123',
    );
    expect(exampleBase('https://site.test', '', 'category', 'news')).toBe(
      'https://site.test/category/news/',
    );
    expect(exampleBase('https://site.test', '/topics/', 'category', 'news')).toBe(
      'https://site.test/topics/news/',
    );
  });
});
