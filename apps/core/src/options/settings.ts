import { z } from 'zod';

/**
 * Settings exposed through the REST API — WordPress's register_setting().
 *
 * Each setting maps a public REST field name (as used by /wp/v2/settings) to
 * an option, with a schema that validates writes and a default for reads.
 * Plugins will register their own settings through this same registry.
 */
export interface SettingDefinition {
  /** Option name in the options table. */
  option: string;
  schema: z.ZodType;
  default: unknown;
  /** Capability required to read or change the setting. */
  capability: string;
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
  registry.register('default_category', {
    option: 'default_category',
    schema: postId,
    default: 1,
  });
}
