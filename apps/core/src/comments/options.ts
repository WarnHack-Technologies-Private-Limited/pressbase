import { z } from 'zod';
import type { Kernel } from '../kernel';
import type { SettingsRegistry } from '../options/settings';

/**
 * Settings → Discussion (wordpress/wp-admin/options-discussion.php). Option
 * names and defaults follow populate_options() in wp-admin/includes/schema.php.
 *
 * WordPress's /wp/v2/settings exposes only `default_comment_status` and
 * `default_ping_status` from this screen; both are registered with the core
 * settings. Everything below is **Pressbase-exposed**: not in WordPress's REST
 * settings, registered so the admin's Discussion screen can edit it.
 *
 * WordPress stores these as '1' / '' strings; Pressbase stores JSON booleans
 * and numbers. Reads accept both, so imported options keep working.
 */

export const AVATAR_RATINGS = ['G', 'PG', 'R', 'X'] as const;
export const AVATAR_DEFAULTS = [
  'mystery',
  'blank',
  'gravatar_default',
  'identicon',
  'wavatar',
  'monsterid',
  'retro',
  'robohash',
] as const;

/** Moderation and disallowed keys: one word, IP or fragment per line. */
const wordList = z
  .string()
  .max(65_535, { message: 'Keep the list under 64 KB.' })
  .transform((v) => v.replace(/\r\n?/g, '\n'));

const DISCUSSION_SETTINGS = {
  // "Email me whenever" (wp_notify_postauthor / wp_notify_moderator).
  comments_notify: { schema: z.boolean(), default: true },
  moderation_notify: { schema: z.boolean(), default: true },
  comment_registration: { schema: z.boolean(), default: false },
  require_name_email: { schema: z.boolean(), default: true },
  comment_moderation: { schema: z.boolean(), default: false },
  comment_previously_approved: { schema: z.boolean(), default: true },
  comment_max_links: {
    schema: z
      .number({ message: 'Enter a number of links.' })
      .int({ message: 'Enter a whole number.' })
      .min(0, { message: 'Enter 0 or more. 0 turns the check off.' })
      .max(1000),
    default: 2,
  },
  moderation_keys: { schema: wordList, default: '' },
  disallowed_keys: { schema: wordList, default: '' },
  close_comments_for_old_posts: { schema: z.boolean(), default: false },
  close_comments_days_old: {
    schema: z
      .number({ message: 'Enter a number of days.' })
      .int({ message: 'Enter a whole number of days.' })
      .min(1, { message: 'Enter at least 1 day.' })
      .max(36_500),
    default: 14,
  },
  thread_comments: { schema: z.boolean(), default: true },
  thread_comments_depth: {
    schema: z
      .number()
      .int()
      .min(2, { message: 'Choose between 2 and 10 levels.' })
      .max(10, { message: 'Choose between 2 and 10 levels.' }),
    default: 5,
  },
  page_comments: { schema: z.boolean(), default: false },
  comments_per_page: {
    schema: z
      .number({ message: 'Enter a number of comments.' })
      .int({ message: 'Enter a whole number.' })
      .min(1, { message: 'Show at least 1 comment per page.' })
      .max(1000),
    default: 50,
  },
  default_comments_page: { schema: z.enum(['newest', 'oldest']), default: 'newest' },
  comment_order: { schema: z.enum(['asc', 'desc']), default: 'asc' },
  show_avatars: { schema: z.boolean(), default: true },
  avatar_rating: { schema: z.enum(AVATAR_RATINGS), default: 'G' },
  avatar_default: { schema: z.enum(AVATAR_DEFAULTS), default: 'mystery' },
} as const;

type Defs = typeof DISCUSSION_SETTINGS;
export type DiscussionOptions = {
  [K in keyof Defs]: Defs[K]['default'] extends boolean
    ? boolean
    : Defs[K]['default'] extends number
      ? number
      : string;
};

/** Registers the Discussion settings (all Pressbase-exposed; see above). */
export function registerDiscussionSettings(registry: SettingsRegistry): void {
  for (const [name, def] of Object.entries(DISCUSSION_SETTINGS)) {
    registry.register(name, { option: name, schema: def.schema, default: def.default });
  }
}

/** '1', 1, true → true; '', '0', 0, false → false (WordPress stores strings). */
function asBool(value: unknown): boolean {
  if (typeof value === 'string') return value !== '' && value !== '0';
  return Boolean(value);
}

/** All Discussion options at once, with WordPress's defaults and types normalised. */
export async function discussionOptions(kernel: Kernel): Promise<DiscussionOptions> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(DISCUSSION_SETTINGS)) {
    const raw = await kernel.options.get<unknown>(name, def.default);
    if (typeof def.default === 'boolean') out[name] = asBool(raw);
    else if (typeof def.default === 'number') {
      const n = Number(raw);
      out[name] = Number.isFinite(n) ? n : def.default;
    } else out[name] = typeof raw === 'string' ? raw : String(raw ?? def.default);
  }
  return out as DiscussionOptions;
}
