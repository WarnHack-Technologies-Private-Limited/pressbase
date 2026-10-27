/**
 * Roles and capabilities, ported from WordPress's populate_roles()
 * (wordpress/wp-admin/includes/schema.php). The legacy level_0…level_10
 * capabilities are left out.
 *
 * Roles are stored in the `user_roles` option so plugins can add roles and
 * capabilities at runtime, as in WordPress. A user's roles and any directly
 * granted capabilities live in the `capabilities` usermeta entry, e.g.
 * { "editor": true, "manage_seo": true }.
 *
 * Meta capabilities (edit_post for a specific post, and so on) arrive with
 * map_meta_cap in Phase 1.
 */

export interface RoleDefinition {
  name: string;
  capabilities: Record<string, boolean>;
}

export type RoleMap = Record<string, RoleDefinition>;

function caps(list: string[]): Record<string, boolean> {
  return Object.fromEntries(list.map((cap) => [cap, true]));
}

const SUBSCRIBER = ['read'];

const CONTRIBUTOR = [...SUBSCRIBER, 'edit_posts', 'delete_posts'];

const AUTHOR = [
  ...CONTRIBUTOR,
  'upload_files',
  'edit_published_posts',
  'publish_posts',
  'delete_published_posts',
];

const EDITOR = [
  ...AUTHOR,
  'moderate_comments',
  'manage_categories',
  'manage_links',
  'unfiltered_html',
  'edit_others_posts',
  'edit_pages',
  'edit_others_pages',
  'edit_published_pages',
  'publish_pages',
  'delete_pages',
  'delete_others_pages',
  'delete_published_pages',
  'delete_others_posts',
  'delete_private_posts',
  'edit_private_posts',
  'read_private_posts',
  'delete_private_pages',
  'edit_private_pages',
  'read_private_pages',
];

const ADMINISTRATOR = [
  ...EDITOR,
  'switch_themes',
  'edit_themes',
  'activate_plugins',
  'edit_plugins',
  'edit_users',
  'edit_files',
  'manage_options',
  'import',
  'delete_users',
  'create_users',
  'unfiltered_upload',
  'edit_dashboard',
  'update_plugins',
  'delete_plugins',
  'install_plugins',
  'update_themes',
  'install_themes',
  'update_core',
  'list_users',
  'remove_users',
  'promote_users',
  'edit_theme_options',
  'delete_themes',
  'export',
];

export const DEFAULT_ROLES: RoleMap = {
  administrator: { name: 'Administrator', capabilities: caps(ADMINISTRATOR) },
  editor: { name: 'Editor', capabilities: caps(EDITOR) },
  author: { name: 'Author', capabilities: caps(AUTHOR) },
  contributor: { name: 'Contributor', capabilities: caps(CONTRIBUTOR) },
  subscriber: { name: 'Subscriber', capabilities: caps(SUBSCRIBER) },
};

/**
 * Resolves a user's effective capabilities. Role names in the grant map
 * contribute that role's capabilities; any other key is a direct grant, and
 * an explicit `false` revokes a capability a role would otherwise give.
 */
export function resolveCapabilities(
  grants: Record<string, boolean>,
  roles: RoleMap,
): { roles: string[]; capabilities: Record<string, boolean> } {
  const userRoles = Object.keys(grants).filter((key) => grants[key] && roles[key]);
  const capabilities: Record<string, boolean> = {};
  for (const role of userRoles) Object.assign(capabilities, roles[role]?.capabilities);
  for (const [key, granted] of Object.entries(grants)) {
    if (!roles[key]) capabilities[key] = granted;
  }
  return { roles: userRoles, capabilities };
}
