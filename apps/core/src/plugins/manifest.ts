import { z } from 'zod';
import { isValidRange, isValidVersion } from './semver';

/**
 * plugin.json, the manifest every plugin ships at the root of its folder.
 * It replaces the PHP file header get_plugin_data() reads in WordPress
 * (wordpress/wp-admin/includes/plugin.php): Plugin Name → title, Version,
 * Description, Author, Plugin URI → homepage, Requires at least → requires.
 *
 * See docs/architecture/plugins.md for the reference.
 */

export const MANIFEST_FILE = 'plugin.json';

/**
 * Scopes a plugin declares. They are shown to the administrator on
 * activation and recorded. What is enforced is listed in
 * docs/architecture/plugins.md#security-model: in-process JavaScript can't be
 * sandboxed, so these are a contract and a review aid more than a wall.
 */
export const PLUGIN_PERMISSIONS = ['network', 'filesystem', 'database', 'options'] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** Folder names and REST namespaces: lowercase words joined by dashes. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Names a plugin can't take: their REST namespaces belong to WordPress and
 * Pressbase (a plugin's namespace starts with its name).
 */
export const RESERVED_NAMES = new Set([
  'wp',
  'pressbase',
  'oembed',
  'wp-site-health',
  'wp-block-editor',
]);

/** A path inside the plugin folder: relative, forward slashes, no `..`. */
const relativePath = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (p) =>
      !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s) => s === '..' || s === ''),
    'Use a path inside the plugin folder, like "dist/index.js".',
  );

const url = z
  .string()
  .max(500)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Use an http:// or https:// URL.');

/**
 * Admin pages and settings a plugin declares. Validated and exposed through
 * /wp/v2/plugins now; the SlotFill admin runtime and the Settings API screens
 * that render them come in a later milestone.
 */
const adminSchema = z.object({
  pages: z
    .array(
      z.object({
        slug: z.string().regex(SLUG, 'Use lowercase letters, numbers and dashes.'),
        title: z.string().min(1).max(100),
        /** Admin section to appear under (settings, tools, appearance…), or a top-level page. */
        parent: z.string().regex(SLUG).optional(),
        capability: z
          .string()
          .regex(/^[a-z0-9_]+$/)
          .default('manage_options'),
        /** Browser module the admin will load for the page (ESM, compiled). */
        entry: relativePath.optional(),
      }),
    )
    .max(20)
    .default([]),
  settings: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores.'),
        type: z.enum(['string', 'boolean', 'integer', 'number', 'array', 'object']),
        label: z.string().max(100).optional(),
        description: z.string().max(500).optional(),
        default: z.unknown().optional(),
      }),
    )
    .max(100)
    .default([]),
});

export const manifestSchema = z
  .object({
    $schema: z.string().optional(),
    name: z
      .string()
      .max(64)
      .regex(SLUG, 'The name is the plugin’s slug: lowercase letters, numbers and dashes.')
      .refine((name) => !RESERVED_NAMES.has(name), 'This name is reserved for Pressbase.'),
    title: z.string().trim().min(1).max(100),
    version: z.string().refine(isValidVersion, 'Use a semantic version, like "1.0.0".'),
    description: z.string().max(1000).default(''),
    author: z
      .union([z.string().max(100), z.object({ name: z.string().max(100), url: url.optional() })])
      .default(''),
    homepage: url.optional(),
    /** Pressbase versions the plugin works with, as a semver range (">=0.5.0 <1"). */
    requires: z
      .string()
      .refine(isValidRange, 'Use a semver range, like ">=0.5.0" or "^0.5".')
      .default('*'),
    /** The ESM module Pressbase imports. Plugins ship compiled JavaScript. */
    main: relativePath
      .refine((p) => /\.(m?js)$/.test(p), 'The entry must be a .js or .mjs file.')
      .default('index.js'),
    admin: adminSchema.optional(),
    permissions: z
      .array(z.enum(PLUGIN_PERMISSIONS))
      .default([])
      .refine((list) => new Set(list).size === list.length, 'List each permission once.'),
    /** Folder of .sql files applied in order on activation. Needs the database permission. */
    migrations: relativePath.optional(),
  })
  .refine((m) => !m.migrations || m.permissions.includes('database'), {
    message: 'Plugins with migrations must ask for the "database" permission.',
    path: ['permissions'],
  });

export type PluginManifest = z.infer<typeof manifestSchema>;

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: Record<string, string> };

/** Parses and validates plugin.json's text. Errors are keyed by field, like rest_invalid_param. */
export function parseManifest(text: string): ManifestResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: { [MANIFEST_FILE]: 'plugin.json is not valid JSON.' } };
  }
  const parsed = manifestSchema.safeParse(json);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    errors[issue.path.join('.') || MANIFEST_FILE] ??= issue.message;
  }
  return { ok: false, errors };
}

export function authorName(manifest: PluginManifest): string {
  return typeof manifest.author === 'string' ? manifest.author : manifest.author.name;
}

export function authorUrl(manifest: PluginManifest): string {
  return typeof manifest.author === 'string' ? '' : (manifest.author.url ?? '');
}

/** One-line summary of the errors, for logs and error messages. */
export function describeManifestErrors(errors: Record<string, string>): string {
  return Object.entries(errors)
    .map(([field, message]) => (field === MANIFEST_FILE ? message : `${field}: ${message}`))
    .join(' ');
}
