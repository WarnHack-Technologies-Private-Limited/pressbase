/**
 * Shapes and helpers for the Users and Profile screens. Pure functions live
 * here (not in .tsx files) so they can be unit-tested.
 */

import { msgid } from './i18n/locale';

/** A user from /wp/v2/users?context=edit. */
export interface EditUser {
  id: number;
  username: string;
  name: string;
  first_name: string;
  last_name: string;
  nickname: string;
  email: string;
  url: string;
  description: string;
  slug: string;
  locale: string;
  /** The stored choice: '' for the site's language (Pressbase's `locale_setting`). */
  locale_setting?: string;
  roles: string[];
  registered_date: string;
  capabilities: Record<string, boolean>;
  /** Registered user meta (`show_in_rest`), by key. */
  meta?: Record<string, unknown>;
}

export interface UserCounts {
  total: number;
  roles: Record<string, number>;
  posts: Record<string, number>;
}

/** An application password as the REST API lists it. `password` only on creation. */
export interface AppPassword {
  uuid: string;
  app_id: string;
  name: string;
  created: string;
  last_used: string | null;
  last_ip: string | null;
  password?: string;
}

/** WordPress's default roles, most powerful first. */
export const ROLES: { id: string; label: string; summary: string }[] = [
  {
    id: 'administrator',
    label: msgid('Administrator', 'User role'),
    summary: 'Everything, including settings and people.',
  },
  {
    id: 'editor',
    label: msgid('Editor', 'User role'),
    summary: 'Publishes and manages everyone’s posts and pages.',
  },
  {
    id: 'author',
    label: msgid('Author', 'User role'),
    summary: 'Publishes and manages their own posts.',
  },
  {
    id: 'contributor',
    label: msgid('Contributor', 'User role'),
    summary: 'Writes posts for review, but can’t publish.',
  },
  {
    id: 'subscriber',
    label: msgid('Subscriber', 'User role'),
    summary: 'Can only read and manage their profile.',
  },
];

export function roleLabel(role: string | undefined): string {
  if (!role) return 'No role';
  return ROLES.find((r) => r.id === role)?.label ?? role.charAt(0).toUpperCase() + role.slice(1);
}

/** Two initials for an avatar: "Grace Hopper" → "GH", "admin" → "A". */
export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/**
 * A stable avatar hue from the user ID, so people are easy to tell apart
 * without relying on colour alone (the initials carry the meaning).
 */
export function avatarHue(id: number): number {
  return (id * 137) % 360;
}

/**
 * The display-name choices WordPress's profile screen offers
 * (wp-admin/user-edit.php): username, nickname, first, last, and both orders.
 */
export function displayNameOptions(user: {
  username: string;
  nickname: string;
  first_name: string;
  last_name: string;
  name?: string;
}): string[] {
  const first = user.first_name.trim();
  const last = user.last_name.trim();
  const options = [
    user.username,
    user.nickname.trim(),
    first,
    last,
    first && last ? `${first} ${last}` : '',
    first && last ? `${last} ${first}` : '',
    user.name?.trim() ?? '',
  ];
  return [...new Set(options.filter(Boolean))];
}

/** "2026-10-27T09:30:00" (GMT, as the API sends it) → a readable local date. */
export function formatGmt(value: string | null, withTime = false): string {
  if (!value) return 'Never';
  const date = new Date(`${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
}
