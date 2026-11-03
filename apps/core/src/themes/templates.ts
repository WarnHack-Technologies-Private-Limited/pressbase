import { schema } from '@pressbase/db';
import { and, eq, inArray } from 'drizzle-orm';
import { userCan } from '../auth/users';
import { type QueryArgs, queryPosts } from '../content/query';
import { PostError, type Post } from '../content/posts';
import type { Kernel } from '../kernel';
import type { ActiveTheme } from './service';

/**
 * Templates and template parts — the `wp_template` and `wp_template_part`
 * post types, and the lookups that put a site owner's customised copy in
 * front of the theme's file. Ports of, in wordpress/wp-includes/:
 *
 * - create_initial_post_types() / create_initial_taxonomies() (post.php,
 *   taxonomy.php): the two post types and the `wp_theme` and
 *   `wp_template_part_area` taxonomies;
 * - block-template-utils.php: get_allowed_block_template_part_areas(),
 *   get_default_block_template_types(), _get_block_templates_files(),
 *   _build_block_template_result_from_file(),
 *   _build_block_template_object_from_post_object(),
 *   _build_block_template_result_from_post(), get_block_templates(),
 *   get_block_template(), get_block_file_template();
 * - block-template.php: resolve_block_template(), locate_block_template(),
 *   wp_render_empty_block_template_warning();
 * - theme-templates.php: wp_filter_wp_template_unique_post_slug();
 * - class-wp-rest-templates-controller.php: prepare_item_for_database(),
 *   update_item(), create_item() and delete_item(), as saveBlockTemplate()
 *   and deleteBlockTemplate(), so Studio and changesets can write without HTTP.
 *
 * As in WordPress, a customised template is a published post tagged with the
 * theme's `wp_theme` term (its name is the theme's stylesheet); a part also
 * has a `wp_template_part_area` term. The theme's file never changes:
 * trashing or deleting the post brings it back.
 *
 * Custom copies are read through queryPosts() (the `content_query_args`
 * filter applies), never a separate cache, so a preview layer over the
 * content queries sees templates too. Changes purge the page cache through
 * the usual post hooks: both types are non-public, so a published change
 * purges the `site` tag (cache/invalidation.ts).
 *
 * Filters, with WordPress's names: pre_get_block_templates,
 * get_block_templates, pre_get_block_template, get_block_template,
 * pre_get_block_file_template, get_block_file_template,
 * default_template_types, default_wp_template_part_areas.
 * Actions: render_block_core_template_part_post / _file / _none (from the
 * template part block).
 */

export const TEMPLATE_POST_TYPE = 'wp_template';
export const TEMPLATE_PART_POST_TYPE = 'wp_template_part';
export const THEME_TAXONOMY = 'wp_theme';
export const TEMPLATE_PART_AREA_TAXONOMY = 'wp_template_part_area';
/** WP_TEMPLATE_PART_AREA_UNCATEGORIZED */
export const TEMPLATE_PART_AREA_UNCATEGORIZED = 'uncategorized';

export type TemplateType = typeof TEMPLATE_POST_TYPE | typeof TEMPLATE_PART_POST_TYPE;

export const isTemplateType = (type: string): type is TemplateType =>
  type === TEMPLATE_POST_TYPE || type === TEMPLATE_PART_POST_TYPE;

/** WP_Block_Template: a template or part, from a theme file or a post. */
export interface BlockTemplate {
  /** `{theme}//{slug}` */
  id: string;
  /** The stylesheet it belongs to (the child theme's, even for a parent's file). */
  theme: string;
  content: string;
  slug: string;
  /** `theme`: the theme's file; `custom`: a post (a customised copy or a new template). */
  source: 'theme' | 'custom';
  /** For a customised copy, where it came from (`theme`); null otherwise. */
  origin: string | null;
  type: TemplateType;
  title: string;
  description: string;
  status: string;
  /** The post's ID (for a revision, the revision's); null for theme files. */
  wpId: number | null;
  hasThemeFile: boolean;
  /** False for the hierarchy's templates (index, single…); true for custom templates. */
  isCustom: boolean;
  author: number | null;
  /** Template parts: header, footer, navigation-overlay or uncategorized. */
  area?: string;
  /** Custom templates from theme.json: the post types that can use them. */
  postTypes?: string[];
  modified: Date | null;
  date: Date | null;
}

export interface BlockTemplatesQuery {
  /** Only these slugs. */
  slug__in?: string[];
  /** Not these slugs (theme files only, as in WordPress). */
  slug__not_in?: string[];
  /** The post of a customised template (also finds drafts; skips theme files). */
  wp_id?: number;
  /** Template parts in this area. */
  area?: string;
  /** Templates a post of this type can choose. */
  post_type?: string;
}

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    pre_get_block_templates: [
      templates: BlockTemplate[] | null,
      query: BlockTemplatesQuery,
      type: TemplateType,
    ];
    get_block_templates: [
      templates: BlockTemplate[],
      query: BlockTemplatesQuery,
      type: TemplateType,
    ];
    pre_get_block_template: [template: BlockTemplate | null, id: string, type: TemplateType];
    get_block_template: [template: BlockTemplate | null, id: string, type: TemplateType];
    pre_get_block_file_template: [template: BlockTemplate | null, id: string, type: TemplateType];
    get_block_file_template: [template: BlockTemplate | null, id: string, type: TemplateType];
    default_template_types: [types: Record<string, { title: string; description: string }>];
    default_wp_template_part_areas: [areas: TemplatePartArea[]];
    pre_wp_unique_post_slug: [
      override: string | null,
      slug: string,
      postId: number,
      status: string,
      type: string,
      parent: number,
    ];
  }
}

/* -------------------------------------------------------------- registration */

/** create_initial_post_types(): wp_template and wp_template_part; create_initial_taxonomies(): wp_theme, wp_template_part_area. */
export function registerTemplatePostTypes(kernel: Kernel): void {
  // Everything but the meta capabilities maps to edit_theme_options.
  const capabilities = {
    create_posts: 'edit_theme_options',
    delete_posts: 'edit_theme_options',
    delete_others_posts: 'edit_theme_options',
    delete_private_posts: 'edit_theme_options',
    delete_published_posts: 'edit_theme_options',
    edit_posts: 'edit_theme_options',
    edit_others_posts: 'edit_theme_options',
    edit_private_posts: 'edit_theme_options',
    edit_published_posts: 'edit_theme_options',
    publish_posts: 'edit_theme_options',
    read: 'edit_theme_options',
    read_private_posts: 'edit_theme_options',
  };
  kernel.postTypes.register(
    TEMPLATE_POST_TYPE,
    {
      label: 'Templates',
      singularLabel: 'Template',
      description: 'Templates to include in your theme.',
      public: false,
      showInRest: true,
      restBase: 'templates',
      capabilityType: ['template', 'templates'],
      capabilities,
      supports: ['title', 'excerpt', 'editor', 'revisions', 'author'],
    },
    true,
  );
  kernel.postTypes.register(
    TEMPLATE_PART_POST_TYPE,
    {
      label: 'Template Parts',
      singularLabel: 'Template Part',
      description: 'Template parts to include in your templates.',
      public: false,
      showInRest: true,
      restBase: 'template-parts',
      capabilities,
      supports: ['title', 'excerpt', 'editor', 'revisions', 'author'],
    },
    true,
  );
  kernel.taxonomies.register(
    THEME_TAXONOMY,
    [TEMPLATE_POST_TYPE, TEMPLATE_PART_POST_TYPE, 'wp_global_styles'],
    { label: 'Themes', singularLabel: 'Theme', public: false },
    true,
  );
  kernel.taxonomies.register(
    TEMPLATE_PART_AREA_TAXONOMY,
    [TEMPLATE_PART_POST_TYPE],
    { label: 'Template Part Areas', singularLabel: 'Template Part Area', public: false },
    true,
  );

  // wp_filter_wp_template_unique_post_slug(): template slugs are unique per theme.
  kernel.hooks.addFilter(
    'pre_wp_unique_post_slug',
    async (override, slug, postId, _status, type) => {
      if (!isTemplateType(type)) return override;
      const theme =
        (postId ? (await postThemeTerms(kernel, [postId])).get(postId)?.theme : undefined) ??
        (await kernel.themes.active()).info.stylesheet;
      return uniqueTemplateSlug(kernel, override || slug, type, theme, postId);
    },
  );
}

/* ------------------------------------------------------------ areas and types */

export interface TemplatePartArea {
  area: string;
  label: string;
  description: string;
  icon: string;
  area_tag: string;
}

/** get_allowed_block_template_part_areas() */
export async function allowedTemplatePartAreas(kernel: Kernel): Promise<TemplatePartArea[]> {
  const { i18n } = kernel;
  const areas: TemplatePartArea[] = [
    {
      area: TEMPLATE_PART_AREA_UNCATEGORIZED,
      label: i18n._x('General', 'template part area'),
      description: i18n.__(
        'General templates often perform a specific role like displaying post content, and are not tied to any particular area.',
      ),
      icon: 'layout',
      area_tag: 'div',
    },
    {
      area: 'header',
      label: i18n._x('Header', 'template part area'),
      description: i18n.__(
        'The Header template defines a page area that typically contains a title, logo, and main navigation.',
      ),
      icon: 'header',
      area_tag: 'header',
    },
    {
      area: 'footer',
      label: i18n._x('Footer', 'template part area'),
      description: i18n.__(
        'The Footer template defines a page area that typically contains site credits, social links, or any other combination of blocks.',
      ),
      icon: 'footer',
      area_tag: 'footer',
    },
    {
      area: 'navigation-overlay',
      label: i18n._x('Navigation Overlay', 'template part area'),
      description: i18n.__(
        'The Navigation Overlay template defines an overlay area that typically contains navigation links and can be toggled open and closed.',
      ),
      icon: 'navigation-overlay',
      area_tag: 'div',
    },
  ];
  const filtered = await kernel.hooks.applyFilters('default_wp_template_part_areas', areas);
  return Array.isArray(filtered) ? filtered : areas;
}

/** _filter_block_template_part_area(): a known area, else `uncategorized`. */
export async function filterTemplatePartArea(kernel: Kernel, area: string): Promise<string> {
  const allowed = await allowedTemplatePartAreas(kernel);
  return allowed.some((a) => a.area === area) ? area : TEMPLATE_PART_AREA_UNCATEGORIZED;
}

/** get_post_format_strings() */
const POST_FORMATS: Record<string, string> = {
  standard: 'Standard',
  aside: 'Aside',
  chat: 'Chat',
  gallery: 'Gallery',
  link: 'Link',
  image: 'Image',
  quote: 'Quote',
  status: 'Status',
  video: 'Video',
  audio: 'Audio',
};

/** get_default_block_template_types(): the hierarchy's templates, with titles and descriptions. */
export async function defaultTemplateTypes(
  kernel: Kernel,
): Promise<Record<string, { title: string; description: string }>> {
  const { i18n } = kernel;
  const t = (title: string) => i18n._x(title, 'Template name');
  const types: Record<string, { title: string; description: string }> = {
    index: {
      title: t('Index'),
      description: i18n.__(
        'Used as a fallback template for all pages when a more specific template is not defined.',
      ),
    },
    home: {
      title: t('Blog Home'),
      description: i18n.__(
        'Displays the latest posts as either the site homepage or as the "Posts page" as defined under reading settings. If it exists, the Front Page template overrides this template when posts are shown on the homepage.',
      ),
    },
    'front-page': {
      title: t('Front Page'),
      description: i18n.__(
        "Displays your site's homepage, whether it is set to display latest posts or a static page. The Front Page template takes precedence over all templates.",
      ),
    },
    singular: {
      title: t('Single Entries'),
      description: i18n.__(
        'Displays any single entry, such as a post or a page. This template will serve as a fallback when a more specific template (e.g. Single Post, Page, or Attachment) cannot be found.',
      ),
    },
    single: {
      title: t('Single Posts'),
      description: i18n.__(
        'Displays a single post on your website unless a custom template has been applied to that post or a dedicated template exists.',
      ),
    },
    page: {
      title: t('Pages'),
      description: i18n.__(
        'Displays a static page unless a custom template has been applied to that page or a dedicated template exists.',
      ),
    },
    archive: {
      title: t('All Archives'),
      description: i18n.__(
        'Displays any archive, including posts by a single author, category, tag, taxonomy, custom post type, and date. This template will serve as a fallback when more specific templates (e.g. Category or Tag) cannot be found.',
      ),
    },
    author: {
      title: t('Author Archives'),
      description: i18n.__(
        "Displays a single author's post archive. This template will serve as a fallback when a more specific template (e.g. Author: Admin) cannot be found.",
      ),
    },
    category: {
      title: t('Category Archives'),
      description: i18n.__(
        'Displays a post category archive. This template will serve as a fallback when a more specific template (e.g. Category: Recipes) cannot be found.',
      ),
    },
    taxonomy: {
      title: t('Taxonomy'),
      description: i18n.__(
        'Displays a custom taxonomy archive. Like categories and tags, taxonomies have terms which you use to classify things. For example: a taxonomy named "Art" can have multiple terms, such as "Modern" and "18th Century." This template will serve as a fallback when a more specific template (e.g. Taxonomy: Art) cannot be found.',
      ),
    },
    date: {
      title: t('Date Archives'),
      description: i18n.__(
        'Displays a post archive when a specific date is visited (e.g., example.com/2023/).',
      ),
    },
    tag: {
      title: t('Tag Archives'),
      description: i18n.__(
        'Displays a post tag archive. This template will serve as a fallback when a more specific template (e.g. Tag: Pizza) cannot be found.',
      ),
    },
    attachment: {
      title: i18n.__('Attachment Pages'),
      description: i18n.__(
        'Displays when a visitor views the dedicated page that exists for any media attachment.',
      ),
    },
    search: {
      title: t('Search Results'),
      description: i18n.__('Displays when a visitor performs a search on your website.'),
    },
    'privacy-policy': {
      title: i18n.__('Privacy Policy'),
      description: i18n.__("Displays your site's Privacy Policy page."),
    },
    '404': {
      title: t('Page: 404'),
      description: i18n.__(
        'Displays when a visitor views a non-existent page, such as a dead link or a mistyped URL.',
      ),
    },
  };
  for (const [slug, name] of Object.entries(POST_FORMATS)) {
    types[`taxonomy-post_format-post-format-${slug}`] = {
      title: i18n._x('Post Format: %s', 'Template name').replace('%s', name),
      description: i18n.__('Displays the %s post format archive.').replace('%s', name),
    };
  }
  const filtered = await kernel.hooks.applyFilters('default_template_types', types);
  return filtered && typeof filtered === 'object' ? filtered : types;
}

/* --------------------------------------------------------------- theme files */

/** A template file of the active theme: _get_block_templates_files()'s items. */
interface TemplateFileItem {
  slug: string;
  /** The theme folder that has the file (a child theme's, or its parent's). */
  theme: string;
  type: TemplateType;
  content: string;
  title?: string;
  postTypes?: string[];
  area?: string;
}

/** _get_block_template_file() + _add_block_template_info() / _add_block_template_part_area_info(). */
async function templateFile(
  kernel: Kernel,
  theme: ActiveTheme,
  type: TemplateType,
  slug: string,
): Promise<TemplateFileItem | undefined> {
  if (type === TEMPLATE_POST_TYPE) {
    const file = theme.templates.get(slug);
    if (!file) return undefined;
    const custom = theme.customTemplates.find((t) => t.name === slug);
    return {
      slug,
      theme: file.theme,
      type,
      content: file.content,
      ...(custom ? { title: custom.title, postTypes: custom.postTypes } : {}),
    };
  }
  const file = theme.parts.get(slug);
  if (!file) return undefined;
  return {
    slug,
    theme: file.theme,
    type,
    content: file.content,
    title: file.title,
    area: await filterTemplatePartArea(kernel, file.area),
  };
}

/** _get_block_templates_files() */
async function templateFiles(
  kernel: Kernel,
  theme: ActiveTheme,
  type: TemplateType,
  query: BlockTemplatesQuery,
): Promise<TemplateFileItem[]> {
  const defaults = type === TEMPLATE_POST_TYPE ? await defaultTemplateTypes(kernel) : {};
  const slugs = [...(type === TEMPLATE_POST_TYPE ? theme.templates : theme.parts).keys()];
  const out: TemplateFileItem[] = [];
  for (const slug of slugs) {
    if (query.slug__in?.length && !query.slug__in.includes(slug)) continue;
    if (query.slug__not_in?.length && query.slug__not_in.includes(slug)) continue;
    const item = await templateFile(kernel, theme, type, slug);
    if (!item) continue;
    if (type === TEMPLATE_PART_POST_TYPE) {
      if (query.area === undefined || query.area === item.area) out.push(item);
      continue;
    }
    const isCustom = !(slug in defaults);
    if (!query.post_type || item.postTypes?.includes(query.post_type)) out.push(item);
    // Custom templates with no post types are available for all post types.
    else if (!item.postTypes && isCustom) out.push(item);
  }
  return out;
}

/** _build_block_template_result_from_file() */
async function buildFromFile(
  kernel: Kernel,
  theme: ActiveTheme,
  file: TemplateFileItem,
): Promise<BlockTemplate> {
  const stylesheet = theme.info.stylesheet;
  const template: BlockTemplate = {
    id: `${stylesheet}//${file.slug}`,
    theme: stylesheet,
    content: file.content,
    slug: file.slug,
    source: 'theme',
    origin: null,
    type: file.type,
    title: file.title || file.slug,
    description: '',
    status: 'publish',
    wpId: null,
    hasThemeFile: true,
    isCustom: true,
    author: null,
    modified: null,
    date: null,
  };
  if (file.type === TEMPLATE_POST_TYPE) {
    const defaults = (await defaultTemplateTypes(kernel))[file.slug];
    if (defaults) {
      template.title = defaults.title;
      template.description = defaults.description;
      template.isCustom = false;
    }
    if (file.postTypes) template.postTypes = file.postTypes;
  }
  if (file.type === TEMPLATE_PART_POST_TYPE && file.area) template.area = file.area;
  return template;
}

/* -------------------------------------------------------------------- posts */

/** The `wp_theme` (and `wp_template_part_area`) term names of posts: one query. */
async function postThemeTerms(
  kernel: Kernel,
  postIds: number[],
): Promise<Map<number, { theme?: string; area?: string }>> {
  const out = new Map<number, { theme?: string; area?: string }>();
  if (!postIds.length) return out;
  const { terms, termTaxonomy, termRelationships } = schema;
  const rows = await kernel.db
    .select({
      objectId: termRelationships.objectId,
      taxonomy: termTaxonomy.taxonomy,
      name: terms.name,
    })
    .from(termRelationships)
    .innerJoin(termTaxonomy, eq(termTaxonomy.id, termRelationships.termTaxonomyId))
    .innerJoin(terms, eq(terms.id, termTaxonomy.termId))
    .where(
      and(
        inArray(termRelationships.objectId, postIds),
        inArray(termTaxonomy.taxonomy, [THEME_TAXONOMY, TEMPLATE_PART_AREA_TAXONOMY]),
      ),
    )
    .orderBy(termRelationships.termOrder, termTaxonomy.termId);
  for (const row of rows) {
    const entry = out.get(row.objectId) ?? {};
    out.set(row.objectId, entry);
    // get_the_terms()[0]: the first term wins.
    if (row.taxonomy === THEME_TAXONOMY) entry.theme ??= row.name;
    else entry.area ??= row.name;
  }
  return out;
}

/** The ID of the term with this exact name, created when missing (wp_set_post_terms() by name). */
async function termIdByName(kernel: Kernel, taxonomy: string, name: string): Promise<number> {
  const { terms, termTaxonomy } = schema;
  const [row] = await kernel.db
    .select({ id: terms.id })
    .from(terms)
    .innerJoin(termTaxonomy, eq(termTaxonomy.termId, terms.id))
    .where(and(eq(termTaxonomy.taxonomy, taxonomy), eq(terms.name, name)))
    .limit(1);
  if (row) return row.id;
  return (await kernel.terms.insert(taxonomy, { name })).id;
}

/**
 * _build_block_template_result_from_post(), for several posts at once (one
 * query for terms, one for meta). Revisions take their parent's slug, type,
 * terms and meta. Posts without a `wp_theme` term are skipped (WordPress's
 * `template_missing_theme` error).
 */
export async function buildBlockTemplatesFromPosts(
  kernel: Kernel,
  posts: Post[],
  theme?: ActiveTheme,
): Promise<(BlockTemplate | undefined)[]> {
  const active = theme ?? (await kernel.themes.active());
  const parents = new Map<number, Post>();
  for (const post of posts) {
    if (post.type === 'revision' && post.parentId && !parents.has(post.parentId)) {
      const parent = await kernel.posts.get(post.parentId);
      if (parent) parents.set(parent.id, parent);
    }
  }
  const parentOf = (post: Post) =>
    post.type === 'revision' && post.parentId ? parents.get(post.parentId) : post;
  const ids = [...new Set(posts.map((p) => parentOf(p)?.id).filter((id) => id !== undefined))];
  const terms = await postThemeTerms(kernel, ids);
  const meta = await kernel.meta.values('post', ids, ['origin', 'is_wp_suggestion']);
  const defaults = await defaultTemplateTypes(kernel);

  const out: (BlockTemplate | undefined)[] = [];
  for (const post of posts) {
    const parent = parentOf(post);
    const type = parent?.type;
    const themeName = parent ? terms.get(parent.id)?.theme : undefined;
    if (!parent || !type || !isTemplateType(type) || !themeName) {
      out.push(undefined);
      continue;
    }
    // _build_block_template_object_from_post_object()
    const file =
      themeName === active.info.stylesheet
        ? await templateFile(kernel, active, type, parent.slug)
        : undefined;
    const postMeta = meta.get(parent.id);
    const origin = postMeta?.get('origin')?.[0];
    const suggestion = postMeta?.get('is_wp_suggestion')?.[0];
    const template: BlockTemplate = {
      id: `${themeName}//${parent.slug}`,
      theme: themeName,
      content: post.content,
      slug: parent.slug,
      source: 'custom',
      origin: typeof origin === 'string' && origin ? origin : null,
      type,
      title: post.title,
      description: post.excerpt,
      status: post.status,
      wpId: post.id,
      hasThemeFile: Boolean(file),
      isCustom: !suggestion,
      author: post.authorId,
      modified: post.modified,
      date: post.date,
    };
    if (type === TEMPLATE_POST_TYPE && file?.postTypes) template.postTypes = file.postTypes;
    if (type === TEMPLATE_POST_TYPE && template.slug in defaults) template.isCustom = false;
    if (type === TEMPLATE_PART_POST_TYPE) {
      const area = terms.get(parent.id)?.area;
      if (area) template.area = area;
    }
    if (
      type === TEMPLATE_POST_TYPE &&
      !template.description &&
      (!template.title || template.title === template.slug)
    ) {
      await describeCustomTemplate(kernel, template);
    }
    out.push(template);
  }
  return out;
}

/** _build_block_template_result_from_post() for one post. */
export async function buildBlockTemplateResultFromPost(
  kernel: Kernel,
  post: Post,
  theme?: ActiveTheme,
): Promise<BlockTemplate | undefined> {
  return (await buildBlockTemplatesFromPosts(kernel, [post], theme))[0];
}

/**
 * The title and description of an untitled template for one author, page,
 * post, tag, category or taxonomy term (`page-about`, `single-post-hello`,
 * `category-news`), from _build_block_template_result_from_post(),
 * _wp_build_title_and_description_for_single_post_type_block_template() and
 * _wp_build_title_and_description_for_taxonomy_block_template().
 */
async function describeCustomTemplate(kernel: Kernel, template: BlockTemplate): Promise<void> {
  const match = /(author|page|single|tag|category|taxonomy)-(.+)/.exec(template.slug);
  if (!match) return;
  const [, kind, rest = ''] = match;
  const { i18n } = kernel;
  const forPost = async (postType: string, slug: string) => {
    const type = kernel.postTypes.get(postType);
    if (!type) return false;
    const [post] = await kernel.db
      .select({ title: schema.posts.title })
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.type, postType),
          eq(schema.posts.status, 'publish'),
          eq(schema.posts.slug, slug),
        ),
      )
      .limit(1);
    if (!post) {
      template.title = i18n
        .__('Not found: %1$s (%2$s)')
        .replace('%1$s', type.singularLabel)
        .replace('%2$s', slug);
      return false;
    }
    template.title = `${type.singularLabel}: ${post.title}`;
    template.description = i18n.__('Template for %s').replace('%s', post.title);
    const same = await kernel.db
      .select({ id: schema.posts.id })
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.type, postType),
          eq(schema.posts.status, 'publish'),
          eq(schema.posts.title, post.title),
        ),
      )
      .limit(2);
    if (same.length > 1) template.title = `${template.title} (${slug})`;
    return true;
  };
  const forTerm = async (taxonomy: string, slug: string) => {
    const tax = kernel.taxonomies.get(taxonomy);
    if (!tax) return false;
    const { terms } = await kernel.terms.list(taxonomy, { slug: [slug], perPage: 1 });
    const term = terms[0];
    if (!term) {
      template.title = i18n
        .__('Not found: %1$s (%2$s)')
        .replace('%1$s', tax.singularLabel)
        .replace('%2$s', slug);
      return false;
    }
    template.title = `${tax.singularLabel}: ${term.name}`;
    template.description = i18n.__('Template for %s').replace('%s', term.name);
    const { terms: same } = await kernel.terms.list(taxonomy, { search: term.name, perPage: 10 });
    if (same.filter((t) => t.name === term.name).length > 1) {
      template.title = `${template.title} (${slug})`;
    }
    return true;
  };

  switch (kind) {
    case 'author': {
      const [user] = await kernel.db
        .select({ name: schema.users.displayName })
        .from(schema.users)
        .where(eq(schema.users.nicename, rest))
        .limit(1);
      if (!user) {
        template.title = i18n.__('Deleted author: %s').replace('%s', rest);
      } else {
        template.title = i18n.__('Author: %s').replace('%s', user.name);
        template.description = i18n.__('Template for %s').replace('%s', user.name);
      }
      return;
    }
    case 'page':
      await forPost('page', rest);
      return;
    case 'single':
      for (const type of kernel.postTypes.all()) {
        if (rest.startsWith(`${type.name}-`) && (await forPost(type.name, rest.slice(type.name.length + 1))))
          return;
      }
      return;
    case 'tag':
      await forTerm('post_tag', rest);
      return;
    case 'category':
      await forTerm('category', rest);
      return;
    case 'taxonomy':
      for (const taxonomy of kernel.taxonomies.all()) {
        if (rest.startsWith(`${taxonomy.name}-`) && (await forTerm(taxonomy.name, rest.slice(taxonomy.name.length + 1))))
          return;
      }
      return;
  }
}

/* ------------------------------------------------------------------- lookups */

/** Splits `theme//slug`; undefined when there is no `//`. */
export function parseTemplateId(id: string): { theme: string; slug: string } | undefined {
  const at = id.indexOf('//');
  if (at < 0) return undefined;
  return { theme: id.slice(0, at), slug: id.slice(at + 2) };
}

/**
 * get_block_templates(): the active theme's templates (or parts), customised
 * copies first; a theme file shows only when no published copy has its slug.
 */
export async function getBlockTemplates(
  kernel: Kernel,
  query: BlockTemplatesQuery = {},
  type: TemplateType = TEMPLATE_POST_TYPE,
  theme?: ActiveTheme,
): Promise<BlockTemplate[]> {
  const pre = await kernel.hooks.applyFilters('pre_get_block_templates', null, query, type);
  if (Array.isArray(pre)) return pre;
  const active = theme ?? (await kernel.themes.active());

  const args: QueryArgs = {
    post_type: type,
    post_status: ['auto-draft', 'draft', 'publish'],
    posts_per_page: -1,
    no_found_rows: true,
    tax_query: [{ taxonomy: THEME_TAXONOMY, field: 'name', terms: [active.info.stylesheet] }],
  };
  if (type === TEMPLATE_PART_POST_TYPE && query.area !== undefined) {
    args.tax_query?.push({
      taxonomy: TEMPLATE_PART_AREA_TAXONOMY,
      field: 'name',
      terms: [query.area],
    });
  }
  if (query.slug__in?.length) {
    args.post_name__in = query.slug__in;
    args.posts_per_page = new Set(query.slug__in).size;
  }
  // Drafts only for the listing and editor of one post.
  if (query.wp_id !== undefined) args.p = query.wp_id;
  else args.post_status = 'publish';

  const { posts } = await queryPosts(kernel, args);
  const result: BlockTemplate[] = [];
  for (const template of await buildBlockTemplatesFromPosts(kernel, posts, active)) {
    if (!template) continue;
    if (query.post_type && !template.isCustom) continue;
    if (query.post_type && template.postTypes && !template.postTypes.includes(query.post_type))
      continue;
    result.push(template);
  }

  if (query.wp_id === undefined) {
    // User templates have priority over the theme's: skip their files. All
    // files are listed regardless of post type, so `page` isn't excluded
    // when looking for page templates (Gutenberg #65584), then filtered.
    const { post_type: postType, ...fileQuery } = query;
    fileQuery.slug__not_in = result.map((t) => t.slug);
    const defaults = await defaultTemplateTypes(kernel);
    for (const file of await templateFiles(kernel, active, type, fileQuery)) {
      if (postType === undefined || file.postTypes?.includes(postType)) {
        result.push(await buildFromFile(kernel, active, file));
      } else if (!file.postTypes && !(file.slug in defaults)) {
        result.push(await buildFromFile(kernel, active, file));
      }
    }
  }

  const filtered = await kernel.hooks.applyFilters('get_block_templates', result, query, type);
  return Array.isArray(filtered) ? filtered : result;
}

/** get_block_template(): one template by `theme//slug`, a customised copy first. */
export async function getBlockTemplate(
  kernel: Kernel,
  id: string,
  type: TemplateType = TEMPLATE_POST_TYPE,
  theme?: ActiveTheme,
): Promise<BlockTemplate | null> {
  const pre = await kernel.hooks.applyFilters('pre_get_block_template', null, id, type);
  if (pre) return pre;
  const parts = parseTemplateId(id);
  if (!parts) return null;
  const active = theme ?? (await kernel.themes.active());
  const { posts } = await queryPosts(kernel, {
    post_name__in: [parts.slug],
    post_type: type,
    post_status: ['auto-draft', 'draft', 'publish', 'trash'],
    posts_per_page: 1,
    no_found_rows: true,
    tax_query: [{ taxonomy: THEME_TAXONOMY, field: 'name', terms: [parts.theme] }],
  });
  if (posts[0]) {
    const template = await buildBlockTemplateResultFromPost(kernel, posts[0], active);
    if (template) return template;
  }
  const file = await getBlockFileTemplate(kernel, id, type, active);
  const filtered = await kernel.hooks.applyFilters('get_block_template', file, id, type);
  return filtered ?? null;
}

/** get_block_file_template(): the theme's file, ignoring customised copies. */
export async function getBlockFileTemplate(
  kernel: Kernel,
  id: string,
  type: TemplateType = TEMPLATE_POST_TYPE,
  theme?: ActiveTheme,
): Promise<BlockTemplate | null> {
  const pre = await kernel.hooks.applyFilters('pre_get_block_file_template', null, id, type);
  if (pre) return pre;
  const parts = parseTemplateId(id);
  let template: BlockTemplate | null = null;
  if (parts) {
    const active = theme ?? (await kernel.themes.active());
    if (parts.theme === active.info.stylesheet) {
      const file = await templateFile(kernel, active, type, parts.slug);
      if (file) template = await buildFromFile(kernel, active, file);
    }
  }
  const filtered = await kernel.hooks.applyFilters('get_block_file_template', template, id, type);
  return filtered ?? null;
}

/**
 * resolve_block_template(): the first template of the hierarchy that exists,
 * as a customised copy or a theme file. A custom template with no theme file
 * (`single-post-hello`, made in Studio) takes part too.
 */
export async function resolveBlockTemplate(
  kernel: Kernel,
  hierarchy: string[],
  theme?: ActiveTheme,
): Promise<BlockTemplate | undefined> {
  if (!hierarchy.length) return undefined;
  const slugs = hierarchy.map((s) => s.replace(/\.(php|html)$/, ''));
  const templates = await getBlockTemplates(kernel, { slug__in: slugs }, TEMPLATE_POST_TYPE, theme);
  const priority = new Map<string, number>();
  slugs.forEach((slug, i) => {
    if (!priority.has(slug)) priority.set(slug, i);
  });
  templates.sort(
    (a, b) =>
      (priority.get(a.slug) ?? Number.MAX_SAFE_INTEGER) -
      (priority.get(b.slug) ?? Number.MAX_SAFE_INTEGER),
  );
  return templates[0];
}

/**
 * locate_block_template() for the public renderer: the template to render
 * for a view's hierarchy, `index` last. An empty customised template shows
 * logged-in users wp_render_empty_block_template_warning() and visitors the
 * theme's file, when there is one.
 */
export async function locateBlockTemplate(
  kernel: Kernel,
  hierarchy: string[],
  options: { theme?: ActiveTheme; loggedIn?: boolean } = {},
): Promise<{ slug: string; content: string; template: BlockTemplate } | undefined> {
  const candidates = hierarchy.includes('index') ? hierarchy : [...hierarchy, 'index'];
  const template = await resolveBlockTemplate(kernel, candidates, options.theme);
  if (!template) return undefined;
  let content = template.content;
  if (!content) {
    if (options.loggedIn) {
      content = emptyTemplateWarning(kernel, template);
    } else if (template.hasThemeFile) {
      const active = options.theme ?? (await kernel.themes.active());
      content = (await templateFile(kernel, active, TEMPLATE_POST_TYPE, template.slug))?.content ?? '';
    }
  }
  return { slug: template.slug, content, template };
}

/** wp_render_empty_block_template_warning(), as a block so it renders through the template. */
function emptyTemplateWarning(kernel: Kernel, template: BlockTemplate): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const { i18n } = kernel;
  // Studio (#28) will give templates their own address; until then it opens Studio.
  return `<!-- wp:html --><div id="wp-empty-template-alert"><h2>${esc(template.title)}</h2><p>${esc(
    i18n.__(
      'This page is blank because the template is empty. You can reset or customize it in the Site Editor.',
    ),
  )}</p><a href="/admin/studio" class="wp-element-button">${esc(i18n.__('Edit template'))}</a></div><!-- /wp:html -->`;
}

/**
 * render_block_core_template_part()'s lookup: the active theme's published
 * copy of a part, else the theme's file. `theme` is the block's attribute;
 * Pressbase also accepts the parent theme's stylesheet there.
 */
export async function templatePartForRender(
  kernel: Kernel,
  slug: string,
  themeAttr: string,
  theme?: ActiveTheme,
): Promise<{ id: string; content: string; area: string; post?: Post } | undefined> {
  const active = theme ?? (await kernel.themes.active());
  const stylesheet = active.info.stylesheet;
  if (themeAttr && themeAttr !== stylesheet && themeAttr !== active.parent?.stylesheet) {
    return undefined;
  }
  const id = `${stylesheet}//${slug}`;
  const { posts } = await queryPosts(kernel, {
    post_type: TEMPLATE_PART_POST_TYPE,
    post_status: 'publish',
    post_name__in: [slug],
    tax_query: [{ taxonomy: THEME_TAXONOMY, field: 'name', terms: [stylesheet] }],
    posts_per_page: 1,
    no_found_rows: true,
  });
  const post = posts[0];
  if (post) {
    const template = await buildBlockTemplateResultFromPost(kernel, post, active);
    if (template) {
      return {
        id,
        content: template.content,
        area: template.area ?? TEMPLATE_PART_AREA_UNCATEGORIZED,
        post,
      };
    }
  }
  // validate_file(): no traversal in a theme file's slug.
  if (slug.includes('..') || slug.includes('\\')) return undefined;
  const file = await getBlockFileTemplate(kernel, id, TEMPLATE_PART_POST_TYPE, active);
  if (!file) return undefined;
  return { id, content: file.content, area: file.area ?? TEMPLATE_PART_AREA_UNCATEGORIZED };
}

/* -------------------------------------------------------------------- writes */

/** wp_filter_wp_template_unique_post_slug(): `slug`, else `slug-2`, `slug-3`… within the theme. */
export async function uniqueTemplateSlug(
  kernel: Kernel,
  slug: string,
  type: TemplateType,
  theme: string,
  exceptId?: number,
): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? slug : `${slug.slice(0, 200 - (String(n).length + 1))}-${n}`;
    const { posts } = await queryPosts(kernel, {
      post_name__in: [candidate],
      post_type: type,
      post_status: 'any',
      posts_per_page: 1,
      no_found_rows: true,
      ...(exceptId ? { post__not_in: [exceptId] } : {}),
      tax_query: [{ taxonomy: THEME_TAXONOMY, field: 'name', terms: [theme] }],
    });
    if (!posts.length) return candidate;
  }
}

/** What a save changes: the REST fields of a template, already validated. */
export interface TemplateChanges {
  content?: string;
  title?: string;
  description?: string;
  /** Template parts only. */
  area?: string;
  author?: number;
  /** Templates only: WordPress's `is_wp_suggestion` meta. */
  isWpSuggestion?: boolean;
  /** The theme of a new template (default: the active theme). */
  theme?: string;
  /** The slug of a new template. */
  slug?: string;
}

export interface SaveTemplateOptions {
  /** The user saving: the new post's author unless `author` is given. */
  userId?: number;
  /** Run content through kses (users without unfiltered_html). */
  filterHtml?: boolean;
}

/**
 * Saves a template or part: WP_REST_Templates_Controller's
 * prepare_item_for_database() with update_item() / create_item().
 *
 * - `id` null: a new template (`changes.slug` required), published, in
 *   `changes.theme` or the active theme.
 * - `id` of a theme file: its first customised copy, starting from the
 *   file's content, title, description and area, with meta `origin: theme`.
 * - `id` of a custom template: the post is updated (a revision is kept).
 *
 * Throws PostError (`rest_template_not_found` 404, `rest_invalid_author`).
 */
export async function saveBlockTemplate(
  kernel: Kernel,
  type: TemplateType,
  id: string | null,
  changes: TemplateChanges,
  options: SaveTemplateOptions = {},
): Promise<{ template: BlockTemplate; created: boolean }> {
  const template = id ? await getBlockTemplate(kernel, id, type) : null;
  if (id && !template) {
    throw new PostError('rest_template_not_found', 'No templates exist with that id.', 404);
  }
  if (changes.author && changes.author !== options.userId) {
    const [user] = await kernel.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, changes.author));
    if (!user) throw new PostError('rest_invalid_author', 'Invalid author ID.');
  }

  const fromFile = template !== null && template.source !== 'custom';
  const content = changes.content ?? (fromFile ? template.content : undefined);
  const title = changes.title ?? (fromFile ? template.title : undefined);
  const description = changes.description ?? (fromFile ? template.description : undefined);
  let area: string | undefined;
  if (type === TEMPLATE_PART_POST_TYPE) {
    if (changes.area !== undefined) area = await filterTemplatePartArea(kernel, changes.area);
    else if (fromFile && template.area) area = await filterTemplatePartArea(kernel, template.area);
    else if (!template?.area) area = TEMPLATE_PART_AREA_UNCATEGORIZED;
  }

  if (template?.source === 'custom' && template.wpId) {
    const terms = area ? { [TEMPLATE_PART_AREA_TAXONOMY]: [await termIdByName(kernel, TEMPLATE_PART_AREA_TAXONOMY, area)] } : undefined;
    await kernel.posts.update(template.wpId, {
      status: 'publish',
      ...(content !== undefined ? { content } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { excerpt: description } : {}),
      ...(changes.author !== undefined ? { authorId: changes.author } : {}),
      ...(terms ? { terms } : {}),
      filterHtml: options.filterHtml,
    });
    if (type === TEMPLATE_POST_TYPE && changes.isWpSuggestion !== undefined) {
      await kernel.meta.update('post', template.wpId, 'is_wp_suggestion', changes.isWpSuggestion);
    }
    const saved = await getBlockTemplate(kernel, template.id, type);
    return { template: saved as BlockTemplate, created: false };
  }

  // A new post: the first customised copy of a theme file, or a new template.
  const themeName = template?.theme ?? changes.theme ?? (await kernel.themes.active()).info.stylesheet;
  const slug = template?.slug ?? changes.slug;
  if (!slug) throw new PostError('rest_missing_callback_param', 'Missing parameter(s): slug');
  const terms: Record<string, number[]> = {
    [THEME_TAXONOMY]: [await termIdByName(kernel, THEME_TAXONOMY, themeName)],
  };
  if (area) {
    terms[TEMPLATE_PART_AREA_TAXONOMY] = [
      await termIdByName(kernel, TEMPLATE_PART_AREA_TAXONOMY, area),
    ];
  }
  const post = await kernel.posts.insert(type, {
    status: 'publish',
    slug,
    content: content ?? '',
    title: title ?? '',
    excerpt: description ?? '',
    authorId: changes.author || options.userId || null,
    terms,
    filterHtml: options.filterHtml,
  });
  // posts.insert() slugs with sanitizeSlug(), which lowercases and turns `_`
  // into `-`; a template keeps its file's name (sanitize_title() keeps `_`).
  const wanted = await uniqueTemplateSlug(kernel, slug, type, themeName, post.id);
  if (post.slug !== wanted) {
    await kernel.db.update(schema.posts).set({ slug: wanted }).where(eq(schema.posts.id, post.id));
  }
  if (fromFile) await kernel.meta.update('post', post.id, 'origin', template.source);
  if (type === TEMPLATE_POST_TYPE && changes.isWpSuggestion !== undefined) {
    await kernel.meta.update('post', post.id, 'is_wp_suggestion', changes.isWpSuggestion);
  }
  const saved = await getBlockTemplate(kernel, `${themeName}//${wanted}`, type);
  return { template: saved as BlockTemplate, created: true };
}

/**
 * WP_REST_Templates_Controller::delete_item(): trashes (or, with `force`,
 * deletes) a custom template. For a customised copy this is the reset: the
 * theme's file shows again. Throws PostError: `rest_template_not_found`,
 * `rest_invalid_template` (a theme file), `rest_template_already_trashed`.
 */
export async function deleteBlockTemplate(
  kernel: Kernel,
  type: TemplateType,
  id: string,
  force = false,
): Promise<{ template: BlockTemplate; deleted: boolean }> {
  const template = await getBlockTemplate(kernel, id, type);
  if (!template) {
    throw new PostError('rest_template_not_found', 'No templates exist with that id.', 404);
  }
  if (template.source !== 'custom' || !template.wpId) {
    throw new PostError('rest_invalid_template', "Templates based on theme files can't be removed.");
  }
  if (force) {
    await kernel.posts.delete(template.wpId);
    return { template, deleted: true };
  }
  if (template.status === 'trash') {
    throw new PostError('rest_template_already_trashed', 'The template has already been deleted.', 410);
  }
  await kernel.posts.trash(template.wpId);
  return { template: { ...template, status: 'trash' }, deleted: false };
}

/** Whether a user may write templates: WP_REST_Templates_Controller::permissions_check(). */
export const canEditTemplates = (user: Parameters<typeof userCan>[0]) =>
  userCan(user, 'edit_theme_options');
