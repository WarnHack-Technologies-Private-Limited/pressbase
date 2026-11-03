import { schema } from '@pressbase/db';
import type { GlobalStylesConfig } from '@pressbase/theme-json';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { currentUserCan } from '../auth/meta-caps';
import { type CurrentUser, userCan } from '../auth/users';
import type { Post, PostInput } from '../content/posts';
import { sanitizePostContent, sanitizePostTitle, sanitizeSlug } from '../content/sanitize';
import type { Kernel } from '../kernel';
import { type SettingDefinition, sanitizeSettingValue } from '../options/settings';
import { rawText } from '../routes/rest-util';
import {
  decodeGlobalStyles,
  GLOBAL_STYLES_POST_TYPE,
  prepareGlobalStyles,
  saveGlobalStyles,
  userGlobalStylesPost,
} from '../themes/global-styles';
import type { ChangesetPreview } from './preview';

/**
 * What a changeset can hold (v0.8, ADR 0022): a small registry of entity
 * handlers, keyed by entity type — WordPress's WP_Customize_Setting
 * subclasses, reduced to four operations.
 *
 * An entry key is `{type}:{id}`: `page:12`, `wp_navigation:5`,
 * `wp_global_styles:pressbase`, `option:blogname`. The handler for `type`
 * validates the value, checks the user may change the entity, writes it
 * inside the publish transaction and lays it over a preview.
 */

/** A value or permission problem with one entry (WordPress's setting validity WP_Error). */
export class ChangesetEntryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ChangesetEntityHandler<V = unknown> {
  /** The entity type: the part of an entry key before the first colon. */
  readonly type: string;
  /** Publish order, lowest first: posts (10), global styles (20), options (30). */
  readonly order: number;
  /**
   * Checks and prepares a value for entity `id`, as `user` writes it
   * (WP_Customize_Setting::validate() and sanitize()): sanitised for that
   * user, so publishing later stores what was checked. Throws ChangesetEntryError.
   */
  validate(kernel: Kernel, id: string, value: unknown, user: CurrentUser): Promise<V>;
  /** Whether `user` may change the entity (WP_Customize_Setting::check_capabilities()). */
  canEdit(kernel: Kernel, id: string, value: V, user: CurrentUser): Promise<boolean>;
  /**
   * Writes the value (WP_Customize_Setting::save()). Runs inside the publish
   * transaction; `author` is who wrote the entry. Throwing rolls back the
   * whole publish.
   */
  apply(kernel: Kernel, id: string, value: V, author: CurrentUser | null): Promise<void>;
  /** Lays the value over a preview (WP_Customize_Setting::preview()). */
  preview(kernel: Kernel, id: string, value: V, preview: ChangesetPreview): Promise<void>;
}

export class ChangesetEntities {
  #handlers = new Map<string, ChangesetEntityHandler>();

  register<V>(handler: ChangesetEntityHandler<V>): void {
    this.#handlers.set(handler.type, handler as ChangesetEntityHandler);
  }

  unregister(type: string): boolean {
    return this.#handlers.delete(type);
  }

  get(type: string): ChangesetEntityHandler | undefined {
    return this.#handlers.get(type);
  }

  types(): string[] {
    return [...this.#handlers.keys()];
  }
}

const KEY = /^([a-z0-9_-]{1,40}):(\S{1,200})$/;

/** Splits an entry key into its entity type and ID. */
export function parseEntryKey(key: string): { type: string; id: string } | undefined {
  const match = KEY.exec(key);
  return match?.[1] && match[2] ? { type: match[1], id: match[2] } : undefined;
}

/* ------------------------------------------------------------------ posts */

/** A post entry's value: the WordPress REST fields Studio changes. */
const postValue = z
  .object({
    title: rawText.optional(),
    content: rawText.optional(),
    excerpt: rawText.optional(),
    status: z.enum(['publish', 'draft', 'pending', 'private']).optional(),
    slug: z.string().max(200).optional(),
    parent: z.number().int().min(0).optional(),
    menu_order: z.number().int().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Give at least one field to change.' });

export type PostEntryValue = z.infer<typeof postValue>;

export interface PostEntityOptions {
  /**
   * Finds the post an entry ID names. By default a numeric ID is the post's
   * ID, and anything else its slug (the newest post of the type with it).
   */
  find?: (kernel: Kernel, id: string, type: string) => Promise<Post | undefined>;
  /**
   * Lets an entry name, by slug, a post that doesn't exist yet: publishing
   * creates it (a template customised from a theme file). `terms` gives the
   * new post's terms, by taxonomy, as slugs (a template's `wp_theme`).
   */
  create?: { terms?: (kernel: Kernel) => Promise<Record<string, string[]>> };
}

async function findPost(kernel: Kernel, id: string, type: string): Promise<Post | undefined> {
  if (/^\d+$/.test(id)) {
    const post = await kernel.posts.get(Number(id));
    return post?.type === type ? post : undefined;
  }
  const [post] = await kernel.db
    .select()
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.type, type),
        eq(schema.posts.slug, id),
        notInArray(schema.posts.status, ['trash', 'inherit']),
      ),
    )
    .orderBy(desc(schema.posts.date), desc(schema.posts.id))
    .limit(1);
  return post;
}

function postInput(value: PostEntryValue): PostInput {
  const input: PostInput = {};
  if (value.title !== undefined) input.title = value.title;
  if (value.content !== undefined) input.content = value.content;
  if (value.excerpt !== undefined) input.excerpt = value.excerpt;
  if (value.status !== undefined) input.status = value.status;
  if (value.slug !== undefined) input.slug = value.slug;
  if (value.parent !== undefined) input.parentId = value.parent || null;
  if (value.menu_order !== undefined) input.menuOrder = value.menu_order;
  return input;
}

/** Term IDs for slugs, creating missing terms (for posts a changeset creates). */
async function termIds(
  kernel: Kernel,
  terms: Record<string, string[]>,
): Promise<Record<string, number[]>> {
  const ids: Record<string, number[]> = {};
  for (const [taxonomy, slugs] of Object.entries(terms)) {
    if (!kernel.taxonomies.get(taxonomy)) continue;
    const found = await kernel.terms.list(taxonomy, { slug: slugs, perPage: 100 });
    ids[taxonomy] = [];
    for (const slug of slugs) {
      const term =
        found.terms.find((t) => t.slug === slug) ??
        (await kernel.terms.insert(taxonomy, { name: slug, slug }));
      ids[taxonomy].push(term.id);
    }
  }
  return ids;
}

/**
 * The handler for posts of one type, keyed by post ID (or slug). Core
 * registers it for `page` and `wp_navigation`; templates and template parts
 * register with one line:
 *
 *   kernel.changesets.entities.register(
 *     postEntityHandler('wp_template_part', { find, create: { terms } }),
 *   );
 *
 * Publishing saves through `kernel.posts`, so revisions, hooks and cache
 * purges work as for any save. Edit rights are `edit_post` on the post (and
 * `publish_post` to change its status to published); creating needs the
 * type's `create_posts` and `publish_posts`.
 */
export function postEntityHandler(
  type: string,
  options: PostEntityOptions = {},
): ChangesetEntityHandler<PostEntryValue> {
  const find = options.find ?? findPost;
  const typeOf = (kernel: Kernel) => {
    const postType = kernel.postTypes.get(type);
    if (!postType) throw new ChangesetEntryError('invalid_post_type', 'Invalid post type.');
    return postType;
  };
  return {
    type,
    order: 10,

    async validate(kernel, id, value, user) {
      const postType = typeOf(kernel);
      const parsed = postValue.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ChangesetEntryError(
          'rest_invalid_param',
          `${issue?.path.join('.') || 'value'}: ${issue?.message ?? 'Invalid value.'}`,
        );
      }
      const post = await find(kernel, id, type);
      if (!post) {
        const isSlug = !/^\d+$/.test(id) && sanitizeSlug(id) === id;
        if (!options.create || !isSlug) {
          throw new ChangesetEntryError('rest_post_invalid_id', 'Invalid post ID.');
        }
      }
      const v = { ...parsed.data };
      if (v.parent !== undefined && !postType.hierarchical) delete v.parent;
      if (v.slug !== undefined) v.slug = sanitizeSlug(v.slug);
      if (!userCan(user, 'unfiltered_html')) {
        if (v.title !== undefined) v.title = sanitizePostTitle(v.title);
        if (v.excerpt !== undefined) v.excerpt = sanitizePostTitle(v.excerpt);
        if (v.content !== undefined) v.content = sanitizePostContent(v.content);
      }
      return v;
    },

    async canEdit(kernel, id, value, user) {
      const postType = typeOf(kernel);
      const post = await find(kernel, id, type);
      if (!post) {
        return userCan(user, postType.cap.create_posts) && userCan(user, postType.cap.publish_posts);
      }
      if (!(await currentUserCan(kernel, user, 'edit_post', post.id))) return false;
      const publishing = value.status === 'publish' || value.status === 'private';
      if (publishing && post.status !== value.status) {
        return currentUserCan(kernel, user, 'publish_post', post.id);
      }
      return true;
    },

    async apply(kernel, id, value, author) {
      const input = postInput(value);
      // The value was sanitised for its author when it was written; publishing
      // filters it again for an author without unfiltered_html, as wp_insert_post() would.
      input.filterHtml = !userCan(author, 'unfiltered_html');
      const post = await find(kernel, id, type);
      if (post) {
        await kernel.posts.update(post.id, input);
        return;
      }
      if (!options.create) throw new ChangesetEntryError('rest_post_invalid_id', 'Invalid post ID.');
      const terms = options.create.terms ? await termIds(kernel, await options.create.terms(kernel)) : {};
      await kernel.posts.insert(type, {
        ...input,
        title: input.title ?? id,
        slug: id,
        status: input.status ?? 'publish',
        authorId: author?.id ?? null,
        terms,
      });
    },

    async preview(kernel, id, value, preview) {
      const post = await find(kernel, id, type);
      const input = postInput(value);
      if (post) {
        preview.posts.set(post.id, {
          ...(preview.posts.get(post.id) ?? post),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.slug ? { slug: input.slug } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.menuOrder !== undefined ? { menuOrder: input.menuOrder } : {}),
          modified: new Date(),
        });
        return;
      }
      if (!options.create) return;
      const now = new Date();
      const previewId = preview.nextId();
      preview.created.set(previewId, {
        post: {
          id: previewId,
          authorId: preview.user.id,
          date: now,
          modified: now,
          content: input.content ?? '',
          title: input.title ?? id,
          excerpt: input.excerpt ?? '',
          status: input.status ?? 'publish',
          commentStatus: 'closed',
          pingStatus: 'closed',
          password: '',
          slug: id,
          contentFiltered: '',
          parentId: input.parentId ?? null,
          guid: '',
          menuOrder: input.menuOrder ?? 0,
          type,
          mimeType: '',
          commentCount: 0,
        },
        terms: options.create.terms ? await options.create.terms(kernel) : {},
      });
    },
  };
}

/* ---------------------------------------------------------- global styles */

/**
 * User global styles, keyed by theme: `wp_global_styles:{stylesheet}`. The
 * value is what POST /wp/v2/global-styles/{id} takes (`styles`, `settings`),
 * prepared as that endpoint prepares it; `edit_theme_options` (the post
 * type's capabilities) is needed.
 */
export function globalStylesEntityHandler(): ChangesetEntityHandler<GlobalStylesConfig> {
  return {
    type: GLOBAL_STYLES_POST_TYPE,
    order: 20,

    async validate(kernel, id, value, user) {
      if (!(await kernel.themes.get(id))) {
        throw new ChangesetEntryError('rest_theme_not_found', 'Theme not found.');
      }
      const request = z
        .object({ styles: z.unknown().optional(), settings: z.unknown().optional() })
        .strict()
        .safeParse(value);
      if (!request.success) {
        throw new ChangesetEntryError('rest_invalid_param', 'Give `styles` and/or `settings`.');
      }
      const post = await userGlobalStylesPost(kernel, id);
      const existing: GlobalStylesConfig = post
        ? decodeGlobalStyles(post.content)
        : { version: 3, isGlobalStylesUserThemeJSON: true };
      const prepared = prepareGlobalStyles(kernel, user, existing, request.data);
      if (!prepared.ok) throw new ChangesetEntryError(prepared.code, prepared.message);
      return prepared.config;
    },

    async canEdit(_kernel, _id, _value, user) {
      return userCan(user, 'edit_theme_options');
    },

    async apply(kernel, id, config, author) {
      const post = await userGlobalStylesPost(kernel, id, true);
      if (!post) throw new ChangesetEntryError('rest_global_styles_not_found', 'No global styles.');
      await saveGlobalStyles(kernel, post, config, undefined, author?.id);
    },

    async preview(kernel, id, config, preview) {
      if (id === (await kernel.themes.activeStylesheet())) preview.globalStyles = config;
    },
  };
}

/* ---------------------------------------------------------------- options */

/**
 * The options a changeset may change: the site's identity and front page,
 * and the header menu — what the Customizer's Site Identity, Homepage
 * Settings and Menus panels change. Each needs its setting's capability
 * (`manage_options`), or `edit_theme_options` for the menu.
 */
export const CHANGESET_OPTIONS = [
  'blogname',
  'blogdescription',
  'show_on_front',
  'page_on_front',
  'page_for_posts',
  'site_logo',
  'site_icon',
  'pressbase_navigation_fallback',
] as const;

/** Settings the registry doesn't expose over REST but a changeset may change. */
const EXTRA_SETTINGS: Record<string, SettingDefinition> = {
  pressbase_navigation_fallback: {
    option: 'pressbase_navigation_fallback',
    schema: z.number().int().min(0),
    default: 0,
    capability: 'edit_theme_options',
  },
};

function settingFor(kernel: Kernel, option: string): SettingDefinition | undefined {
  for (const [, setting] of kernel.settings.entries()) if (setting.option === option) return setting;
  return EXTRA_SETTINGS[option];
}

/** Options on the allow-list, keyed by option name: `option:blogname`. */
export function optionEntityHandler(allowed: ReadonlySet<string>): ChangesetEntityHandler<unknown> {
  const setting = (kernel: Kernel, id: string) => {
    const found = allowed.has(id) ? settingFor(kernel, id) : undefined;
    if (!found) {
      throw new ChangesetEntryError(
        'changeset_option_not_allowed',
        'This option can’t be changed in a changeset.',
      );
    }
    return found;
  };
  return {
    type: 'option',
    order: 30,

    async validate(kernel, id, value) {
      const definition = setting(kernel, id);
      const parsed = definition.schema.safeParse(value);
      if (!parsed.success) {
        throw new ChangesetEntryError(
          'rest_invalid_param',
          parsed.error.issues[0]?.message ?? 'Invalid value.',
        );
      }
      try {
        return definition.sanitize ? await definition.sanitize(parsed.data, id) : parsed.data;
      } catch (error) {
        throw new ChangesetEntryError(
          'rest_invalid_param',
          error instanceof Error ? error.message : String(error),
        );
      }
    },

    async canEdit(kernel, id, _value, user) {
      return userCan(user, setting(kernel, id).capability);
    },

    async apply(kernel, id, value) {
      // update_option(): sanitize_option() and the pre_update_option filters run now.
      const next = await sanitizeSettingValue(kernel, setting(kernel, id), value);
      await kernel.options.set(id, next);
    },

    async preview(_kernel, id, value, preview) {
      preview.options.set(id, value);
    },
  };
}
