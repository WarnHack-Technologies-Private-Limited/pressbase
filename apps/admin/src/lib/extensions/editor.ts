/**
 * Live editor data for plugins' UI modules: `window.pressbase.editor`.
 *
 * The post editor (components/content/post-editor.tsx) owns the post in React
 * state; it publishes a snapshot here on every change and connects a handler
 * for edits. Plugins read the snapshot (`getPost()`, `getEditedPostAttribute()`,
 * or the `usePost()` hook in host.tsx) and change it with `editPost()`, as
 * `select('core/editor')` and `dispatch('core/editor').editPost()` do in
 * Gutenberg. Edits go into the editor's own state, so they mark the post dirty
 * and save with it. Framework-free so it can be tested. See ADR 0018.
 */

/** The post being edited, with REST field names (`featured_media`, `meta`…). */
export interface EditorPost {
  /** null until a new post is first saved. */
  id: number | null;
  /** The post type: `post`, `page`, or a plugin's. */
  type: string;
  /** `auto-draft` for a post that was never saved. */
  status: string;
  title: string;
  /** Serialised block markup; follows typing within about 300 ms. */
  content: string;
  /** The parsed blocks (`@wordpress/blocks` `parse()` of `content`), parsed on first read. */
  readonly blocks: readonly ParsedBlock[];
  slug: string;
  excerpt: string;
  /** Attachment ID, 0 for none. */
  featured_media: number;
  /** Category IDs. */
  categories: number[];
  /** IDs of existing tags; tags typed but not yet created are only in `terms`. */
  tags: number[];
  /** Terms with names, by REST base: `{ categories: [{ id, name }], tags: [...] }` (`id` 0 = new). */
  terms: Record<string, { id: number; name: string }[]>;
  /** Registered meta (`show_in_rest`), with unsaved edits. */
  meta: Record<string, unknown>;
  /** The saved permalink, as REST's `link`. */
  link: string;
  /** The permalink with the edited slug, where it can be worked out; otherwise `link`. */
  permalink: string;
  /** Unsaved changes. */
  isDirty: boolean;
  /** A save is running. */
  isSaving: boolean;
}

export interface ParsedBlock {
  name: string | null;
  attributes: Record<string, unknown>;
  innerBlocks: ParsedBlock[];
  [key: string]: unknown;
}

/** What `editPost()` may change. Meta merges key by key, as in Gutenberg. */
export interface PostEdits {
  meta?: Record<string, unknown>;
  slug?: string;
  excerpt?: string;
}

const EDITABLE = new Set(['meta', 'slug', 'excerpt']);

/** Checks a plugin's edits; throws a TypeError naming the problem. */
export function normalizeEdits(edits: unknown): PostEdits {
  if (!isPlainObject(edits)) throw new TypeError('editPost() takes an object of edits.');
  const out: PostEdits = {};
  for (const [key, value] of Object.entries(edits)) {
    if (!EDITABLE.has(key)) {
      throw new TypeError(`editPost() can change meta, slug and excerpt, not "${key}".`);
    }
    if (key === 'meta') {
      if (!isPlainObject(value)) throw new TypeError('editPost({ meta }) takes an object.');
      out.meta = { ...value };
    } else {
      if (typeof value !== 'string') throw new TypeError(`editPost({ ${key} }) takes a string.`);
      out[key as 'slug' | 'excerpt'] = value;
    }
  }
  return out;
}

/** Meta keys whose values differ from what was saved: what a save sends. */
export function metaChanges(
  saved: Record<string, unknown> | undefined,
  edited: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(edited ?? {})) {
    if (JSON.stringify(value) !== JSON.stringify(saved?.[key])) out[key] = value;
  }
  return out;
}

/** Applies edits to meta (merged key by key); returns the same object when nothing changed. */
export function mergeMeta(
  meta: Record<string, unknown>,
  edits: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!edits || Object.keys(metaChanges(meta, edits)).length === 0) return meta;
  return { ...meta, ...edits };
}

/**
 * The permalink with an edited slug. `link` is the saved permalink; when it
 * ends in the saved slug (pretty permalinks) the new slug replaces it, and a
 * `%postname%`/`%pagename%` template takes it directly. Plain links (`?p=12`)
 * stay as they are.
 */
export function permalinkFor(link: string, savedSlug: string, slug: string): string {
  if (!link) return '';
  if (/%(postname|pagename)%/.test(link)) {
    return slug ? link.replace(/%(postname|pagename)%/, slug) : link;
  }
  if (!slug || !savedSlug || slug === savedSlug) return link;
  const match = link.match(/^(.*\/)([^/?#]+)(\/?)([?#].*)?$/);
  if (!match || decodeURIComponent(match[2] ?? '') !== savedSlug) return link;
  return `${match[1]}${encodeURIComponent(slug)}${match[3]}${match[4] ?? ''}`;
}

type Listener = () => void;
type EditHandler = (edits: PostEdits) => void;

/** One editor at a time: the post editor connects, publishes, and disconnects on unmount. */
export class EditorStore {
  #post: EditorPost | null = null;
  #handler: EditHandler | null = null;
  #listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The post being edited, or null outside the editor. The same object until it changes. */
  getPost = (): EditorPost | null => this.#post;

  /** `select('core/editor').getEditedPostAttribute(name)`: one field, e.g. `'title'` or `'meta'`. */
  getEditedPostAttribute = (name: string): unknown =>
    this.#post ? (this.#post as unknown as Record<string, unknown>)[name] : undefined;

  /**
   * `dispatch('core/editor').editPost(edits)`: changes meta, slug or excerpt
   * of the post being edited. They save with the post. Returns false outside
   * the editor.
   */
  editPost = (edits: PostEdits): boolean => {
    const normalized = normalizeEdits(edits);
    if (!this.#handler) return false;
    this.#handler(normalized);
    return true;
  };

  /** Called by the post editor: who applies edits. Returns the disconnect. */
  connect(handler: EditHandler): () => void {
    this.#handler = handler;
    return () => {
      if (this.#handler !== handler) return;
      this.#handler = null;
      this.publish(null);
    };
  }

  /** Called by the post editor with a new snapshot whenever the post changes. */
  publish(post: EditorPost | null) {
    if (post === this.#post) return;
    this.#post = post;
    for (const listener of [...this.#listeners]) listener();
  }
}

/** A snapshot whose `blocks` are parsed from `content` on first read, then kept. */
export function editorSnapshot(
  fields: Omit<EditorPost, 'blocks'>,
  parser: () => ((markup: string) => unknown[]) | null,
): EditorPost {
  let blocks: readonly ParsedBlock[] | null = null;
  const snapshot = { ...fields } as EditorPost;
  Object.defineProperty(snapshot, 'blocks', {
    enumerable: true,
    get() {
      if (blocks === null) {
        const parse = parser();
        if (!parse) return NO_BLOCKS;
        try {
          blocks = parse(fields.content) as ParsedBlock[];
        } catch {
          blocks = NO_BLOCKS;
        }
      }
      return blocks;
    },
  });
  return Object.freeze(snapshot);
}

const NO_BLOCKS: readonly ParsedBlock[] = Object.freeze([]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
