import { describe, expect, it } from 'vitest';
import { avatarHue, displayNameOptions, formatGmt, initials, roleLabel } from './people';

describe('people helpers', () => {
  it('makes initials from names and usernames', () => {
    expect(initials('Grace Hopper')).toBe('GH');
    expect(initials('admin')).toBe('A');
    expect(initials('ada.lovelace')).toBe('AL');
    expect(initials('  ')).toBe('?');
  });

  it('offers WordPress’s display-name choices without duplicates', () => {
    expect(
      displayNameOptions({
        username: 'grace',
        nickname: 'grace',
        first_name: 'Grace',
        last_name: 'Hopper',
        name: 'Amazing Grace',
      }),
    ).toEqual(['grace', 'Grace', 'Hopper', 'Grace Hopper', 'Hopper Grace', 'Amazing Grace']);
    expect(
      displayNameOptions({ username: 'ada', nickname: '', first_name: '', last_name: '' }),
    ).toEqual(['ada']);
  });

  it('labels roles and dates', () => {
    expect(roleLabel('editor')).toBe('Editor');
    expect(roleLabel('shop_manager')).toBe('Shop_manager');
    expect(roleLabel(undefined)).toBe('No role');
    expect(formatGmt(null)).toBe('Never');
    expect(formatGmt('2026-10-27T09:30:00')).toMatch(/2026/);
    expect(avatarHue(1)).toBeGreaterThanOrEqual(0);
    expect(avatarHue(3)).toBeLessThan(360);
  });
});
