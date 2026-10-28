import { describe, expect, it } from 'vitest';
import {
  type AdminPage,
  activeOwners,
  isPageCurrent,
  pageHref,
  pagesUnder,
  parsePagePath,
} from './pages';
import {
  colorInputValue,
  fromInput,
  initialValues,
  pageEndpoint,
  sectionTitle,
  toInput,
} from './settings';

const page = (overrides: Partial<AdminPage>): AdminPage => ({
  plugin: 'daily-tips',
  plugin_title: 'Daily Tips',
  slug: 'daily-tips',
  title: 'Daily Tips',
  parent: 'settings',
  capability: 'manage_options',
  description: '',
  module: null,
  has_settings: true,
  ...overrides,
});

describe('plugin page addresses', () => {
  it('puts pages under Settings, Tools or the top level, short for the main page', () => {
    expect(pageHref(page({}))).toBe('/admin/settings/daily-tips');
    expect(pageHref(page({ slug: 'advanced' }))).toBe('/admin/settings/daily-tips/advanced');
    expect(pageHref(page({ parent: 'tools' }))).toBe('/admin/tools/daily-tips');
    expect(pageHref(page({ parent: null, slug: 'stats' }))).toBe('/admin/plugin/daily-tips/stats');
    // A plugin named like a core screen keeps the long form, so it can't shadow it.
    expect(pageHref(page({ plugin: 'media', slug: 'media' }))).toBe('/admin/settings/media/media');
  });

  it('parses the catch-all route', () => {
    expect(parsePagePath(['daily-tips'])).toEqual({ plugin: 'daily-tips', page: 'daily-tips' });
    expect(parsePagePath(['daily-tips', 'advanced'])).toEqual({
      plugin: 'daily-tips',
      page: 'advanced',
    });
    expect(parsePagePath([])).toBeNull();
    expect(parsePagePath(['a', 'b', 'c'])).toBeNull();
    expect(parsePagePath(['..'])).toBeNull();
    expect(parsePagePath(['Daily'])).toBeNull();
  });

  it('marks only the exact page current', () => {
    const main = page({});
    expect(isPageCurrent(main, '/admin/settings/daily-tips')).toBe(true);
    expect(isPageCurrent(main, '/admin/settings/daily-tips/')).toBe(true);
    expect(isPageCurrent(main, '/admin/settings/daily-tips/advanced')).toBe(false);
  });

  it('groups pages and lists the plugins that own them', () => {
    const extensions = {
      pages: [page({}), page({ plugin: 'reports', plugin_title: 'Reports', parent: null })],
      modules: [{ plugin: 'daily-tips', title: 'Daily Tips', url: '/x.js' }],
    };
    expect(pagesUnder(extensions, null).map((p) => p.plugin)).toEqual(['reports']);
    expect(pagesUnder(extensions, 'tools')).toEqual([]);
    expect(activeOwners(extensions)).toEqual([
      { plugin: 'daily-tips', title: 'Daily Tips' },
      { plugin: 'reports', title: 'Reports' },
    ]);
  });
});

describe('plugin settings fields', () => {
  it('starts from stored values, falling back to defaults', () => {
    const field = (name: string, value: unknown) => ({
      name,
      default: value,
    });
    const values = initialValues({
      sections: [
        {
          id: 'default',
          title: '',
          description: '',
          fields: [field('a', 1), field('b', 'x')] as never,
        },
      ],
      values: { a: 5 },
    });
    expect(values).toEqual({ a: 5, b: 'x' });
  });

  it('converts inputs back to the setting type', () => {
    expect(fromInput({ control: 'number', type: 'integer' }, '42')).toBe(42);
    expect(fromInput({ control: 'number', type: 'number' }, '')).toBe('');
    expect(fromInput({ control: 'number', type: 'number' }, '4e')).toBe('4e');
    expect(fromInput({ control: 'select', type: 'integer' }, '2')).toBe(2);
    expect(fromInput({ control: 'select', type: 'string' }, '2')).toBe('2');
    expect(fromInput({ control: 'text', type: 'string' }, ' hi ')).toBe(' hi ');
    expect(toInput(undefined)).toBe('');
    expect(toInput(3)).toBe('3');
  });

  it('gives the colour picker a #rrggbb value', () => {
    expect(colorInputValue('#ABC')).toBe('#aabbcc');
    expect(colorInputValue('#3858e9')).toBe('#3858e9');
    expect(colorInputValue('blue')).toBe('#000000');
  });

  it('titles untitled sections and builds the endpoint', () => {
    const untitled = { id: 'default', title: '', description: '', fields: [] };
    expect(sectionTitle(untitled, 'Daily Tips', 0)).toBe('Daily Tips');
    expect(sectionTitle(untitled, 'Daily Tips', 1)).toBe('More settings');
    expect(sectionTitle({ ...untitled, title: 'Look' }, 'Daily Tips', 0)).toBe('Look');
    expect(pageEndpoint('daily-tips', 'daily-tips')).toBe(
      '/pressbase/v1/plugin-pages/daily-tips/daily-tips',
    );
  });
});
