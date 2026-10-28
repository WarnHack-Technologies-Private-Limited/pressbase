import { currentUserCan } from '../auth/meta-caps';
import type { CurrentUser } from '../auth/users';
import type { Kernel } from '../kernel';
import { type JsonSchema, validateJsonSchema } from './json-schema';

/**
 * The Abilities API (WordPress 6.9/7.0): named, schema-described units of work
 * that the REST API (`/wp-abilities/v1`), the CLI (`pressbase ability`) and
 * AI models (`kernel.ai.prompt().usingAbilities()`) can discover and run, with
 * the same permission checks everywhere.
 *
 * Ports wp-includes/abilities-api.php, abilities-api/class-wp-ability.php,
 * class-wp-abilities-registry.php and class-wp-ability-categories-registry.php.
 * Differences, because Pressbase has no global current user and no WP_Error:
 * callbacks receive an {@link AbilityContext} as their second argument, and
 * failures are thrown as {@link AbilityError}s carrying WordPress's codes.
 */

/** Behaviour hints (WP_Ability::$default_annotations). */
export interface AbilityAnnotations {
  /** The ability doesn't change anything. REST runs it with GET. */
  readonly?: boolean | null;
  /** It may delete or overwrite. With `idempotent`, REST runs it with DELETE. */
  destructive?: boolean | null;
  /** Running it twice with the same input has no further effect. */
  idempotent?: boolean | null;
  [key: string]: unknown;
}

export interface AbilityMeta {
  annotations?: AbilityAnnotations;
  /** Listed and runnable over REST. Defaults to `public`, then false (DEFAULT_SHOW_IN_REST). */
  showInRest?: boolean;
  /** Meant for any client (REST, AI agents). Defaults to false. */
  public?: boolean;
  [key: string]: unknown;
}

/** Who is running an ability, and from where. */
export interface AbilityContext {
  /** The logged-in user, the CLI's --user, or the user an AI prompt runs for. */
  user: CurrentUser | null;
  /**
   * current_user_can() for that user. The CLI without --user acts with full
   * trust, as wp-cli does, so every check passes there.
   */
  can(capability: string, objectId?: number): Promise<boolean>;
  via: 'rest' | 'cli' | 'ai' | 'server';
}

// biome-ignore lint/suspicious/noExplicitAny: plugin callbacks pick their own input type.
type AnyInput = any;

export interface AbilityArgs<I = AnyInput, O = unknown> {
  label: string;
  description: string;
  /** A registered category slug (`site`, `user`, or one a plugin registers). */
  category: string;
  /** JSON Schema for the input. Without one, the ability takes no input. */
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  /**
   * Required, as WordPress requires `permission_callback`: return true to
   * allow, false or an AbilityError to refuse.
   */
  permissionCallback: (
    input: I,
    context: AbilityContext,
  ) => boolean | AbilityError | Promise<boolean | AbilityError>;
  /** Does the work. Throw an AbilityError to fail with a code. */
  executeCallback: (input: I, context: AbilityContext) => O | Promise<O>;
  meta?: AbilityMeta;
}

export interface AbilityCategoryArgs {
  label: string;
  description: string;
  meta?: Record<string, unknown>;
}

/** A WP_Error, thrown: `code` is WordPress's error code, `status` the HTTP status for REST. */
export class AbilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AbilityError';
  }
}

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    wp_register_ability_args: [args: AbilityArgs, name: string];
    wp_register_ability_category_args: [args: AbilityCategoryArgs, slug: string];
    wp_ability_normalize_input: [input: unknown, name: string, ability: Ability];
    wp_ability_validate_input: [result: true | false | AbilityError, input: unknown, name: string];
    wp_ability_permission_result: [
      result: boolean | AbilityError,
      name: string,
      input: unknown,
      ability: Ability,
    ];
    wp_pre_execute_ability: [pre: unknown, name: string, input: unknown, ability: Ability];
    wp_ability_execute_result: [result: unknown, name: string, input: unknown, ability: Ability];
    wp_ability_validate_output: [
      result: true | false | AbilityError,
      output: unknown,
      name: string,
    ];
  }
  interface ActionRegistry {
    wp_ability_invoked: [name: string, input: unknown, ability: Ability];
    wp_before_execute_ability: [name: string, input: unknown, ability: Ability];
    wp_after_execute_ability: [name: string, input: unknown, result: unknown, ability: Ability];
  }
}

const ABILITY_NAME = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const CATEGORY_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_ANNOTATIONS: AbilityAnnotations = {
  readonly: null,
  destructive: null,
  idempotent: null,
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** WP_Ability */
export class Ability {
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly meta: AbilityMeta & {
    annotations: AbilityAnnotations;
    showInRest: boolean;
    public: boolean;
  };
  readonly #permission: AbilityArgs['permissionCallback'];
  readonly #execute: AbilityArgs['executeCallback'];

  constructor(
    private readonly kernel: Kernel,
    readonly name: string,
    args: AbilityArgs,
    /** The plugin that registered it, or null for core. */
    readonly plugin: string | null = null,
  ) {
    // WP_Ability::prepare_properties()
    if (!args.label || typeof args.label !== 'string') {
      throw new TypeError('The ability properties must contain a `label` string.');
    }
    if (!args.description || typeof args.description !== 'string') {
      throw new TypeError('The ability properties must contain a `description` string.');
    }
    if (!args.category || typeof args.category !== 'string') {
      throw new TypeError('The ability properties must contain a `category` string.');
    }
    if (typeof args.executeCallback !== 'function') {
      throw new TypeError(
        'The ability properties must contain a valid `executeCallback` function.',
      );
    }
    if (typeof args.permissionCallback !== 'function') {
      throw new TypeError(
        'The ability properties must provide a valid `permissionCallback` function.',
      );
    }
    if (args.inputSchema !== undefined && !isObject(args.inputSchema)) {
      throw new TypeError(
        'The ability properties should provide a valid `inputSchema` definition.',
      );
    }
    if (args.outputSchema !== undefined && !isObject(args.outputSchema)) {
      throw new TypeError(
        'The ability properties should provide a valid `outputSchema` definition.',
      );
    }
    const meta = args.meta ?? {};
    if (!isObject(meta))
      throw new TypeError('The ability properties should provide a valid `meta` object.');
    if (meta.annotations !== undefined && !isObject(meta.annotations)) {
      throw new TypeError('The ability meta should provide a valid `annotations` object.');
    }
    if (meta.showInRest !== undefined && typeof meta.showInRest !== 'boolean') {
      throw new TypeError('The ability meta should provide a valid `showInRest` boolean.');
    }
    if (meta.public !== undefined && typeof meta.public !== 'boolean') {
      throw new TypeError('The ability meta should provide a valid `public` boolean.');
    }
    this.label = args.label;
    this.description = args.description;
    this.category = args.category;
    this.inputSchema = args.inputSchema ?? {};
    this.outputSchema = args.outputSchema ?? {};
    this.meta = {
      ...meta,
      annotations: { ...DEFAULT_ANNOTATIONS, ...meta.annotations },
      // An explicit showInRest wins, then `public` seeds it, then the default (false).
      showInRest: meta.showInRest ?? meta.public ?? false,
      public: meta.public ?? false,
    };
    this.#permission = args.permissionCallback;
    this.#execute = args.executeCallback;
  }

  #hasInputSchema(): boolean {
    return Object.keys(this.inputSchema).length > 0;
  }

  /** WP_Ability::normalize_input(): the schema's default when no input is given. */
  async normalizeInput(input: unknown): Promise<unknown> {
    let value: unknown = input ?? null;
    if (value === null && 'default' in this.inputSchema) value = this.inputSchema.default;
    return this.kernel.hooks.applyFilters('wp_ability_normalize_input', value, this.name, this);
  }

  /** WP_Ability::validate_input(): throws `ability_invalid_input`. */
  async validateInput(input: unknown): Promise<void> {
    let result: true | false | AbilityError = true;
    if (!this.#hasInputSchema()) {
      if (input !== null && input !== undefined) {
        result = new AbilityError(
          'ability_missing_input_schema',
          `Ability "${this.name}" does not define an input schema required to validate the provided input.`,
          400,
        );
      }
    } else {
      const error = validateJsonSchema(input, this.inputSchema, 'input');
      if (error) {
        result = new AbilityError(
          'ability_invalid_input',
          `Ability "${this.name}" has invalid input. Reason: ${error}`,
          400,
        );
      }
    }
    const validity = await this.kernel.hooks.applyFilters(
      'wp_ability_validate_input',
      result,
      input,
      this.name,
    );
    if (validity === false) throw new AbilityError('ability_invalid_input', 'Invalid input.', 400);
    if (validity instanceof AbilityError) throw validity;
  }

  /** Runs a callback, turning unexpected exceptions into `ability_callback_exception`. */
  async #invoke<T>(callback: () => T | Promise<T>): Promise<T> {
    try {
      return await callback();
    } catch (error) {
      if (error instanceof AbilityError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new AbilityError(
        'ability_callback_exception',
        `Ability "${this.name}" callback threw an exception: ${message}`,
        500,
      );
    }
  }

  /**
   * WP_Ability::check_permissions(): true, false or an AbilityError, after the
   * `wp_ability_permission_result` filter. Input isn't validated here.
   */
  async checkPermissions(input: unknown, context: AbilityContext): Promise<boolean | AbilityError> {
    let permission: boolean | AbilityError;
    try {
      permission = await this.#invoke(() => this.#permission(input, context));
    } catch (error) {
      permission = error as AbilityError;
    }
    const result = await this.kernel.hooks.applyFilters(
      'wp_ability_permission_result',
      permission,
      this.name,
      input,
      this,
    );
    return typeof result === 'boolean' || result instanceof AbilityError ? result : false;
  }

  /** WP_Ability::validate_output(): throws `ability_invalid_output`. */
  async #validateOutput(output: unknown): Promise<void> {
    let result: true | false | AbilityError = true;
    if (Object.keys(this.outputSchema).length) {
      const error = validateJsonSchema(output, this.outputSchema, 'output');
      if (error) {
        result = new AbilityError(
          'ability_invalid_output',
          `Ability "${this.name}" has invalid output. Reason: ${error}`,
          500,
        );
      }
    }
    const validity = await this.kernel.hooks.applyFilters(
      'wp_ability_validate_output',
      result,
      output,
      this.name,
    );
    if (validity === false)
      throw new AbilityError('ability_invalid_output', 'Invalid output.', 500);
    if (validity instanceof AbilityError) throw validity;
  }

  /**
   * WP_Ability::execute(): normalise, validate the input, check permissions,
   * run, validate the output. Throws an AbilityError on any failure.
   */
  async execute(input: unknown, context: AbilityContext): Promise<unknown> {
    const { hooks } = this.kernel;
    await hooks.doAction('wp_ability_invoked', this.name, input, this);

    // wp_pre_execute_ability: anything but the sentinel short-circuits.
    const sentinel = Symbol('pre_execute');
    const pre = await hooks.applyFilters(
      'wp_pre_execute_ability',
      sentinel,
      this.name,
      input,
      this,
    );
    if (pre !== sentinel) return pre;

    const normalized = await this.normalizeInput(input);
    await this.validateInput(normalized);
    const permitted = await this.checkPermissions(normalized, context);
    if (permitted !== true) {
      // Don't leak the permission check's own error to someone without the permission.
      throw new AbilityError(
        'ability_invalid_permissions',
        `Ability "${this.name}" does not have necessary permission.`,
        context.user ? 403 : 401,
      );
    }

    await hooks.doAction('wp_before_execute_ability', this.name, normalized, this);
    let result: unknown;
    try {
      result = await this.#invoke(() => this.#execute(normalized, context));
    } catch (error) {
      result = error;
    }
    result = await hooks.applyFilters(
      'wp_ability_execute_result',
      result,
      this.name,
      normalized,
      this,
    );
    if (result instanceof AbilityError) throw result;
    await this.#validateOutput(result);
    await hooks.doAction('wp_after_execute_ability', this.name, normalized, result, this);
    return result;
  }
}

/** WP_Ability_Category */
export interface AbilityCategory {
  slug: string;
  label: string;
  description: string;
  meta: Record<string, unknown>;
  plugin: string | null;
}

export interface AbilityQuery {
  category?: string;
  /** The part of the name before the slash. */
  namespace?: string;
  /** Meta values every returned ability must have (`{ showInRest: true }`). */
  meta?: Record<string, unknown>;
}

/** WP_Abilities_Registry and WP_Ability_Categories_Registry, on the kernel as `kernel.abilities`. */
export class AbilitiesRegistry {
  #abilities = new Map<string, Ability>();
  #categories = new Map<string, AbilityCategory>();

  constructor(private readonly kernel: Kernel) {}

  /**
   * wp_register_ability_category(). Returns a function that unregisters it.
   * `wp_register_ability_category_args` runs synchronously here.
   */
  registerCategory(
    slug: string,
    args: AbilityCategoryArgs,
    plugin: string | null = null,
  ): () => void {
    if (this.#categories.has(slug)) {
      throw new Error(`Ability category "${slug}" is already registered.`);
    }
    if (!CATEGORY_SLUG.test(slug)) {
      throw new Error(
        'Ability category slug must contain only lowercase alphanumeric characters and dashes.',
      );
    }
    const filtered = this.kernel.hooks.applyFiltersSync(
      'wp_register_ability_category_args',
      args,
      slug,
    );
    if (!filtered.label || typeof filtered.label !== 'string') {
      throw new TypeError('The ability category properties must contain a `label` string.');
    }
    if (!filtered.description || typeof filtered.description !== 'string') {
      throw new TypeError('The ability category properties must contain a `description` string.');
    }
    const category: AbilityCategory = {
      slug,
      label: filtered.label,
      description: filtered.description,
      meta: filtered.meta ?? {},
      plugin,
    };
    this.#categories.set(slug, category);
    return () => {
      if (this.#categories.get(slug) === category) this.#categories.delete(slug);
    };
  }

  /**
   * wp_register_ability(). Returns a function that unregisters it.
   * `wp_register_ability_args` runs synchronously here.
   */
  register(name: string, args: AbilityArgs, plugin: string | null = null): () => void {
    if (!ABILITY_NAME.test(name)) {
      throw new Error(
        'Ability name must be a string containing a namespace prefix, i.e. "my-plugin/my-ability". It can only contain lowercase alphanumeric characters, dashes and the forward slash.',
      );
    }
    if (this.#abilities.has(name)) throw new Error(`Ability "${name}" is already registered.`);
    const filtered = this.kernel.hooks.applyFiltersSync('wp_register_ability_args', args, name);
    if (filtered.category && !this.#categories.has(filtered.category)) {
      throw new Error(
        `Ability category "${filtered.category}" is not registered. Please register the category before assigning it to an ability.`,
      );
    }
    const ability = new Ability(this.kernel, name, filtered, plugin);
    this.#abilities.set(name, ability);
    return () => {
      if (this.#abilities.get(name) === ability) this.#abilities.delete(name);
    };
  }

  /** wp_unregister_ability() */
  unregister(name: string): boolean {
    return this.#abilities.delete(name);
  }

  /** wp_unregister_ability_category() */
  unregisterCategory(slug: string): boolean {
    return this.#categories.delete(slug);
  }

  /** wp_get_ability() */
  get(name: string): Ability | undefined {
    return this.#abilities.get(name);
  }

  /** wp_has_ability() */
  has(name: string): boolean {
    return this.#abilities.has(name);
  }

  /** wp_get_abilities(), filtered by category, namespace and meta, in name order. */
  all(query: AbilityQuery = {}): Ability[] {
    return [...this.#abilities.values()]
      .filter((a) => !query.category || a.category === query.category)
      .filter((a) => !query.namespace || a.name.startsWith(`${query.namespace}/`))
      .filter((a) =>
        Object.entries(query.meta ?? {}).every(
          ([key, value]) => (a.meta as Record<string, unknown>)[key] === value,
        ),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** wp_get_ability_category() */
  category(slug: string): AbilityCategory | undefined {
    return this.#categories.get(slug);
  }

  /** wp_get_ability_categories() */
  categories(): AbilityCategory[] {
    return [...this.#categories.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** An AbilityContext for `user`. `trusted` (the CLI without --user) passes every check. */
  context(
    user: CurrentUser | null,
    via: AbilityContext['via'],
    options: { trusted?: boolean } = {},
  ): AbilityContext {
    const kernel = this.kernel;
    return {
      user,
      via,
      async can(capability, objectId) {
        if (options.trusted && !user) return true;
        return currentUserCan(kernel, user, capability, objectId);
      },
    };
  }
}
