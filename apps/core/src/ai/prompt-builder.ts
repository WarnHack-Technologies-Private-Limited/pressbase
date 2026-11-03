import { type JsonSchema, validateJsonSchema } from '../abilities/json-schema';
import type { Ability } from '../abilities/registry';
import type { CurrentUser } from '../auth/users';
import type { AiClient } from './client';
import { AbilityFunctionResolver, abilityFunctionDeclaration } from './function-resolver';
import { createHtmlStripper, stripHtml, stripHtmlDeep } from './security';
import {
  AI_IMAGE_MIME_TYPES,
  AiError,
  type AiImageMimeType,
  type AiMessage,
  type AiModelTier,
  type AiResult,
  type AiTextRequest,
} from './types';

/** The largest image withImage() takes (Claude's limit per image). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * What streamText() returns: iterate it for the reply's plain text as it's
 * written; `result` resolves when it ends, with the full result and the
 * token usage summed over ability rounds (or rejects as the stream did).
 */
export interface AiTextStream extends AsyncIterable<string> {
  readonly result: Promise<AiResult>;
}

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
 * - The model is the site's setting; callers don't pick one, only a tier
 *   (usingModelTier('fast') for quick edits).
 * - streamText() streams the reply; usingTimeout() sets a timeout per call.
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
  #timeoutMs: number | undefined;
  #tier: AiModelTier = 'default';
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

  /**
   * This prompt's timeout per request, in milliseconds. The default is 30 s
   * (`wp_ai_client_default_request_timeout`); generation stages that write a
   * whole page need 60–120 s. A streamed reply must finish within it.
   */
  usingTimeout(ms: number): this {
    if (!(ms > 0) || !Number.isFinite(ms)) {
      throw new AiError('prompt_invalid_argument', 'The timeout must be a positive number.', 400);
    }
    this.#timeoutMs = Math.ceil(ms);
    return this;
  }

  /** usingTimeout() in seconds, as WordPress's request options give it. */
  usingRequestTimeout(seconds: number): this {
    return this.usingTimeout(seconds * 1000);
  }

  /**
   * Which of the site's models answers: `default` (Settings → AI's model)
   * or `fast` (its "model for quick edits", for rewrites and small changes;
   * the main model when none is set). Callers never name a model.
   */
  usingModelTier(tier: AiModelTier): this {
    if (tier !== 'default' && tier !== 'fast') {
      throw new AiError('prompt_invalid_argument', `Unknown model tier "${String(tier)}".`, 400);
    }
    this.#tier = tier;
    return this;
  }

  /**
   * with_file() for images: adds an image (bytes, or base64) to the current
   * user message, for a model to look at (a screenshot to rebuild as a
   * section). JPEG, PNG, GIF or WebP, up to 5 MB. Never logged.
   */
  withImage(image: Uint8Array | string, mimeType: AiImageMimeType): this {
    if (!AI_IMAGE_MIME_TYPES.includes(mimeType)) {
      throw new AiError('prompt_invalid_argument', 'Images must be JPEG, PNG, GIF or WebP.', 400);
    }
    const data =
      typeof image === 'string'
        ? image.replace(/^data:[^,]*,/, '')
        : Buffer.from(image).toString('base64');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new AiError('prompt_invalid_argument', 'The image is not valid base64.', 400);
    }
    if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) {
      throw new AiError('prompt_invalid_argument', 'Images can be up to 5 MB.', 400);
    }
    const part = { type: 'image' as const, mimeType, data };
    const last = this.#messages[this.#messages.length - 1];
    if (last && last.role === 'user') last.parts.push(part);
    else this.#messages.push({ role: 'user', parts: [part] });
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
    tier: AiModelTier;
  } {
    return {
      plugin: this.plugin,
      ability: this.#ability,
      userId: this.#user?.id ?? null,
      hasOutputSchema: Boolean(this.#outputSchema),
      abilities: this.#abilities.map((a) => a.name),
      tier: this.#tier,
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

  /** What each round sends, the resolver for ability calls, and who it's for. */
  async #start() {
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
    const request = (): Omit<AiTextRequest, 'model'> => ({
      messages,
      maxTokens: this.#maxTokens,
      ...(this.#system ? { systemInstruction: this.#system } : {}),
      ...(this.#temperature !== undefined ? { temperature: this.#temperature } : {}),
      ...(this.#outputSchema ? { outputSchema: this.#outputSchema } : {}),
      ...(resolver
        ? { functionDeclarations: this.#abilities.map(abilityFunctionDeclaration) }
        : {}),
    });
    const attribution = {
      plugin: this.plugin,
      ability: this.#ability,
      user: this.#user,
      timeoutMs: this.#timeoutMs,
      tier: this.#tier,
    };
    return { resolver, messages, request, attribution };
  }

  /**
   * generate_text_result(): the model's reply, its finish reason and token
   * usage (summed over ability rounds). Text isn't stripped here.
   */
  async generateTextResult(): Promise<AiResult> {
    const { resolver, messages, request, attribution } = await this.#start();
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (let round = 0; ; round++) {
      const result = await this.client.send(request(), attribution);
      addUsage(usage, result);
      if (!resolver?.hasAbilityCalls(result.message) || round + 1 >= this.#maxRounds) {
        return { ...result, tokenUsage: usage };
      }
      messages.push(result.message, await resolver.executeAbilities(result.message));
    }
  }

  /**
   * The reply as it's written: an async iterable of plain-text pieces (HTML
   * stripped, as generateText() does), with the same caps, timeout, log and
   * key redaction. With usingAbilities(), the text of every round is
   * streamed and ability calls are answered between rounds. `result` gives
   * the final result and token usage once the stream ends.
   *
   *   const stream = kernel.ai.prompt(question).forUser(user).streamText();
   *   for await (const text of stream) send(text);
   *   const { tokenUsage } = await stream.result;
   *
   * Stopping early (`break`) aborts the request; it is logged as
   * `prompt_cancelled`. Iterate it once.
   */
  streamText(): AiTextStream {
    let settle: { resolve(result: AiResult): void; reject(error: unknown): void } | undefined;
    const result = new Promise<AiResult>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // Callers that only iterate don't have to await `result`.
    result.catch(() => {});
    const builder = this;
    async function* run(): AsyncGenerator<string, void, undefined> {
      try {
        const { resolver, messages, request, attribution } = await builder.#start();
        const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        for (let round = 0; ; round++) {
          const stripper = createHtmlStripper();
          let final: AiResult | undefined;
          let streamed = false;
          for await (const event of builder.client.stream(request(), attribution)) {
            if (event.type === 'text') {
              streamed = true;
              const text = stripper.push(event.text);
              if (text) yield text;
            } else final = event.result;
          }
          if (!final) throw new AiError('prompt_builder_error', 'The reply ended early.', 502);
          // A provider that doesn't stream gives its text only in the result.
          const tail = (streamed ? '' : stripper.push(textOf(final))) + stripper.end();
          if (tail) yield tail;
          addUsage(usage, final);
          if (!resolver?.hasAbilityCalls(final.message) || round + 1 >= builder.#maxRounds) {
            settle?.resolve({ ...final, tokenUsage: usage });
            return;
          }
          messages.push(final.message, await resolver.executeAbilities(final.message));
        }
      } catch (error) {
        settle?.reject(error);
        throw error;
      } finally {
        settle?.reject(new AiError('prompt_cancelled', 'The reply was not read to the end.', 499));
      }
    }
    const iterable = run();
    return { result, [Symbol.asyncIterator]: () => iterable };
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

function addUsage(usage: AiResult['tokenUsage'], result: AiResult): void {
  usage.promptTokens += result.tokenUsage.promptTokens;
  usage.completionTokens += result.tokenUsage.completionTokens;
  usage.totalTokens += result.tokenUsage.totalTokens;
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
