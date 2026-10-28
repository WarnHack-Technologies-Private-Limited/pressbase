import { prepareJsonSchemaForClient } from '../abilities/json-schema';
import {
  type AbilitiesRegistry,
  type Ability,
  type AbilityContext,
  AbilityError,
} from '../abilities/registry';
import type { AiFunctionDeclaration, AiMessage, AiMessagePart } from './types';

/**
 * Resolves and runs the abilities an AI model calls: a port of
 * WP_AI_Client_Ability_Function_Resolver
 * (wordpress/wp-includes/ai-client/class-wp-ai-client-ability-function-resolver.php).
 *
 * It's built with the abilities the model may run, and refuses any other, so a
 * model can never run an ability it wasn't given. Each call goes through
 * Ability.execute(): input validation and the permission check run for the
 * user the prompt is for.
 */

/** ABILITY_PREFIX: `wpab__` keeps abilities apart from other functions. */
const ABILITY_PREFIX = 'wpab__';

/** "tec/create-event" → "wpab__tec__create-event" */
export function abilityNameToFunctionName(abilityName: string): string {
  return ABILITY_PREFIX + abilityName.replace('/', '__');
}

/** "wpab__tec__create-event" → "tec/create-event" */
export function functionNameToAbilityName(functionName: string): string {
  return functionName.slice(ABILITY_PREFIX.length).replace('__', '/');
}

/** An ability's input schema is an object schema; others are wrapped as `{ input: … }`. */
function wrapsInput(ability: Ability): boolean {
  const schema = ability.inputSchema;
  return Object.keys(schema).length > 0 && schema.type !== 'object';
}

/** WP_AI_Client_Prompt_Builder::using_abilities(): an ability as a function declaration. */
export function abilityFunctionDeclaration(ability: Ability): AiFunctionDeclaration {
  const input = prepareJsonSchemaForClient(ability.inputSchema);
  const empty = Object.keys(input).length === 0;
  return {
    name: abilityNameToFunctionName(ability.name),
    description: ability.description,
    ...(empty
      ? {}
      : {
          parameters: wrapsInput(ability)
            ? { type: 'object', properties: { input }, required: ['input'] }
            : input,
        }),
  };
}

export class AbilityFunctionResolver {
  readonly #allowed: Set<string>;

  constructor(
    private readonly registry: AbilitiesRegistry,
    abilities: readonly (Ability | string)[],
    private readonly context: AbilityContext,
  ) {
    this.#allowed = new Set(abilities.map((a) => (typeof a === 'string' ? a : a.name)));
  }

  isAbilityCall(name: string): boolean {
    return name.startsWith(ABILITY_PREFIX);
  }

  /** Runs one call. Failures become a response the model can read, never an exception. */
  async executeAbility(call: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  }): Promise<Extract<AiMessagePart, { type: 'function_response' }>> {
    const respond = (response: unknown) =>
      ({ type: 'function_response', id: call.id, name: call.name, response }) as const;
    if (!this.isAbilityCall(call.name)) {
      return respond({ error: 'Not an ability function call', code: 'invalid_ability_call' });
    }
    const abilityName = functionNameToAbilityName(call.name);
    if (!this.#allowed.has(abilityName)) {
      return respond({
        error: `Ability "${abilityName}" was not specified in the allowed abilities list.`,
        code: 'ability_not_allowed',
      });
    }
    const ability = this.registry.get(abilityName);
    if (!ability) {
      return respond({ error: `Ability "${abilityName}" not found`, code: 'ability_not_found' });
    }
    const args = call.args ?? {};
    let input: unknown = Object.keys(args).length ? args : null;
    if (input !== null && wrapsInput(ability)) input = (args as { input?: unknown }).input ?? null;
    try {
      return respond(await ability.execute(input, this.context));
    } catch (error) {
      if (error instanceof AbilityError) {
        return respond({ error: error.message, code: error.code, data: error.data ?? null });
      }
      return respond({ error: 'The ability failed.', code: 'ability_callback_exception' });
    }
  }

  /** has_ability_calls() */
  hasAbilityCalls(message: AiMessage): boolean {
    return message.parts.some((p) => p.type === 'function_call' && this.isAbilityCall(p.name));
  }

  /** execute_abilities(): a user message with a response for each ability call. */
  async executeAbilities(message: AiMessage): Promise<AiMessage> {
    const parts: AiMessagePart[] = [];
    for (const part of message.parts) {
      if (part.type === 'function_call' && this.isAbilityCall(part.name)) {
        parts.push(await this.executeAbility(part));
      }
    }
    return { role: 'user', parts };
  }
}
