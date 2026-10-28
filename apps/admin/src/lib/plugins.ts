/**
 * Plugins as /wp/v2/plugins returns them (WP_REST_Plugins_Controller plus
 * Pressbase's fields), and the helpers the Plugins screen needs. See
 * docs/architecture/plugins.md.
 */

export type PluginPermission = 'network' | 'filesystem' | 'database' | 'options';

export interface PluginErrorRecord {
  message: string;
  during: string;
  time: string;
}

export interface RestPlugin {
  plugin: string;
  status: 'active' | 'inactive';
  name: string;
  plugin_uri: string;
  author: string;
  author_uri: string;
  description: { raw: string; rendered: string };
  version: string;
  requires_pressbase: string;
  permissions: PluginPermission[];
  granted_permissions: PluginPermission[];
  /** Declared admin pages and settings; rendered by a later release. */
  admin: unknown;
  source: 'site' | 'bundled';
  compatible: boolean;
  error: PluginErrorRecord | null;
  runtime_errors: PluginErrorRecord[];
}

/** What each permission lets a plugin do, in the words shown before activation. */
export const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  database: 'Run its own database migrations and query the database directly.',
  options: 'Read and change any site setting, not only its own.',
  network: 'Connect to other servers on the internet.',
  filesystem: 'Read and write files on the server.',
};

export function describePermission(permission: string): string {
  return PERMISSION_DESCRIPTIONS[permission as PluginPermission] ?? permission;
}

/** Active plugins first, then by name, as wp-admin/plugins.php groups them. */
export function sortPlugins(plugins: readonly RestPlugin[]): RestPlugin[] {
  return [...plugins].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** A plugin folder whose plugin.json couldn't be read: it can only be deleted. */
export function isBroken(plugin: RestPlugin): boolean {
  return plugin.error?.during === 'manifest';
}

export function canDelete(plugin: RestPlugin): boolean {
  return plugin.status === 'inactive' && plugin.source === 'site';
}

/** Counts for the filter links: All (3) | Active (1) | Inactive (2). */
export function countPlugins(plugins: readonly RestPlugin[]) {
  const active = plugins.filter((p) => p.status === 'active').length;
  return { all: plugins.length, active, inactive: plugins.length - active };
}

/** The notice to show for a plugin, if anything went wrong with it. */
export function pluginProblem(plugin: RestPlugin): string | null {
  if (isBroken(plugin)) return `This plugin can’t be loaded: ${plugin.error?.message}`;
  if (plugin.error) {
    const when =
      plugin.error.during === 'load'
        ? 'was switched off because it failed to load'
        : 'couldn’t be activated';
    return `This plugin ${when}: ${plugin.error.message}`;
  }
  if (!plugin.compatible) {
    return `This plugin needs Pressbase ${plugin.requires_pressbase || 'a different version'}.`;
  }
  if (plugin.status === 'active' && plugin.runtime_errors.length) {
    return `This plugin reported an error: ${plugin.runtime_errors[0]?.message}`;
  }
  return null;
}

export class PluginUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Turns install errors into a sentence that says what to do next. */
export function uploadMessage(status: number, code?: string, message?: string): string {
  switch (code) {
    case 'folder_exists':
      return message ?? 'This plugin is already installed. Delete it first to install this copy.';
    case 'incompatible_archive_no_plugins':
      return 'This .zip doesn’t contain a plugin: there’s no plugin.json in it.';
    case 'incompatible_archive_path':
    case 'incompatible_archive_symlink':
      return `This .zip was refused for safety. ${message ?? ''}`.trim();
    case 'rest_cannot_install_plugin':
      return 'Your role can’t install plugins. Ask an administrator for access.';
    default:
      if (status === 413) return message ?? 'This file is too big for the server.';
      return message ?? 'The plugin couldn’t be installed. Please try again.';
  }
}

/** Uploads a plugin .zip to /wp/v2/plugins (multipart, field `file`). */
export async function uploadPlugin(file: File): Promise<RestPlugin> {
  const form = new FormData();
  form.append('file', file, file.name);
  let res: Response;
  try {
    res = await fetch('/wp-json/wp/v2/plugins', {
      method: 'POST',
      credentials: 'same-origin',
      // Required on writes; see requireRequestHeader in apps/core/src/http.ts.
      headers: { 'x-pressbase-request': '1' },
      body: form,
    });
  } catch {
    throw new PluginUploadError(
      0,
      'pressbase_network_error',
      'The upload was interrupted. Check your connection and try again.',
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new PluginUploadError(
      res.status,
      data?.code ?? 'pressbase_unknown_error',
      uploadMessage(res.status, data?.code, data?.message),
    );
  }
  return data as RestPlugin;
}
