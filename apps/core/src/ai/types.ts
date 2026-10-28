import type { JsonSchema } from '../abilities/json-schema';

/**
 * The AI client's provider-neutral shapes: messages, function calls, results
 * and the provider interface. They follow the PHP AI Client that WordPress 7
 * bundles (WordPress\AiClient\Messages\DTO\Message, Tools\DTO\FunctionCall,
 * Results\DTO\GenerativeAiResult), in TypeScript.
 */

/** A part of a message: text, a call the model asks for, or its response. */
export type AiMessagePart =
  | { type: 'text'; text: string }
  | { type: 'function_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'function_response'; id: string; name: string; response: unknown };

/** MessageRoleEnum: `user` or `model` (the assistant). */
export interface AiMessage {
  role: 'user' | 'model';
  parts: AiMessagePart[];
  /**
   * The message as the provider sent it (Claude's content blocks, thinking
   * included). The same provider sends it back unchanged in the next turn;
   * others use `parts`. Never logged.
   */
  providerContent?: { providerId: string; content: unknown };
}

/**
 * FunctionDeclaration: a tool the model may call. `parameters` is a JSON
 * Schema of type object (core wraps other schemas as `{ input: … }`).
 */
export interface AiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: JsonSchema;
}

/** What a provider is asked to generate. */
export interface AiTextRequest {
  model: string;
  systemInstruction?: string;
  messages: AiMessage[];
  maxTokens: number;
  /** Ignored by providers whose models no longer take it (Claude's current models). */
  temperature?: number;
  /** Structured output: the reply is JSON matching this schema. */
  outputSchema?: JsonSchema;
  functionDeclarations?: AiFunctionDeclaration[];
}

/** TokenUsage, with WordPress's names. */
export interface AiTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** FinishReasonEnum */
export type AiFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';

/** GenerativeAiResult: one candidate, the usage and which provider and model answered. */
export interface AiResult {
  id: string;
  message: AiMessage;
  finishReason: AiFinishReason;
  tokenUsage: AiTokenUsage;
  providerId: string;
  model: string;
}

/** What core hands a provider with each request. */
export interface AiProviderContext {
  apiKey: string;
  /** Aborted when the request times out. */
  signal: AbortSignal;
  timeoutMs: number;
}

/**
 * An AI provider (Anthropic, OpenAI, Google…). Register one with
 * `kernel.ai.registerProvider()`; see docs/architecture/ai.md#providers.
 */
export interface AiProvider {
  /** `anthropic`: also names its key option (`connectors_ai_anthropic_api_key`). */
  id: string;
  /** Shown in Settings → AI. */
  name: string;
  /** The environment variable whose value, when set, is used instead of the saved key. */
  envVar: string;
  /** The model used when the site hasn't chosen one. */
  defaultModel: string;
  /** Models offered in Settings → AI; the first is the default. Others can be typed in. */
  models: { id: string; name: string }[];
  /** Where to get a key, shown next to the key field. */
  keyUrl?: string;
  /**
   * Sends one request and returns one result. Throw an {@link AiError}
   * (`prompt_client_error`, `prompt_upstream_server_error`, `prompt_network_error`…)
   * on failure; core redacts keys from its message.
   */
  generateText(request: AiTextRequest, context: AiProviderContext): Promise<AiResult>;
}

/**
 * A failed prompt, with the codes and statuses WP_AI_Client_Prompt_Builder
 * gives its WP_Errors (exception_to_wp_error()).
 */
export class AiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = 'AiError';
  }
}
