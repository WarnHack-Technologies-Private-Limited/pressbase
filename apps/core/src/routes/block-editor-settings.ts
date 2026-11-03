import { Hono } from 'hono';
import { z } from 'zod';
import { userCan } from '../auth/users';
import { assetUrl, safeInline } from '../frontend/dependencies';
import { type AppEnv, invalidParams, restError } from '../http';
import type { Kernel } from '../kernel';
import type { ActiveTheme } from '../themes/service';
import { authStatus } from './rest-util';

// biome-ignore lint/suspicious/noExplicitAny: theme.json settings are open-ended JSON.
type Json = any;

/** One entry of the editor's `styles` setting, as get_block_editor_settings() builds it. */
export interface EditorStyle {
  css: string;
  __unstableType: 'presets' | 'theme' | 'user';
  isGlobalStyles: boolean;
}

const ORIGINS = ['default', 'theme', 'custom'] as const;

/**
 * The global styles part of get_block_editor_settings()
 * (wordpress/wp-includes/block-editor.php): preset variables, preset
 * classes, the theme's styles, then the user's custom CSS, each a separate
 * stylesheet so a broken one can't take the others down. Empty ones are left
 * out, as WordPress does.
 */
export function editorStyles(theme: Pick<ActiveTheme, 'themeJson' | 'css'>): EditorStyle[] {
  const tree = theme.themeJson.tree;
  const styles: EditorStyle[] = [];
  const add = (css: string, type: EditorStyle['__unstableType']) => {
    if (css !== '') styles.push({ css, __unstableType: type, isGlobalStyles: true });
  };
  add(tree.getStylesheet(['variables'], ORIGINS), 'presets');
  add(tree.getStylesheet(['presets'], ORIGINS), 'presets');
  add(tree.getStylesheet(['styles'], ORIGINS), 'theme');
  add(theme.css.custom, 'user');
  return styles;
}

/**
 * The theme's part of _wp_get_iframed_editor_assets(): its web fonts
 * (wp_print_font_faces()), the inline styles of the block styles it
 * registers, and the stylesheets it enqueues, as HTML for the canvas
 * iframe's <head>. WordPress's own block library styles are the editor's to
 * load, so they aren't repeated here.
 */
export function iframedThemeAssets(theme: Pick<ActiveTheme, 'css' | 'stylesheets' | 'info'>): {
  styles: string;
  scripts: string;
} {
  const html: string[] = [];
  if (theme.css.fontFaces) {
    html.push(`<style class='wp-fonts-local'>\n${safeInline(theme.css.fontFaces, 'style')}\n</style>`);
  }
  if (theme.css.blockStyles) {
    html.push(
      `<style id='theme-block-styles-inline-css'>\n${safeInline(theme.css.blockStyles, 'style')}\n</style>`,
    );
  }
  theme.stylesheets.forEach((href, i) => {
    const url = assetUrl(href, theme.info.version);
    if (!url) return;
    const handle = `${theme.info.stylesheet}-style${i ? `-${i}` : ''}`;
    html.push(
      `<link rel='stylesheet' id='${escAttr(handle)}-css' href='${escAttr(url)}' media='all' />`,
    );
  });
  return { styles: html.join('\n'), scripts: '' };
}

const escAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/'/g, '&#039;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** A preset list by origin, as WordPress picks it for `colors`, `fontSizes`…: custom, then theme, then default. */
function byOrigin(presets: Json): Json {
  if (!presets || typeof presets !== 'object' || Array.isArray(presets)) return presets;
  return presets.custom ?? presets.theme ?? presets.default;
}

/**
 * `__experimentalFeatures` (wp_get_global_settings(), presets keyed by
 * origin) and the top-level
 * settings get_block_editor_settings() derives from it, moving the
 * `custom*` switches out of the features as WordPress does.
 */
export function editorFeatureSettings(globalSettings: Json): Record<string, Json> {
  const features: Json = structuredClone(globalSettings ?? {});
  const out: Record<string, Json> = {};
  const color = features.color ?? {};
  const typography = features.typography ?? {};
  const spacing = features.spacing ?? {};
  if (color.palette !== undefined) out.colors = byOrigin(color.palette);
  if (color.gradients !== undefined) out.gradients = byOrigin(color.gradients);
  if (typography.fontSizes !== undefined) out.fontSizes = byOrigin(typography.fontSizes);
  if (color.custom !== undefined) {
    out.disableCustomColors = !color.custom;
    delete color.custom;
  }
  if (color.customGradient !== undefined) {
    out.disableCustomGradients = !color.customGradient;
    delete color.customGradient;
  }
  if (typography.customFontSize !== undefined) {
    out.disableCustomFontSizes = !typography.customFontSize;
    delete typography.customFontSize;
  }
  if (typography.lineHeight !== undefined) {
    out.enableCustomLineHeight = typography.lineHeight;
    delete typography.lineHeight;
  }
  if (spacing.units !== undefined) {
    out.enableCustomUnits = spacing.units;
    delete spacing.units;
  }
  if (spacing.padding !== undefined) {
    out.enableCustomSpacing = spacing.padding;
    delete spacing.padding;
  }
  if (spacing.customSpacingSize !== undefined) {
    out.disableCustomSpacingSizes = !spacing.customSpacingSize;
    delete spacing.customSpacingSize;
  }
  if (spacing.spacingSizes !== undefined) out.spacingSizes = byOrigin(spacing.spacingSizes);
  return { __experimentalFeatures: features, ...out };
}

const query = z.object({
  context: z.enum(['post-editor', 'site-editor', 'widgets-editor', 'mobile']).default('mobile'),
});

/**
 * `GET /wp-block-editor/v1/settings`: the theme-dependent block editor
 * settings, a port of Gutenberg's WP_REST_Block_Editor_Settings_Controller
 * (WordPress prints the same settings into the editor page with PHP;
 * Pressbase's admin is a separate app, so it asks for them). Only the fields
 * that come from the active theme: `styles`, `__experimentalFeatures` and
 * what derives from it, `__unstableResolvedAssets` (the theme's part) and
 * `__unstableIsBlockBasedTheme`. The admin adds the rest itself (see
 * apps/admin/src/components/block-editor/).
 *
 * Readable by anyone who can edit posts of some type, as in Gutenberg.
 */
export function blockEditorSettingsRoutes(kernel: Kernel) {
  const app = new Hono<AppEnv>({ strict: false });

  app.get('/wp-block-editor/v1/settings', async (c) => {
    const user = c.get('user');
    const canRead =
      userCan(user, 'edit_posts') ||
      kernel.postTypes.all().some((type) => type.showInRest && userCan(user, type.cap.edit_posts));
    if (!canRead) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_read_block_editor_settings',
        'Sorry, you are not allowed to read the block editor settings.',
      );
    }
    const parsed = query.safeParse(c.req.query());
    if (!parsed.success) return invalidParams(c, parsed.error);
    const theme = await kernel.themes.active();
    return c.json({
      styles: editorStyles(theme),
      // WP_Theme_JSON::get_settings(): presets keyed by origin, as the editor expects them.
      ...editorFeatureSettings(theme.themeJson.tree.getSettings()),
      __unstableResolvedAssets: iframedThemeAssets(theme),
      __unstableIsBlockBasedTheme: true,
    });
  });

  return app;
}
