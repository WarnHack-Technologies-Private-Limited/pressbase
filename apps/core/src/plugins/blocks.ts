import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type AttributeSchema,
  type BlockAttributes,
  type BlockTypeArgs,
  escAttr,
  escHtml,
  escUrl,
  getBlockWrapperAttributes,
  validateValueFromSchema,
  type WPBlock,
  type WrapperAttributes,
} from '@pressbase/blocks';
import type { BlockServices } from '../blocks/helpers';
import type { Kernel } from '../kernel';
import { isRelativeModule, type PluginAdmin } from './admin';
import { PUBLIC_DIR, pluginAssetUrl } from './assets';
import type { InstalledPlugin } from './discovery';

/**
 * Blocks registered by plugins: `api.blocks` (docs/architecture/plugins.md#blocks,
 * ADR 0020). register_block_type() and register_block_type_from_metadata()
 * from wordpress/wp-includes/blocks.php, on top of core's block registry
 * (`kernel.blocks`, WP_Block_Type_Registry), so a plugin block renders through
 * the same render_block() pipeline, filters included, as core's blocks.
 *
 * - Names are namespaced by the plugin's slug (`daily-tips/tip`).
 * - `render` makes the block dynamic. Its output is trusted HTML, as WordPress
 *   trusts a `render_callback`: escape what you print (`api.blocks.escHtml`…).
 *   A callback that throws is recorded against the plugin and renders nothing.
 * - `style` is enqueued only on pages that show the block (WP_Block::render());
 *   `editorScript` is the block's editor module, imported by the block editor
 *   before it parses the post (it calls `pressbase.blocks.registerBlockType()`).
 * - Everything is taken back on deactivation; the page cache is purged when a
 *   block is registered or unregistered.
 */

/** render_callback( $attributes, $content, $block ). */
export type PluginBlockRender = (
  attributes: BlockAttributes,
  content: string,
  block: WPBlock<unknown>,
) => string | null | undefined | Promise<string | null | undefined>;

/** block.json's fields (camelCase), plus the render callback and the assets. */
export interface PluginBlockArgs
  extends Omit<
    BlockTypeArgs<unknown>,
    'render' | 'editorScriptHandles' | 'styleHandles' | 'editorStyleHandles'
  > {
  /** Makes the block dynamic: its HTML is produced on every view. */
  render?: PluginBlockRender;
  /**
   * The block's editor module, a `.js`/`.mjs` file in the plugin folder
   * (`admin/tip.js`), served like a UI module. It calls
   * `window.pressbase.blocks.registerBlockType(name, { edit, save })`.
   */
  editorScript?: string;
  /** Stylesheets in `public/` (`'tip.css'`), on public pages that show the block and in the editor. */
  style?: string | string[];
  /** Stylesheets in `public/` for the editor canvas only. */
  editorStyle?: string | string[];
}

export interface PluginBlocks {
  /**
   * register_block_type(): `name` is `{plugin-slug}/{block}`. Throws on a bad
   * name, a duplicate or invalid arguments, so a mistake fails activation.
   */
  register(name: string, args?: PluginBlockArgs): void;
  /**
   * register_block_type_from_metadata(): reads `block.json` from a folder (or
   * the file) inside the plugin, relative to the plugin's folder. `file:`
   * paths in it are relative to the block.json: `editorScript`, `style` and
   * `editorStyle` (inside `public/`), and `render` (a module whose default
   * export is the render callback). `args` override the file. Returns the name.
   */
  registerFromMetadata(fileOrFolder: string, args?: PluginBlockArgs): Promise<string>;
  /** unregister_block_type() for one of the plugin's blocks. */
  unregister(name: string): boolean;
  /** WP_Block_Type_Registry::is_registered(), for any block. */
  isRegistered(name: string): boolean;
  /** esc_html(), esc_attr(), esc_url() for render callbacks. */
  escHtml(value: unknown): string;
  escAttr(value: unknown): string;
  escUrl(value: unknown): string;
  /** get_block_wrapper_attributes(): the outer element's attributes, block supports included. */
  getBlockWrapperAttributes(block: WPBlock<unknown>, extra?: WrapperAttributes): string;
}

export interface BlocksHost {
  kernel: Kernel;
  plugin: InstalledPlugin;
  admin: PluginAdmin;
  track(dispose: () => void): void;
  reportError(during: string, error: unknown): void;
  purge(tags: string[]): Promise<void>;
}

/** Keys block.json and register_block_type() share (the property mappings in blocks.php). */
const BLOCK_KEYS = [
  'apiVersion',
  'title',
  'category',
  'parent',
  'ancestor',
  'icon',
  'description',
  'keywords',
  'attributes',
  'providesContext',
  'usesContext',
  'selectors',
  'supports',
  'styles',
  'variations',
  'example',
  'allowedBlocks',
  'textdomain',
] as const;

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

/** generate_block_asset_handle() for a block outside core. */
export function blockAssetHandle(
  name: string,
  field: 'editorScript' | 'style' | 'editorStyle',
  index = 0,
): string {
  const suffix = { editorScript: 'editor-script', style: 'style', editorStyle: 'editor-style' }[
    field
  ];
  return `${name.replace('/', '-')}-${suffix}${index > 0 ? `-${index + 1}` : ''}`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringList = (value: unknown) =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

/** Checks register_block_type()'s arguments, so a mistake fails activation with a message. */
export function validateBlockArgs(name: string, args: PluginBlockArgs): void {
  const fail = (message: string): never => {
    throw new Error(`Block "${name}": ${message}`);
  };
  for (const key of ['title', 'description', 'category', 'icon', 'textdomain'] as const) {
    const value = args[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      fail(`\`${key}\` must be a string.`);
    }
  }
  for (const key of ['keywords', 'parent', 'ancestor', 'allowedBlocks', 'usesContext'] as const) {
    const value = args[key];
    if (value !== undefined && value !== null && !isStringList(value)) {
      fail(`\`${key}\` must be a list of strings.`);
    }
  }
  for (const key of ['supports', 'selectors'] as const) {
    if (args[key] !== undefined && !isObject(args[key])) fail(`\`${key}\` must be an object.`);
  }
  if (args.apiVersion !== undefined && ![1, 2, 3].includes(args.apiVersion)) {
    fail('`apiVersion` must be 1, 2 or 3.');
  }
  if (args.render !== undefined && typeof args.render !== 'function') {
    fail('`render` must be a function.');
  }

  const attributes = args.attributes ?? {};
  if (!isObject(attributes)) fail('`attributes` must be an object.');
  for (const [key, schema] of Object.entries(attributes)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) fail(`"${key}" isn't a valid attribute name.`);
    if (!isObject(schema)) fail(`the attribute "${key}" must be an object.`);
    const s = schema as AttributeSchema;
    const types = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
    if (!types.length && !Array.isArray(s.enum)) {
      fail(`the attribute "${key}" needs a \`type\` (or an \`enum\`).`);
    }
    for (const type of types) {
      if (!SCHEMA_TYPES.has(type as string)) {
        fail(`the attribute "${key}" has an unknown type "${String(type)}".`);
      }
    }
    if (s.enum !== undefined && !Array.isArray(s.enum)) {
      fail(`the attribute "${key}"'s \`enum\` must be a list.`);
    }
    if (s.default !== undefined && validateValueFromSchema(s.default, s, key) !== null) {
      fail(`the attribute "${key}"'s default doesn't match its schema.`);
    }
  }

  const provides = args.providesContext ?? {};
  if (!isObject(provides)) fail('`providesContext` must be an object.');
  for (const [context, attribute] of Object.entries(provides)) {
    if (typeof attribute !== 'string' || !(attribute in attributes)) {
      fail(`\`providesContext.${context}\` must name one of the block's attributes.`);
    }
  }
}

/** One or more strings, as block.json's asset fields allow. */
function assetList(value: unknown, field: string, name: string): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (!list.every((v) => typeof v === 'string' && v)) {
    throw new Error(`Block "${name}": \`${field}\` must be a file name or a list of them.`);
  }
  return list as string[];
}

export function createPluginBlocks(host: BlocksHost): PluginBlocks {
  const { kernel, plugin, admin } = host;
  const slug = plugin.slug;
  const version = plugin.manifest.version;
  const own = new Set<string>();
  const disposers = new Map<string, () => void>();

  // Registering or removing a block changes how cached pages render: purge once per tick.
  let purging: Promise<void> | undefined;
  const schedulePurge = () => {
    purging ??= Promise.resolve().then(() => {
      purging = undefined;
      return host.purge(['site']).catch((error) => host.reportError('cache purge', error));
    });
  };

  const register = (name: string, args: PluginBlockArgs = {}): void => {
    if (typeof name !== 'string' || !new RegExp(`^${slug}/[a-z0-9-]+$`).test(name)) {
      throw new Error(
        `Block names start with the plugin's name and use lowercase letters, digits and dashes: "${slug}/my-block", not "${String(name)}".`,
      );
    }
    if (kernel.blocks.registry.isRegistered(name)) {
      throw new Error(`Block type "${name}" is already registered.`);
    }
    if (!isObject(args as unknown)) {
      throw new Error(`Block "${name}": the arguments must be an object.`);
    }
    validateBlockArgs(name, args);

    const styleFiles = assetList(args.style, 'style', name);
    const editorStyleFiles = assetList(args.editorStyle, 'editorStyle', name);
    // pluginAssetUrl() checks each path stays inside public/.
    const styleUrls = styleFiles.map((file) => pluginAssetUrl(slug, file));
    const editorStyleUrls = editorStyleFiles.map((file) => pluginAssetUrl(slug, file));
    const editorScript = args.editorScript ?? null;
    if (
      editorScript !== null &&
      (!isRelativeModule(editorScript) ||
        path.posix.normalize(editorScript) === path.posix.normalize(plugin.manifest.main))
    ) {
      throw new Error(
        `Block "${name}": \`editorScript\` must be a .js or .mjs module in the plugin folder, like "admin/${name.split('/')[1]}.js", and not the plugin's main file.`,
      );
    }

    const cleanup: (() => void)[] = [];
    const registerStyles = (urls: string[], field: 'style' | 'editorStyle') =>
      urls.map((url, index) => {
        const handle = blockAssetHandle(name, field, index);
        if (kernel.styles.register(handle, url, [], version)) {
          cleanup.push(() => kernel.styles.deregister(handle));
        }
        return handle;
      });
    const styleHandles = registerStyles(styleUrls, 'style');
    const editorStyleHandles = registerStyles(editorStyleUrls, 'editorStyle');

    const render = args.render;
    const blockArgs: BlockTypeArgs<BlockServices> = {};
    for (const key of BLOCK_KEYS) {
      if (args[key] !== undefined) (blockArgs as Record<string, unknown>)[key] = args[key];
    }
    try {
      kernel.blocks.registerBlockType(name, {
        ...blockArgs,
        title: args.title || name,
        editorScriptHandles: editorScript ? [blockAssetHandle(name, 'editorScript')] : [],
        styleHandles,
        editorStyleHandles,
        render: render
          ? async (attributes, content, block) => {
              try {
                const html = await render(attributes, content, block as WPBlock<unknown>);
                return typeof html === 'string' ? html : '';
              } catch (error) {
                host.reportError(`block ${name}`, error);
                return '';
              }
            }
          : undefined,
      });
    } catch (error) {
      for (const dispose of cleanup) dispose();
      throw error;
    }
    admin.addBlock(name, {
      editorScript,
      styles: [...styleFiles, ...editorStyleFiles].map((file) =>
        file.replace(/^\.\//, '').replace(new RegExp(`^${PUBLIC_DIR}/`), ''),
      ),
    });

    let removed = false;
    const dispose = () => {
      if (removed) return;
      removed = true;
      kernel.blocks.unregisterBlockType(name);
      for (const fn of cleanup) fn();
      own.delete(name);
      disposers.delete(name);
      schedulePurge();
    };
    own.add(name);
    disposers.set(name, dispose);
    host.track(dispose);
    schedulePurge();
  };

  /** A path inside the plugin's folder, or an error naming it. */
  const inside = async (relative: string, what: string): Promise<string> => {
    const root = await realpath(plugin.dir);
    const resolved = path.resolve(root, relative);
    let real: string;
    try {
      real = await realpath(resolved);
    } catch {
      throw new Error(`${what} "${relative}" doesn't exist in the plugin.`);
    }
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      throw new Error(`${what} "${relative}" is outside the plugin's folder.`);
    }
    return real;
  };

  const registerFromMetadata = async (
    fileOrFolder: string,
    args: PluginBlockArgs = {},
  ): Promise<string> => {
    if (typeof fileOrFolder !== 'string' || path.isAbsolute(fileOrFolder)) {
      throw new Error(`Give block.json's path relative to the plugin's folder: "${fileOrFolder}".`);
    }
    const relative = fileOrFolder.endsWith('block.json')
      ? fileOrFolder
      : path.join(fileOrFolder, 'block.json');
    const file = await inside(relative, 'The block metadata file');
    const root = await realpath(plugin.dir);
    const folder = path.dirname(file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      throw new Error(`${relative} isn't valid JSON: ${(error as Error).message}`);
    }
    const metadata = (await kernel.hooks.applyFilters('block_type_metadata', parsed)) as Record<
      string,
      unknown
    >;
    if (!isObject(metadata) || typeof metadata.name !== 'string') {
      throw new Error(`${relative} needs a "name".`);
    }
    const name = metadata.name;

    /** `file:./x` → the path relative to the plugin folder (remove_block_asset_path_prefix()). */
    const fromFile = async (value: string, field: string) => {
      const target = await inside(
        path.relative(root, path.resolve(folder, value.slice('file:'.length))),
        `Block "${name}": \`${field}\``,
      );
      return path.relative(root, target).split(path.sep).join('/');
    };
    const publicFile = async (value: string, field: string) => {
      if (!value.startsWith('file:')) return value;
      const file = await fromFile(value, field);
      if (!file.startsWith(`${PUBLIC_DIR}/`)) {
        throw new Error(`Block "${name}": \`${field}\` files must be in the plugin's public/ folder.`);
      }
      return file.slice(PUBLIC_DIR.length + 1);
    };

    const settings: PluginBlockArgs = {};
    for (const key of BLOCK_KEYS) {
      if (metadata[key] !== undefined) (settings as Record<string, unknown>)[key] = metadata[key];
    }
    if (typeof metadata.editorScript === 'string') {
      settings.editorScript = metadata.editorScript.startsWith('file:')
        ? await fromFile(metadata.editorScript, 'editorScript')
        : metadata.editorScript;
    }
    for (const field of ['style', 'editorStyle'] as const) {
      const list = assetList(metadata[field], field, name);
      if (list.length) {
        settings[field] = await Promise.all(list.map((value) => publicFile(value, field)));
      }
    }
    if (typeof metadata.render === 'string' && metadata.render.startsWith('file:') && !args.render) {
      const module = (await import(
        pathToFileURL(path.join(root, await fromFile(metadata.render, 'render'))).href
      )) as { default?: unknown; render?: unknown };
      const render = module.default ?? module.render;
      if (typeof render !== 'function') {
        throw new Error(`Block "${name}": the render module has no default export function.`);
      }
      settings.render = render as PluginBlockRender;
    }
    register(name, { ...settings, ...args });
    return name;
  };

  return Object.freeze<PluginBlocks>({
    register,
    registerFromMetadata,
    unregister: (name: string) => {
      const dispose = disposers.get(name);
      if (!dispose || !own.has(name)) return false;
      dispose();
      return true;
    },
    isRegistered: (name: string) => kernel.blocks.registry.isRegistered(name),
    escHtml: (value: unknown) => escHtml(value == null ? '' : String(value)),
    escAttr: (value: unknown) => escAttr(value == null ? '' : String(value)),
    escUrl: (value: unknown) => escUrl(value == null ? '' : String(value)),
    getBlockWrapperAttributes: (block, extra) =>
      getBlockWrapperAttributes(block as WPBlock<BlockServices>, extra),
  });
}
