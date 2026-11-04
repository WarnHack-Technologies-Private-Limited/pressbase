/**
 * Studio's draft (#31): which changeset entries the canvas wants, what to
 * send to bring the server's changeset in line, and how each change is
 * described in the Publish list. Pure functions, tested in
 * changes-model.test.ts. See docs/architecture/studio.md#saving-the-draft-publish-preview-discard and
 * docs/architecture/changesets.md.
 */

/** An entry's value, as `POST /pressbase/v1/changesets` takes it. */
export type EntryValue = unknown;

/** An entry as the server stores it (save_changeset_post()'s settings). */
export interface StoredEntry {
  value: EntryValue;
  type: string;
  user_id: number;
  date_modified_gmt: string;
}

/** A changeset as `/pressbase/v1/changesets` answers. */
export interface Changeset {
  uuid: string;
  status: string;
  modified_gmt: string;
  entries: Record<string, StoredEntry>;
  count: number;
  preview_link: string;
}

/** A page's entry key: `page:12`, or `page:about-us` for a page the draft adds (#29). */
export const pageKey = (id: number | string) => `page:${id}`;
export const partKey = (slug: string) => `wp_template_part:${slug}`;

/** `{type}:{id}` → its parts; the id may itself contain colons. */
export function parseKey(key: string): { type: string; id: string } {
  const at = key.indexOf(':');
  return at < 0 ? { type: key, id: '' } : { type: key.slice(0, at), id: key.slice(at + 1) };
}

/* ------------------------------------------------------------- the canvas */

/**
 * One entity on the canvas (the page's content, a template part), as block
 * markup after a parse/serialize pass so that opening it is never a change.
 */
export interface RegionState {
  key: string;
  /** What visitors see now. */
  live: string;
  /** What the canvas opened with: the draft's value, or `live`. */
  initial: string;
  /** What the canvas shows now. */
  current: string;
  /**
   * Template parts: the theme's file, when the live part is a customised
   * copy of it. Back to exactly that is a reset (`{ source: "theme" }`),
   * which deletes the copy on publish.
   */
  themeFile?: string;
  /**
   * The same markup without changes nobody made (the Navigation block
   * filling in its fallback menu's `ref`), compared before calling it an edit.
   */
  normalized?: string;
}

const same = (state: RegionState, other: string) =>
  state.current === other || (state.normalized !== undefined && state.normalized === other);

/** Whether the canvas changed this region since it opened. */
export const regionChanged = (state: RegionState) => !same(state, state.initial);

/**
 * The entry the region needs: null when it's back to what visitors see (the
 * entry goes), a reset for a customised part back to the theme's file, else
 * its content. Regions untouched since opening aren't asked: the draft
 * already holds what they show.
 */
export function desiredEntry(state: RegionState): EntryValue | null {
  if (same(state, state.live)) return null;
  if (state.themeFile !== undefined && same(state, state.themeFile)) return { source: 'theme' };
  return { content: state.current };
}

/**
 * A page entry is shared: the canvas writes its `content`, the Pages panel
 * its `title`, `parent`, `menu_order`, `template`… Each merges its fields
 * into the entry's value; `undefined` takes a field out. An entry left with
 * no fields is no entry (null).
 */
export function mergeFields(
  base: EntryValue | null | undefined,
  fields: Readonly<Record<string, unknown>>,
): EntryValue | null {
  const next: Record<string, unknown> =
    base && typeof base === 'object' && !Array.isArray(base)
      ? { ...(base as Record<string, unknown>) }
      : {};
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  return Object.keys(next).length ? next : null;
}

/* ----------------------------------------------------------------- syncing */

const json = (value: unknown) => JSON.stringify(value ?? null);

/**
 * What to send so the server's entries match `desired` (null removes an
 * entry). `sent` remembers values already sent: the server may store them
 * changed (sanitised for people without `unfiltered_html`), and sending the
 * same thing again would loop.
 */
export function entriesPatch(
  desired: ReadonlyMap<string, EntryValue | null>,
  server: Readonly<Record<string, StoredEntry>>,
  sent: ReadonlyMap<string, string> = new Map(),
): Record<string, EntryValue | null> {
  const patch: Record<string, EntryValue | null> = {};
  for (const [key, value] of desired) {
    const stored = server[key];
    if (value === null) {
      if (stored) patch[key] = null;
      continue;
    }
    const wanted = json(value);
    if (stored && (json(stored.value) === wanted || sent.get(key) === wanted)) continue;
    patch[key] = value;
  }
  return patch;
}

/** The changeset's keys with a patch laid over, in a stable order (pages, parts, the rest). */
export function pendingKeys(
  server: Readonly<Record<string, StoredEntry>>,
  patch: Readonly<Record<string, EntryValue | null>> = {},
): string[] {
  const keys = new Set(Object.keys(server));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) keys.delete(key);
    else keys.add(key);
  }
  const rank = (key: string) => {
    const type = parseKey(key).type;
    return type === 'wp_template_part' ? 0 : type === 'page' ? 1 : 2;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/* ------------------------------------------------------------ descriptions */

export interface ChangeNames {
  /** A page's title, by ID or (for a page the draft adds) slug. */
  page(id: number | string): string | undefined;
  part(slug: string): string | undefined;
  menu?(id: number): string | undefined;
}

export interface ChangeDescription {
  /** "Home", "Header", "Site title"… */
  title: string;
  /** What kind of thing, or where it shows: "Page", "On every page"… */
  detail: string;
}

type Translate = (text: string, domain?: string) => string;

const OPTION_TITLES: Record<string, string> = {
  blogname: 'Site title',
  blogdescription: 'Tagline',
  site_logo: 'Logo',
  site_icon: 'Site icon',
  show_on_front: 'Home page',
  page_on_front: 'Home page',
  page_for_posts: 'Posts page',
  pressbase_navigation_fallback: 'Header menu',
};

/** How a change is listed under Publish, in words a site owner knows. */
export function describeChange(
  key: string,
  entry: { value: EntryValue } | undefined,
  names: ChangeNames,
  __: Translate,
): ChangeDescription {
  const { type, id } = parseKey(key);
  const d = 'pressbase-admin';
  const value = entry?.value as Record<string, unknown> | undefined;
  switch (type) {
    case 'page': {
      // A page the draft adds is named by its slug; it gets its ID on Publish.
      const isNew = !/^\d+$/.test(id);
      return {
        title:
          names.page(isNew ? id : Number(id)) ||
          (typeof value?.title === 'string' && value.title) ||
          __('A page', d),
        detail: isNew ? __('New page', d) : __('Page', d),
      };
    }
    case 'wp_template_part': {
      const slug = id.includes('//') ? id.split('//')[1] || id : id;
      return {
        title: names.part(slug) || slug,
        detail:
          value?.source === 'theme' ? __('Back to the theme’s design', d) : __('On every page', d),
      };
    }
    case 'wp_template':
      return { title: id.split('//').pop() || id, detail: __('Template', d) };
    case 'wp_global_styles':
      return { title: __('Site styles', d), detail: __('Colours, fonts and spacing', d) };
    case 'wp_navigation':
      return { title: names.menu?.(Number(id)) || __('Menu', d), detail: __('Menu', d) };
    case 'option':
      return {
        title: OPTION_TITLES[id] ? __(OPTION_TITLES[id], d) : id,
        detail: __('Site settings', d),
      };
    default:
      return { title: key, detail: '' };
  }
}

/* ------------------------------------------------- site record (core-data) */

/** `/wp/v2/settings` fields the site blocks edit → the options a changeset sets. */
export const SITE_FIELDS: Readonly<Record<string, string>> = {
  title: 'blogname',
  description: 'blogdescription',
  site_logo: 'site_logo',
  site_icon: 'site_icon',
};

export const FIELD_OF_OPTION = Object.fromEntries(
  Object.entries(SITE_FIELDS).map(([field, option]) => [option, field]),
);

/** The site record's edits as option entries; fields edited before but not now become null. */
export function siteEntries(
  edits: Readonly<Record<string, unknown>>,
  before: Iterable<string> = [],
): Map<string, EntryValue | null> {
  const out = new Map<string, EntryValue | null>();
  for (const key of before) out.set(key, null);
  for (const [field, value] of Object.entries(edits)) {
    const option = SITE_FIELDS[field];
    if (option) out.set(`option:${option}`, value ?? null);
  }
  return out;
}

/** A draft's option entries as edits to the site record. */
export function siteEdits(entries: Readonly<Record<string, { value: unknown }>>) {
  const edits: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const { type, id } = parseKey(key);
    const field = FIELD_OF_OPTION[id];
    if (type === 'option' && field) edits[field] = entry.value;
  }
  return edits;
}

/* ------------------------------------------------------- published since */

/**
 * A UTC time as the site's wall clock (`YYYY-MM-DDTHH:MM:SS`), the form REST
 * `modified` fields take (WordPress's `mysql_to_rfc3339()` of local time).
 * Unknown zones count as UTC.
 */
export function wallClock(iso: string, timeZone: string): string {
  const date = new Date(iso);
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return date.toISOString().slice(0, 19);
  }
  const part = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}`;
}

/** When an entity last changed on the live site: `modified_gmt` (UTC), or `modified` (site time). */
export type LiveModified = { gmt: string } | { local: string };

/**
 * The draft's entries whose entity changed on the live site after the entry
 * was written: someone published (or saved) it since. Publishing the draft
 * would replace their work, so Studio says so when it reopens the draft.
 */
export function changedSince(
  entries: Readonly<Record<string, StoredEntry>>,
  live: ReadonlyMap<string, LiveModified>,
  timeZone: string,
): string[] {
  const out: string[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    const modified = live.get(key);
    if (!modified || !entry.date_modified_gmt) continue;
    // REST dates have whole seconds; the entry's has milliseconds.
    const written = entry.date_modified_gmt.slice(0, 19);
    const later =
      'gmt' in modified
        ? modified.gmt.slice(0, 19) > written
        : modified.local.slice(0, 19) > wallClock(entry.date_modified_gmt, timeZone);
    if (later) out.push(key);
  }
  return out;
}
