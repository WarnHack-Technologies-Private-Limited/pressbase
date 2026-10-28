/**
 * Post types — WordPress's register_post_type() and create_initial_post_types()
 * (wordpress/wp-includes/post.php), reduced to the arguments Pressbase uses.
 */

export type PostSupport =
  | 'title'
  | 'editor'
  | 'author'
  | 'thumbnail'
  | 'excerpt'
  | 'comments'
  | 'revisions'
  | 'page-attributes'
  | 'custom-fields';

/** The capability names a post type maps to — WordPress's $post_type->cap. */
export interface PostTypeCapabilities {
  edit_post: string;
  read_post: string;
  delete_post: string;
  edit_posts: string;
  edit_others_posts: string;
  delete_posts: string;
  publish_posts: string;
  read_private_posts: string;
  create_posts: string;
  read: string;
  delete_private_posts: string;
  delete_published_posts: string;
  delete_others_posts: string;
  edit_private_posts: string;
  edit_published_posts: string;
}

export interface PostTypeArgs {
  label: string;
  singularLabel: string;
  description?: string;
  public?: boolean;
  hierarchical?: boolean;
  supports?: PostSupport[];
  showInRest?: boolean;
  restBase?: string;
  /** Singular and plural capability bases, e.g. ['page', 'pages']. */
  capabilityType?: string | [string, string];
  /** Overrides for individual capabilities, as WordPress's `capabilities` argument. */
  capabilities?: Partial<PostTypeCapabilities>;
  /** Map meta capabilities (edit_post on one post) to primitive ones. */
  mapMetaCap?: boolean;
  /** Taxonomies attached at registration; taxonomies can also attach themselves. */
  taxonomies?: string[];
}

export interface PostType {
  name: string;
  label: string;
  singularLabel: string;
  description: string;
  public: boolean;
  hierarchical: boolean;
  supports: Set<PostSupport>;
  showInRest: boolean;
  restBase: string;
  mapMetaCap: boolean;
  cap: PostTypeCapabilities;
  builtin: boolean;
}

/** get_post_type_capabilities() */
function capabilitiesFor(type: string | [string, string]): PostTypeCapabilities {
  const [one, many] = Array.isArray(type) ? type : [type, `${type}s`];
  return {
    edit_post: `edit_${one}`,
    read_post: `read_${one}`,
    delete_post: `delete_${one}`,
    edit_posts: `edit_${many}`,
    edit_others_posts: `edit_others_${many}`,
    delete_posts: `delete_${many}`,
    publish_posts: `publish_${many}`,
    read_private_posts: `read_private_${many}`,
    create_posts: `edit_${many}`,
    read: 'read',
    delete_private_posts: `delete_private_${many}`,
    delete_published_posts: `delete_published_${many}`,
    delete_others_posts: `delete_others_${many}`,
    edit_private_posts: `edit_private_${many}`,
    edit_published_posts: `edit_published_${many}`,
  };
}

const NAME = /^[a-z0-9_-]{1,20}$/;

export class PostTypeRegistry {
  #types = new Map<string, PostType>();

  register(name: string, args: PostTypeArgs, builtin = false): PostType {
    if (!NAME.test(name)) {
      throw new Error(
        `Post type names must be 1–20 lowercase letters, numbers, dashes or underscores: "${name}".`,
      );
    }
    const type: PostType = {
      name,
      label: args.label,
      singularLabel: args.singularLabel,
      description: args.description ?? '',
      public: args.public ?? false,
      hierarchical: args.hierarchical ?? false,
      supports: new Set(args.supports ?? ['title', 'editor']),
      showInRest: args.showInRest ?? false,
      restBase: args.restBase ?? name,
      mapMetaCap: args.mapMetaCap ?? true,
      cap: { ...capabilitiesFor(args.capabilityType ?? 'post'), ...args.capabilities },
      builtin,
    };
    this.#types.set(name, type);
    return type;
  }

  get(name: string): PostType | undefined {
    return this.#types.get(name);
  }

  all(): PostType[] {
    return [...this.#types.values()];
  }

  byRestBase(restBase: string): PostType | undefined {
    return this.all().find((t) => t.showInRest && t.restBase === restBase);
  }
}

/** create_initial_post_types(), for the types Pressbase stores today. */
export function registerCorePostTypes(registry: PostTypeRegistry): void {
  registry.register(
    'post',
    {
      label: 'Posts',
      singularLabel: 'Post',
      public: true,
      showInRest: true,
      restBase: 'posts',
      supports: [
        'title',
        'editor',
        'author',
        'thumbnail',
        'excerpt',
        'comments',
        'revisions',
        'custom-fields',
      ],
    },
    true,
  );
  registry.register(
    'page',
    {
      label: 'Pages',
      singularLabel: 'Page',
      public: true,
      hierarchical: true,
      showInRest: true,
      restBase: 'pages',
      capabilityType: 'page',
      supports: [
        'title',
        'editor',
        'author',
        'thumbnail',
        'page-attributes',
        'comments',
        'revisions',
        'custom-fields',
      ],
    },
    true,
  );
  registry.register(
    'attachment',
    {
      label: 'Media',
      singularLabel: 'Media',
      public: true,
      showInRest: true,
      restBase: 'media',
      supports: ['title', 'author', 'comments'],
    },
    true,
  );
  registry.register('revision', { label: 'Revisions', singularLabel: 'Revision' }, true);
  registry.register(
    'wp_block',
    {
      label: 'Patterns',
      singularLabel: 'Pattern',
      showInRest: true,
      restBase: 'blocks',
      capabilityType: 'block',
      // As WordPress: reading raw patterns needs edit_posts, creating them
      // publish_posts, and the other *_blocks capabilities map to their *_posts
      // equivalents (map_meta_cap()'s $block_caps).
      capabilities: {
        read: 'edit_posts',
        create_posts: 'publish_posts',
        edit_posts: 'edit_posts',
        edit_others_posts: 'edit_others_posts',
        publish_posts: 'publish_posts',
        read_private_posts: 'read_private_posts',
        delete_posts: 'delete_posts',
        delete_private_posts: 'delete_private_posts',
        delete_published_posts: 'delete_published_posts',
        delete_others_posts: 'delete_others_posts',
        edit_private_posts: 'edit_private_posts',
        edit_published_posts: 'edit_published_posts',
      },
      supports: ['title', 'editor', 'revisions'],
    },
    true,
  );
  // Navigation menus (v0.4): block markup for core/navigation, edited in
  // Appearance → Menus. WordPress's arguments: not public, served at
  // /wp/v2/navigation, every capability but `read` mapped to edit_theme_options.
  // See docs/architecture/navigation.md.
  registry.register(
    'wp_navigation',
    {
      label: 'Navigation Menus',
      singularLabel: 'Navigation Menu',
      description: 'Navigation menus that can be inserted into your site.',
      public: false,
      showInRest: true,
      restBase: 'navigation',
      capabilities: {
        edit_others_posts: 'edit_theme_options',
        delete_posts: 'edit_theme_options',
        publish_posts: 'edit_theme_options',
        create_posts: 'edit_theme_options',
        read_private_posts: 'edit_theme_options',
        delete_private_posts: 'edit_theme_options',
        delete_published_posts: 'edit_theme_options',
        delete_others_posts: 'edit_theme_options',
        edit_private_posts: 'edit_theme_options',
        edit_published_posts: 'edit_theme_options',
        edit_posts: 'edit_theme_options',
      },
      supports: ['title', 'editor', 'revisions'],
    },
    true,
  );
}
