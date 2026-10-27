import type { LucideIcon } from 'lucide-react';
import {
  FileText,
  Image,
  LayoutDashboard,
  MessageSquare,
  Paintbrush,
  PenSquare,
  Plug,
  Settings,
  Users,
  Wrench,
} from 'lucide-react';

/**
 * The admin's information architecture: WordPress's menu order, grouped.
 * `release` marks sections that are not built yet; their pages show what is
 * coming instead of a dead end. Keep in step with docs/roadmap.md.
 */
export interface Section {
  slug: string;
  label: string;
  icon: LucideIcon;
  /** Capability needed to see the item, as in WordPress's admin menu. */
  capability: string;
  release?: string;
  summary?: string;
}

export interface SectionGroup {
  label?: string;
  items: Section[];
}

export const SECTION_GROUPS: SectionGroup[] = [
  {
    items: [{ slug: '', label: 'Dashboard', icon: LayoutDashboard, capability: 'read' }],
  },
  {
    label: 'Content',
    items: [
      {
        slug: 'posts',
        label: 'Posts',
        icon: PenSquare,
        capability: 'edit_posts',
      },
      {
        slug: 'pages',
        label: 'Pages',
        icon: FileText,
        capability: 'edit_pages',
      },
      {
        slug: 'media',
        label: 'Media',
        icon: Image,
        capability: 'upload_files',
      },
      {
        slug: 'comments',
        label: 'Comments',
        icon: MessageSquare,
        capability: 'moderate_comments',
      },
    ],
  },
  {
    label: 'Design',
    items: [
      {
        slug: 'appearance',
        label: 'Appearance',
        icon: Paintbrush,
        capability: 'switch_themes',
      },
    ],
  },
  {
    label: 'Extend',
    items: [
      {
        slug: 'plugins',
        label: 'Plugins',
        icon: Plug,
        capability: 'activate_plugins',
        release: 'v0.5',
        summary: 'Add features with plugins that install at runtime — no rebuild required.',
      },
    ],
  },
  {
    label: 'Manage',
    items: [
      {
        slug: 'users',
        label: 'Users',
        icon: Users,
        capability: 'list_users',
      },
      {
        slug: 'tools',
        label: 'Tools',
        icon: Wrench,
        capability: 'edit_posts',
        release: 'v0.6',
        summary: 'Import from WordPress, export your content and check your site’s health.',
      },
      { slug: 'settings', label: 'Settings', icon: Settings, capability: 'manage_options' },
    ],
  },
];

export function findSection(slug: string): Section | undefined {
  return SECTION_GROUPS.flatMap((g) => g.items).find((s) => s.slug === slug);
}
