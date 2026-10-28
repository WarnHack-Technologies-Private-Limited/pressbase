import { describe, expect, it } from 'vitest';
import {
  authorChoices,
  contentSummary,
  countLabel,
  defaultAuthorValue,
  exportUrl,
  filtersFor,
  importedLines,
  type ImportReport,
  itemKind,
  monthLabel,
  percent,
} from './import-export';

const users = [
  { id: 1, login: 'admin', name: 'Admin' },
  { id: 4, login: 'Maria', name: 'Maria Okafor' },
];

describe('import helpers', () => {
  it('picks WordPress’s default for each author', () => {
    const maria = { login: 'maria', email: '', display_name: 'Maria' };
    const tomas = { login: 'tomas', email: '', display_name: 'Tomás' };
    expect(defaultAuthorValue(maria, users, true, 1)).toBe('4');
    expect(defaultAuthorValue(tomas, users, true, 1)).toBe('new');
    expect(defaultAuthorValue(tomas, users, false, 1)).toBe('1');
    expect(authorChoices({ maria: '4', tomas: 'new' })).toEqual({
      maria: { action: 'map', user_id: 4 },
      tomas: { action: 'create' },
    });
  });

  it('describes what a file holds', () => {
    expect(countLabel(1, 'attachment')).toBe('1 media item');
    expect(countLabel(3, 'product')).toBe('3 product items');
    expect(
      contentSummary({
        posts: { post: 12, page: 3, attachment: 1, nav_menu_item: 4 },
        terms: { category: 2, post_tag: 5, nav_menu: 1 },
        comments: 1,
        items: 20,
      }),
    ).toEqual(['12 posts', '3 pages', '1 media item', '1 comment', '7 categories and tags', '1 menu']);
  });

  it('reports progress and results', () => {
    expect(percent(null)).toBe(0);
    expect(percent({ phase: 'importing', done: 1, total: 3, current: '' })).toBe(33);
    expect(percent({ phase: 'finishing', done: 3, total: 3, current: '' })).toBe(99);
    expect(percent({ phase: 'done', done: 3, total: 3, current: '' })).toBe(100);
    const report: ImportReport = {
      imported: { users: 1, terms: 2, posts: { post: 2, page: 1 }, comments: 1, menus: 1 },
      skipped: { total: 0, items: [] },
      errors: { total: 0, items: [] },
      skippedPostTypes: {},
      skippedTaxonomies: {},
      authors: {},
      startedAt: '',
      finishedAt: '',
    };
    expect(importedLines(report)).toEqual(['2 posts', '1 page', '1 comment', '2 categories and tags', '1 menu', '1 new user']);
    expect(itemKind({ kind: 'post', type: 'page', title: '', code: '', reason: '' })).toBe('Page');
    expect(itemKind({ kind: 'post', type: 'product', title: '', code: '', reason: '' })).toBe('product');
    expect(itemKind({ kind: 'attachment', title: '', code: '', reason: '' })).toBe('Media');
  });
});

describe('export helpers', () => {
  const base = { content: 'all', category: '3', author: '2', start_date: '2026-01', end_date: '', status: 'draft' };

  it('only sends the filters that apply', () => {
    expect(filtersFor('all')).toEqual([]);
    expect(exportUrl(base)).toBe('/wp-json/pressbase/v1/export/download?content=all');
    expect(exportUrl({ ...base, content: 'post' })).toBe(
      '/wp-json/pressbase/v1/export/download?content=post&category=3&author=2&start_date=2026-01&status=draft',
    );
    expect(exportUrl({ ...base, content: 'attachment' })).toBe(
      '/wp-json/pressbase/v1/export/download?content=attachment&start_date=2026-01',
    );
  });

  it('names months', () => {
    expect(monthLabel('2026-10')).toBe('October 2026');
  });
});
