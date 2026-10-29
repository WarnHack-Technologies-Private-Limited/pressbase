import { z } from 'zod';
import { type CurrentUser, userCan } from '../auth/users';
import type { Kernel } from '../kernel';
import { type SettingDefinition, sanitizeSettingValue } from '../options/settings';
import type { InstalledPlugin } from './discovery';
import type { PluginManifest, PluginPermission } from './manifest';

/**
 * What plugins add to the admin: settings (the Settings API), admin pages
 * (the admin menu) and browser modules (SlotFill extensions).
 *
 * WordPress equivalents:
 * - register_setting(), add_settings_section(), add_settings_field()
 *   (wordpress/wp-includes/option.php, wp-admin/includes/template.php),
 *   merged into one call: a setting carries its own field.
 * - add_menu_page(), add_options_page(), add_management_page()
 *   (wordpress/wp-admin/includes/plugin.php): a page is top level or sits
 *   under Settings or Tools.
 *
 * Everything here is registered per plugin, tracked by its PluginRuntime and
 * taken back on deactivation. See docs/architecture/plugins.md#admin-pages-and-settings
 * and docs/adr/0011-plugin-admin-extensions.md.
 */

export const SETTING_TYPES = ['string', 'boolean', 'integer', 'number', 'array', 'object'] as const;
export type SettingType = (typeof SETTING_TYPES)[number];

/** The fields the admin can draw. Array and object settings have none: REST only. */
export const SETTING_CONTROLS = [
  'text',
  'textarea',
  'number',
  'toggle',
  'select',
  'radio',
  'url',
  'email',
  'color',
] as const;
export type SettingControl = (typeof SETTING_CONTROLS)[number];

/** Where a plugin page can sit: top level (no parent), or under Settings or Tools. */
export const PAGE_PARENTS = ['settings', 'tools'] as const;
export type PageParent = (typeof PAGE_PARENTS)[number];

export interface SettingChoice {
  value: string | number;
  label: string;
}

/** `api.settings.register(name, args)`: register_setting() and its field in one. */
export interface PluginSettingArgs {
  /** The stored value's type (register_setting's `type`). Defaults from `control`. */
  type?: SettingType;
  /** The field the admin draws. Defaults from `type`: toggle, number or text. */
  control?: SettingControl;
  label?: string;
  description?: string;
  /** Returned while nothing is stored (register_setting's `default`). */
  default?: unknown;
  /** Choices for `select` and `radio`. */
  options?: SettingChoice[];
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  placeholder?: string;
  /** An empty value is refused. */
  required?: boolean;
  /** Section on the page (add_settings_section's id). Default: "default", untitled. */
  section?: string;
  /** Admin page slug the field shows on. Default: the plugin's own settings page. */
  page?: string;
  /** Needed to see and change it. Default manage_options. */
  capability?: string;
  /** Also exposed at /wp/v2/settings under its option name (WordPress's show_in_rest). */
  showInRest?: boolean;
  /**
   * The option it's stored in. Default `{prefix}{name}` (daily_tips_tone).
   * Another option needs the `options` permission.
   */
  option?: string;
  /**
   * sanitize_callback: receives the validated value, returns what to store.
   * Throw an Error to refuse the value; its message is shown on the field.
   */
  sanitize?: (value: unknown, option: string) => unknown;
}

export interface PluginSectionArgs {
  title?: string;
  description?: string;
  page?: string;
}

/** `api.admin.addPage(args)` or an entry of plugin.json's `admin.pages`. */
export interface PluginPageArgs {
  slug: string;
  title: string;
  /** Under Settings or Tools; omitted, the page is top level (in the Extend group). */
  parent?: PageParent;
  /** Needed to see the page (add_menu_page's $capability). Default manage_options. */
  capability?: string;
  description?: string;
  /** Browser module (ESM) whose default export renders the page body. */
  entry?: string;
}

export interface ResolvedSetting {
  plugin: string;
  name: string;
  option: string;
  type: SettingType;
  control: SettingControl | null;
  label: string;
  description: string;
  default: unknown;
  options: SettingChoice[];
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  placeholder: string;
  required: boolean;
  section: string;
  page: string;
  capability: string;
  showInRest: boolean;
  schema: z.ZodType;
  sanitize?: (value: unknown, option: string) => unknown;
}

export interface ResolvedSection {
  id: string;
  page: string;
  title: string;
  description: string;
}

export interface ResolvedPage {
  plugin: string;
  slug: string;
  title: string;
  parent: PageParent | null;
  capability: string;
  description: string;
  entry: string | null;
}

const NAME = /^[a-z0-9_]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAPABILITY = /^[a-z0-9_]+$/;
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** A refused value, with the message to show next to the field. */
export { SettingSanitizeError } from '../options/settings';

function defaultControl(type: SettingType): SettingControl | null {
  if (type === 'boolean') return 'toggle';
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'string') return 'text';
  return null;
}

function controlType(control: SettingControl, options: SettingChoice[]): SettingType {
  if (control === 'toggle') return 'boolean';
  if (control === 'number') return 'number';
  if (
    (control === 'select' || control === 'radio') &&
    options.every((o) => typeof o.value === 'number')
  )
    return 'integer';
  return 'string';
}

/** Which types each control can edit. */
const CONTROL_TYPES: Record<SettingControl, SettingType[]> = {
  text: ['string'],
  textarea: ['string'],
  url: ['string'],
  email: ['string'],
  color: ['string'],
  number: ['integer', 'number'],
  toggle: ['boolean'],
  select: ['string', 'integer', 'number'],
  radio: ['string', 'integer', 'number'],
};

/** A string that's empty (unless required) or passes `test`. */
function optionalString(required: boolean, message: string, test: (value: string) => boolean) {
  return z
    .string({ message })
    .trim()
    .refine((v) => v === '' || test(v), { message })
    .refine((v) => !required || v !== '', { message: 'Fill in this field.' });
}

/** The zod schema that validates a setting's value: the field's own rules, then the type's. */
export function settingSchema(s: {
  type: SettingType;
  control: SettingControl | null;
  options: SettingChoice[];
  min?: number;
  max?: number;
  maxLength?: number;
  required: boolean;
}): z.ZodType {
  const requiredString = (schema: z.ZodString) =>
    s.required ? schema.min(1, { message: 'Fill in this field.' }) : schema;
  switch (s.control) {
    case 'text':
      return requiredString(
        z
          .string({ message: 'Enter some text.' })
          .trim()
          .max(s.maxLength ?? 1000, { message: `Use ${s.maxLength ?? 1000} characters or fewer.` }),
      );
    case 'textarea':
      return requiredString(
        z.string({ message: 'Enter some text.' }).max(s.maxLength ?? 10_000, {
          message: `Use ${s.maxLength ?? 10_000} characters or fewer.`,
        }),
      );
    case 'url':
      return optionalString(
        s.required,
        'Enter a full address, like https://example.com.',
        (v) => z.url({ protocol: /^https?$/ }).safeParse(v).success,
      );
    case 'email':
      return optionalString(
        s.required,
        'Enter a valid email address.',
        (v) => z.email().safeParse(v).success,
      );
    case 'color':
      return optionalString(s.required, 'Enter a colour like #3858e9.', (v) =>
        COLOR.test(v),
      ).transform((v) => v.toLowerCase());
    case 'number': {
      let n = z.number({ message: 'Enter a number.' });
      if (s.type === 'integer') n = n.int({ message: 'Enter a whole number.' });
      if (s.min !== undefined) n = n.min(s.min, { message: `Enter ${s.min} or more.` });
      if (s.max !== undefined) n = n.max(s.max, { message: `Enter ${s.max} or less.` });
      return n;
    }
    case 'toggle':
      return z.boolean({ message: 'Choose on or off.' });
    case 'select':
    case 'radio': {
      const values = s.options.map((o) => o.value);
      return z.custom<string | number>((v) => values.includes(v as string | number), {
        message: 'Choose one of the options.',
      });
    }
    default:
      return s.type === 'array'
        ? z.array(z.unknown(), { message: 'Expected a list.' })
        : z.record(z.string(), z.unknown(), { message: 'Expected an object.' });
  }
}

function fallbackDefault(type: SettingType, control: SettingControl | null, s: PluginSettingArgs) {
  if (control === 'select' || control === 'radio') return s.options?.[0]?.value;
  if (type === 'boolean') return false;
  if (type === 'integer' || type === 'number') return s.min ?? 0;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return '';
}

/**
 * Checks a setting's arguments and fills in defaults. Throws an Error that
 * names the problem: these are developer mistakes, reported on activation.
 */
export function resolveSetting(
  plugin: string,
  name: string,
  args: PluginSettingArgs,
  context: { prefix: string; permissions: readonly PluginPermission[] },
): ResolvedSetting {
  if (!NAME.test(name)) {
    throw new Error(`Setting names use lowercase letters, numbers and underscores: "${name}".`);
  }
  if (args.control !== undefined && !SETTING_CONTROLS.includes(args.control)) {
    throw new Error(
      `The setting "${name}" has an unknown control "${args.control}". Use one of: ${SETTING_CONTROLS.join(', ')}.`,
    );
  }
  if (args.type !== undefined && !SETTING_TYPES.includes(args.type)) {
    throw new Error(`The setting "${name}" has an unknown type "${args.type}".`);
  }
  const options = (args.options ?? []).map((o) => ({ value: o.value, label: String(o.label) }));
  const type: SettingType =
    args.type ?? (args.control ? controlType(args.control, options) : 'string');
  const control = args.control ?? defaultControl(type);
  if (control && !CONTROL_TYPES[control].includes(type)) {
    throw new Error(`The setting "${name}" is a ${type}; a ${control} field can’t edit it.`);
  }
  if ((control === 'select' || control === 'radio') && options.length === 0) {
    throw new Error(`The setting "${name}" needs \`options\` for its ${control} field.`);
  }
  for (const choice of options) {
    const ok =
      type === 'string' ? typeof choice.value === 'string' : typeof choice.value === 'number';
    if (!ok) throw new Error(`The setting "${name}" has an option whose value isn’t a ${type}.`);
  }
  const page = args.page ?? plugin;
  if (!SLUG.test(page)) throw new Error(`The setting "${name}" names an invalid page "${page}".`);
  const section = args.section ?? 'default';
  if (!SLUG.test(section.replace(/_/g, '-'))) {
    throw new Error(`The setting "${name}" names an invalid section "${section}".`);
  }
  const capability = args.capability ?? 'manage_options';
  if (!CAPABILITY.test(capability)) {
    throw new Error(`The setting "${name}" names an invalid capability "${capability}".`);
  }
  if (args.sanitize !== undefined && typeof args.sanitize !== 'function') {
    throw new Error(`The setting "${name}" has a \`sanitize\` that isn’t a function.`);
  }

  let option = args.option ?? `${context.prefix}${name}`;
  if (!option.startsWith(context.prefix)) {
    if (!NAME.test(option)) throw new Error(`Invalid option name "${option}".`);
    if (!context.permissions.includes('options')) {
      throw new Error(
        `The setting "${name}" is stored in "${option}", outside the plugin’s prefix "${context.prefix}". That needs the "options" permission.`,
      );
    }
  }
  if (option.length > 191) option = option.slice(0, 191);

  const resolved = {
    plugin,
    name,
    option,
    type,
    control,
    label: args.label ?? name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    description: args.description ?? '',
    default: undefined as unknown,
    options,
    min: args.min,
    max: args.max,
    step: args.step,
    maxLength: args.maxLength,
    placeholder: args.placeholder ?? '',
    required: Boolean(args.required),
    section,
    page,
    capability,
    showInRest: Boolean(args.showInRest),
    schema: z.never() as z.ZodType,
    sanitize: args.sanitize,
  } satisfies ResolvedSetting;
  resolved.schema = settingSchema(resolved);
  const fallback = args.default === undefined ? fallbackDefault(type, control, args) : args.default;
  const parsedDefault = resolved.schema.safeParse(fallback);
  // An empty default is fine for a required field: it's what's shown until someone saves.
  if (!parsedDefault.success && !(resolved.required && fallback === '')) {
    throw new Error(
      `The default of "${name}" isn’t valid: ${parsedDefault.error.issues[0]?.message ?? 'invalid value.'}`,
    );
  }
  resolved.default = parsedDefault.success ? parsedDefault.data : fallback;
  return resolved;
}

export function resolvePage(plugin: string, args: PluginPageArgs): ResolvedPage {
  if (!args || typeof args !== 'object') throw new Error('addPage() needs { slug, title }.');
  if (!SLUG.test(args.slug ?? '')) {
    throw new Error(
      `Page slugs use lowercase letters, numbers and dashes: "${String(args.slug)}".`,
    );
  }
  const title = String(args.title ?? '').trim();
  if (!title) throw new Error(`The page "${args.slug}" needs a title.`);
  if (args.parent !== undefined && !PAGE_PARENTS.includes(args.parent)) {
    throw new Error(
      `The page "${args.slug}" can sit under "settings" or "tools", or at the top level; not "${args.parent}".`,
    );
  }
  const capability = args.capability ?? 'manage_options';
  if (!CAPABILITY.test(capability)) {
    throw new Error(`The page "${args.slug}" names an invalid capability "${capability}".`);
  }
  if (args.entry !== undefined && !isRelativeModule(args.entry)) {
    throw new Error(
      `The page "${args.slug}" has an entry outside the plugin folder or not a .js file: "${args.entry}".`,
    );
  }
  return {
    plugin,
    slug: args.slug,
    title: title.slice(0, 100),
    parent: args.parent ?? null,
    capability,
    description: String(args.description ?? '').slice(0, 300),
    entry: args.entry ?? null,
  };
}

/** A browser module path inside the plugin folder: relative, no `..`, .js or .mjs. */
export function isRelativeModule(p: string): boolean {
  return (
    typeof p === 'string' &&
    p.length <= 200 &&
    /\.m?js$/.test(p) &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !p.split('/').some((s) => s === '..' || s === '' || s === '.' || s.startsWith('.'))
  );
}

/** Hooks fired by the Settings API, as WordPress names them. */
declare module '@pressbase/hooks' {
  interface ActionRegistry {
    register_setting: [optionGroup: string, optionName: string, args: ResolvedSetting];
    unregister_setting: [optionGroup: string, optionName: string];
  }
  interface FilterRegistry {
    pre_update_option: [value: unknown, option: string, oldValue: unknown];
  }
}

/** What the block editor loads for a plugin's block: paths in the plugin folder. */
export interface PluginBlockAssets {
  /** The editor module (`admin/tip.js`), served like a UI module. */
  editorScript: string | null;
  /** Stylesheets for the editor canvas (`style` then `editorStyle`), in `public/`. */
  styles: string[];
}

/**
 * One plugin's settings, sections and pages. Created by its PluginRuntime,
 * which passes `track` so deactivation removes everything.
 */
export class PluginAdmin {
  readonly settings = new Map<string, ResolvedSetting>();
  readonly sections = new Map<string, ResolvedSection>();
  readonly pages = new Map<string, ResolvedPage>();
  /** The plugin's blocks' editor assets (api.blocks, plugins/blocks.ts), by block name. */
  readonly blocks = new Map<string, PluginBlockAssets>();
  readonly prefix: string;

  constructor(
    private readonly kernel: Kernel,
    readonly plugin: InstalledPlugin,
    private readonly permissions: readonly PluginPermission[],
    private readonly track: (dispose: () => void) => void,
  ) {
    this.prefix = `${plugin.slug.replace(/-/g, '_')}_`;
  }

  get slug(): string {
    return this.plugin.slug;
  }

  /** register_setting() + add_settings_field(). */
  registerSetting(name: string, args: PluginSettingArgs = {}): ResolvedSetting {
    const setting = resolveSetting(this.slug, name, args ?? {}, {
      prefix: this.prefix,
      permissions: this.permissions,
    });
    if ([...this.settings.values()].some((s) => s.name === name)) {
      throw new Error(`The setting "${name}" is already registered.`);
    }
    // Another plugin (or core) can't be shadowed: one option, one setting.
    for (const runtime of this.kernel.plugins.adminRegistrations()) {
      if (runtime.settings.has(setting.option)) {
        throw new Error(`The option "${setting.option}" already has a registered setting.`);
      }
    }
    if (setting.showInRest) {
      if (this.kernel.settings.get(setting.option)) {
        throw new Error(`The setting "${setting.option}" is already in /wp/v2/settings.`);
      }
      this.kernel.settings.register(setting.option, toDefinition(setting));
    }
    this.settings.set(setting.option, setting);
    this.track(() => {
      this.settings.delete(setting.option);
      if (setting.showInRest) this.kernel.settings.unregister(setting.option);
      void this.kernel.hooks
        .doAction('unregister_setting', this.slug, setting.option)
        .catch(() => {});
    });
    void this.kernel.hooks
      .doAction('register_setting', this.slug, setting.option, setting)
      .catch(() => {});
    return setting;
  }

  /** add_settings_section(). */
  addSection(id: string, args: PluginSectionArgs = {}): void {
    if (!SLUG.test(String(id).replace(/_/g, '-'))) {
      throw new Error(
        `Section ids use lowercase letters, numbers, dashes and underscores: "${id}".`,
      );
    }
    const page = args.page ?? this.slug;
    const key = `${page}/${id}`;
    if (this.sections.has(key)) throw new Error(`The section "${id}" is already registered.`);
    this.sections.set(key, {
      id,
      page,
      title: String(args.title ?? '').slice(0, 100),
      description: String(args.description ?? '').slice(0, 500),
    });
    this.track(() => this.sections.delete(key));
  }

  /** add_menu_page() / add_options_page() / add_management_page(). */
  addPage(args: PluginPageArgs): void {
    const page = resolvePage(this.slug, args);
    if (this.pages.has(page.slug))
      throw new Error(`The page "${page.slug}" is already registered.`);
    if (this.pages.size >= 20) throw new Error('A plugin can add at most 20 admin pages.');
    this.pages.set(page.slug, page);
    this.track(() => this.pages.delete(page.slug));
  }

  /** A block's editor module and stylesheets, for the block editor (plugins/blocks.ts). */
  addBlock(name: string, assets: PluginBlockAssets): void {
    this.blocks.set(name, assets);
    this.track(() => this.blocks.delete(name));
  }

  /** What plugin.json's `admin` declares: registered before `register(api)` runs. */
  registerManifest(admin: PluginManifest['admin']): void {
    if (!admin) return;
    for (const page of admin.pages) this.addPage(page);
    for (const section of admin.sections) this.addSection(section.id, section);
    for (const { name, ...args } of admin.settings) this.registerSetting(name, args);
  }

  /** get_option() with the registered default. */
  async get<T = unknown>(name: string): Promise<T> {
    const setting = this.#find(name);
    return this.kernel.options.get<T>(setting.option, setting.default as T);
  }

  /** update_option() through the setting's validation and sanitising. Throws SettingSanitizeError. */
  async set(name: string, value: unknown): Promise<unknown> {
    return saveSetting(this.kernel, this.#find(name), value);
  }

  #find(name: string): ResolvedSetting {
    const setting =
      this.settings.get(name) ?? [...this.settings.values()].find((s) => s.name === name);
    if (!setting) throw new Error(`The setting "${name}" isn’t registered.`);
    return setting;
  }

  /**
   * The plugin's pages, including its implicit settings page: settings that
   * don't name a page show on one titled after the plugin, under Settings
   * (as add_options_page() would add).
   */
  allPages(): ResolvedPage[] {
    const pages = [...this.pages.values()];
    const implicit = [...this.settings.values()].some(
      (s) => s.page === this.slug && s.control !== null,
    );
    if (implicit && !this.pages.has(this.slug)) {
      pages.unshift({
        plugin: this.slug,
        slug: this.slug,
        title: this.plugin.manifest.title,
        parent: 'settings',
        capability: 'manage_options',
        description: '',
        entry: null,
      });
    }
    return pages;
  }

  /** The admin's browser module (plugin.json `admin.module`), loaded on every admin screen. */
  get module(): string | null {
    return this.plugin.manifest.admin?.module ?? null;
  }
}

function toDefinition(setting: ResolvedSetting): SettingDefinition {
  return {
    option: setting.option,
    schema: setting.schema,
    default: setting.default,
    capability: setting.capability,
    sanitize: setting.sanitize,
  };
}

/**
 * Validates, sanitises and stores one setting: the field's schema, then the
 * plugin's `sanitize`, the `sanitize_option_{option}` filter and the
 * `pre_update_option_{option}` / `pre_update_option` filters, as
 * update_option() does. Returns what was stored.
 */
export async function saveSetting(
  kernel: Kernel,
  setting: ResolvedSetting,
  value: unknown,
): Promise<unknown> {
  const prepared = await sanitizeSettingValue(kernel, toDefinition(setting), value);
  await kernel.options.set(setting.option, prepared);
  return prepared;
}

/* ------------------------------------------------------------- REST shapes */

/** The URL core serves a plugin's browser module at; `ver` makes it cacheable forever. */
export function moduleUrl(plugin: InstalledPlugin, file: string): string {
  const path = file
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/wp-content/plugins/${plugin.slug}/${path}?ver=${encodeURIComponent(plugin.manifest.version)}`;
}

/** A plugin block's editor assets as /pressbase/v1/admin-extensions lists them. */
export function blockItem(admin: PluginAdmin, name: string, assets: PluginBlockAssets) {
  return {
    plugin: admin.slug,
    title: admin.plugin.manifest.title,
    name,
    editor_script: assets.editorScript ? moduleUrl(admin.plugin, assets.editorScript) : null,
    styles: assets.styles.map((file) => moduleUrl(admin.plugin, file)),
  };
}

export function pageItem(admin: PluginAdmin, page: ResolvedPage) {
  return {
    plugin: page.plugin,
    plugin_title: admin.plugin.manifest.title,
    slug: page.slug,
    title: page.title,
    parent: page.parent,
    capability: page.capability,
    description: page.description,
    module: page.entry ? moduleUrl(admin.plugin, page.entry) : null,
    has_settings: [...admin.settings.values()].some(
      (s) => s.page === page.slug && s.control !== null,
    ),
  };
}

export type AdminPageItem = ReturnType<typeof pageItem>;

export function fieldItem(setting: ResolvedSetting) {
  return {
    name: setting.option,
    label: setting.label,
    description: setting.description,
    type: setting.type,
    control: setting.control,
    default: setting.default,
    options: setting.options,
    min: setting.min ?? null,
    max: setting.max ?? null,
    step: setting.step ?? null,
    max_length: setting.maxLength ?? null,
    placeholder: setting.placeholder,
    required: setting.required,
  };
}

/** Settings of one page the user may change, grouped into sections in registration order. */
export function pageSettings(admin: PluginAdmin, page: string, user: CurrentUser | null) {
  const settings = [...admin.settings.values()].filter(
    (s) => s.page === page && s.control !== null && userCan(user, s.capability),
  );
  const order: string[] = [];
  for (const section of admin.sections.values()) if (section.page === page) order.push(section.id);
  for (const s of settings) if (!order.includes(s.section)) order.push(s.section);
  // The untitled default section comes first, as do_settings_sections() lists it first when added first.
  order.sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : 0));
  return {
    settings,
    sections: order
      .map((id) => {
        const section = admin.sections.get(`${page}/${id}`);
        return {
          id,
          title: section?.title ?? '',
          description: section?.description ?? '',
          fields: settings.filter((s) => s.section === id),
        };
      })
      .filter((section) => section.fields.length > 0),
  };
}
