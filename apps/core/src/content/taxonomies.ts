/**
 * Taxonomies — WordPress's register_taxonomy() and create_initial_taxonomies()
 * (wordpress/wp-includes/taxonomy.php), reduced to what Pressbase uses.
 */

export interface TaxonomyCapabilities {
  manage_terms: string;
  edit_terms: string;
  delete_terms: string;
  assign_terms: string;
}

export interface TaxonomyArgs {
  label: string;
  singularLabel: string;
  description?: string;
  public?: boolean;
  hierarchical?: boolean;
  showInRest?: boolean;
  restBase?: string;
  capabilities?: Partial<TaxonomyCapabilities>;
}

export interface Taxonomy {
  name: string;
  objectTypes: Set<string>;
  label: string;
  singularLabel: string;
  description: string;
  public: boolean;
  hierarchical: boolean;
  showInRest: boolean;
  restBase: string;
  cap: TaxonomyCapabilities;
  builtin: boolean;
}

const NAME = /^[a-z0-9_-]{1,32}$/;

export class TaxonomyRegistry {
  #taxonomies = new Map<string, Taxonomy>();

  register(name: string, objectTypes: string[], args: TaxonomyArgs, builtin = false): Taxonomy {
    if (!NAME.test(name)) {
      throw new Error(
        `Taxonomy names must be 1–32 lowercase letters, numbers, dashes or underscores: "${name}".`,
      );
    }
    const taxonomy: Taxonomy = {
      name,
      objectTypes: new Set(objectTypes),
      label: args.label,
      singularLabel: args.singularLabel,
      description: args.description ?? '',
      public: args.public ?? true,
      hierarchical: args.hierarchical ?? false,
      showInRest: args.showInRest ?? false,
      restBase: args.restBase ?? name,
      cap: {
        manage_terms: 'manage_categories',
        edit_terms: 'manage_categories',
        delete_terms: 'manage_categories',
        assign_terms: 'edit_posts',
        ...args.capabilities,
      },
      builtin,
    };
    this.#taxonomies.set(name, taxonomy);
    return taxonomy;
  }

  get(name: string): Taxonomy | undefined {
    return this.#taxonomies.get(name);
  }

  /** unregister_taxonomy(): built-in taxonomies can't be removed. Terms stay in the database. */
  unregister(name: string): boolean {
    const taxonomy = this.#taxonomies.get(name);
    if (!taxonomy || taxonomy.builtin) return false;
    return this.#taxonomies.delete(name);
  }

  all(): Taxonomy[] {
    return [...this.#taxonomies.values()];
  }

  forObjectType(type: string): Taxonomy[] {
    return this.all().filter((t) => t.objectTypes.has(type));
  }

  byRestBase(restBase: string): Taxonomy | undefined {
    return this.all().find((t) => t.showInRest && t.restBase === restBase);
  }
}

export function registerCoreTaxonomies(registry: TaxonomyRegistry): void {
  registry.register(
    'category',
    ['post'],
    {
      label: 'Categories',
      singularLabel: 'Category',
      hierarchical: true,
      showInRest: true,
      restBase: 'categories',
    },
    true,
  );
  registry.register(
    'post_tag',
    ['post'],
    { label: 'Tags', singularLabel: 'Tag', showInRest: true, restBase: 'tags' },
    true,
  );
  // Post formats (v0.6): terms named `post-format-{format}`, as
  // create_initial_taxonomies() registers them, so imports and exports keep a
  // post's format. Not in the REST API, as in WordPress.
  registry.register(
    'post_format',
    ['post'],
    { label: 'Formats', singularLabel: 'Format', public: false },
    true,
  );
}
