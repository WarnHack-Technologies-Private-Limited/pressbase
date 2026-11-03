import { describe, expect, it } from 'vitest';
import {
  changedSince,
  describeChange,
  desiredEntry,
  entriesPatch,
  type LiveModified,
  parseKey,
  pendingKeys,
  type RegionState,
  regionChanged,
  SITE_FIELDS,
  type StoredEntry,
  siteEdits,
  siteEntries,
  wallClock,
} from './changes-model';

const stored = (value: unknown, date = '2026-11-03T10:00:00.000Z'): StoredEntry => ({
  value,
  type: 'page',
  user_id: 1,
  date_modified_gmt: date,
});

const region = (over: Partial<RegionState>): RegionState => ({
  key: 'page:12',
  live: 'live',
  initial: 'live',
  current: 'live',
  ...over,
});

describe('desiredEntry', () => {
  it('is null when the canvas is back to what visitors see', () => {
    expect(desiredEntry(region({}))).toBeNull();
    expect(desiredEntry(region({ initial: 'draft', current: 'live' }))).toBeNull();
  });

  it('is the content otherwise', () => {
    expect(desiredEntry(region({ current: 'edited' }))).toEqual({ content: 'edited' });
  });

  it('is a reset when a customised part is back to the theme’s file', () => {
    const part = region({ key: 'wp_template_part:footer', themeFile: 'theme', current: 'theme' });
    expect(desiredEntry(part)).toEqual({ source: 'theme' });
    expect(desiredEntry({ ...part, current: 'other' })).toEqual({ content: 'other' });
  });

  it('ignores changes nobody made (the menu’s ref filled in)', () => {
    const header = region({ current: 'live+ref', normalized: 'live' });
    expect(desiredEntry(header)).toBeNull();
    expect(regionChanged(header)).toBe(false);
    expect(regionChanged(region({ current: 'typed' }))).toBe(true);
  });
});

describe('entriesPatch', () => {
  it('sends only what differs from the server, removing entries that go back', () => {
    const desired = new Map<string, unknown>([
      ['page:1', { content: 'same' }],
      ['page:2', { content: 'new' }],
      ['page:3', null],
      ['page:4', null],
    ]);
    const server = { 'page:1': stored({ content: 'same' }), 'page:3': stored({ content: 'x' }) };
    expect(entriesPatch(desired, server)).toEqual({ 'page:2': { content: 'new' }, 'page:3': null });
  });

  it('doesn’t resend a value the server stored changed (sanitised)', () => {
    const value = { content: '<p onclick="x">Hi</p>' };
    const desired = new Map([['page:1', value]]);
    const server = { 'page:1': stored({ content: '<p>Hi</p>' }) };
    expect(entriesPatch(desired, server)).toEqual({ 'page:1': value });
    const sent = new Map([['page:1', JSON.stringify(value)]]);
    expect(entriesPatch(desired, server, sent)).toEqual({});
  });
});

describe('pendingKeys', () => {
  it('lists parts, then pages, then the rest, with the patch laid over', () => {
    const server = {
      'option:blogname': stored('Bakery'),
      'page:5': stored({}),
      'wp_template_part:footer': stored({}),
    };
    expect(pendingKeys(server, { 'page:5': null, 'page:2': { content: 'x' } })).toEqual([
      'wp_template_part:footer',
      'page:2',
      'option:blogname',
    ]);
  });

  it('splits keys at the first colon', () => {
    expect(parseKey('wp_template_part:pressbase//header')).toEqual({
      type: 'wp_template_part',
      id: 'pressbase//header',
    });
  });
});

describe('describeChange', () => {
  const __ = (text: string) => text;
  const names = {
    page: (id: number) => (id === 12 ? 'Home' : undefined),
    part: (slug: string) => (slug === 'footer' ? 'Footer' : undefined),
  };

  it('names pages, parts and settings in plain words', () => {
    expect(describeChange('page:12', undefined, names, __)).toEqual({
      title: 'Home',
      detail: 'Page',
    });
    expect(describeChange('page:99', undefined, names, __).title).toBe('A page');
    expect(
      describeChange('wp_template_part:footer', { value: { content: '' } }, names, __),
    ).toEqual({ title: 'Footer', detail: 'On every page' });
    expect(
      describeChange(
        'wp_template_part:pressbase//footer',
        { value: { source: 'theme' } },
        names,
        __,
      ),
    ).toEqual({ title: 'Footer', detail: 'Back to the theme’s design' });
    expect(describeChange('wp_global_styles:pressbase', undefined, names, __).title).toBe(
      'Site styles',
    );
    expect(describeChange('option:blogname', undefined, names, __).title).toBe('Site title');
  });
});

describe('changedSince', () => {
  const entries = {
    'page:12': stored({}, '2026-11-03T10:00:00.500Z'),
    'wp_template_part:footer': stored({}, '2026-11-03T10:00:00.000Z'),
  };

  it('finds entities changed on the live site after the draft was written', () => {
    const live = new Map<string, LiveModified>([
      ['page:12', { gmt: '2026-11-03T10:05:00' }],
      // Site time in Kolkata (UTC+5:30): 15:29 is 09:59 UTC, before the draft.
      ['wp_template_part:footer', { local: '2026-11-03T15:29:00' }],
    ]);
    expect(changedSince(entries, live, 'Asia/Kolkata')).toEqual(['page:12']);
    live.set('wp_template_part:footer', { local: '2026-11-03T15:31:00' });
    expect(changedSince(entries, live, 'Asia/Kolkata')).toEqual([
      'page:12',
      'wp_template_part:footer',
    ]);
  });

  it('keeps entries the live site hasn’t touched since', () => {
    const live = new Map<string, LiveModified>([['page:12', { gmt: '2026-11-03T10:00:00' }]]);
    expect(changedSince(entries, live, 'UTC')).toEqual([]);
  });

  it('reads site time, falling back to UTC for unknown zones', () => {
    expect(wallClock('2026-11-03T10:00:00.000Z', 'Asia/Kolkata')).toBe('2026-11-03T15:30:00');
    expect(wallClock('2026-11-03T10:00:00.000Z', 'Not/AZone')).toBe('2026-11-03T10:00:00');
    expect(wallClock('2026-11-03T10:00:00.000Z', '')).toBe('2026-11-03T10:00:00');
  });
});

describe('site record edits ⇄ option entries', () => {
  it('turns the site blocks’ edits into the options a changeset may set', () => {
    expect([
      ...siteEntries({ title: 'Corner Bakery', description: 'Fresh daily', site_logo: 12 }),
    ]).toEqual([
      ['option:blogname', 'Corner Bakery'],
      ['option:blogdescription', 'Fresh daily'],
      ['option:site_logo', 12],
    ]);
    // Settings the site blocks don't edit aren't changeset entries.
    expect([...siteEntries({ posts_per_page: 5 })]).toEqual([]);
  });

  it('removes entries for fields no longer edited', () => {
    expect([
      ...siteEntries({ title: 'Bakery' }, ['option:blogname', 'option:blogdescription']),
    ]).toEqual([
      ['option:blogname', 'Bakery'],
      ['option:blogdescription', null],
    ]);
  });

  it('lays a resumed draft’s options back over the site record', () => {
    expect(
      siteEdits({
        'option:blogname': { value: 'Corner Bakery' },
        'option:site_icon': { value: 3 },
        'option:show_on_front': { value: 'page' },
        'page:12': { value: { content: '' } },
      }),
    ).toEqual({ title: 'Corner Bakery', site_icon: 3 });
  });

  it('maps only options a changeset allows', () => {
    // changesets.md: blogname, blogdescription, site_logo, site_icon are on the allow-list.
    expect(Object.values(SITE_FIELDS).sort()).toEqual([
      'blogdescription',
      'blogname',
      'site_icon',
      'site_logo',
    ]);
  });
});
