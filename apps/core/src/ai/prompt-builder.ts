import { type JsonSchema, validateJsonSchema } from '../abilities/json-schema';
import type { Ability } from '../abilities/registry';
import type { CurrentUser } from '../auth/users';
import type { AiClient } from './client';
import { AbilityFunctionResolver, abilityFunctionDeclaration } from './function-resolver';
import { stripHtml, stripHtmlDeep } from './security';
import { AiError, type AiMessage, type AiResult, type AiTextRequest } from './types';

/**
 * The fluent prompt builder `kernel.ai.prompt()` returns: a port of
 * WP_AI_Client_Prompt_Builder (wordpress/wp-includes/ai-client/class-wp-ai-client-prompt-builder.php)
 * with WordPress's method names in camelCase (`using_system_instruction()` →
 * `usingSystemInstruction()`).
 *
 * Configuration methods return the builder; generating methods are async and
 * throw an {@link AiError} (WordPress returns a WP_Error) with the same codes:
 * `prompt_prevented` (503) when AI is off or a `wp_ai_client_prevent_prompt`
 * filter says no, `prompt_timeout`, `prompt_network_error`,
 * `prompt_client_error`, `prompt_upstream_server_error`, and Pressbase's
 * `ai_daily_limit_reached` (429).
 *
 * Differences from WordPress:
 * - The model is the site's setting; callers don't pick one.
 * - Text and JSON output come back with HTML stripped (generateText(), generateJson()).
 * - With usingAbilities(), generating runs the model's ability calls (through
 *   the ability function resolver, as `forUser()`'s user) and asks again, up
 *   to usingMaxFunctionRounds() times; WordPress leaves that loop to the caller.
 */
export class AiPromptBuilder {
  #messages: AiMessage[] = [];
  #system: string | undefined;
  #maxTokens = 16_000;
  #temperature: number | undefined;
  #outputSchema: JsonSchema | undefined;
  #abilities: Ability[] = [];
  #maxRounds = 5;
  #timeoutSeconds: number | undefined;
  #user: CurrentUser | null = null;
  #ability: string | null = null;

  constructor(
    private readonly client: AiClient,
    prompt: string | AiMessage[] | undefined,
    private readonly plugin: string | null,
  ) {
    if (typeof prompt === 'string') this.withText(prompt);
    else if (Array.isArray(prompt)) this.withHistory(...prompt);
  }

  /** with_text(): adds text to the current user message. */
  withText(text: string): this {
    const last = this.#messages[this.#messages.length - 1];
    if (last && last.role === 'user') last.parts.push({ type: 'text', text });
    else this.#messages.push({ role: 'user', parts: [{ type: 'text', text }] });
    return this;
  }

  /** with_history(): earlier messages of the conversation. */
  withHistory(...messages: AiMessage[]): this {
    for (const message of messages) {
      this.#messages.push({ ...message, parts: [...message.parts] });
    }
    return this;
  }

  /** using_system_instruction() */
  usingSystemInstruction(instruction: string): this {
    this.#system = instruction;
    return this;
  }

  /** using_max_tokens(): the reply's token budget (default 16,000). */
  usingMaxTokens(maxTokens: number): this {
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      throw new AiError(
        'prompt_invalid_argument',
        'Max tokens must be a positive whole number.',
        400,
      );
    }
    this.#maxTokens = maxTokens;
    return this;
  }

  /** using_temperature(). Providers whose models don't take it ignore it (Claude's current models). */
  usingTemperature(temperature: number): this {
    this.#temperature = temperature;
    return this;
  }

  /** The request timeout in seconds (`wp_ai_client_default_request_timeout` sets the default, 30). */
  usingRequestTimeout(seconds: number): this {
    if (!(seconds > 0)) {
      throw new AiError('prompt_invalid_argument', 'The timeout must be a positive number.', 400);
    }
    this.#timeoutSeconds = seconds;
    return this;
  }

  /** as_output_schema() / as_json_response(): the reply is JSON matching `schema`. */
  asJsonResponse(schema: JsonSchema): this {
    this.#outputSchema = schema;
    return this;
  }

  /** as_output_schema() */
  asOutputSchema(schema: JsonSchema): this {
    return this.asJsonResponse(schema);
  }

  /**
   * using_abilities(): the model may call these abilities (names or Ability
   * objects). Unknown names are skipped, as WordPress does with a notice.
   */
  usingAbilities(...abilities: (Ability | string | (Ability | string)[])[]): this {
    for (const item of abilities.flat()) {
      const ability = typeof item === 'string' ? this.client.abilities.get(item) : item;
      if (!ability) {
        console.warn(`AI prompt: the ability ${String(item)} was not found.`);
        continue;
      }
      if (!this.#abilities.includes(ability)) this.#abilities.push(ability);
    }
    return this;
  }

  /** How many times a model's ability calls are answered before giving up (default 5). */
  usingMaxFunctionRounds(rounds: number): this {
    this.#maxRounds = Math.max(1, Math.floor(rounds));
    return this;
  }

  /**
   * The person the prompt runs for: recorded in the usage log, and the user
   * abilities check permissions for. Without one, abilities that check a
   * capability refuse.
   */
  forUser(user: CurrentUser | null): this {
    this.#user = user;
    return this;
  }

  /** The ability the prompt runs for, recorded in the usage log. */
  forAbility(name: string): this {
    this.#ability = name;
    return this;
  }

  /** Read-only view of the configuration, for `wp_ai_client_prevent_prompt` callbacks. */
  describe(): {
    plugin: string | null;
    ability: string | null;
    userId: number | null;
    hasOutputSchema: boolean;
    abilities: string[];
  } {
    return {
      plugin: this.plugin,
      ability: this.#ability,
      userId: this.#user?.id ?? null,
      hasOutputSchema: Boolean(this.#outputSchema),
      abilities: this.#abilities.map((a) => a.name),
    };
  }

  /** is_supported_for_text_generation(): AI is on and the prompt wouldn't be prevented. */
  async isSupportedForTextGeneration(): Promise<boolean> {
    if (!(await this.client.supportsAi())) return false;
    return !(await this.client.kernel.hooks.applyFilters(
      'wp_ai_client_prevent_prompt',
      false,
      this,
    ));
  }

  async #ensureAllowed(): Promise<void> {
    if (!(await this.client.supportsAi())) {
      throw new AiError(
        'prompt_prevented',
        'AI features are not supported in this environment.',
        503,
      );
    }
    if (await this.client.kernel.hooks.applyFilters('wp_ai_client_prevent_prompt', false, this)) {
      throw new AiError('prompt_prevented', 'Prompt execution was prevented by a filter.', 503);
    }
  }

  /**
   * generate_text_result(): the model's reply, its finish reason and token
   * usage (summed over ability rounds). Text isn't stripped here.
   */
  async generateTextResult(): Promise<AiResult> {
    await this.#ensureAllowed();
    if (!this.#messages.length) {
      throw new AiError('prompt_invalid_argument', 'The prompt has no messages.', 400);
    }
    const resolver = this.#abilities.length
      ? new AbilityFunctionResolver(
          this.client.abilities,
          this.#abilities,
          this.client.abilities.context(this.#user, 'ai'),
        )
      : undefined;
    const messages = [...this.#messages];
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (let round = 0; ; round++) {
      const request: Omit<AiTextRequest, 'model'> = {
        messages,
        maxTokens: this.#maxTokens,
        ...(this.#system ? { systemInstruction: this.#system } : {}),
        ...(this.#temperature !== undefined ? { temperature: this.#temperature } : {}),
        ...(this.#outputSchema ? { outputSchema: this.#outputSchema } : {}),
        ...(resolver
          ? { functionDeclarations: this.#abilities.map(abilityFunctionDeclaration) }
          : {}),
      };
      const result = await this.client.send(request, {
        plugin: this.plugin,
        ability: this.#ability,
        user: this.#user,
        timeoutSeconds: this.#timeoutSeconds,
      });
      usage.promptTokens += result.tokenUsage.promptTokens;
      usage.completionTokens += result.tokenUsage.completionTokens;
      usage.totalTokens += result.tokenUsage.totalTokens;
      if (!resolver?.hasAbilityCalls(result.message) || round + 1 >= this.#maxRounds) {
        return { ...result, tokenUsage: usage };
      }
      messages.push(result.message, await resolver.executeAbilities(result.message));
    }
  }

  /** generate_text(): the reply's text, with HTML stripped. */
  async generateText(): Promise<string> {
    const result = await this.generateTextResult();
    return stripHtml(textOf(result));
  }

  /**
   * The reply parsed as JSON and checked against the schema given to
   * asJsonResponse(), with HTML stripped from every string.
   * Throws `prompt_invalid_output` (502) when it doesn't match.
   */
  async generateJson<T = unknown>(): Promise<T> {
    const schema = this.#outputSchema;
    if (!schema) {
      throw new AiError('prompt_invalid_argument', 'Call asJsonResponse(schema) first.', 400);
    }
    const result = await this.generateTextResult();
    return parseStructuredOutput<T>(textOf(result), schema);
  }
}

function textOf(result: AiResult): string {
  return result.message.parts
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join('')
    .trim();
}

/** Parses and validates a structured reply. */
export function parseStructuredOutput<T>(text: string, schema: JsonSchema): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AiError('prompt_invalid_output', 'The model did not answer with valid JSON.', 502);
  }
  const error = validateJsonSchema(value, schema, 'output');
  if (error) {
    throw new AiError(
      'prompt_invalid_output',
      `The model's answer doesn't match the schema: ${error}`,
      502,
    );
  }
  return stripHtmlDeep(value) as T;
}
