import type { HookBus } from '@pressbase/hooks';
import { z } from 'zod';
import type { Options } from './store';

/**
 * Settings exposed through the REST API — WordPress's register_setting().
 *
 * Each setting maps a public REST field name (as used by /wp/v2/settings) to
 * an option, with a schema that validates writes and a default for reads.
 * Plugins register theirs through this same registry when they ask for
 * `showInRest` (see plugins/admin.ts).
 */
export interface SettingDefinition {
  /** Option name in the options table. */
  option: string;
  schema: z.ZodType;
  default: unknown;
  /** Capability required to read or change the setting. */
  capability: string;
  /**
   * register_setting()'s sanitize_callback: runs after the schema, before
   * the `sanitize_option_{option}` filter. Throwing refuses the value.
   */
  sanitize?: (value: unknown, option: string) => unknown;
}

/** A value refused by a setting's schema or sanitize callback; the message is shown on the field. */
export class SettingSanitizeError extends Error {}

/**
 * What update_option() does to a value before storing it
 * (wordpress/wp-includes/option.php): sanitize_option() — the setting's
 * sanitize callback, then the `sanitize_option_{option}` filter — and the
 * `pre_update_option_{option}` and `pre_update_option` filters. The value is
 * validated by the setting's schema first. Throws SettingSanitizeError.
 */
export async function sanitizeSettingValue(
  kernel: { hooks: HookBus; options: Options },
  setting: SettingDefinition,
  value: unknown,
): Promise<unknown> {
  const parsed = setting.schema.safeParse(value);
  if (!parsed.success) {
    throw new SettingSanitizeError(parsed.error.issues[0]?.message ?? 'Invalid value.');
  }
  let next: unknown = parsed.data;
  if (setting.sanitize) {
    try {
      next = await setting.sanitize(next, setting.option);
    } catch (error) {
      throw new SettingSanitizeError(error instanceof Error ? error.message : String(error));
    }
  }
  const { option } = setting;
  next = await kernel.hooks.applyFilters(`sanitize_option_${option}`, next, option, value);
  const old = await kernel.options.get(option, setting.default);
  next = await kernel.hooks.applyFilters(`pre_update_option_${option}`, next, old, option);
  next = await kernel.hooks.applyFilters('pre_update_option', next, option, old);
  return next;
}

export class SettingsRegistry {
  #settings = new Map<string, SettingDefinition>();

  register(
    name: string,
    definition: Omit<SettingDefinition, 'capability'> & { capability?: string },
  ): void {
    if (this.#settings.has(name)) throw new Error(`Setting "${name}" is already registered.`);
    this.#settings.set(name, { capability: 'manage_options', ...definition });
  }

  /** unregister_setting(): a plugin's settings go when it's deactivated. */
  unregister(name: string): boolean {
    return this.#settings.delete(name);
  }

  get(name: string): SettingDefinition | undefined {
    return this.#settings.get(name);
  }

  entries(): [string, SettingDefinition][] {
    return [...this.#settings.entries()];
  }
}

const timezone = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Choose a valid time zone, such as Europe/London or UTC.' },
);

const postId = z.number().int().min(0);

/** The settings WordPress exposes at /wp/v2/settings, with the same names and options. */
export function registerCoreSettings(registry: SettingsRegistry): void {
  registry.register('title', {
    option: 'blogname',
    schema: z.string().trim().max(200),
    default: '',
  });
  registry.register('description', {
    option: 'blogdescription',
    schema: z.string().trim().max(500),
    default: '',
  });
  registry.register('url', {
    option: 'siteurl',
    schema: z.url({
      protocol: /^https?$/,
      message: 'Enter a full address, like https://example.com.',
    }),
    default: '',
  });
  registry.register('email', {
    option: 'admin_email',
    schema: z.email({ message: 'Enter a valid email address.' }),
    default: '',
  });
  registry.register('timezone', { option: 'timezone_string', schema: timezone, default: 'UTC' });
  registry.register('date_format', {
    option: 'date_format',
    schema: z.string().min(1).max(50),
    default: 'F j, Y',
  });
  registry.register('time_format', {
    option: 'time_format',
    schema: z.string().min(1).max(50),
    default: 'g:i a',
  });
  registry.register('start_of_week', {
    option: 'start_of_week',
    schema: z.number().int().min(0).max(6),
    default: 1,
  });
  registry.register('language', { option: 'locale', schema: z.enum(['en_US']), default: 'en_US' });
  registry.register('posts_per_page', {
    option: 'posts_per_page',
    schema: z.number().int().min(1).max(100),
    default: 10,
  });
  registry.register('default_comment_status', {
    option: 'default_comment_status',
    schema: z.enum(['open', 'closed']),
    default: 'open',
  });
  registry.register('default_ping_status', {
    option: 'default_ping_status',
    schema: z.enum(['open', 'closed']),
    default: 'closed',
  });
  registry.register('show_on_front', {
    option: 'show_on_front',
    schema: z.enum(['posts', 'page']),
    default: 'posts',
  });
  registry.register('page_on_front', { option: 'page_on_front', schema: postId, default: 0 });
  registry.register('page_for_posts', { option: 'page_for_posts', schema: postId, default: 0 });
  // Not in WordPress's /wp/v2/settings, but on its Reading screen; exposed for the admin.
  registry.register('blog_public', {
    option: 'blog_public',
    schema: z.boolean(),
    default: true,
  });
  // Settings → Reading's feed settings (options-reading.php). Not in WordPress's
  // /wp/v2/settings; exposed for the admin. Read by frontend/feeds.ts.
  registry.register('posts_per_rss', {
    option: 'posts_per_rss',
    schema: z.number().int().min(1).max(100),
    default: 10,
  });
  registry.register('rss_use_excerpt', {
    option: 'rss_use_excerpt',
    schema: z.boolean(),
    default: false,
  });
  registry.register('default_category', {
    option: 'default_category',
    schema: postId,
    default: 1,
  });
  // Settings → Media (options-media.php). Not in WordPress's /wp/v2/settings; exposed for the admin.
  const pixels = z
    .number({ message: 'Enter a number of pixels.' })
    .int({ message: 'Enter a whole number of pixels.' })
    .min(0, { message: 'Enter 0 or more.' })
    .max(10000, { message: 'Enter 10,000 pixels or fewer.' });
  for (const [name, fallback] of [
    ['thumbnail_size_w', 150],
    ['thumbnail_size_h', 150],
    ['medium_size_w', 300],
    ['medium_size_h', 300],
    ['large_size_w', 1024],
    ['large_size_h', 1024],
  ] as const) {
    registry.register(name, { option: name, schema: pixels, default: fallback });
  }
  registry.register('thumbnail_crop', {
    option: 'thumbnail_crop',
    schema: z.boolean(),
    default: true,
  });
  registry.register('uploads_use_yearmonth_folders', {
    option: 'uploads_use_yearmonth_folders',
    schema: z.boolean(),
    default: true,
  });
}
