import type { Kernel } from '../kernel';
import { PRESSBASE_VERSION } from '../version';

/**
 * Core's ability categories and abilities, ported from
 * wordpress/wp-includes/abilities.php (wp_register_core_ability_categories(),
 * wp_register_core_abilities()). Pressbase ships `core/get-site-info` for now.
 */

const SITE_INFO_PROPERTIES = {
  name: { type: 'string', title: 'Site Title', description: 'The site title.' },
  description: { type: 'string', title: 'Tagline', description: 'The site tagline.' },
  url: {
    type: 'string',
    title: 'Site Address (URL)',
    description: 'The public URL where visitors access the site.',
  },
  wpurl: {
    type: 'string',
    title: 'Pressbase Address (URL)',
    description: 'The URL of the Pressbase installation. May differ from the public site URL.',
  },
  admin_email: {
    type: 'string',
    title: 'Administration Email Address',
    description: 'The site administrator email address.',
  },
  charset: { type: 'string', title: 'Site Charset', description: 'The site character encoding.' },
  language: {
    type: 'string',
    title: 'Site Language',
    description: 'The site locale in dash form (e.g. en-US).',
  },
  version: {
    type: 'string',
    title: 'Pressbase Version',
    description: 'The Pressbase version running on this site.',
  },
} as const;

type SiteInfoField = keyof typeof SITE_INFO_PROPERTIES;
const SITE_INFO_FIELDS = Object.keys(SITE_INFO_PROPERTIES) as SiteInfoField[];

export function registerCoreAbilities(kernel: Kernel): void {
  const { abilities } = kernel;
  abilities.registerCategory('site', {
    label: 'Site',
    description: 'Abilities that retrieve or modify site information and settings.',
  });
  abilities.registerCategory('user', {
    label: 'User',
    description: 'Abilities that retrieve or modify user information and settings.',
  });

  abilities.register('core/get-site-info', {
    label: 'Get Site Information',
    description:
      'Returns site information configured in Pressbase. By default returns all fields, or optionally a filtered subset.',
    category: 'site',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: { type: 'string', enum: SITE_INFO_FIELDS },
          description:
            'Optional: Limit response to specific fields. If omitted, all fields are returned.',
        },
      },
      additionalProperties: false,
      default: {},
    },
    outputSchema: {
      type: 'object',
      properties: SITE_INFO_PROPERTIES,
      additionalProperties: false,
    },
    permissionCallback: (_input, context) => context.can('manage_options'),
    async executeCallback(input: { fields?: SiteInfoField[] } | null) {
      const fields = input?.fields?.length ? input.fields : SITE_INFO_FIELDS;
      const { options } = kernel;
      const values: Record<SiteInfoField, () => Promise<string>> = {
        name: () => options.get<string>('blogname', ''),
        description: () => options.get<string>('blogdescription', ''),
        url: () => options.get<string>('home', ''),
        wpurl: () => options.get<string>('siteurl', ''),
        admin_email: () => options.get<string>('admin_email', ''),
        charset: async () => 'UTF-8',
        language: async () => kernel.i18n.getLocale().replace(/_/g, '-'),
        version: async () => PRESSBASE_VERSION,
      };
      const result: Record<string, string> = {};
      for (const field of fields) result[field] = await values[field]();
      return result;
    },
    meta: {
      annotations: { readonly: true, destructive: false, idempotent: true },
      public: true,
    },
  });
}
