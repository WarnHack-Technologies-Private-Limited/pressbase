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
import { msgid } from './i18n/locale';

/**
 * The admin's information architecture: WordPress's menu order, grouped.
 * `release` marks sections that are not built yet; their pages show what is
 * coming instead of a dead end. Keep in step with docs/roadmap.md.
 *
 * Labels are English, marked with msgid() for translators; the shell shows
 * them with `__(label, 'pressbase-admin')`.
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
    items: [{ slug: '', label: msgid('Dashboard'), icon: LayoutDashboard, capability: 'read' }],
  },
  {
    label: msgid('Content'),
    items: [
      {
        slug: 'posts',
        label: msgid('Posts'),
        icon: PenSquare,
        capability: 'edit_posts',
      },
      {
        slug: 'pages',
        label: msgid('Pages'),
        icon: FileText,
        capability: 'edit_pages',
      },
      {
        slug: 'media',
        label: msgid('Media'),
        icon: Image,
        capability: 'upload_files',
      },
      {
        slug: 'comments',
        label: msgid('Comments'),
        icon: MessageSquare,
        capability: 'moderate_comments',
      },
    ],
  },
  {
    label: msgid('Design'),
    items: [
      {
        slug: 'appearance',
        label: msgid('Appearance'),
        icon: Paintbrush,
        capability: 'switch_themes',
      },
    ],
  },
  {
    label: msgid('Extend'),
    items: [
      {
        slug: 'plugins',
        label: msgid('Plugins'),
        icon: Plug,
        capability: 'activate_plugins',
        summary: msgid('Add features with plugins that install at runtime — no rebuild required.'),
      },
    ],
  },
  {
    label: msgid('Manage'),
    items: [
      {
        slug: 'users',
        label: msgid('Users'),
        icon: Users,
        capability: 'list_users',
      },
      {
        slug: 'tools',
        label: msgid('Tools'),
        icon: Wrench,
        capability: 'edit_posts',
      },
      { slug: 'settings', label: msgid('Settings'), icon: Settings, capability: 'manage_options' },
    ],
  },
];

export function findSection(slug: string): Section | undefined {
  return SECTION_GROUPS.flatMap((g) => g.items).find((s) => s.slug === slug);
}
