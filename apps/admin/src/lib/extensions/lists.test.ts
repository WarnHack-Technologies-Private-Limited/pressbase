import { describe, expect, it, vi } from 'vitest';
import { filterQuery, listFilters } from './lists';
import { appliesTo, type FillEntry } from './registry';

let nextId = 1;
const fill = (props: Record<string, unknown>, owner = 'seo'): FillEntry => ({
  id: nextId++,
  slot: 'posts-list.filters',
  owner,
  props,
  children: null,
});

const missing = {
  id: 'seo-description',
  label: 'All descriptions',
  options: [
    { value: 'missing', label: 'Missing a description' },
    { value: 'set', label: 'With a description' },
  ],
  query: (value: string) => ({ seo_description: value }),
};

describe('listFilters', () => {
  it('keeps well-formed filters, the first of each id, and leaves out reserved ids', () => {
    const filters = listFilters([
      fill(missing),
      fill({ ...missing, label: 'Duplicate' }),
      fill({ ...missing, id: 'status' }),
      fill({ ...missing, id: 'Bad Id' }),
      fill({ id: 'no-query', label: 'x', options: [] }),
    ]);
    expect(filters.map((f) => [f.id, f.label, f.owner])).toEqual([
      ['seo-description', 'All descriptions', 'seo'],
    ]);
  });
});

describe('filterQuery', () => {
  it('turns chosen values into REST parameters', () => {
    const params = filterQuery(listFilters([fill(missing)]), (id) =>
      id === 'seo-description' ? 'missing' : null,
    );
    expect(params).toEqual({ seo_description: 'missing' });
  });

  it('ignores values that are not options, and joins arrays', () => {
    const filters = listFilters([
      fill(missing),
      fill({
        id: 'seo-robots',
        label: 'Robots',
        options: [{ value: 'hidden', label: 'Hidden' }],
        query: () => ({ seo_robots: ['noindex', 'nofollow'], seo_flag: true }),
      }),
    ]);
    expect(filterQuery(filters, (id) => (id === 'seo-robots' ? 'hidden' : 'other'))).toEqual({
      seo_robots: 'noindex,nofollow',
      seo_flag: 'true',
    });
  });

  it('reports a query that throws or claims the list’s own parameters', () => {
    const onError = vi.fn();
    const filters = listFilters([
      fill({ ...missing, query: () => ({ status: 'trash', seo_ok: 1 }) }),
      fill({
        ...missing,
        id: 'seo-broken',
        query: () => {
          throw new Error('boom');
        },
      }),
    ]);
    expect(filterQuery(filters, () => 'missing', onError)).toEqual({ seo_ok: '1' });
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe('appliesTo', () => {
  it('limits fills by postTypes or taxonomies', () => {
    expect(appliesTo(fill({}), 'page')).toBe(true);
    expect(appliesTo(fill({ postTypes: 'post' }), 'page')).toBe(false);
    expect(appliesTo(fill({ postTypes: ['post', 'page'] }), 'page')).toBe(true);
    expect(appliesTo(fill({ taxonomies: ['category'] }), 'post_tag')).toBe(false);
  });
});
