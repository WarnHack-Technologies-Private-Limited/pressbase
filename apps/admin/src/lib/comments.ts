/**
 * Client-side shapes and helpers for the Comments screen (/wp/v2/comments,
 * /pressbase/v1/comment-counts). Pure functions live here so they can be tested.
 */

export type CommentStatus = 'approved' | 'hold' | 'spam' | 'trash';

export interface RestComment {
  id: number;
  post: number;
  parent: number;
  author: number;
  author_name: string;
  author_email?: string;
  author_url: string;
  author_ip?: string;
  author_user_agent?: string;
  date: string;
  date_gmt: string;
  content: { rendered: string; raw?: string };
  link: string;
  status: CommentStatus;
  type: string;
  _links?: { up?: { href: string; post_type?: string }[] };
}

/** wp_count_comments(), plus the current user's own comments. */
export interface CommentCounts {
  approved: number;
  moderated: number;
  spam: number;
  trash: number;
  all: number;
  mine: number;
}

export type CommentTab = 'all' | 'mine' | 'moderated' | 'approved' | 'spam' | 'trash';

export const COMMENT_TABS: { id: CommentTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'moderated', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'spam', label: 'Spam' },
  { id: 'trash', label: 'Trash' },
];

/** The REST `status` (and `author`) parameters for a tab, as edit-comments.php filters. */
export function tabQuery(tab: CommentTab, userId: number): Record<string, string> {
  switch (tab) {
    case 'mine':
      return { status: 'all', author: String(userId) };
    case 'moderated':
      return { status: 'hold' };
    case 'approved':
      return { status: 'approve' };
    case 'spam':
      return { status: 'spam' };
    case 'trash':
      return { status: 'trash' };
    default:
      return { status: 'all' };
  }
}

export function tabCount(tab: CommentTab, counts: CommentCounts | null): number | undefined {
  if (!counts) return undefined;
  if (tab === 'moderated') return counts.moderated;
  return counts[tab];
}

/** Up to two initials for the avatar placeholder: "Ada Lovelace" → "AL". */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** A stable hue per name, so each commenter's initials keep their colour. */
export function avatarHue(seed: string): number {
  let hash = 0;
  for (const char of seed.toLowerCase()) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % 360;
}

/** Plain text of rendered comment HTML, for excerpts and accessible names. */
export function commentPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#8217;/g, '’')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&hellip;/g, '…')
    .trim();
}

/** What a status change says in a toast: "Comment approved." / "2 comments marked as spam." */
export function statusMessage(action: CommentAction, n: number): string {
  const subject = n === 1 ? 'Comment' : `${n.toLocaleString('en')} comments`;
  const verbs: Record<CommentAction, string> = {
    approve: 'approved',
    unapprove: 'unapproved',
    spam: 'marked as spam',
    unspam: 'restored from spam',
    trash: 'moved to the Trash',
    untrash: 'restored',
    delete: 'permanently deleted',
  };
  return `${subject} ${verbs[action]}.`;
}

export type CommentAction =
  | 'approve'
  | 'unapprove'
  | 'spam'
  | 'unspam'
  | 'trash'
  | 'untrash'
  | 'delete';

/** The REST `status` each action sends (handle_status_param()), and its undo. */
export const ACTION_STATUS: Record<Exclude<CommentAction, 'delete'>, string> = {
  approve: 'approved',
  unapprove: 'hold',
  spam: 'spam',
  unspam: 'unspam',
  trash: 'trash',
  untrash: 'untrash',
};

export const UNDO: Partial<Record<CommentAction, CommentAction>> = {
  approve: 'unapprove',
  unapprove: 'approve',
  spam: 'unspam',
  unspam: 'spam',
  trash: 'untrash',
  untrash: 'trash',
};

/** The bulk actions WordPress offers on each tab. */
export function bulkActions(tab: CommentTab): CommentAction[] {
  if (tab === 'spam') return ['unspam', 'delete'];
  if (tab === 'trash') return ['untrash', 'delete'];
  if (tab === 'approved') return ['unapprove', 'spam', 'trash'];
  if (tab === 'moderated') return ['approve', 'spam', 'trash'];
  return ['approve', 'unapprove', 'spam', 'trash'];
}

export const ACTION_LABELS: Record<CommentAction, string> = {
  approve: 'Approve',
  unapprove: 'Unapprove',
  spam: 'Mark as spam',
  unspam: 'Not spam',
  trash: 'Move to Trash',
  untrash: 'Restore',
  delete: 'Delete permanently',
};

/** The settings on Settings → Discussion (options-discussion.php). */
export const DISCUSSION_KEYS: string[] = [
  'default_comment_status',
  'require_name_email',
  'comment_registration',
  'close_comments_for_old_posts',
  'close_comments_days_old',
  'thread_comments',
  'thread_comments_depth',
  'page_comments',
  'comments_per_page',
  'default_comments_page',
  'comment_order',
  'comment_moderation',
  'comment_previously_approved',
  'comment_max_links',
  'moderation_keys',
  'disallowed_keys',
  'show_avatars',
  'avatar_rating',
  'avatar_default',
];
