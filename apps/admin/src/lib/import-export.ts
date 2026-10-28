/**
 * Tools → Import and Export: the shapes core returns
 * (apps/core/src/routes/import-export.ts) and the pure helpers the screens use.
 */

export type ImportStatus = 'uploaded' | 'queued' | 'running' | 'completed' | 'failed';

export interface ImportAuthor {
  login: string;
  email: string;
  display_name: string;
}

export interface SiteUser {
  id: number;
  login: string;
  name: string;
}

export interface ReportItem {
  kind: 'author' | 'term' | 'post' | 'attachment' | 'comment' | 'menu' | 'meta';
  title: string;
  type?: string;
  id?: number;
  code: string;
  reason: string;
}

export interface ImportReport {
  imported: {
    users: number;
    terms: number;
    posts: Record<string, number>;
    comments: number;
    menus: number;
  };
  skipped: { total: number; items: ReportItem[] };
  errors: { total: number; items: ReportItem[] };
  skippedPostTypes: Record<string, number>;
  skippedTaxonomies: Record<string, number>;
  authors: Record<string, number>;
  startedAt: string;
  finishedAt: string | null;
}

export interface ImportProgress {
  phase: 'importing' | 'finishing' | 'done';
  done: number;
  total: number;
  current: string;
}

export interface ImportSession {
  id: string;
  filename: string;
  size: number;
  created: string;
  started: string | null;
  site: { title: string; url: string; wxr_version: string };
  authors: ImportAuthor[];
  counts: {
    posts: Record<string, number>;
    terms: Record<string, number>;
    comments: number;
    items: number;
  };
  unsupported_types: string[];
  status: ImportStatus;
  progress: ImportProgress | null;
  report: ImportReport | null;
  error: string | null;
}

/** POST /pressbase/v1/import adds who posts can go to, and what this user may do. */
export interface UploadedSession extends ImportSession {
  users: SiteUser[];
  can_create_users: boolean;
  can_fetch_attachments: boolean;
}

/** The value of an author's select: `new` or a user ID. */
export type AuthorValue = 'new' | `${number}`;

/**
 * WordPress's default: an existing user with the same login, else a new
 * user (when this person may create users), else the person importing.
 */
export function defaultAuthorValue(
  author: ImportAuthor,
  users: SiteUser[],
  canCreate: boolean,
  meId: number,
): AuthorValue {
  const same = users.find((u) => u.login.toLowerCase() === author.login.toLowerCase());
  if (same) return `${same.id}`;
  return canCreate ? 'new' : `${meId}`;
}

/** The `authors` body for POST /pressbase/v1/import/{id}/start. */
export function authorChoices(values: Record<string, AuthorValue>) {
  return Object.fromEntries(
    Object.entries(values).map(([login, value]) => [
      login,
      value === 'new'
        ? { action: 'create' as const }
        : { action: 'map' as const, user_id: Number(value) },
    ]),
  );
}

const TYPE_NAMES: Record<string, [string, string]> = {
  post: ['post', 'posts'],
  page: ['page', 'pages'],
  attachment: ['media item', 'media items'],
  wp_navigation: ['menu', 'menus'],
  wp_block: ['pattern', 'patterns'],
  nav_menu_item: ['menu item', 'menu items'],
};

/** "3 posts", "1 media item", "2 product items". */
export function countLabel(count: number, type: string): string {
  const [one, many] = TYPE_NAMES[type] ?? [`${type} item`, `${type} items`];
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** What the file holds, largest first, for the summary line. */
export function contentSummary(counts: ImportSession['counts']): string[] {
  const parts = Object.entries(counts.posts)
    .filter(([type]) => type !== 'nav_menu_item')
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => countLabel(n, type));
  if (counts.comments) {
    parts.push(
      `${counts.comments.toLocaleString()} ${counts.comments === 1 ? 'comment' : 'comments'}`,
    );
  }
  const terms = (counts.terms.category ?? 0) + (counts.terms.post_tag ?? 0);
  if (terms)
    parts.push(
      `${terms.toLocaleString()} ${terms === 1 ? 'category or tag' : 'categories and tags'}`,
    );
  if (counts.terms.nav_menu) {
    parts.push(`${counts.terms.nav_menu} ${counts.terms.nav_menu === 1 ? 'menu' : 'menus'}`);
  }
  return parts;
}

/** "45%" of the items read, for the progress bar. */
export function percent(progress: ImportProgress | null): number {
  if (!progress?.total) return 0;
  if (progress.phase === 'done') return 100;
  return Math.min(99, Math.floor((progress.done / progress.total) * 100));
}

/** The report's "imported" counts as lines, for the summary list. */
export function importedLines(report: ImportReport): string[] {
  const lines = Object.entries(report.imported.posts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => countLabel(n, type));
  const { comments, terms, users, menus } = report.imported;
  if (comments)
    lines.push(`${comments.toLocaleString()} ${comments === 1 ? 'comment' : 'comments'}`);
  if (terms)
    lines.push(
      `${terms.toLocaleString()} ${terms === 1 ? 'category or tag' : 'categories and tags'}`,
    );
  if (menus) lines.push(`${menus} ${menus === 1 ? 'menu' : 'menus'}`);
  if (users) lines.push(`${users} new ${users === 1 ? 'user' : 'users'}`);
  return lines;
}

const KIND_LABELS: Record<ReportItem['kind'], string> = {
  author: 'Author',
  term: 'Term',
  post: 'Post',
  attachment: 'Media',
  comment: 'Comment',
  menu: 'Menu',
  meta: 'Custom field',
};

/** "Page" for a post item of type page, "Media", "Comment"… */
export function itemKind(item: ReportItem): string {
  if (item.kind === 'post' && item.type) {
    const name = TYPE_NAMES[item.type]?.[0];
    return name ? name[0]?.toUpperCase() + name.slice(1) : item.type;
  }
  return KIND_LABELS[item.kind];
}

/* ------------------------------------------------------------------ export */

export interface ExportChoices {
  types: { name: string; label: string; builtin: boolean }[];
  authors: Record<'post' | 'page' | 'attachment', { id: number; name: string }[]>;
  categories: { id: number; name: string; count: number }[];
  statuses: { name: string; label: string }[];
  months: Record<'post' | 'page' | 'attachment', string[]>;
}

export interface ExportFilters {
  content: string;
  category: string;
  author: string;
  start_date: string;
  end_date: string;
  status: string;
}

/** Which filters apply to a content choice, as in wp-admin/export.php. */
export function filtersFor(content: string): (keyof ExportFilters)[] {
  if (content === 'post') return ['category', 'author', 'start_date', 'end_date', 'status'];
  if (content === 'page') return ['author', 'start_date', 'end_date', 'status'];
  if (content === 'attachment') return ['start_date', 'end_date'];
  return [];
}

/** The download address for the chosen content and filters. */
export function exportUrl(filters: ExportFilters): string {
  const params = new URLSearchParams({ content: filters.content || 'all' });
  for (const key of filtersFor(filters.content)) {
    if (filters[key]) params.set(key, filters[key]);
  }
  return `/wp-json/pressbase/v1/export/download?${params}`;
}

/** "October 2026" for "2026-10". */
export function monthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number);
  if (!year || !m) return month;
  return new Date(Date.UTC(year, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "2.4 MB" */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
