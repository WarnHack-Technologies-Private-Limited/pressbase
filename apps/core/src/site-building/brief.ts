import { z } from 'zod';
import type { Kernel } from '../kernel';

/**
 * The site brief (v0.8, the plan's Brief stage): what the site is, for whom
 * and in what voice, and the facts the person gave. Saved as the
 * `pressbase_site_brief` option, so every later AI request knows the site;
 * read with the `core/get-site-brief` ability and changed through
 * `/wp/v2/settings` (`pressbase_site_brief`, `manage_options`).
 *
 * Facts come from the person only. The model may write copy, never facts:
 * anything not given stays empty, and becomes a placeholder on the page.
 * See docs/architecture/site-abilities.md.
 */

export const SITE_BRIEF_OPTION = 'pressbase_site_brief';

export interface SiteBrief {
  /** The business's or person's name. */
  name: string;
  /** What kind of site: "bakery", "dental practice", "portfolio". */
  kind: string;
  audience: string;
  tone: string;
  /** Facts the person gave (address, hours, prices…), one per item. Never invented. */
  facts: string[];
  /** The pages the site should have, by title. */
  pages: string[];
  /** The site's language, as a locale in dash form (`en-GB`). */
  language: string;
}

const text = (max: number) => z.string().trim().max(max);

/** The option's schema, for `/wp/v2/settings` and the ability. Missing fields are empty. */
export const siteBriefSchema = z
  .object({
    name: text(200).default(''),
    kind: text(200).default(''),
    audience: text(500).default(''),
    tone: text(200).default(''),
    facts: z.array(text(500).min(1)).max(50).default([]),
    pages: z.array(text(100).min(1)).max(20).default([]),
    language: z
      .string()
      .trim()
      .regex(/^([a-z]{2,3}([-_][A-Za-z0-9]{2,8})*)?$/, {
        message: 'Use a language code such as en or en-GB.',
      })
      .default(''),
  })
  .strict();

export const EMPTY_SITE_BRIEF: SiteBrief = {
  name: '',
  kind: '',
  audience: '',
  tone: '',
  facts: [],
  pages: [],
  language: '',
};

/** The brief as a JSON Schema: the ability's output, and the Brief stage's answer. */
export const SITE_BRIEF_JSON_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 200, description: 'The business’s or person’s name.' },
    kind: {
      type: 'string',
      maxLength: 200,
      description: 'What kind of site it is, such as a bakery or a dental practice.',
    },
    audience: { type: 'string', maxLength: 500, description: 'Who the site is for.' },
    tone: { type: 'string', maxLength: 200, description: 'The voice of the copy.' },
    facts: {
      type: 'array',
      maxItems: 50,
      items: { type: 'string', maxLength: 500 },
      description:
        'Facts the site owner gave, such as the address, opening hours or prices. Only these may be stated as facts on the site.',
    },
    pages: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', maxLength: 100 },
      description: 'The pages the site should have, by title.',
    },
    language: {
      type: 'string',
      maxLength: 20,
      description: 'The site’s language as a locale in dash form, such as en-GB.',
    },
  },
  required: ['name', 'kind', 'audience', 'tone', 'facts', 'pages', 'language'],
  additionalProperties: false,
} as const;

/** Registers the `pressbase_site_brief` setting (REST: `/wp/v2/settings`). */
export function registerSiteBriefSetting(kernel: Kernel): void {
  kernel.settings.register(SITE_BRIEF_OPTION, {
    option: SITE_BRIEF_OPTION,
    schema: siteBriefSchema,
    default: EMPTY_SITE_BRIEF,
    capability: 'manage_options',
    // Language codes are stored in dash form, as the ability gives them.
    sanitize: (value) => {
      const brief = value as SiteBrief;
      return { ...brief, language: brief.language.replace(/_/g, '-') };
    },
  });
}

/**
 * The saved brief, every field present. Where the person gave no name or
 * language, the site's title and language fill them: those are facts too.
 */
export async function getSiteBrief(kernel: Kernel): Promise<SiteBrief> {
  const stored = await kernel.options.get<unknown>(SITE_BRIEF_OPTION, null);
  const parsed = siteBriefSchema.safeParse(stored ?? {});
  const brief: SiteBrief = parsed.success ? parsed.data : { ...EMPTY_SITE_BRIEF };
  if (!brief.name) brief.name = (await kernel.options.get<string>('blogname', '')) ?? '';
  if (!brief.language) brief.language = kernel.i18n.getLocale().replace(/_/g, '-');
  return brief;
}
