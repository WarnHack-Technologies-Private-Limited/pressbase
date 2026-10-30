/**
 * Themes as /wp/v2/themes returns them (WP_REST_Themes_Controller), and the
 * small helpers the Appearance screen needs.
 */

export interface RestTheme {
  stylesheet: string;
  template: string;
  name: { raw: string; rendered: string };
  description: { raw: string; rendered: string };
  version: string;
  author: { raw: string; rendered: string };
  author_uri: { raw: string; rendered: string };
  theme_uri: { raw: string; rendered: string };
  screenshot: string;
  status: 'active' | 'inactive';
  tags: { raw: string[]; rendered: string };
  requires_wp: string;
  requires_php: string;
  textdomain: string;
  is_block_theme: boolean;
  /** `bundled`: ships with Pressbase (read-only); `site`: uploaded to this site. */
  pressbase_source: 'bundled' | 'site';
  /** Uploaded, not active and not the active theme's parent. */
  pressbase_deletable: boolean;
}

/** The active theme first, then the rest by name, as wp-admin/themes.php lists them. */
export function sortThemes(themes: readonly RestTheme[]): RestTheme[] {
  return [...themes].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return themeName(a).localeCompare(themeName(b));
  });
}

/** The theme's display name, falling back to its folder name. */
export function themeName(theme: RestTheme): string {
  return theme.name.raw.trim() || theme.stylesheet;
}

/**
 * Theme headers are plain text (style.css). The raw values are used and
 * rendered by React, so nothing here is ever injected as HTML.
 */
export function themeAuthor(theme: RestTheme): string {
  return theme.author.raw.trim();
}

/** Whether the Delete action shows for a theme (the user also needs delete_themes). */
export function canDeleteTheme(theme: RestTheme): boolean {
  return theme.pressbase_deletable && theme.status !== 'active';
}

/** A theme as the 409 `folder_exists` answer describes it. */
export interface ThemeSummary {
  stylesheet: string;
  name: string;
  version: string;
  author: string;
  template: string;
  source: 'bundled' | 'site';
}

/** The installed and the uploaded copy, for "Replace the installed theme?". */
export interface ThemeConflict {
  current: ThemeSummary;
  uploaded: ThemeSummary;
}

export class ThemeUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Set on `folder_exists`: the theme can be replaced with `overwrite`. */
    readonly conflict: ThemeConflict | null = null,
  ) {
    super(message);
  }
}

/** Only .zip files are offered to the server. */
export function isZipFile(file: Pick<File, 'name' | 'type'>): boolean {
  return /\.zip$/i.test(file.name) || /^application\/(x-)?zip(-compressed)?$/.test(file.type);
}

/** "2.4 MB", "512 KB". */
export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Turns install errors into a sentence that says what to do next. */
export function themeUploadMessage(status: number, code?: string, message?: string): string {
  switch (code) {
    case 'folder_exists':
      return message ?? 'This theme is already installed.';
    case 'incompatible_archive_theme_no_style':
      return 'This .zip doesn’t contain a theme: there’s no style.css in it. Check that you chose the theme’s download, not a plugin or a whole site.';
    case 'incompatible_archive_theme_no_name':
      return 'The theme’s style.css doesn’t name the theme. Its header needs a “Theme Name:” line.';
    case 'incompatible_archive_theme_no_index':
      return 'This theme has no templates/index.html, so Pressbase can’t show any page with it.';
    case 'pressbase_theme_not_block_theme':
      return (
        message ??
        'This is a classic theme. Pressbase only runs block themes, which build their pages from HTML templates.'
      );
    case 'incompatible_archive_empty':
      return 'This .zip is empty.';
    case 'incompatible_archive_path':
    case 'incompatible_archive_symlink':
      return `This .zip was refused for safety. ${message ?? ''}`.trim();
    case 'incompatible_archive_too_big':
      return message ?? 'This theme is too big once unpacked.';
    case 'incompatible_archive':
      return message ?? 'This file isn’t a .zip archive Pressbase can read.';
    case 'rest_cannot_install_theme':
      return 'Your role can’t install themes. Ask an administrator for access.';
    default:
      if (status === 413) return message ?? 'This file is too big for the server.';
      return message ?? 'The theme couldn’t be installed. Please try again.';
  }
}

function conflictOf(data: unknown): ThemeConflict | null {
  const d = data as Partial<ThemeConflict> | undefined;
  return d?.current && d.uploaded ? { current: d.current, uploaded: d.uploaded } : null;
}

export interface ThemeUploadOptions {
  /** Replace the installed theme with the same folder name. */
  overwrite?: boolean;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Uploads a theme .zip to POST /pressbase/v1/themes (multipart, field `file`).
 * XHR rather than fetch, because only XHR reports upload progress.
 */
export function uploadTheme(file: File, options: ThemeUploadOptions = {}): Promise<RestTheme> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/wp-json/pressbase/v1/themes?_locale=user');
    xhr.withCredentials = true;
    // Required on writes; see requireRequestHeader in apps/core/src/http.ts.
    xhr.setRequestHeader('x-pressbase-request', '1');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      const data = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as RestTheme);
        return;
      }
      reject(
        new ThemeUploadError(
          xhr.status,
          data?.code ?? 'pressbase_unknown_error',
          themeUploadMessage(xhr.status, data?.code, data?.message),
          data?.code === 'folder_exists' ? conflictOf(data?.data) : null,
        ),
      );
    };
    xhr.onerror = () =>
      reject(
        new ThemeUploadError(
          0,
          'pressbase_network_error',
          'The upload was interrupted. Check your connection and try again.',
        ),
      );
    xhr.onabort = () => reject(new ThemeUploadError(0, 'pressbase_upload_cancelled', 'Cancelled.'));
    options.signal?.addEventListener('abort', () => xhr.abort());

    const form = new FormData();
    form.append('file', file, file.name);
    if (options.overwrite) form.append('overwrite', 'true');
    xhr.send(form);
  });
}
