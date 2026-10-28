import {
  type Ability,
  type AbilityArgs,
  type AbilityCategoryArgs,
  type AbilityContext,
  AbilityError,
  type AbilityQuery,
} from '../abilities/registry';
import type { AiPromptBuilder } from '../ai/prompt-builder';
import type { AiMessage, AiProvider } from '../ai/types';
import type { CurrentUser } from '../auth/users';
import type { Kernel } from '../kernel';

/**
 * `api.ai` and `api.abilities`: the AI client and the Abilities API for a
 * plugin (v0.7). See docs/architecture/ai.md#plugins.
 */

export interface PluginAi {
  /** wp_supports_ai(): AI is turned on in Settings → AI, has a key, and no filter turned it off. */
  supportsAi(): Promise<boolean>;
  /**
   * wp_ai_client_prompt(), attributed to the plugin: its requests are logged
   * under its slug and count against its daily limit. Generating throws
   * `prompt_prevented` while AI is off.
   */
  prompt(input?: string | AiMessage[]): AiPromptBuilder;
  /**
   * Adds an AI provider (as WordPress 7's provider plugins do), listed in
   * Settings → AI while the plugin is active. See docs/architecture/ai.md#providers.
   */
  registerProvider(provider: AiProvider): () => void;
}

export interface PluginAbilities {
  /**
   * wp_register_ability(), namespaced by the plugin: `suggest-meta` becomes
   * `my-plugin/suggest-meta` (a full name must start with `my-plugin/`).
   * `permissionCallback` is required. Unregistered when the plugin is deactivated.
   */
  // biome-ignore lint/suspicious/noExplicitAny: plugins pick their input type.
  register<I = any, O = unknown>(name: string, args: AbilityArgs<I, O>): () => void;
  /**
   * wp_register_ability_category(): the slug is the plugin's slug or starts
   * with it (`my-plugin`, `my-plugin-seo`).
   */
  registerCategory(slug: string, args: AbilityCategoryArgs): () => void;
  /** wp_get_ability(): any registered ability, core's and other plugins' too. */
  get(name: string): Ability | undefined;
  /** wp_get_abilities() */
  all(query?: AbilityQuery): Ability[];
  /** Runs an ability as `user` (validation and permission checks included). */
  execute(name: string, input: unknown, user: CurrentUser | null): Promise<unknown>;
  /** The context abilities receive, for running Ability objects yourself. */
  context(user: CurrentUser | null): AbilityContext;
  /**
   * An AbilityError (WordPress's WP_Error) to throw from a callback, or to
   * return from a permission callback: `api.abilities.error('my_code', 'Message', 400)`.
   */
  error(
    code: string,
    message: string,
    status?: number,
    data?: Record<string, unknown>,
  ): AbilityError;
}

export function createPluginAi(
  kernel: Kernel,
  slug: string,
  active: () => boolean,
  track: (dispose: () => void) => void,
): PluginAi {
  return {
    registerProvider(provider) {
      const remove = kernel.ai.registerProvider(provider);
      track(remove);
      return remove;
    },
    supportsAi: () => kernel.ai.supportsAi(),
    prompt(input) {
      if (!active()) throw new Error(`${slug} is no longer active.`);
      return kernel.ai.prompt(input, slug);
    },
  };
}

export function createPluginAbilities(
  kernel: Kernel,
  slug: string,
  track: (dispose: () => void) => void,
): PluginAbilities {
  const { abilities } = kernel;
  return {
    register(name, args) {
      const full = name.includes('/') ? name : `${slug}/${name}`;
      if (!full.startsWith(`${slug}/`)) {
        throw new Error(`Ability names of ${slug} start with "${slug}/": "${name}".`);
      }
      const unregister = abilities.register(full, args as AbilityArgs, slug);
      track(unregister);
      return unregister;
    },
    registerCategory(categorySlug, args) {
      if (categorySlug !== slug && !categorySlug.startsWith(`${slug}-`)) {
        throw new Error(`Ability categories of ${slug} are "${slug}" or start with "${slug}-".`);
      }
      const unregister = abilities.registerCategory(categorySlug, args, slug);
      track(unregister);
      return unregister;
    },
    get: (name) => abilities.get(name),
    all: (query) => abilities.all(query),
    async execute(name, input, user) {
      const ability = abilities.get(name);
      if (!ability) throw new Error(`Ability "${name}" is not registered.`);
      return ability.execute(input, abilities.context(user, 'server'));
    },
    context: (user) => abilities.context(user, 'server'),
    error: (code, message, status, data) => new AbilityError(code, message, status, data),
  };
}
