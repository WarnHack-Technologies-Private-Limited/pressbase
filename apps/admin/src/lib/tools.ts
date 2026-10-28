/**
 * Pressbase's own tools, listed on Tools (wp-admin/tools.php) above the
 * plugins' tools pages. Each tool is one entry, so tools added in parallel
 * don't touch the same lines.
 */
export interface CoreTool {
  /** Its screen, under /admin/tools/. */
  slug: string;
  title: string;
  /** One sentence: what the tool does. */
  description: string;
  /** Shown only to users with this capability. */
  capability: string;
}

export const CORE_TOOLS: CoreTool[] = [
  {
    slug: 'import',
    title: 'Import',
    description: 'Bring in posts, pages, comments and media from a WordPress export file.',
    capability: 'import',
  },
  {
    slug: 'export',
    title: 'Export',
    description: 'Download your content as a WordPress export file.',
    capability: 'export',
  },
  {
    slug: 'site-health',
    title: 'Site health',
    description: 'Check your site’s security and performance, and copy its details for support.',
    capability: 'view_site_health_checks',
  },
];

/** The core tools a user with these capabilities may open. */
export function toolsFor(capabilities: Record<string, boolean>): CoreTool[] {
  return CORE_TOOLS.filter((tool) => capabilities[tool.capability]);
}
