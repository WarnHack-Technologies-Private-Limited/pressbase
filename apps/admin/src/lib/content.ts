/**
 * Client-side shapes of the WordPress-compatible REST resources the admin
 * edits, and the per-type configuration of the content screens.
 */

export interface RestPost {
  id: number;
  date: string;
  date_gmt: string;
  modified: string;
  modified_gmt: string;
  slug: string;
  status: 'publish' | 'future' | 'draft' | 'pending' | 'private' | 'trash';
  type: string;
  link: string;
  title: { raw: string; rendered: string };
  content: { raw: string; rendered: string; protected: boolean };
  excerpt: { raw: string; rendered: string };
  author: number;
  comment_status: 'open' | 'closed';
  /** Attachment ID of the featured image, 0 for none. */
  featured_media?: number;
  password: string;
  sticky?: boolean;
  categories?: number[];
  tags?: number[];
  parent?: number;
  menu_order?: number;
  /** Registered meta (`show_in_rest`), by key. */
  meta?: Record<string, unknown>;
  /** Edit context: the permalink, with %postname% for drafts where WordPress gives it. */
  permalink_template?: string;
}

export interface RestTerm {
  id: number;
  count: number;
  description: string;
  name: string;
  slug: string;
  taxonomy: string;
  link: string;
  parent?: number;
  /** Registered term meta (`show_in_rest`), by key. */
  meta?: Record<string, unknown>;
}

export interface RestRevision {
  id: number;
  author: number;
  date: string;
  title: { raw: string };
  content: { raw: string };
  excerpt: { raw: string };
}

export interface RestUser {
  id: number;
  name: string;
  slug: string;
}

export interface ContentType {
  /** Post type name. */
  type: 'post' | 'page';
  /** REST base and admin URL segment. */
  base: 'posts' | 'pages';
  plural: string;
  singular: string;
  hierarchical: boolean;
  taxonomies: boolean;
  /** Capability names, as in WordPress's $post_type->cap. */
  cap: { edit: string; editOthers: string; publish: string; delete: string };
}

export const CONTENT_TYPES: Record<'posts' | 'pages', ContentType> = {
  posts: {
    type: 'post',
    base: 'posts',
    plural: 'Posts',
    singular: 'Post',
    hierarchical: false,
    taxonomies: true,
    cap: {
      edit: 'edit_posts',
      editOthers: 'edit_others_posts',
      publish: 'publish_posts',
      delete: 'delete_posts',
    },
  },
  pages: {
    type: 'page',
    base: 'pages',
    plural: 'Pages',
    singular: 'Page',
    hierarchical: true,
    taxonomies: false,
    cap: {
      edit: 'edit_pages',
      editOthers: 'edit_others_pages',
      publish: 'publish_pages',
      delete: 'delete_pages',
    },
  },
};

export const STATUS_LABELS: Record<RestPost['status'], string> = {
  publish: 'Published',
  future: 'Scheduled',
  draft: 'Draft',
  pending: 'Pending review',
  private: 'Private',
  trash: 'Trash',
};

/** "Oct 27, 2026 at 3:04 PM" from a REST local date string. */
export function formatLocalDate(local: string): string {
  const [date = '', time = ''] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const value = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, h ?? 0, min ?? 0));
  const day = value.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const clock = value.toLocaleTimeString('en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${day} at ${clock}`;
}

/** Decodes the few entities REST titles carry, for plain-text display. */
export function plainTitle(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

/** Categories and Tags screens. Lives here (not in a client file) so server pages can read it. */
export interface TaxonomyScreen {
  base: 'categories' | 'tags';
  plural: string;
  singular: string;
  hierarchical: boolean;
  /** Query parameter that filters the posts list by this taxonomy. */
  postsFilter?: string;
}

export const TAXONOMY_SCREENS: Record<'categories' | 'tags', TaxonomyScreen> = {
  categories: {
    base: 'categories',
    plural: 'Categories',
    singular: 'Category',
    hierarchical: true,
    postsFilter: 'cat',
  },
  tags: { base: 'tags', plural: 'Tags', singular: 'Tag', hierarchical: false },
};
