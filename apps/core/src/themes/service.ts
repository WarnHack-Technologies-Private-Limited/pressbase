import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type BlockStyleMetadata,
  CORE_BLOCK_STYLE_METADATA,
  type GlobalStylesConfig,
  getGlobalStylesheet,
  type JsonObject,
  keyPresetsByOrigin,
  type ResolvedThemeJson,
  resolveThemeJson,
  type StyleVariation,
  styleVariationScope,
  type ThemeJsonData,
  type ThemeJsonPartial,
} from '@pressbase/theme-json';
import type { Kernel } from '../kernel';
import { THEME_COMPAT, type ThemeCompat } from './compat';
import { readFileHeaders, THEME_HEADERS } from './file-headers';
import { decodeGlobalStyles, userGlobalStylesPost } from './global-styles';
import { loadPhpPattern } from './php-patterns';

/**
 * Themes — WP_Theme, search_theme_directories(), switch_theme() and the
 * theme side of WP_Theme_JSON_Resolver (wordpress/wp-includes/class-wp-theme.php,
 * theme.php, class-wp-theme-json-resolver.php).
 *
 * Themes are folders with a `style.css` header. Pressbase looks in the
 * bundled `themes/` folder of the repository and in `<dataDir>/themes`
 * (a theme there wins over a bundled one with the same folder name).
 * Only block themes (with `templates/index.html`) can render.
 */

export const DEFAULT_THEME = 'twentytwentyfive';
const BUNDLED_THEMES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../themes',
);
const SCREENSHOTS = ['png', 'gif', 'jpg', 'jpeg', 'webp', 'avif'];
/** Theme assets are served from WordPress's URL path, relative to the site's origin. */
export const THEMES_URL_PATH = '/wp-content/themes';

export interface ThemeInfo {
  /** The folder name: WordPress's "stylesheet". */
  stylesheet: string;
  /** The parent theme's folder, or the theme's own for a parent theme. */
  template: string;
  dir: string;
  name: string;
  description: string;
  version: string;
  author: string;
  authorUri: string;
  themeUri: string;
  tags: string[];
  textDomain: string;
  requiresWp: string;
  testedUpTo: string;
  requiresPhp: string;
  license: string;
  /** File name of the screenshot, if there is one. */
  screenshot: string | null;
  isBlockTheme: boolean;
}

export interface TemplateFile {
  slug: string;
  content: string;
  /** The theme that provided it (a child theme's own, or its parent's). */
  theme: string;
}

export interface TemplatePartFile extends TemplateFile {
  area: string;
  title: string;
}

/** What the theme's styles are resolved from, before user global styles. */
export interface ThemeStyleSources {
  /** The theme's theme.json (the parent's, then the child's on top). */
  themeData: ThemeJsonData;
  /** Block style variation partials (styles/blocks, styles/sections…). */
  partials: ThemeJsonPartial[];
  blocks: Record<string, BlockStyleMetadata>;
  registeredStyles: Record<string, string[]>;
}

/** The active theme, loaded: templates, parts, theme.json and global styles. */
export interface ActiveTheme {
  info: ThemeInfo;
  parent: ThemeInfo | null;
  compat: ThemeCompat | null;
  themeJson: ResolvedThemeJson;
  /** wp_get_global_settings() */
  settings: JsonObject;
  templates: Map<string, TemplateFile>;
  parts: Map<string, TemplatePartFile>;
  customTemplates: { name: string; title: string; postTypes: string[] }[];
  css: {
    global: string;
    custom: string;
    fontFaces: string;
    /** Inline CSS of block styles the theme registers (register_block_style( inline_style )). */
    blockStyles: string;
  };
  /** Stylesheet URLs the theme enqueues. */
  stylesheets: string[];
  /**
   * Theme style variations (JSON files under `styles/` without `blockTypes`),
   * as WP_Theme_JSON_Resolver::get_style_variations() returns them: presets
   * keyed by the theme origin, a title from the file name when there is none.
   */
  variations: StyleVariation[];
  /** User global styles (the custom origin): the `wp_global_styles` post and its config. */
  globalStyles: { id: number | null; config: GlobalStylesConfig };
  sources: ThemeStyleSources;
  /** URL of a file in the theme (get_theme_file_uri()): child first, then parent. */
  fileUri(relative: string): string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<ThemeJsonData | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as ThemeJsonData;
  } catch {
    return undefined;
  }
}

async function readHtmlFiles(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.html') || name.startsWith('.')) continue;
    out.set(name.slice(0, -5), await readFile(path.join(dir, name), 'utf8'));
  }
  return out;
}

export class ThemesService {
  #active: ActiveTheme | undefined;
  #loading: Promise<ActiveTheme> | undefined;
  /** Pattern and category names registered by the active theme, to unregister on switch. */
  #registered = { patterns: [] as string[], categories: [] as string[] };

  constructor(private readonly kernel: Kernel) {
    kernel.hooks.addAction('init', async () => {
      await this.reload();
    });
  }

  /** Folders searched for themes, in increasing priority. */
  directories(): string[] {
    return [BUNDLED_THEMES, path.join(this.kernel.config.dataDir, 'themes')];
  }

  /** search_theme_directories() + wp_get_themes(). */
  async all(): Promise<ThemeInfo[]> {
    const found = new Map<string, ThemeInfo>();
    for (const root of this.directories()) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith('.') || !/^[A-Za-z0-9_-]+$/.test(name)) continue;
        const info = await this.#read(root, name);
        if (info) found.set(name, info);
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(stylesheet: string): Promise<ThemeInfo | undefined> {
    if (!/^[A-Za-z0-9_-]+$/.test(stylesheet)) return undefined;
    const roots = this.directories().reverse();
    for (const root of roots) {
      const info = await this.#read(root, stylesheet);
      if (info) return info;
    }
    return undefined;
  }

  async #read(root: string, name: string): Promise<ThemeInfo | undefined> {
    const dir = path.join(root, name);
    let css: string;
    try {
      css = await readFile(path.join(dir, 'style.css'), 'utf8');
    } catch {
      return undefined;
    }
    const headers = readFileHeaders(css, THEME_HEADERS);
    if (!headers.name) return undefined;
    let screenshot: string | null = null;
    for (const ext of SCREENSHOTS) {
      if (await exists(path.join(dir, `screenshot.${ext}`))) {
        screenshot = `screenshot.${ext}`;
        break;
      }
    }
    const template =
      headers.template && /^[A-Za-z0-9_-]+$/.test(headers.template) ? headers.template : name;
    return {
      stylesheet: name,
      template,
      dir,
      name: headers.name,
      description: headers.description,
      version: headers.version,
      author: headers.author,
      authorUri: headers.authorUri,
      themeUri: headers.themeUri,
      tags: headers.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      textDomain: headers.textDomain,
      requiresWp: headers.requiresWp,
      testedUpTo: headers.testedUpTo,
      requiresPhp: headers.requiresPhp,
      license: headers.license,
      screenshot,
      // wp_is_block_theme(): templates/index.html (or the legacy block-templates/).
      isBlockTheme:
        (await exists(path.join(dir, 'templates', 'index.html'))) ||
        (await exists(path.join(dir, 'block-templates', 'index.html'))),
    };
  }

  /** The `stylesheet` option, falling back to the default theme. */
  async activeStylesheet(): Promise<string> {
    const stylesheet = await this.kernel.options.get<string>('stylesheet', DEFAULT_THEME);
    return stylesheet && stylesheet !== 'default' ? stylesheet : DEFAULT_THEME;
  }

  /**
   * The active theme, loaded and cached. A missing or broken theme falls back
   * to the default one, as WordPress's validate_current_theme() does.
   */
  async active(): Promise<ActiveTheme> {
    if (this.#active) return this.#active;
    this.#loading ??= this.#load().finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  /** Drops the cache and loads the active theme again (after a switch or file changes). */
  async reload(): Promise<ActiveTheme> {
    this.#active = undefined;
    return this.active();
  }

  /** switch_theme() */
  async activate(stylesheet: string): Promise<ThemeInfo> {
    const info = await this.get(stylesheet);
    if (!info?.isBlockTheme) throw new Error(`"${stylesheet}" is not an installed block theme.`);
    const old = await this.activeStylesheet();
    await this.kernel.options.set('template', info.template);
    await this.kernel.options.set('stylesheet', info.stylesheet);
    await this.reload();
    await this.kernel.hooks.doAction('switch_theme', info.name, info, old);
    return info;
  }

  async #load(): Promise<ActiveTheme> {
    let info = await this.get(await this.activeStylesheet());
    if (!info?.isBlockTheme) info = await this.get(DEFAULT_THEME);
    if (!info) throw new Error(`The default theme "${DEFAULT_THEME}" is missing.`);
    const parent =
      info.template !== info.stylesheet ? ((await this.get(info.template)) ?? null) : null;
    const chain = parent ? [info, parent] : [info];
    const compat =
      THEME_COMPAT[info.stylesheet] ??
      (parent ? THEME_COMPAT[parent.stylesheet] : undefined) ??
      null;
    const uri = (theme: ThemeInfo, relative: string) =>
      `${THEMES_URL_PATH}/${encodeURIComponent(theme.stylesheet)}/${relative.replace(/^\/+/, '')}`;
    const fileUri = (relative: string) => {
      // get_theme_file_uri(): the child's file when it exists, else the parent's.
      return uri(chain[0] as ThemeInfo, relative);
    };

    // theme.json: the parent's, then the child's on top (get_theme_data()).
    let themeData: ThemeJsonData = { version: 3 };
    const partials: ThemeJsonPartial[] = [];
    for (const theme of [...chain].reverse()) {
      const data = await readJson(path.join(theme.dir, 'theme.json'));
      if (data) themeData = mergeThemeData(themeData, data);
      for (const folder of ['blocks', 'sections']) {
        const dir = path.join(theme.dir, 'styles', folder);
        let names: string[] = [];
        try {
          names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
        } catch {
          // No partials.
        }
        for (const name of names) {
          const partial = await readJson(path.join(dir, name));
          if (partial && Array.isArray(partial.blockTypes))
            partials.push(partial as ThemeJsonPartial);
        }
      }
    }

    // Block style variations: block.json `styles`, plus the theme's register_block_style() calls.
    const registeredStyles: Record<string, string[]> = {};
    for (const style of compat?.blockStyles ?? []) {
      registeredStyles[style.block] = [...(registeredStyles[style.block] ?? []), style.name];
    }
    // WordPress's core blocks, including those Pressbase doesn't render yet, so
    // theme.json styles for them survive; then the registered block types.
    const blocks: Record<string, BlockStyleMetadata> = { ...CORE_BLOCK_STYLE_METADATA };
    for (const type of this.kernel.blocks.registry.all()) {
      blocks[type.name] = {
        supports: type.supports as JsonObject,
        selectors: type.selectors as JsonObject,
        styles: type.styles.map((s) => s.name),
      };
    }
    const sources: ThemeStyleSources = { themeData, partials, blocks, registeredStyles };
    const globalStyles = await this.#userStyles(info.stylesheet);
    const resolvedStyles = resolveStyles(sources, globalStyles.config, fileUri);
    const { themeJson } = resolvedStyles;

    // Templates and parts: the child's first, then the parent's.
    const templates = new Map<string, TemplateFile>();
    const parts = new Map<string, TemplatePartFile>();
    const areas = new Map<string, { area: string; title: string }>();
    for (const part of themeJson.tree.getTemplateParts()) {
      if (typeof part.name !== 'string') continue;
      areas.set(part.name, {
        area: typeof part.area === 'string' ? part.area : 'uncategorized',
        title: typeof part.title === 'string' ? part.title : part.name,
      });
    }
    for (const theme of chain) {
      for (const [slug, content] of await readHtmlFiles(path.join(theme.dir, 'templates'))) {
        if (!templates.has(slug)) templates.set(slug, { slug, content, theme: theme.stylesheet });
      }
      for (const [slug, content] of await readHtmlFiles(path.join(theme.dir, 'parts'))) {
        if (parts.has(slug)) continue;
        const meta = areas.get(slug) ?? { area: 'uncategorized', title: slug };
        parts.set(slug, { slug, content, theme: theme.stylesheet, ...meta });
      }
    }

    const active: ActiveTheme = {
      info,
      parent,
      compat,
      ...resolvedStyles,
      templates,
      parts,
      customTemplates: themeJson.tree
        .getCustomTemplates()
        .filter((t) => typeof t.name === 'string')
        .map((t) => ({
          name: String(t.name),
          title: typeof t.title === 'string' ? t.title : String(t.name),
          postTypes: Array.isArray(t.postTypes) ? t.postTypes.map(String) : ['page'],
        })),
      css: {
        ...resolvedStyles.css,
        blockStyles: (compat?.blockStyles ?? []).map((s) => s.inlineStyle ?? '').join(''),
      },
      stylesheets: (compat?.stylesheets ?? []).map((file) => fileUri(file)),
      variations: await readStyleVariations(chain),
      globalStyles,
      sources,
      fileUri,
    };
    await this.#registerPatterns(active, chain);
    this.#active = active;
    return active;
  }

  /** The active theme's user global styles post, decoded (get_user_data()). */
  async #userStyles(stylesheet: string): Promise<ActiveTheme['globalStyles']> {
    const post = await userGlobalStylesPost(this.kernel, stylesheet);
    return post
      ? { id: post.id, config: decodeGlobalStyles(post.content) }
      : { id: null, config: { version: 3, isGlobalStylesUserThemeJSON: true } };
  }

  /**
   * Re-reads the user global styles and rebuilds the active theme's styles,
   * without reloading its files. Renders already running keep the old styles.
   */
  async refreshStyles(): Promise<void> {
    const current = this.#active;
    if (!current) return;
    const globalStyles = await this.#userStyles(current.info.stylesheet);
    if (this.#active !== current) return;
    const resolved = resolveStyles(current.sources, globalStyles.config, current.fileUri);
    this.#active = {
      ...current,
      ...resolved,
      css: { ...resolved.css, blockStyles: current.css.blockStyles },
      globalStyles,
    };
  }

  /**
   * The active theme with other user global styles, for previews: nothing is
   * stored, and the cached theme is left alone.
   */
  async withUserStyles(config: GlobalStylesConfig): Promise<ActiveTheme> {
    const active = await this.active();
    const resolved = resolveStyles(active.sources, config, active.fileUri);
    return {
      ...active,
      ...resolved,
      css: { ...resolved.css, blockStyles: active.css.blockStyles },
      globalStyles: { id: active.globalStyles.id, config },
    };
  }

  /**
   * get_merged_data( 'theme' ): WordPress's defaults and the theme, without
   * user styles — settings with presets keyed by origin, and the theme's
   * styles as written (`var:preset|…`), for /wp/v2/global-styles/themes/{stylesheet}.
   */
  async themeGlobalStyles(): Promise<{ settings: JsonObject; styles: JsonObject }> {
    const active = await this.active();
    const tree = resolveThemeJson({
      theme: active.sources.themeData,
      blockStyleVariations: active.sources.partials,
      blocks: active.sources.blocks,
      registeredStyles: active.sources.registeredStyles,
    }).tree;
    const theme = keyPresetsByOrigin(active.sources.themeData, 'theme');
    return {
      settings: tree.getSettings(),
      styles: (theme.styles as JsonObject | undefined) ?? {},
    };
  }

  /** _register_theme_block_patterns() and the theme's pattern categories. */
  async #registerPatterns(active: ActiveTheme, chain: ThemeInfo[]): Promise<void> {
    const blocks = this.kernel.blocks;
    for (const name of this.#registered.patterns) blocks.unregisterBlockPattern(name);
    for (const name of this.#registered.categories) blocks.unregisterBlockPatternCategory(name);
    this.#registered = { patterns: [], categories: [] };

    for (const category of active.compat?.patternCategories ?? []) {
      blocks.registerBlockPatternCategory(category.name, category);
      this.#registered.categories.push(category.name);
    }
    const context = {
      templateUri: `${THEMES_URL_PATH}/${(chain[chain.length - 1] as ThemeInfo).stylesheet}`,
      stylesheetUri: `${THEMES_URL_PATH}/${active.info.stylesheet}`,
    };
    const seen = new Set<string>();
    for (const theme of chain) {
      const dir = path.join(theme.dir, 'patterns');
      let names: string[] = [];
      try {
        names = (await readdir(dir)).filter((n) => n.endsWith('.php')).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const result = loadPhpPattern(await readFile(path.join(dir, name), 'utf8'), context);
        if (!result.ok) {
          console.warn(
            `Skipped the pattern ${theme.stylesheet}/patterns/${name}: ${result.reason}.`,
          );
          continue;
        }
        const { slug, ...pattern } = result.pattern;
        if (seen.has(slug)) continue;
        seen.add(slug);
        blocks.registerBlockPattern(slug, { ...pattern, source: 'theme' });
        this.#registered.patterns.push(slug);
      }
    }
  }
}

/** Resolves theme.json with the given user styles and builds the global stylesheet. */
function resolveStyles(
  sources: ThemeStyleSources,
  user: GlobalStylesConfig,
  fileUri: (relative: string) => string,
): Pick<ActiveTheme, 'themeJson' | 'settings'> & {
  css: Omit<ActiveTheme['css'], 'blockStyles'>;
} {
  const themeJson = resolveThemeJson({
    theme: sources.themeData,
    blockStyleVariations: sources.partials,
    user,
    blocks: sources.blocks,
    registeredStyles: sources.registeredStyles,
  });
  const styles = getGlobalStylesheet(themeJson, { resolveFileUri: fileUri });
  return {
    themeJson,
    settings: themeJson.tree.getGlobalSettings(),
    css: { global: styles.stylesheet, custom: styles.customCss, fontFaces: styles.fontFaces },
  };
}

/** JSON files under a folder, recursively (recursively_iterate_json()). */
async function jsonFilesIn(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await jsonFilesIn(full)));
    else if (entry.isFile() && /\.json$/i.test(entry.name)) files.push(full);
  }
  return files;
}

/**
 * WP_Theme_JSON_Resolver::get_style_variations( 'theme' ): every JSON file
 * under the theme's `styles/` folder that isn't a block style variation; a
 * child theme's file hides a parent file with the same name. Sorted by path.
 */
async function readStyleVariations(chain: ThemeInfo[]): Promise<StyleVariation[]> {
  const [child, parent] = chain;
  const files = child ? await jsonFilesIn(path.join(child.dir, 'styles')) : [];
  if (parent) {
    const childNames = new Set(files.map((f) => path.basename(f)));
    for (const file of await jsonFilesIn(path.join(parent.dir, 'styles'))) {
      if (!childNames.has(path.basename(file))) files.push(file);
    }
  }
  const variations: StyleVariation[] = [];
  for (const file of files.sort()) {
    const data = await readJson(file);
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    if (styleVariationScope(data) !== 'theme') continue;
    const { $schema: _schema, ...rest } = keyPresetsByOrigin(data, 'theme') as StyleVariation;
    const variation = rest as StyleVariation;
    if (!variation.title) variation.title = path.basename(file, '.json');
    variations.push(variation);
  }
  return variations;
}

/** Child theme.json on top of the parent's (WP_Theme_JSON::merge() handles the rest). */
function mergeThemeData(base: ThemeJsonData, incoming: ThemeJsonData): ThemeJsonData {
  const merge = (a: unknown, b: unknown): unknown => {
    if (
      a &&
      b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
      for (const [key, value] of Object.entries(b as Record<string, unknown>)) {
        out[key] = merge(out[key], value);
      }
      return out;
    }
    return b;
  };
  return merge(base, incoming) as ThemeJsonData;
}
