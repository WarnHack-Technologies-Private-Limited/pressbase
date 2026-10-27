/**
 * The editor's two safety nets, as in WordPress's block editor:
 *
 * 1. Server autosaves (/wp/v2/{type}/{id}/autosaves) every minute while
 *    there are unsaved changes. Drafts are updated in place; anything else
 *    gets a per-user autosave revision.
 * 2. A local copy in the browser (localStorage) on every change, for when
 *    the network or the tab goes away before an autosave.
 *
 * When the editor opens, a newer autosave or local copy is offered back.
 */

export const AUTOSAVE_INTERVAL_MS = 60_000;

export interface EditableFields {
  title: string;
  content: string;
  excerpt: string;
}

/** An item from GET /wp/v2/{type}/{id}/autosaves?context=edit. */
export interface RestAutosave {
  id: number;
  author: number;
  parent: number;
  modified: string;
  modified_gmt: string;
  title: { raw: string };
  content: { raw: string };
  excerpt: { raw: string };
}

export interface LocalBackup extends EditableFields {
  /** When the copy was written (ms since the epoch). */
  savedAt: number;
}

/** REST GMT dates have no zone designator. */
export const gmtTime = (value: string) => new Date(`${value.replace(/Z$/, '')}Z`).getTime();

/** normalize_whitespace(), as WordPress compares autosaves with posts. */
const normalize = (value: string) =>
  value
    .trim()
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, '\n')
    .replace(/[ \t]+/g, ' ');

export function differs(a: EditableFields, b: EditableFields): boolean {
  return (['title', 'content', 'excerpt'] as const).some(
    (key) => normalize(a[key]) !== normalize(b[key]),
  );
}

export const fieldsOfAutosave = (autosave: RestAutosave): EditableFields => ({
  title: autosave.title.raw,
  content: autosave.content.raw,
  excerpt: autosave.excerpt.raw,
});

/**
 * The current user's autosave, when it's newer than the saved post and says
 * something different — the condition WordPress's editor uses for its
 * "There is an autosave of this post that is more recent" notice.
 */
export function newerAutosave(
  post: EditableFields & { id: number; modified_gmt: string },
  autosaves: readonly RestAutosave[],
  userId: number,
): RestAutosave | null {
  const mine = autosaves.find((a) => a.author === userId && a.id !== post.id);
  if (!mine) return null;
  if (gmtTime(mine.modified_gmt) <= gmtTime(post.modified_gmt)) return null;
  return differs(fieldsOfAutosave(mine), post) ? mine : null;
}

/* ------------------------------------------------------------- local copy */

export const backupKey = (type: string, id?: number) =>
  `pressbase:editor-backup:${type}:${id ?? 'new'}`;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readBackup(storage: StorageLike | undefined, key: string): LocalBackup | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<LocalBackup>;
    if (
      typeof value.title !== 'string' ||
      typeof value.content !== 'string' ||
      typeof value.excerpt !== 'string' ||
      typeof value.savedAt !== 'number'
    ) {
      return null;
    }
    return value as LocalBackup;
  } catch {
    return null;
  }
}

export function writeBackup(storage: StorageLike | undefined, key: string, backup: LocalBackup) {
  try {
    storage?.setItem(key, JSON.stringify(backup));
  } catch {
    // Storage full or blocked (private mode): the server autosave still runs.
  }
}

export function clearBackup(storage: StorageLike | undefined, key: string) {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing to clean up.
  }
}

/** A local copy worth offering: written after the last save, and different from it. */
export function usefulBackup(
  backup: LocalBackup | null,
  saved: EditableFields,
  savedModifiedGmt?: string,
): LocalBackup | null {
  if (!backup) return null;
  if (savedModifiedGmt && backup.savedAt <= gmtTime(savedModifiedGmt)) return null;
  if (!backup.title.trim() && !backup.content.trim() && !backup.excerpt.trim()) return null;
  return differs(backup, saved) ? backup : null;
}

/** The browser's localStorage, when there is one and it's allowed. */
export function browserStorage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
